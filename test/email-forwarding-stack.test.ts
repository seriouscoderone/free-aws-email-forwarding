import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EmailForwardingStack, EmailForwardingStackProps } from '../lib/email-forwarding-stack';

const baseProps = {
  domain: 'example.com',
  hostedZoneId: 'Z0123456789ABCDEF',
  rules: [{ from: 'hello@example.com', to: 'me@gmail.com' }],
};

function synth(extraProps: Partial<EmailForwardingStackProps> = {}): Template {
  const app = new cdk.App();
  const stack = new EmailForwardingStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...baseProps,
    ...extraProps,
  });
  return Template.fromStack(stack);
}

describe('default behaviour (no existingRuleSetName)', () => {
  test('creates its own receipt rule set and attaches the forwarding rule to it', () => {
    const template = synth();
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    template.hasResourceProperties('AWS::SES::ReceiptRuleSet', {
      RuleSetName: 'TestStack-rule-set',
    });
  });

  test('emits RuleSetName and ActivateCommand outputs', () => {
    const template = synth();
    template.hasOutput('RuleSetName', {
      Value: 'TestStack-rule-set',
    });
    template.hasOutput('ActivateCommand', {
      Value: 'aws ses set-active-receipt-rule-set --rule-set-name TestStack-rule-set',
    });
  });
});

describe('lambda runtime', () => {
  test('no function uses a deprecated Node.js runtime', () => {
    const template = synth({ enableSmtpSending: true });
    const functions = template.findResources('AWS::Lambda::Function');
    const runtimes = Object.values(functions)
      .map(f => f.Properties.Runtime)
      .filter((r): r is string => typeof r === 'string' && r.startsWith('nodejs'));
    expect(runtimes.length).toBeGreaterThanOrEqual(2);
    for (const runtime of runtimes) {
      // nodejs20.x and earlier are at/past Lambda deprecation
      const major = Number(runtime.match(/^nodejs(\d+)\.x$/)?.[1]);
      expect(major).toBeGreaterThanOrEqual(22);
    }
  });
});

const twoDomains = {
  domains: [
    {
      domain: 'example.com',
      hostedZoneId: 'Z0123456789ABCDEF',
      rules: [{ from: 'hello@example.com', to: 'me@gmail.com' }],
    },
    {
      domain: 'example.org',
      hostedZoneId: 'ZFEDCBA9876543210',
      rules: [{ from: 'hello@example.org', to: 'me@gmail.com' }],
    },
  ],
};

function synthDomains(extraProps: Partial<EmailForwardingStackProps> = {}): Template {
  const app = new cdk.App();
  const stack = new EmailForwardingStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...twoDomains,
    ...extraProps,
  });
  return Template.fromStack(stack);
}

