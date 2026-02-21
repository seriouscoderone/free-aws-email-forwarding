import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ForwardingRule {
  from: string;
  to: string;
}

export interface EmailForwardingStackProps extends cdk.StackProps {
  domain: string;
  hostedZoneId: string;
  rules: ForwardingRule[];
  enableSmtpSending?: boolean;
  /** Existing TXT record values at the domain apex to preserve (e.g. google-site-verification) */
  existingTxtValues?: string[];
}

export class EmailForwardingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EmailForwardingStackProps) {
    super(scope, id, props);

    const { domain, hostedZoneId, rules, enableSmtpSending, existingTxtValues } = props;

    // --- Hosted Zone ---
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: domain,
    });

    // --- SES Domain Identity + DKIM ---
    const emailIdentity = new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.publicHostedZone(hostedZone),
    });

    // --- Route53 DNS Records ---
    const region = cdk.Stack.of(this).region;

    new route53.MxRecord(this, 'MxRecord', {
      zone: hostedZone,
      values: [{ priority: 10, hostName: `inbound-smtp.${region}.amazonaws.com` }],
    });

    // Use CfnRecordSet for the apex TXT record so we can merge SPF with
    // any existing TXT values (e.g. google-site-verification). Route53
    // only allows one TXT record set per name.
    const txtValues = [
      '"v=spf1 include:amazonses.com ~all"',
      ...(existingTxtValues || []).map(v => `"${v}"`),
    ];

    new route53.CfnRecordSet(this, 'SpfRecord', {
      hostedZoneId,
      name: `${domain}.`,
      type: 'TXT',
      ttl: '1800',
      resourceRecords: txtValues,
    });

    new route53.TxtRecord(this, 'DmarcRecord', {
      zone: hostedZone,
      recordName: `_dmarc.${domain}`,
      values: [`v=DMARC1; p=none; rua=mailto:${rules[0].from}`],
    });

    // --- S3 Bucket for raw emails ---
    const emailBucket = new s3.Bucket(this, 'EmailBucket', {
      bucketName: `${id.toLowerCase()}-emails-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
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
        StringEquals: { 'AWS:SourceAccount': cdk.Stack.of(this).account },
      },
    }));

    // --- Forwarding Lambda ---
    const forwardMapping: Record<string, string> = {};
    for (const rule of rules) {
      forwardMapping[rule.from] = rule.to;
    }

    const forwarder = new lambda.NodejsFunction(this, 'ForwarderFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'forwarder.ts'),
      handler: 'handler',
      runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EMAIL_BUCKET: emailBucket.bucketName,
        FORWARD_MAPPING: JSON.stringify(forwardMapping),
        DOMAIN: domain,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
      },
    });

    emailBucket.grantRead(forwarder);
    forwarder.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendRawEmail'],
      resources: ['*'],
    }));

    // --- SES Receipt Rule Set + Rules ---
    const ruleSet = new ses.ReceiptRuleSet(this, 'RuleSet', {
      receiptRuleSetName: `${id}-rule-set`,
    });

    // Collect all "from" addresses for recipient matching
    const recipients = rules.map(r => r.from);

    new ses.ReceiptRule(this, 'ForwardingRule', {
      ruleSet,
      recipients,
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

    // --- SMTP Sending Credentials (conditional) ---
    if (enableSmtpSending) {
      const smtpUser = new iam.User(this, 'SmtpUser', {
        userName: `${id}-smtp-user`,
      });

      // Scope to configured from addresses
      const fromArns = rules.map(r =>
        `arn:aws:ses:${region}:${cdk.Stack.of(this).account}:identity/${r.from}`
      );
      const domainArn = `arn:aws:ses:${region}:${cdk.Stack.of(this).account}:identity/${domain}`;

      smtpUser.addToPolicy(new iam.PolicyStatement({
        actions: ['ses:SendRawEmail'],
        resources: [...fromArns, domainArn],
      }));

      const accessKey = new iam.AccessKey(this, 'SmtpAccessKey', {
        user: smtpUser,
      });

      new secretsmanager.Secret(this, 'SmtpCredentials', {
        secretName: `${id}/smtp-credentials`,
        secretObjectValue: {
          accessKeyId: cdk.SecretValue.unsafePlainText(accessKey.accessKeyId),
          secretAccessKey: accessKey.secretAccessKey,
        },
        description: `SMTP credentials for ${domain} email sending. Use scripts/smtp-password.py to convert the secret access key to an SMTP password.`,
      });

      new cdk.CfnOutput(this, 'SmtpEndpoint', {
        value: `email-smtp.${region}.amazonaws.com`,
        description: 'SMTP server endpoint',
      });

      new cdk.CfnOutput(this, 'SmtpPort', {
        value: '587',
        description: 'SMTP TLS port',
      });

      new cdk.CfnOutput(this, 'SmtpCredentialsSecret', {
        value: `${id}/smtp-credentials`,
        description: 'Secrets Manager secret name containing SMTP credentials',
      });
    }

    // --- Outputs ---
    new cdk.CfnOutput(this, 'EmailBucketName', {
      value: emailBucket.bucketName,
      description: 'S3 bucket storing incoming emails',
    });

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
