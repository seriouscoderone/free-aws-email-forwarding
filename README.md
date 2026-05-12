# Free AWS Email Forwarding

Serverless email forwarding using AWS SES, Lambda, S3, and CDK. Forward emails from your custom domain to any address, and optionally send from your domain via Gmail's "Send mail as" feature.

Costs essentially nothing on AWS free tier. No servers to manage.

## What This Does

- Receives email at `you@yourdomain.com` via SES
- Stores raw emails in S3 (90-day retention)
- Forwards to your personal email (Gmail, etc.)
- Rewrites headers so replies go to the original sender
- Optionally creates ready-to-use SMTP credentials so you can **send** from your domain via Gmail

## Prerequisites

- AWS account with SES **out of sandbox** (or sandbox with verified destination addresses)
- Domain with a Route53 hosted zone
- Node.js 18+
- AWS CDK CLI: `npm install -g aws-cdk`
- AWS credentials configured (`aws configure` or `AWS_PROFILE`)

## Quick Start

```bash
# Clone
git clone https://github.com/yourusername/free-aws-email-forwarding.git
cd free-aws-email-forwarding
npm install

# Configure
cp config.example.json config.json
# Edit config.json with your domain, hosted zone ID, and forwarding rules

# Deploy
npx cdk deploy

# Activate the SES receipt rule set (see note below)
aws ses set-active-receipt-rule-set --rule-set-name EmailForwarding-rule-set

# Test
# Send an email to your configured address and check your inbox
```

## Configuration

Edit `config.json`:

```json
{
  "domain": "yourdomain.com",
  "hostedZoneId": "Z0123456789ABCDEF",
  "region": "us-east-1",
  "rules": [
    { "from": "hello@yourdomain.com", "to": "you@gmail.com" },
    { "from": "support@yourdomain.com", "to": "team@company.com" }
  ],
  "enableSmtpSending": true,
  "existingTxtValues": []
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `domain` | Yes | Your domain name |
| `hostedZoneId` | Yes | Route53 hosted zone ID for the domain |
| `region` | No | AWS region (default: `us-east-1`). Must support SES receiving. |
| `rules` | Yes | Array of forwarding rules |
| `enableSmtpSending` | No | Create SMTP credentials for sending (default: `false`) |
| `existingTxtValues` | No | Existing TXT record values at the domain apex to preserve (e.g. `["google-site-verification=abc123"]`) |

**SES receiving regions:** SES inbound email is only available in `us-east-1`, `us-west-2`, and `eu-west-1`.

**Existing TXT records:** Route53 only allows one TXT record set per name. If your domain already has TXT records (like Google site verification), add them to `existingTxtValues` so they're preserved when the stack creates the SPF record. You'll need to delete the existing TXT record before the first deploy so CDK can manage it.

## Activating the Rule Set

**Important:** AWS SES allows only **one active receipt rule set** per account. When you activate this stack's rule set, any previously active rule set is deactivated.

```bash
# Activate
aws ses set-active-receipt-rule-set --rule-set-name EmailForwarding-rule-set

# Check which rule set is active
aws ses describe-active-receipt-rule-set
```

If you have existing SES receipt rules (e.g., for another domain), add all forwarding rules to this stack's config so everything runs through one rule set.

## Gmail "Send mail as" Setup

This lets each forwarded address send email **from** your custom domain using Gmail's interface. **Each rule gets its own IAM user and SMTP credentials**, scoped via an `ses:FromAddress` condition so the credentials for `alice@yourdomain.com` cannot be used to send as `bob@yourdomain.com`.

### 1. Enable SMTP credentials

Set `"enableSmtpSending": true` in `config.json` and deploy. The stack creates **one IAM user, one access key, and one Secrets Manager entry per rule**, with the password pre-converted to SES SMTP format.

### 2. Get SMTP credentials for a specific address

Each rule's secret is named `EmailForwarding/smtp/<sanitized-from-address>`. The sanitizer lower-cases and replaces non-alphanumerics with `-`:

| `from` in config.json | Secret name |
|---|---|
| `alice@example.com` | `EmailForwarding/smtp/alice-example-com` |
| `Bob.Jones@example.com` | `EmailForwarding/smtp/bob-jones-example-com` |

```bash
aws secretsmanager get-secret-value \
  --secret-id EmailForwarding/smtp/alice-example-com \
  --query SecretString --output text | jq .
