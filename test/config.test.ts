import { parseConfig } from '../lib/config';

const minimal = {
  domain: 'example.com',
  hostedZoneId: 'Z1',
  rules: [{ from: 'a@example.com', to: 'b@x.com' }],
};

describe('parseConfig stackName', () => {
  test('defaults to the exact literal EmailForwarding so existing deployments stay put', () => {
    expect(parseConfig(minimal).stackName).toBe('EmailForwarding');
  });

  test('accepts a custom stack name', () => {
    expect(parseConfig({ ...minimal, stackName: 'EmailForwardingAcme' }).stackName)
      .toBe('EmailForwardingAcme');
  });

  test('rejects names CloudFormation would refuse', () => {
    expect(() => parseConfig({ ...minimal, stackName: 'has spaces' })).toThrow(/stackName/);
    expect(() => parseConfig({ ...minimal, stackName: '-leading-dash' })).toThrow(/stackName/);
    expect(() => parseConfig({ ...minimal, stackName: '' })).toThrow(/stackName/);
  });
});

describe('parseConfig validation (moved from bin/app.ts)', () => {
  test('accepts the legacy single-domain shape', () => {
    const { props } = parseConfig(minimal);
    expect(props.domain).toBe('example.com');
  });

  test('accepts the domains shape', () => {
    const { props } = parseConfig({
      domains: [{ domain: 'example.com', hostedZoneId: 'Z1', rules: [{ from: 'a@example.com', to: 'b@x.com' }] }],
    });
    expect(props.domains).toHaveLength(1);
  });

  test('rejects both shapes at once', () => {
    expect(() => parseConfig({ ...minimal, domains: [] })).toThrow(/not both/);
  });

  test('rejects an unknown mode', () => {
    expect(() => parseConfig({ ...minimal, mode: 'sideways' })).toThrow(/mode/);
  });

  test('send-only mode does not require hostedZoneId or to', () => {
    const { props } = parseConfig({
      mode: 'send-only',
      domains: [{ domain: 'example.com', rules: [{ from: 'a@example.com' }] }],
    });
    expect(props.mode).toBe('send-only');
  });

  test('other modes require hostedZoneId and to', () => {
    expect(() => parseConfig({
      domains: [{ domain: 'example.com', rules: [{ from: 'a@example.com', to: 'b@x.com' }] }],
    })).toThrow(/hostedZoneId/);
    expect(() => parseConfig({
      domains: [{ domain: 'example.com', hostedZoneId: 'Z1', rules: [{ from: 'a@example.com' }] }],
    })).toThrow(/"to"/);
  });

  test('does not force enableSmtpSending to an explicit false (the #6 regression)', () => {
    expect(parseConfig(minimal).props.enableSmtpSending).toBeUndefined();
  });
});
