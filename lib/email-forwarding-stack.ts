import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ForwardingRule {
  from: string;
  /** Forwarding destination. Required except in send-only mode, where mail is never received. */
  to?: string;
}

export interface DomainConfig {
  domain: string;
  /** Route53 hosted zone for the domain. Required except in send-only mode, which touches no DNS. */
  hostedZoneId?: string;
  rules: ForwardingRule[];
  /** Existing TXT record values at the domain apex to preserve (e.g. google-site-verification) */
  existingTxtValues?: string[];
  /**
   * Default true. Set false when the domain's SES identity is created and
   * managed by something else (typically the application stack that sends
   * mail from this domain) — creating a second identity for the same domain
   * fails CloudFormation's early validation with "already exists". When
   * false, the DKIM record sets are skipped too, since the identity's owner
   * is already publishing them; MX, SPF, DMARC, and the receipt rule are
   * still created. The identity must actually be verified: if SMTP sending
   * is enabled the deploy checks this and fails clearly, otherwise it is on
   * you — an unverified identity means forwarding silently never works.
   */
  createIdentity?: boolean;
  /**
   * Full DMARC record value. Default: `v=DMARC1; p=reject; rua=mailto:<first
   * rule's address>`. That default is right for a domain this stack is
   * introducing and wrong to impose on one that already sends mail: under
   * p=reject, any existing sender that fails SPF/DKIM alignment stops being
   * a line in a report and becomes mail that silently never arrives. For a
   * domain with existing senders, start at p=quarantine, watch the aggregate
   * reports (rua) for a few weeks, and tighten once everything legitimate
   * aligns. Note the deploy REPLACES any DMARC record already at
   * _dmarc.<domain>. Set to null to skip creating the record entirely, for
   * operators who manage DMARC elsewhere.
   */
  dmarc?: string | null;
}

export type StackMode = 'send-only' | 'receive-only' | 'both';

export interface EmailForwardingStackProps extends cdk.StackProps {
  /**
   * Domains handled by this deployment. One SES identity, MX/SPF/DMARC
   * record set, and receipt rule is created per domain; the rule set,
   * S3 bucket, and forwarder Lambda are shared.
   *
   * IMPORTANT: keep the first domain first. The first entry uses the
   * original (unsuffixed) construct IDs so existing single-domain
   * deployments upgrade in place; reordering the list replaces resources.
   */
  domains?: DomainConfig[];
  /** @deprecated Legacy single-domain shape; use `domains` instead. */
  domain?: string;
  /** @deprecated Legacy single-domain shape; use `domains` instead. */
  hostedZoneId?: string;
  /** @deprecated Legacy single-domain shape; use `domains` instead. */
  rules?: ForwardingRule[];
  /** @deprecated Legacy single-domain shape; use `domains` instead. */
  existingTxtValues?: string[];
  enableSmtpSending?: boolean;
  /**
   * What this deployment provisions (default 'both'):
   * - 'both': receiving infrastructure, plus SMTP credentials when
   *   enableSmtpSending is set — exactly the behaviour before this
   *   option existed.
   * - 'send-only': ONLY the per-address IAM users, access keys, and
   *   SMTP secrets. No S3 bucket, Lambda, receipt rule/set, identity,
   *   or DNS records. For accounts that hold SES production sending
   *   access while the domain's DNS (and the receiving stack) live in
   *   a different account. The domain identity must already be
   *   verified in this account — the credentials custom resource
   *   checks and fails the deploy otherwise.
   * - 'receive-only': the receiving infrastructure with no SMTP
   *   credentials; the explicit form of enableSmtpSending: false.
   */
  mode?: StackMode;
  /**
   * Name of an SES receipt rule set that already exists in this account/region.
   * When set, the forwarding rules are added to that rule set instead of
   * creating (and requiring activation of) a new one. Use this when the
   * account already has an active rule set — SES allows only one active rule
   * set per account per region, and switching the active set breaks whatever
   * the current set handles.
   */
  existingRuleSetName?: string;
}

