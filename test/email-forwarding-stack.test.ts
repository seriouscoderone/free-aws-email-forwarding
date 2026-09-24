import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EmailForwardingStack, EmailForwardingStackProps } from '../lib/email-forwarding-stack';

const baseProps: Omit<EmailForwardingStackProps, 'env'> = {
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
