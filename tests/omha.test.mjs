import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'omha-test-'));
process.env.OMHA_HOME = join(root, 'state');
const { projectIdentity } = await import('../lib/core.mjs');
const { initMemory, memoryPointer, readMemory, searchMemory, writeMemory } =
  await import('../lib/memory.mjs');
const { dispatch } = await import('../lib/runner.mjs');
const { handoff } = await import('../lib/terminal.mjs');

test('memory is isolated and indexed for one project', () => {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const identity = initMemory(repo);
  assert.equal(identity.kind, 'git');
  const written = writeMemory(repo, {
    name: 'decision',
    description: 'migration decision',
    content: 'Use the event log.',
    source: 'test',
  });
  assert.match(readMemory(repo), /decision/);
  assert.deepEqual(searchMemory(repo, 'event log'), ['decision.md']);
  assert.match(memoryPointer(repo).uri, new RegExp(identity.projectId));
  assert.ok(written.hash);
});

test('expected hash prevents stale shared-memory overwrite', () => {
  const repo = join(root, 'repo-conflict');
  execFileSync('git', ['init', '-q', repo]);
  initMemory(repo);
  const first = writeMemory(repo, { name: 'shared', description: 'shared', content: 'one' });
  assert.throws(
    () =>
      writeMemory(repo, {
        name: 'shared',
        description: 'shared',
        content: 'two',
        expectedHash: 'stale',
      }),
    /memory_conflict/,
  );
  assert.ok(first.hash);
});

test(
  'router falls back after an explicit rate-limit response',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await dispatch('task', ['primary', 'backup'], {
      profiles: {
        primary: {
          command: '/bin/sh',
          model: 'fake-a',
          sandbox: 'external',
          sandboxCommand: '/usr/bin/env',
          sandboxArgs: ['--'],
          args: ['-c', 'echo 429 >&2; exit 1'],
          retry: { maxRetries: 0 },
        },
        backup: {
          command: '/bin/sh',
          model: 'fake-b',
          sandbox: 'external',
          sandboxCommand: '/usr/bin/env',
          sandboxArgs: ['--'],
          args: ['-c', 'printf fallback'],
        },
      },
    });
    assert.equal(result.provider, 'backup');
    assert.equal(result.stdout, 'fallback');
    assert.equal(result.attempts.length, 2);
  },
);

test('file handoff works without terminal backends', async () => {
  const cwd = join(root, 'handoff');
  mkdirSync(cwd);
  const result = await handoff(cwd, 'continue from pointer', {
    backend: 'file',
    name: 'test-handoff',
    json: true,
  });
  assert.equal(result.backend, 'file');
  assert.match(result.promptFile, /prompt\.md$/);
  assert.equal(result.state, 'awaiting');
});

test('CLI help and artifact-only butterfly detection do not mistake hash changes for drift', () => {
  const bin = join(process.cwd(), 'bin', 'omha.mjs');
  const cwd = join(root, 'cli');
  mkdirSync(cwd);
  writeFileSync(join(root, 'artifact.md'), 'one');
  const env = { ...process.env, OMHA_HOME: join(root, 'cli-state') };
  assert.match(
    execFileSync(process.execPath, [bin, 'help'], { encoding: 'utf8', env }),
    /memory init/,
  );
  const first = JSON.parse(
    execFileSync(
      process.execPath,
      [bin, 'auto-butterfly', '--artifact', join(root, 'artifact.md'), '--cwd', cwd],
      { encoding: 'utf8', env },
    ),
  );
  assert.equal(first.status, 'no_op');
  writeFileSync(join(root, 'artifact.md'), 'two');
  const second = JSON.parse(
    execFileSync(
      process.execPath,
      [
        bin,
        'auto-butterfly',
        '--artifact',
        join(root, 'artifact.md'),
        '--cwd',
        cwd,
        '--handoff',
        '--backend',
        'file',
      ],
      { encoding: 'utf8', env },
    ),
  );
  assert.equal(second.status, 'no_op');
  assert.equal(second.handoffs, undefined);
  assert.notEqual(first.currentHash, second.currentHash);
});
