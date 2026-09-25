#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { EmailForwardingStack } from '../lib/email-forwarding-stack';
import { parseConfig } from '../lib/config';

const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json not found. Copy config.example.json to config.json and fill in your values.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

let parsed;
try {
  parsed = parseConfig(config);
} catch (e: any) {
  console.error(e.message);
  process.exit(1);
}

const app = new cdk.App();

new EmailForwardingStack(app, parsed.stackName, {
  env: { region: parsed.region },
  ...parsed.props,
});