// Convert an email address or domain into a string safe to embed in IAM user
// names, Secrets Manager secret names, and CDK construct IDs.
// e.g. "alice.smith@example.com" -> "alice-smith-example-com"
function sanitizeForResourceName(addr: string): string {
  return addr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeDomains(props: EmailForwardingStackProps): DomainConfig[] {
  const hasLegacy = props.domain !== undefined || props.hostedZoneId !== undefined || props.rules !== undefined;
  if (props.domains && hasLegacy) {
    throw new Error('Specify either `domains` or the legacy `domain`/`hostedZoneId`/`rules` fields, not both.');
  }
  if (props.domains) {
    if (props.domains.length === 0) {
      throw new Error('`domains` must contain at least one domain.');
    }
    return props.domains;
  }
  if (!props.domain || !props.rules?.length) {
    throw new Error('Provide `domains`, or the legacy `domain`, `hostedZoneId`, and `rules` fields.');
  }
  return [{
    domain: props.domain,
    hostedZoneId: props.hostedZoneId,
    rules: props.rules,
    existingTxtValues: props.existingTxtValues,
  }];
}

export class EmailForwardingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EmailForwardingStackProps) {
    super(scope, id, props);

    const { enableSmtpSending, existingRuleSetName } = props;
    const mode: StackMode = props.mode ?? 'both';
    const domains = normalizeDomains(props);
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    const receiving = mode !== 'send-only';
    const sending = mode === 'send-only' || (mode === 'both' && !!enableSmtpSending);

    if (mode === 'receive-only' && enableSmtpSending) {
      throw new Error('mode "receive-only" contradicts enableSmtpSending: true — drop one of them.');
    }
    if (mode === 'send-only' && enableSmtpSending === false) {
      throw new Error('mode "send-only" exists only to provision SMTP credentials — remove enableSmtpSending: false.');
    }
    if (receiving) {
      for (const d of domains) {
        if (!d.hostedZoneId) {
          throw new Error(`Domain ${d.domain} needs a hostedZoneId (required except in send-only mode).`);
        }
        for (const rule of d.rules) {
          if (!rule.to) {
            throw new Error(`Rule for ${rule.from} needs a "to" forwarding destination (required except in send-only mode).`);
          }
        }
      }
    }

