#!/usr/bin/env python3
"""
Convert an IAM Secret Access Key to an SES SMTP password.

AWS SES SMTP authentication uses a derived password, not the raw secret key.
This script implements the documented conversion algorithm.

Usage:
    python3 scripts/smtp-password.py <secret-access-key> [region]

Or retrieve from Secrets Manager:
    SECRET=$(aws secretsmanager get-secret-value \
        --secret-id EmailForwarding/smtp-credentials \
        --query SecretString --output text)
    python3 scripts/smtp-password.py $(echo $SECRET | jq -r .secretAccessKey)
"""

import sys
import hmac
import hashlib
import base64

# Per AWS documentation
SMTP_SIGNING_VERSION = b'\x04'


def calculate_smtp_password(secret_key: str, region: str = 'us-east-1') -> str:
    """Convert IAM secret access key to SES SMTP password."""
    date = '11111111'  # Static date per AWS algorithm
    service = 'ses'

    # Derive signing key
    k_date = hmac.new(('AWS4' + secret_key).encode('utf-8'),
                       date.encode('utf-8'), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode('utf-8'), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode('utf-8'), hashlib.sha256).digest()
    k_terminal = hmac.new(k_service, b'aws4_request', hashlib.sha256).digest()

    # Sign the version byte
    signature = hmac.new(k_terminal, SMTP_SIGNING_VERSION, hashlib.sha256).digest()

    # Prepend version byte and base64 encode
    return base64.b64encode(SMTP_SIGNING_VERSION + signature).decode('utf-8')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    secret_key = sys.argv[1]
    region = sys.argv[2] if len(sys.argv) > 2 else 'us-east-1'

    password = calculate_smtp_password(secret_key, region)
    print(f'SMTP Password: {password}')