describe('multi-domain (domains[])', () => {
  test('legacy single-domain props and a one-element domains list synthesize identical templates', () => {
    const legacyApp = new cdk.App();
    const legacy = Template.fromStack(new EmailForwardingStack(legacyApp, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      ...baseProps,
      enableSmtpSending: true,
    }));
    const newApp = new cdk.App();
    const modern = Template.fromStack(new EmailForwardingStack(newApp, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      domains: [{ ...baseProps }],
      enableSmtpSending: true,
    }));
    expect(modern.toJSON()).toEqual(legacy.toJSON());
  });

  test('each domain gets its own SES identity, MX, SPF, and DMARC records', () => {
    const template = synthDomains();
    template.resourceCountIs('AWS::SES::EmailIdentity', 2);
    const records = template.findResources('AWS::Route53::RecordSet');
    const byType = (t: string) => Object.values(records).filter(r => r.Properties.Type === t);
    expect(byType('MX').map(r => r.Properties.Name).sort()).toEqual(['example.com.', 'example.org.']);
    const txtNames = byType('TXT').map(r => r.Properties.Name).sort();
    expect(txtNames).toEqual(['_dmarc.example.com.', '_dmarc.example.org.', 'example.com.', 'example.org.']);
  });

  test('one rule set holds one receipt rule per domain, deterministically ordered', () => {
    const template = synthDomains();
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    const rules = Object.entries(template.findResources('AWS::SES::ReceiptRule'));
    expect(rules).toHaveLength(2);
    const recipients = rules.map(([, r]) => r.Properties.Rule.Recipients).sort();
    expect(recipients).toEqual([['hello@example.com'], ['hello@example.org']]);
    // second rule is chained after the first so ordering within the set is deterministic
    const withAfter = rules.filter(([, r]) => r.Properties.After !== undefined);
    expect(withAfter).toHaveLength(1);
  });

  test('shares one bucket and one forwarder covering all domains', () => {
    const template = synthDomains();
    template.resourceCountIs('AWS::S3::Bucket', 1);
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    const forwarders = functions.filter(f => f.Properties.Environment?.Variables?.FORWARD_MAPPING);
    expect(forwarders).toHaveLength(1);
    const mapping = JSON.parse(forwarders[0].Properties.Environment.Variables.FORWARD_MAPPING);
    expect(mapping).toEqual({
      'hello@example.com': 'me@gmail.com',
      'hello@example.org': 'me@gmail.com',
    });
  });

  test('SMTP users are isolated per address and scoped to their own domain identity', () => {
    const template = synthDomains({ enableSmtpSending: true });
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const sendPolicies = policies.filter(p =>
      p.Properties.Users !== undefined &&
      JSON.stringify(p.Properties.PolicyDocument).includes('ses:SendRawEmail'));
    expect(sendPolicies).toHaveLength(2);
    const scopes = sendPolicies.map(p => {
      const stmt = p.Properties.PolicyDocument.Statement[0];
      return {
        resource: stmt.Resource,
        from: stmt.Condition.StringEquals['ses:FromAddress'],
      };
    });
    expect(scopes).toContainEqual({
      resource: 'arn:aws:ses:us-east-1:123456789012:identity/example.com',
      from: 'hello@example.com',
    });
    expect(scopes).toContainEqual({
      resource: 'arn:aws:ses:us-east-1:123456789012:identity/example.org',
      from: 'hello@example.org',
    });
  });

  test('multi-domain works with existingRuleSetName: every rule targets the adopted set', () => {
    const template = synthDomains({ existingRuleSetName: 'already-active-set' });
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    const rules = Object.values(template.findResources('AWS::SES::ReceiptRule'));
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.Properties.RuleSetName).toBe('already-active-set');
    }
  });

  test('first domain keeps the legacy construct IDs so existing deployments upgrade without churn', () => {
    const legacyApp = new cdk.App();
    const legacy = Template.fromStack(new EmailForwardingStack(legacyApp, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      ...baseProps,
    }));
    const multi = synthDomains();
    const legacyIds = Object.keys(legacy.toJSON().Resources);
    const multiIds = Object.keys(multi.toJSON().Resources);
    for (const id of legacyIds) {
      expect(multiIds).toContain(id);
    }
  });
});