    if (receiving) {
      this.buildReceiving(id, domains, region, account, existingRuleSetName);
    }
    if (sending) {
      this.buildSmtpCredentials(id, domains, region, account, mode);
    }
  }

  private buildReceiving(
    id: string,
    domains: DomainConfig[],
    region: string,
    account: string,
    existingRuleSetName: string | undefined,
  ): void {
    // --- S3 Bucket for raw emails (shared across domains) ---
    const emailBucket = new s3.Bucket(this, 'EmailBucket', {
      bucketName: `${id.toLowerCase()}-emails-${account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      // Deliberate: destroying the stack deletes every stored email. The
      // bucket is a rolling 90-day cache of already-forwarded mail, not the
      // system of record — the forwarded copies live in the destination
      // inboxes. RETAIN would leave an orphaned bucket to clean up by hand.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // SES needs permission to write to the bucket
    emailBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [`${emailBucket.bucketArn}/incoming/*`],
      conditions: {
        StringEquals: { 'AWS:SourceAccount': account },
      },
    }));

    // --- Forwarding Lambda (shared; mapping covers every domain) ---
    const forwardMapping: Record<string, string> = {};
    for (const d of domains) {
      for (const rule of d.rules) {
        forwardMapping[rule.from] = rule.to!;
      }
    }

    const forwarder = new lambda.NodejsFunction(this, 'ForwarderFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'forwarder.ts'),
      handler: 'handler',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EMAIL_BUCKET: emailBucket.bucketName,
        FORWARD_MAPPING: JSON.stringify(forwardMapping),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    emailBucket.grantRead(forwarder);
    forwarder.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendRawEmail'],
      resources: ['*'],
    }));

    // --- SES Receipt Rule Set (shared; exactly one owner) ---
    // SES allows one active receipt rule set per account per region. If the
    // account already has an active set, adopt it (existingRuleSetName)
    // instead of creating a competing one.
    const ruleSet = existingRuleSetName
      ? ses.ReceiptRuleSet.fromReceiptRuleSetName(this, 'RuleSet', existingRuleSetName)
      : new ses.ReceiptRuleSet(this, 'RuleSet', {
          receiptRuleSetName: `${id}-rule-set`,
        });

    // --- Per-domain resources ---
    // The first domain uses the original construct IDs so existing
    // single-domain deployments upgrade in place with no resource
    // replacement. Additional domains get domain-suffixed IDs.
    let previousRule: ses.ReceiptRule | undefined;

    for (const [index, d] of domains.entries()) {
      const suffix = index === 0 ? '' : `-${sanitizeForResourceName(d.domain)}`;

      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, `HostedZone${suffix}`, {
        hostedZoneId: d.hostedZoneId!,
        zoneName: d.domain,
      });

      // SES Domain Identity + DKIM — skipped when another stack owns the
      // identity (and is therefore already publishing the DKIM records).
      if (d.createIdentity !== false) {
        new ses.EmailIdentity(this, `EmailIdentity${suffix}`, {
          identity: ses.Identity.publicHostedZone(hostedZone),
        });
      }

      new route53.MxRecord(this, `MxRecord${suffix}`, {
        zone: hostedZone,
        values: [{ priority: 10, hostName: `inbound-smtp.${region}.amazonaws.com` }],
      });

      // Use CfnRecordSet for the apex TXT record so we can merge SPF with
      // any existing TXT values (e.g. google-site-verification). Route53
      // only allows one TXT record set per name.
      const txtValues = [
        '"v=spf1 include:amazonses.com -all"',
        ...(d.existingTxtValues || []).map(v => `"${v}"`),
      ];

      new route53.CfnRecordSet(this, `SpfRecord${suffix}`, {
        hostedZoneId: d.hostedZoneId!,
        name: `${d.domain}.`,
        type: 'TXT',
        ttl: '1800',
        resourceRecords: txtValues,
      });

      // dmarc: null means the operator manages the DMARC record elsewhere.
      if (d.dmarc !== null) {
        new route53.TxtRecord(this, `DmarcRecord${suffix}`, {
          zone: hostedZone,
          recordName: `_dmarc.${d.domain}`,
          values: [d.dmarc ?? `v=DMARC1; p=reject; rua=mailto:${d.rules[0].from}`],
        });
      }

      // One receipt rule per domain, chained with `after` so evaluation
      // order within the rule set is deterministic.
      previousRule = new ses.ReceiptRule(this, `ForwardingRule${suffix}`, {
        ruleSet,
        after: previousRule,
        recipients: d.rules.map(r => r.from),
        scanEnabled: true,
        actions: [
          new sesActions.S3({
            bucket: emailBucket,
            objectKeyPrefix: 'incoming/',
          }),
          new sesActions.Lambda({
            function: forwarder,
            invocationType: sesActions.LambdaInvocationType.EVENT,
          }),
        ],
      });
    }

    // --- Receiving outputs ---
    new cdk.CfnOutput(this, 'EmailBucketName', {
      value: emailBucket.bucketName,
      description: 'S3 bucket storing incoming emails',
    });

    if (existingRuleSetName) {
      // Adopted an already-existing (typically already-active) rule set:
      // do NOT tell the operator to switch the active rule set.
      new cdk.CfnOutput(this, 'RuleSetName', {
        value: existingRuleSetName,
        description: 'Existing SES receipt rule set the forwarding rules were added to (no action needed)',
      });
    } else {
      new cdk.CfnOutput(this, 'RuleSetName', {
        value: `${id}-rule-set`,
        description: 'SES receipt rule set name (must be manually activated)',
      });

      new cdk.CfnOutput(this, 'ActivateCommand', {
        value: `aws ses set-active-receipt-rule-set --rule-set-name ${id}-rule-set`,
        description: 'Run this command to activate the rule set',
      });
    }
  }

  // --- SMTP Sending Credentials ---
  // One IAM user, access key, and Secrets Manager entry per rule.
  // Each user is scoped via an IAM `ses:FromAddress` condition so they
  // can only send mail with their own address in the From header — even
  // though the underlying SES identity (the domain) covers all addresses.
  // The single implementation serves both 'both' and 'send-only' modes.
  private buildSmtpCredentials(
    id: string,
    domains: DomainConfig[],
    region: string,
    account: string,
    mode: StackMode,
  ): void {
    {
      const smtpEndpoint = `email-smtp.${region}.amazonaws.com`;
      const smtpPort = '587';

      // Single custom-resource handler, invoked once per rule with different SecretName.
      const smtpCredsHandler = new lambda.NodejsFunction(this, 'SmtpCredsHandler', {
        entry: path.join(__dirname, '..', 'lambda', 'smtp-credentials.ts'),
        handler: 'handler',
        runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(30),
        bundling: { minify: true, sourceMap: true, target: 'node22' },
      });

      smtpCredsHandler.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:DeleteSecret',
        ],
        resources: [
          `arn:aws:secretsmanager:${region}:${account}:secret:${id}/smtp/*`,
        ],
      }));

      if (mode === 'send-only' || domains.some(d => d.createIdentity === false)) {
        // The handler verifies the identity before minting credentials
        // (this API does not support resource-level scoping).
        smtpCredsHandler.addToRolePolicy(new iam.PolicyStatement({
          actions: ['ses:GetIdentityVerificationAttributes'],
          resources: ['*'],
        }));
      }

      const smtpCredsProvider = new cr.Provider(this, 'SmtpCredsProvider', {
        onEventHandler: smtpCredsHandler,
      });

      for (const d of domains) {
        // Each user may only send via its own domain's identity...
        const domainArn = `arn:aws:ses:${region}:${account}:identity/${d.domain}`;

        for (const rule of d.rules) {
          const safe = sanitizeForResourceName(rule.from);

          const smtpUser = new iam.User(this, `SmtpUser-${safe}`, {
            userName: `${id}-smtp-${safe}`,
          });

          // ...and only with its own address in the From header.
          smtpUser.addToPolicy(new iam.PolicyStatement({
            actions: ['ses:SendRawEmail'],
            resources: [domainArn],
            conditions: {
              StringEquals: { 'ses:FromAddress': rule.from },
            },
          }));

          const accessKey = new iam.AccessKey(this, `SmtpAccessKey-${safe}`, {
            user: smtpUser,
          });

          const secretName = `${id}/smtp/${safe}`;

          new cdk.CustomResource(this, `SmtpCredentials-${safe}`, {
            serviceToken: smtpCredsProvider.serviceToken,
            properties: {
              SecretName: secretName,
              AccessKeyId: accessKey.accessKeyId,
              SecretAccessKey: accessKey.secretAccessKey.unsafeUnwrap(),
              Region: region,
              SmtpEndpoint: smtpEndpoint,
              SmtpPort: smtpPort,
              Version: '2',
              // Whenever this stack did not create the identity (send-only
              // mode, or createIdentity: false), the handler checks it is
              // verified before minting credentials that would otherwise
              // fail at send time.
              ...(mode === 'send-only' || d.createIdentity === false
                ? { VerifyIdentityDomain: d.domain } : {}),
            },
          });

          new cdk.CfnOutput(this, `SmtpSecret-${safe}`, {
            value: secretName,
            description: `Secrets Manager secret with SMTP creds for ${rule.from}`,
          });
        }
      }

      new cdk.CfnOutput(this, 'SmtpEndpoint', {
        value: smtpEndpoint,
        description: 'SMTP server endpoint (shared across all rules)',
      });

      new cdk.CfnOutput(this, 'SmtpPort', {
        value: smtpPort,
        description: 'SMTP TLS port',
      });
    }
  }
}
