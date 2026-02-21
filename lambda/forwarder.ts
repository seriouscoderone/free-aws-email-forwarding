import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';

const s3 = new S3Client({});
const sesClient = new SESClient({});

const BUCKET = process.env.EMAIL_BUCKET!;
const FORWARD_MAPPING: Record<string, string> = JSON.parse(process.env.FORWARD_MAPPING || '{}');
const DOMAIN = process.env.DOMAIN!;

interface SESEventRecord {
  ses: {
    mail: {
      messageId: string;
      commonHeaders: {
        from: string[];
        to: string[];
        subject: string;
      };
    };
    receipt: {
      recipients: string[];
    };
  };
}

interface SESEvent {
  Records: SESEventRecord[];
}

export async function handler(event: SESEvent): Promise<void> {
  for (const record of event.Records) {
    const messageId = record.ses.mail.messageId;
    const recipients = record.ses.receipt.recipients;

    console.log(`Processing message ${messageId} for recipients: ${recipients.join(', ')}`);

    // Fetch raw email from S3
    const s3Response = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `incoming/${messageId}`,
    }));

    const rawEmail = await s3Response.Body!.transformToString();

    for (const recipient of recipients) {
      const recipientLower = recipient.toLowerCase();
      const destination = FORWARD_MAPPING[recipientLower];

      if (!destination) {
        console.log(`No forwarding rule for ${recipientLower}, skipping`);
        continue;
      }

      console.log(`Forwarding ${recipientLower} → ${destination}`);

      const rewritten = rewriteEmail(rawEmail, recipientLower, destination);

      await sesClient.send(new SendRawEmailCommand({
        Source: recipientLower,
        Destinations: [destination],
        RawMessage: {
          Data: Buffer.from(rewritten),
        },
      }));

      console.log(`Forwarded ${messageId} to ${destination}`);
    }
  }
}

function rewriteEmail(raw: string, forwardFrom: string, _destination: string): string {
  // Split headers and body
  const headerEndIndex = raw.indexOf('\r\n\r\n');
  if (headerEndIndex === -1) {
    // Try plain \n\n
    const altIndex = raw.indexOf('\n\n');
    if (altIndex === -1) return raw;
    return rewriteWithSplit(raw, altIndex, '\n\n', forwardFrom);
  }
  return rewriteWithSplit(raw, headerEndIndex, '\r\n\r\n', forwardFrom);
}

function rewriteWithSplit(raw: string, splitIndex: number, separator: string, forwardFrom: string): string {
  const headerSection = raw.substring(0, splitIndex);
  const body = raw.substring(splitIndex);
  const lineBreak = separator === '\r\n\r\n' ? '\r\n' : '\n';

  const lines = headerSection.split(lineBreak);
  const newLines: string[] = [];

  let originalFrom = '';
  let hasReplyTo = false;

  // First pass: extract original From
  for (const line of lines) {
    if (line.match(/^From:\s/i)) {
      originalFrom = line.replace(/^From:\s*/i, '').trim();
    }
    if (line.match(/^Reply-To:\s/i)) {
      hasReplyTo = true;
    }
  }

  // Extract email from "Name <email>" or bare email
  const originalEmail = extractEmail(originalFrom);
  const originalName = extractName(originalFrom);

  // Second pass: rewrite headers
  for (const line of lines) {
    // Strip existing DKIM-Signature (SES will re-sign)
    if (line.match(/^DKIM-Signature:\s/i)) continue;
    // Skip continuation lines of DKIM-Signature
    if (newLines.length > 0 && newLines[newLines.length - 1] === '__SKIP__' && line.match(/^\s/)) continue;

    // Rewrite From header
    if (line.match(/^From:\s/i)) {
      const displayName = originalName
        ? `${originalName} via ${DOMAIN}`
        : `${originalEmail} via ${DOMAIN}`;
      newLines.push(`From: "${displayName}" <${forwardFrom}>`);

      // Add Reply-To if not already present
      if (!hasReplyTo && originalEmail) {
        newLines.push(`Reply-To: ${originalFrom}`);
      }
      continue;
    }

    // Remove Return-Path (SES sets its own)
    if (line.match(/^Return-Path:\s/i)) continue;

    newLines.push(line);
  }

  // Remove any __SKIP__ markers
  const filtered = newLines.filter(l => l !== '__SKIP__');

  return filtered.join(lineBreak) + body;
}

function extractEmail(fromValue: string): string {
  const match = fromValue.match(/<([^>]+)>/);
  if (match) return match[1];
  // Bare email
  return fromValue.trim();
}

function extractName(fromValue: string): string {
  const match = fromValue.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return '';
}