describe('send-only mode', () => {
  function synthSendOnly(): Template {
    const app = new cdk.App();
    const stack = new EmailForwardingStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      mode: 'send-only',
      domains: [
        { domain: 'example.com', rules: [{ from: 'hello@example.com' }] },
        { domain: 'example.org', rules: [{ from: 'hello@example.org' }] },
      ],
    });
    return Template.fromStack(stack);
  }

  test('creates no receiving infrastructure at all', () => {
    const template = synthSendOnly();
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    template.resourceCountIs('AWS::SES::ReceiptRule', 0);
    template.resourceCountIs('AWS::SES::EmailIdentity', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    const forwarders = functions.filter(f => f.Properties.Environment?.Variables?.FORWARD_MAPPING);
    expect(forwarders).toHaveLength(0);
  });

  test('creates per-address IAM users, secrets, and SMTP outputs', () => {
    const template = synthSendOnly();
    template.resourceCountIs('AWS::IAM::User', 2);
    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(p => p.Properties.Users !== undefined);
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      const stmt = p.Properties.PolicyDocument.Statement[0];
      expect(stmt.Action).toBe('ses:SendRawEmail');
      expect(stmt.Condition.StringEquals['ses:FromAddress']).toMatch(/^hello@example\.(com|org)$/);
    }
    template.hasOutput('SmtpEndpoint', { Value: 'email-smtp.us-east-1.amazonaws.com' });
    template.hasOutput('SmtpPort', { Value: '587' });
    template.hasOutput('SmtpSecrethelloexamplecom', {});
    template.hasOutput('SmtpSecrethelloexampleorg', {});
  });

  test('asks the credentials handler to verify the identity exists in the target account', () => {
    const template = synthSendOnly();
    const resources = Object.values(template.findResources('AWS::CloudFormation::CustomResource'));
    expect(resources).toHaveLength(2);
    const verified = resources.map(r => r.Properties.VerifyIdentityDomain).sort();
    expect(verified).toEqual(['example.com', 'example.org']);
  });

  test('emits no receiving-related outputs', () => {
    const template = synthSendOnly();
    expect(template.findOutputs('ActivateCommand')).toEqual({});
    expect(template.findOutputs('RuleSetName')).toEqual({});
    expect(template.findOutputs('EmailBucketName')).toEqual({});
  });
});

describe('receive-only mode', () => {
  test('creates receiving infrastructure but no SMTP credentials', () => {
    const app = new cdk.App();
    const stack = new EmailForwardingStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      mode: 'receive-only',
      ...baseProps,
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::SES::ReceiptRule', 1);
    template.resourceCountIs('AWS::IAM::User', 0);
    expect(template.findOutputs('SmtpEndpoint')).toEqual({});
  });

  test('rejects the contradiction of receive-only with enableSmtpSending', () => {
    const app = new cdk.App();
    expect(() => new EmailForwardingStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      mode: 'receive-only',
      enableSmtpSending: true,
      ...baseProps,
    })).toThrow(/receive-only/);
  });
});

describe('mode validation', () => {
  test('both mode still requires hostedZoneId', () => {
    const app = new cdk.App();
    expect(() => new EmailForwardingStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      domains: [{ domain: 'example.com', rules: [{ from: 'a@example.com', to: 'b@x.com' }] }],
    })).toThrow(/hostedZoneId/);
  });

  test('both mode still requires a forwarding destination', () => {
    const app = new cdk.App();
    expect(() => new EmailForwardingStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
      domains: [{ domain: 'example.com', hostedZoneId: 'Z1', rules: [{ from: 'a@example.com' }] }],
    })).toThrow(/to/);
  });

  test('default mode does not pass VerifyIdentityDomain (the stack creates the identity itself)', () => {
    const template = synth({ enableSmtpSending: true });
    const resources = Object.values(template.findResources('AWS::CloudFormation::CustomResource'));
    expect(resources.length).toBeGreaterThanOrEqual(1);
    for (const r of resources) {
      expect(r.Properties.VerifyIdentityDomain).toBeUndefined();
    }
  });
});

describe('existingRuleSetName set', () => {
  const existing = { existingRuleSetName: 'sla-harness-ses-harness' };

  test('creates no new receipt rule set', () => {
    const template = synth(existing);
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
  });

  test('adds the forwarding rule to the existing rule set', () => {
    const template = synth(existing);
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      RuleSetName: 'sla-harness-ses-harness',
    });
  });

  test('does not emit the ActivateCommand output', () => {
    const template = synth(existing);
    const outputs = template.findOutputs('ActivateCommand');
    expect(outputs).toEqual({});
  });

  test('RuleSetName output names the adopted rule set without instructing activation', () => {
    const template = synth(existing);
    const outputs = template.findOutputs('RuleSetName');
    expect(outputs.RuleSetName.Value).toBe('sla-harness-ses-harness');
    expect(outputs.RuleSetName.Description).not.toMatch(/activat/i);
  });
});
