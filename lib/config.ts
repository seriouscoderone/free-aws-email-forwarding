import { DomainConfig, EmailForwardingStackProps, ForwardingRule, StackMode } from './email-forwarding-stack';

/** The shape of config.json (both the legacy single-domain and domains forms). */
export interface FileConfig {
  stackName?: string;
  mode?: StackMode | string;
  region?: string;
  domain?: string;
  hostedZoneId?: string;
  rules?: ForwardingRule[];
  existingTxtValues?: string[];
  domains?: DomainConfig[];
  enableSmtpSending?: boolean;
  existingRuleSetName?: string;
}

export interface ParsedConfig {
  stackName: string;
  region: string;
  props: Omit<EmailForwardingStackProps, 'env'>;
}

// Existing deployments live under this exact name; changing the default would
// be a stack rename, i.e. a delete-and-recreate that loses IAM users and
// their SMTP credentials.
const DEFAULT_STACK_NAME = 'EmailForwarding';

// CloudFormation stack name rules: letter first, then letters/digits/hyphens.
const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;

/**
 * Validate a parsed config.json and turn it into stack props.
 * Throws with a plain-English message on any problem.
 */
export function parseConfig(config: FileConfig): ParsedConfig {
  const stackName = config.stackName ?? DEFAULT_STACK_NAME;
  if (!STACK_NAME_PATTERN.test(stackName)) {
    throw new Error(
      `stackName "${stackName}" is not a valid CloudFormation stack name: ` +
      'it must start with a letter and contain only letters, digits, and hyphens (max 128 characters).',
    );
  }

  const hasLegacy = config.domain || config.hostedZoneId || config.rules;
  if (config.domains && hasLegacy) {
    throw new Error('Use either "domains" or the top-level "domain"/"hostedZoneId"/"rules" fields, not both.');
  }

  const mode = config.mode ?? 'both';
  if (!['send-only', 'receive-only', 'both'].includes(mode)) {
    throw new Error(`Unknown mode "${config.mode}". Use "send-only", "receive-only", or "both".`);
  }
  const sendOnly = mode === 'send-only';

  if (config.domains) {
    if (config.domains.length === 0) {
      throw new Error('"domains" must contain at least one domain.');
    }
    for (const d of config.domains) {
      if (!d.domain || !d.rules?.length || (!sendOnly && !d.hostedZoneId)) {
        throw new Error(`Each entry in "domains" must include domain${sendOnly ? '' : ', hostedZoneId,'} and at least one rule.`);
      }
      if (!sendOnly && d.rules.some(r => !r.to)) {
        throw new Error('Each rule needs a "to" forwarding destination (only send-only mode may omit it).');
      }
    }
  } else if (!config.domain || !config.rules?.length || (!sendOnly && !config.hostedZoneId)) {
    throw new Error(`config.json must include domain${sendOnly ? '' : ', hostedZoneId,'} and at least one rule (or a "domains" list).`);
  } else if (!sendOnly && config.rules.some(r => !r.to)) {
    throw new Error('Each rule needs a "to" forwarding destination (only send-only mode may omit it).');
  }

  return {
    stackName,
    region: config.region || 'us-east-1',
    props: {
      mode: config.mode as StackMode | undefined,
      domains: config.domains,
      domain: config.domain,
      hostedZoneId: config.hostedZoneId,
      rules: config.rules,
      enableSmtpSending: config.enableSmtpSending,
      existingTxtValues: config.existingTxtValues,
      existingRuleSetName: config.existingRuleSetName,
    },
  };
}
