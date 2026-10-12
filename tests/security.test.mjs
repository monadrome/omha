import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoCredentialArgs, assertNoSecrets, redact } from '../lib/security.mjs';

test('credential scanner rejects quoted, redacted-prefix and multiline assignments', () => {
  for (const value of [
    'auth_token: opaque-value',
    'password: "my secret phrase"',
    'api_key: [REDACTED]-live-value',
  ]) {
    assert.throws(() => assertNoSecrets(value), { code: 'sensitive_content' });
    assert.doesNotMatch(redact(value), /opaque-value|my secret phrase|live-value/);
  }
});

test('credential flags cannot be smuggled through equals or shell-looking values', () => {
  for (const args of [
    ['--auth-token=opaque-value'],
    ['--password', '$literal-credential'],
    ['--password', '{literal-credential}'],
  ])
    assert.throws(() => assertNoCredentialArgs(args), { code: 'sensitive_content' });
  assert.doesNotThrow(() => assertNoCredentialArgs(['--password', '$AUTH_TOKEN']));
});

test('JSON escaped allowlisted secrets are redacted from provider output', () => {
  const secret = 'line-one\nline-two';
  assert.equal(
    redact(JSON.stringify({ AUTH_TOKEN: secret }), [secret]),
    '{"AUTH_TOKEN":"[REDACTED]"}',
  );
});
