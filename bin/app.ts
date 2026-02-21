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

if (!config.domain || !config.hostedZoneId || !config.rules?.length) {
  console.error('config.json must include domain, hostedZoneId, and at least one rule.');
  process.exit(1);
}

const app = new cdk.App();

new EmailForwardingStack(app, 'EmailForwarding', {
  env: {
    region: config.region || 'us-east-1',
  },
  domain: config.domain,
  hostedZoneId: config.hostedZoneId,
  rules: config.rules,
  enableSmtpSending: config.enableSmtpSending ?? false,
});