```

This gives you `smtpEndpoint`, `smtpPort`, `smtpUsername`, and `smtpPassword` — all ready to use directly.

You can also find every per-rule secret name in the stack's CloudFormation outputs (`SmtpSecret<sanitized>`).

### 3. Configure Gmail

For each address you want to send from:

1. Gmail Settings > Accounts and Import > "Send mail as" > "Add another email address"
2. Enter the display name and `you@yourdomain.com`, uncheck "Treat as an alias"
3. SMTP server: `smtpEndpoint` from the secret
4. Port: `smtpPort` from the secret
5. Username: `smtpUsername` from the secret
6. Password: `smtpPassword` from the secret
7. Select "Secured connection using TLS"
8. Click "Add Account" — Gmail will send a confirmation email to `you@yourdomain.com`
9. That confirmation arrives via this stack's forwarding, so **make sure forwarding is working first**
10. Click the confirmation link in the forwarded email to finish setup

> **Note on upgrading from a pre-per-rule deploy:** earlier versions of this stack created a single shared IAM user and a single secret named `EmailForwarding/smtp-credentials`. After upgrading and redeploying, that shared resource will be deleted and replaced with per-rule equivalents — any Gmail "Send mail as" entries configured against the old credentials will need to be re-added with the new ones.

## Architecture

```
Incoming email
  → SES (receives at your domain)
  → S3 (stores raw email)
  → Lambda (rewrites headers, forwards via SES)
  → Your inbox

Outgoing email (Gmail "Send mail as")
  → Gmail SMTP → SES SMTP endpoint → Recipient
```

### What gets deployed

- **SES Email Identity** with DKIM (3 CNAME records auto-created)
- **Route53 records:** MX, SPF (TXT), DMARC (TXT)
- **S3 bucket** for raw email storage (90-day lifecycle)
- **Lambda function** for email forwarding
- **SES Receipt Rule Set** with forwarding rules
- **Per-rule IAM User + SMTP credentials** in Secrets Manager (optional, for sending). Each rule gets its own credentials, scoped to only send as its own `from` address.
- **Custom resource** that converts IAM keys → SES SMTP passwords automatically

## Costs

For typical personal use (under 1,000 emails/month):

| Service | Cost |
|---------|------|
| SES receiving | Free (first 1,000/month) |
| SES sending | $0.10 per 1,000 |
| Lambda | Free tier (1M requests/month) |
| S3 | Pennies (emails expire after 90 days) |
| Route53 | $0.50/month per hosted zone |
| **Total** | **~$0.50/month** (the hosted zone) |

## Troubleshooting

### Emails not arriving

1. Check MX record: `dig MX yourdomain.com`
   - Should show `10 inbound-smtp.{region}.amazonaws.com`
2. Check rule set is active: `aws ses describe-active-receipt-rule-set`
3. Check Lambda logs: CloudWatch Logs group `/aws/lambda/EmailForwarding-ForwarderFunction*`
4. Check S3 bucket for raw emails (confirms SES received them)

### SES sandbox

In sandbox mode, you can only send to verified email addresses. Verify your destination:
```bash
aws ses verify-email-identity --email-address you@gmail.com
```

Or request production access in the SES console.

### DKIM not verified

Check SES console > Verified identities > your domain. DKIM records can take up to 72 hours to propagate, but usually complete in minutes.

### Gmail "Send mail as" verification email not arriving

The verification email goes to your custom domain address, which should be forwarded by this stack. Make sure forwarding is working first.

## Cleanup

```bash
npx cdk destroy
```

This removes all resources. The S3 bucket and its contents are also deleted (autoDeleteObjects is enabled).

To deactivate the rule set without destroying the stack:
```bash
aws ses set-active-receipt-rule-set
```

(No `--rule-set-name` deactivates all rule sets.)

## License

Apache 2.0
