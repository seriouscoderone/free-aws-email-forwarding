#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { EmailForwardingStack } from '../lib/email-forwarding-stack';

const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json not found. Copy config.example.json to config.json and fill in your values.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const hasLegacy = config.domain || config.hostedZoneId || config.rules;

if (config.domains && hasLegacy) {
  console.error('config.json must use either "domains" or the top-level "domain"/"hostedZoneId"/"rules" fields, not both.');
  process.exit(1);
}

if (config.domains) {
  for (const d of config.domains) {
    if (!d.domain || !d.hostedZoneId || !d.rules?.length) {
      console.error('Each entry in "domains" must include domain, hostedZoneId, and at least one rule.');
      process.exit(1);
    }
  }
  if (config.domains.length === 0) {
    console.error('"domains" must contain at least one domain.');
    process.exit(1);
  }
} else if (!config.domain || !config.hostedZoneId || !config.rules?.length) {
  console.error('config.json must include domain, hostedZoneId, and at least one rule (or a "domains" list).');
  process.exit(1);
}

const app = new cdk.App();

new EmailForwardingStack(app, 'EmailForwarding', {
  env: {
    region: config.region || 'us-east-1',
  },
  domains: config.domains,
  domain: config.domain,
  hostedZoneId: config.hostedZoneId,
  rules: config.rules,
  enableSmtpSending: config.enableSmtpSending ?? false,
  existingTxtValues: config.existingTxtValues,
  existingRuleSetName: config.existingRuleSetName,
});
