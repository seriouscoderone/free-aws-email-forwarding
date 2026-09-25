import { createHmac } from 'crypto';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import {
  SESClient,
  GetIdentityVerificationAttributesCommand,
} from '@aws-sdk/client-ses';

const sm = new SecretsManagerClient({});
const sesClient = new SESClient({});

// Per AWS documentation: https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html
const VERSION = Buffer.from([0x04]);
const MESSAGE = 'SendRawEmail';

function calculateSmtpPassword(secretKey: string, region: string): string {
  const kDate = createHmac('sha256', `AWS4${secretKey}`).update('11111111').digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update('ses').digest();
  const kTerminal = createHmac('sha256', kService).update('aws4_request').digest();
  const kMessage = createHmac('sha256', kTerminal).update(MESSAGE).digest();

  return Buffer.concat([VERSION, kMessage]).toString('base64');
}

interface Event {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: {
    SecretName: string;
    AccessKeyId: string;
    SecretAccessKey: string;
    Region: string;
    SmtpEndpoint: string;
    SmtpPort: string;
    /** When set (send-only mode), the identity must already be verified here. */
    VerifyIdentityDomain?: string;
  };
}

// An unverified identity yields credentials that authenticate fine and then
// fail at send time — fail the deploy instead, with the reason spelled out.
export function assertIdentityVerified(domain: string, status: string | undefined): void {
  if (status !== 'Success') {
    throw new Error(
      `SES identity ${domain} is not verified in this account/region ` +
      `(status: ${status ?? 'not found'}). In send-only mode the identity must ` +
      `already exist and be verified — credentials minted against an unverified ` +
      `identity would authenticate and then fail at send time.`,
    );
  }
}

export async function handler(event: Event): Promise<{ PhysicalResourceId: string }> {
  const { SecretName, AccessKeyId, SecretAccessKey, Region, SmtpEndpoint, SmtpPort, VerifyIdentityDomain } =
    event.ResourceProperties;

  const physicalId = `smtp-creds-${SecretName}`;

  if (event.RequestType === 'Delete') {
    try {
      await sm.send(new DeleteSecretCommand({
        SecretId: SecretName,
        ForceDeleteWithoutRecovery: true,
      }));
    } catch (e: any) {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    }
    return { PhysicalResourceId: physicalId };
  }

  // Create or Update
  if (VerifyIdentityDomain) {
    const attrs = await sesClient.send(new GetIdentityVerificationAttributesCommand({
      Identities: [VerifyIdentityDomain],
    }));
    assertIdentityVerified(
      VerifyIdentityDomain,
      attrs.VerificationAttributes?.[VerifyIdentityDomain]?.VerificationStatus,
    );
  }

  const smtpPassword = calculateSmtpPassword(SecretAccessKey, Region);

  const secretValue = JSON.stringify({
    smtpEndpoint: SmtpEndpoint,
    smtpPort: SmtpPort,
    smtpUsername: AccessKeyId,
    smtpPassword,
  });

  try {
    await sm.send(new PutSecretValueCommand({
      SecretId: SecretName,
      SecretString: secretValue,
    }));
  } catch (e: any) {
    if (e instanceof ResourceNotFoundException) {
      await sm.send(new CreateSecretCommand({
        Name: SecretName,
        SecretString: secretValue,
        Description: `Ready-to-use SES SMTP credentials. smtpUsername + smtpPassword for ${SmtpEndpoint}:${SmtpPort}`,
      }));
    } else {
      throw e;
    }
  }

  return { PhysicalResourceId: physicalId };
}
