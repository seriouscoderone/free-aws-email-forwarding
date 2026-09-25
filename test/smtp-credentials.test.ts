import { assertIdentityVerified } from '../lambda/smtp-credentials';

describe('assertIdentityVerified', () => {
  test('passes for a verified identity', () => {
    expect(() => assertIdentityVerified('example.com', 'Success')).not.toThrow();
  });

  test('fails clearly for an unverified identity', () => {
    expect(() => assertIdentityVerified('example.com', 'Failed'))
      .toThrow(/example\.com.*not verified/i);
  });

  test('fails clearly when the identity does not exist at all', () => {
    expect(() => assertIdentityVerified('example.com', undefined))
      .toThrow(/example\.com.*not verified/i);
  });
});
