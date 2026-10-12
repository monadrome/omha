import { OmhaError } from './validation.mjs';

const patterns = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
  /\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]{8,}/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret|credential)\s*["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\[[^\]\r\n]*\][^\s"',;}]*)|([^\s"',;}\r\n]+))/gi,
];

function escaped(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

export function redact(value, secrets = []) {
  let result = String(value ?? '');
  for (const secret of [...new Set(secrets)]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[REDACTED]').split(escaped(secret)).join('[REDACTED]');
  for (const pattern of patterns) pattern.lastIndex = 0;
  for (const pattern of patterns)
    result = result.replace(pattern, (...args) =>
      pattern === patterns[3]
        ? [args[2], args[3], args[4], args[5]].some((value) => value === '[REDACTED]')
          ? args[0]
          : `${args[1]}${args[2] !== undefined ? '"' : args[3] !== undefined ? "'" : ''}[REDACTED]${args[2] !== undefined ? '"' : args[3] !== undefined ? "'" : ''}`
        : '[REDACTED]',
    );
  return result;
}

export function redactData(value, secrets = []) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((x) => redactData(x, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactData(v, secrets)]));
  return value;
}

export function assertNoSecrets(value, secrets = []) {
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  if (redact(input, secrets) !== input)
    throw new OmhaError(
      'sensitive_content',
      'Credentials are not permitted in persisted context or memory',
    );
}

export function assertNoCredentialArgs(args) {
  if (!Array.isArray(args)) return;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const match = arg.match(
      /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|secret|credential)(?:=(.*))?$/i,
    );
    if (match) {
      const next = args[i + 1];
      const value = match[1] ?? next;
      if (!value || !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(String(value)))
        throw new OmhaError(
          'sensitive_content',
          'Credentials must come from an allowlisted environment variable, not argv',
        );
    }
  }
}

export function environment(allowlist = [], source = process.env) {
  return Object.fromEntries(
    allowlist.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
}

export function environmentSecrets(env) {
  return Object.entries(env)
    .filter(([key]) => /key|token|secret|password|credential|auth/i.test(key))
    .map(([, value]) => value);
}
