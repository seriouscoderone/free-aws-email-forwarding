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
- Node.js 20+
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

# Activate the SES receipt rule set (see "Activating the Rule Set" below —
# skip this if you deployed with existingRuleSetName)
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
| `domain` | Yes* | Your domain name |
| `hostedZoneId` | Yes* | Route53 hosted zone ID for the domain |
| `region` | No | AWS region (default: `us-east-1`). Must support SES receiving. |
| `rules` | Yes* | Array of forwarding rules |
| `enableSmtpSending` | No | Create SMTP credentials for sending (default: `false`) |
| `existingTxtValues` | No | Existing TXT record values at the domain apex to preserve (e.g. `["google-site-verification=abc123"]`) |
| `existingRuleSetName` | No | Name of an SES receipt rule set that already exists in the account/region. When set, the stack adds its forwarding rules to that rule set instead of creating a new one. See [Activating the Rule Set](#activating-the-rule-set). |
| `domains` | Yes* | Multi-domain alternative to `domain`/`hostedZoneId`/`rules`/`existingTxtValues`. See [Multiple Domains](#multiple-domains). |

\* Provide either the single-domain fields (`domain`, `hostedZoneId`, `rules`) **or** a `domains` list — not both.

## Multiple Domains

One deployment can forward for any number of domains. This matters because **AWS allows one active SES receipt rule set per account per region** — deploying this stack once per domain means the deployments fight over the active slot, and whichever one loses has its inbound mail silently dropped (delivered to SES by the MX record, then discarded because its rule set is not the active one; no bounce, no error).

Use the `domains` list instead of the top-level `domain`/`hostedZoneId`/`rules`:

```json
{
  "region": "us-east-1",
  "enableSmtpSending": true,
  "domains": [
    {
      "domain": "example.com",
      "hostedZoneId": "Z0123456789ABCDEF",
      "rules": [{ "from": "hello@example.com", "to": "me@gmail.com" }],
      "existingTxtValues": []
    },
    {
      "domain": "example.org",
      "hostedZoneId": "ZFEDCBA9876543210",
      "rules": [{ "from": "hello@example.org", "to": "me@gmail.com" }]
    }
  ]
}
```

Each domain gets its own SES identity (with DKIM), MX, SPF, and DMARC records, and its own receipt rule. The rule set, S3 bucket, and forwarder Lambda are shared — one deployment, one rule set, exactly one owner.

**Migrating an existing single-domain deployment:** your current `config.json` keeps working unchanged. To add a second domain, convert to the `domains` shape **with your existing domain as the first entry** — the first entry keeps the original resource IDs, so CloudFormation updates in place with no replacement, no DKIM re-verification, and no change to SMTP credentials. Keep it first permanently; reordering the list replaces resources.

**Consolidating two existing deployments** (one stack per domain) is different: destroy the second domain's stack, then add that domain to the surviving deployment's `domains` list. Its IAM users and secrets are recreated, so **its SMTP credentials change and every Gmail "Send mail as" entry configured against them must be re-added** (same caveat as the per-rule credentials note below). Destroy the old stack *before* deploying the consolidated one — both would otherwise try to own DNS records and SES identities for the same domain. Note that destroying the old stack deletes its rule set; if that rule set was the **active** one, activate the surviving deployment's rule set immediately after (or deploy first with `existingRuleSetName` pointed at the old set, then migrate — but the simple destroy-then-activate window is usually fine for personal mail).

**Prefer `domains` over `existingRuleSetName` for multiple domains you own.** `existingRuleSetName` exists for coexisting with a rule set owned by *something else* (another stack, another tool). Using it to chain your own forwarding deployments together leaves the rule set owned by whichever deployment created it — destroy that one and every other domain's rule goes down with it, with no CloudFormation warning, because an adopted rule set is an import, not a dependency. The `domains` list keeps one owner.

**SES receiving regions:** SES inbound email is only available in `us-east-1`, `us-west-2`, and `eu-west-1`.

**Existing TXT records:** Route53 only allows one TXT record set per name. If your domain already has TXT records (like Google site verification), add them to `existingTxtValues` so they're preserved when the stack creates the SPF record. You'll need to delete the existing TXT record before the first deploy so CDK can manage it.

## Activating the Rule Set

**Important:** AWS SES allows only **one active receipt rule set** per account per region. When you activate this stack's rule set, any previously active rule set is deactivated — and **inbound mail handled by that rule set silently stops arriving**. Nothing errors; you find out later. Check what's active before switching:

```bash
# Check which rule set is active (do this BEFORE activating anything)
aws ses describe-active-receipt-rule-set

# Activate (only if nothing else is active, or you intend to replace it)
aws ses set-active-receipt-rule-set --rule-set-name EmailForwarding-rule-set
```

### If the account already has an active rule set

Don't create a competing rule set — adopt the existing one. Set `existingRuleSetName` in `config.json`:

```json
{
  "existingRuleSetName": "my-existing-rule-set"
}
```

With this set, the stack:

- adds its forwarding rule to the named rule set instead of creating a new one
- leaves the rule set's other rules intact
- skips the `ActivateCommand` output — the rule set is already active, so there is nothing to switch (and switching is exactly what this option exists to avoid)

**Rule ordering caveat:** SES evaluates rules within a set **in order**, and a broad rule (e.g. a catch-all for your domain) can shadow a later, more specific rule. The stack's rule is appended to the end of the adopted set. If the existing set contains a catch-all matching your forwarding addresses, reorder the rules in the SES console (or with `aws ses reorder-receipt-rule-set`) so the forwarding rule comes first — otherwise it may never fire.

Alternatively, if the existing rules are simple forwards for another domain, you can add them all to this stack's config so everything runs through one rule set.

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

- **SES Email Identity** with DKIM (3 CNAME records auto-created) — one per domain
- **Route53 records:** MX, SPF (TXT), DMARC (TXT) — one set per domain
- **S3 bucket** for raw email storage (90-day lifecycle) — shared
- **Lambda function** for email forwarding — shared
- **SES Receipt Rule Set** with one forwarding rule per domain
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

This removes all resources. The S3 bucket and its contents are also deleted (autoDeleteObjects is enabled). If you deployed with `existingRuleSetName`, only the stack's own forwarding rule is removed from the adopted rule set — the rule set and its other rules are left alone.

To deactivate the rule set without destroying the stack:
```bash
aws ses set-active-receipt-rule-set
```

(No `--rule-set-name` deactivates all rule sets.)

## License

Apache 2.0
