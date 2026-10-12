import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function temp(prefix = 'omha-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
export function fake(output = 'done', extra = {}) {
  return {
    adapter: 'fake',
    command: 'fake',
    model: 'local-test',
    retry: { maxRetries: 0, baseMs: 0, maxMs: 10, jitter: 0 },
    budget: { reserveTokens: 10, reserveCostUsd: 0 },
    responses: [{ output }],
    ...extra,
  };
}
export function config(profiles) {
  return { version: 1, profiles };
}
