import { rewriteEmail } from '../lambda/forwarder';

function rawEmail(headers: string[], body = 'Hello there'): string {
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

describe('rewriteEmail', () => {
  test('derives the "via" display domain from the forwarding address, not a fixed domain', () => {
    const raw = rawEmail([
      'From: Alice <alice@sender.net>',
      'To: hello@example.org',
      'Subject: hi',
    ]);
    const result = rewriteEmail(raw, 'hello@example.org', 'me@gmail.com');
    expect(result).toContain('From: "Alice via example.org" <hello@example.org>');
  });

  test('different recipient domains in one deployment each get their own via-domain', () => {
    const raw = rawEmail([
      'From: Bob <bob@sender.net>',
      'To: hello@example.com',
      'Subject: hi',
    ]);
    const result = rewriteEmail(raw, 'hello@example.com', 'me@gmail.com');
    expect(result).toContain('From: "Bob via example.com" <hello@example.com>');
  });

  test('adds Reply-To pointing at the original sender', () => {
    const raw = rawEmail([
      'From: Alice <alice@sender.net>',
      'To: hello@example.org',
      'Subject: hi',
    ]);
    const result = rewriteEmail(raw, 'hello@example.org', 'me@gmail.com');
    expect(result).toContain('Reply-To: Alice <alice@sender.net>');
  });
});
