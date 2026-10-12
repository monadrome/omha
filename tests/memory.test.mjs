import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { temp } from './helpers.mjs';
import {
  doctorMemory,
  forgetMemory,
  initMemory,
  injectMemory,
  listMemory,
  memoryPaths,
  memoryPointer,
  readMemory,
  searchMemory,
  writeMemory,
  MEMORY_CAPS,
} from '../lib/memory.mjs';
import { projectIdentity } from '../lib/core.mjs';
import { lockDir } from '../lib/storage.mjs';
import { markdown, parseMarkdown } from '../lib/frontmatter.mjs';

const root = temp();
process.env.OMHA_HOME = join(root, 'state');
const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', [
  '-C',
  repo,
  '-c',
  'user.name=test',
  '-c',
  'user.email=test@example.invalid',
  'commit',
  '--allow-empty',
  '-qm',
  'init',
]);
const sibling = join(root, 'worktree');
execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', sibling], { stdio: 'ignore' });
const other = join(root, 'other');
mkdirSync(other);

test('topic filenames round-trip through write, listing, index, search, injection and forget', () => {
  const names = ['a', 'topic.md', 'topic.with.dots', 'Mixed-case_42'];
  for (const name of names) writeMemory(other, { name, content: `Unique content for ${name}` });
  assert.deepEqual(
    listMemory(other)
      .map((record) => record.name)
      .sort(),
    [...names].sort(),
  );
  for (const name of names) {
    assert.match(readMemory(other, name), /Unique content/);
    assert.ok(readMemory(other).includes(`topics/${name}.md`));
    assert.deepEqual(searchMemory(other, `Unique content for ${name}`), [`${name}.md`]);
    assert.ok(injectMemory(other, { topics: [name] }).included.includes(`project/${name}`));
    forgetMemory(other, name);
  }
  assert.equal(listMemory(other).length, 0);
});

test('canonical Git roots share project memory across worktrees; two projects and non-Git paths are isolated', () => {
  assert.equal(projectIdentity(repo).projectId, projectIdentity(sibling).projectId);
  assert.notEqual(projectIdentity(repo).worktreeId, projectIdentity(sibling).worktreeId);
  assert.notEqual(projectIdentity(repo).projectId, projectIdentity(other).projectId);
  writeMemory(repo, {
    name: 'shared',
    description: 'A shared decision',
    type: 'decision',
    content: 'Use durable events',
  });
  assert.match(readMemory(sibling, 'shared'), /durable events/);
  assert.equal(listMemory(other).length, 0);
  const third = join(root, 'third');
  mkdirSync(third);
  assert.notEqual(projectIdentity(other).projectId, projectIdentity(third).projectId);
});

test('user, worktree, session and role scopes require explicit identities and never appear in project injection', () => {
  for (const options of [
    { scope: 'user' },
    { scope: 'worktree' },
    { scope: 'session', session: 's1' },
    { scope: 'role', role: 'reviewer' },
  ])
    writeMemory(repo, { name: 'private-topic', content: `scope ${options.scope}` }, options);
  assert.throws(() => memoryPaths(repo, { scope: 'session' }), /session/);
  assert.throws(() => memoryPaths(repo, { scope: 'role' }), /role/);
  assert.equal(listMemory(sibling, { scope: 'worktree' }).length, 0);
  assert.equal(listMemory(repo, { scope: 'session', session: 's2' }).length, 0);
  assert.equal(listMemory(repo, { scope: 'role', role: 'writer' }).length, 0);
  assert.equal(injectMemory(repo).content.includes('private-topic'), false);
  assert.throws(() => injectMemory(repo, { scopes: ['user'] }), /includePrivate/);
  assert.match(
    injectMemory(other, { scopes: ['user'], includePrivate: true, topics: ['private-topic'] })
      .content,
    /scope user/,
  );
});

test('frontmatter remains valid for YAML punctuation, preserves provenance and detects stale topics', () => {
  const written = writeMemory(other, {
    name: 'stale',
    description: 'Colon: quoted # text',
    content: 'Verify before reuse',
    at: '2000-01-01T00:00:00.000Z',
    ttlDays: 1,
    provenance: { source: 'issue', author: 'reviewer', reference: 'https://example.invalid/1' },
  });
  assert.equal(written.stale, true);
  const listed = listMemory(other);
  assert.equal(listed[0].metadata.provenance.source, 'issue');
  assert.equal(listed[0].stale, true);
  assert.match(injectMemory(other, { topics: ['stale'] }).warnings[0], /Stale memory/);
  assert.equal(doctorMemory(other).ok, true);
});

test('expected hashes protect put and forget, including explicit create-only writes', () => {
  const first = writeMemory(other, { name: 'conflict', content: 'one', expectedHash: null });
  assert.throws(
    () => writeMemory(other, { name: 'conflict', content: 'two', expectedHash: null }),
    /memory_conflict/,
  );
  assert.throws(
    () => writeMemory(other, { name: 'conflict', content: 'two', expectedHash: 'stale' }),
    /memory_conflict/,
  );
  const next = writeMemory(other, { name: 'conflict', content: 'two', expectedHash: first.hash });
  assert.throws(
    () => forgetMemory(other, 'conflict', { expectedHash: first.hash }),
    /memory_conflict/,
  );
  forgetMemory(other, 'conflict', { expectedHash: next.hash });
  assert.equal(
    listMemory(other).some((r) => r.name === 'conflict'),
    false,
  );
});

test(
  'traversal, null byte, symlink and hardlink attacks cannot touch external files',
  { skip: process.platform === 'win32' },
  () => {
    const target = join(root, 'attack');
    mkdirSync(target);
    const p = memoryPaths(target);
    initMemory(target);
    const outside = join(root, 'outside.md');
    writeFileSync(outside, 'untouched');
    for (const name of ['../outside', '..', 'x/../../y', 'a\0b', '/absolute'])
      assert.throws(() => writeMemory(target, { name, content: 'attack' }), /filename/);
    symlinkSync(outside, join(p.topics, 'symlink.md'));
    assert.throws(() => writeMemory(target, { name: 'symlink', content: 'attack' }), /Symlinks/);
    assert.throws(() => readMemory(target, 'symlink'), /Symlinks/);
    linkSync(outside, join(p.topics, 'hardlink.md'));
    assert.throws(() => readMemory(target, 'hardlink'), /Hardlinked/);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    const parent = join(root, 'parent-attack');
    mkdirSync(parent);
    const p2 = memoryPaths(parent);
    mkdirSync(join(p2.dir, '..'), { recursive: true });
    symlinkSync(root, p2.dir);
    assert.throws(() => initMemory(parent), /Symlinks/);
  },
);

test('shared memory rejects credentials and transcripts without leaving records', () => {
  for (const content of [
    'api_key: live-secret-value',
    'User: hi\nAssistant: response',
    '[{"role":"user","content":"raw history"}]',
  ])
    assert.throws(() => writeMemory(other, { name: 'unsafe', content }), /Credentials|transcripts/);
  assert.equal(existsSync(join(memoryPaths(other).topics, 'unsafe.md')), false);
});

test('stale dead-owner locks recover, while old live-owner locks remain protected', () => {
  const dir = join(root, 'locks');
  mkdirSync(dir);
  const dead = join(dir, '.dead');
  mkdirSync(dead);
  writeFileSync(
    join(dead, 'owner.json'),
    JSON.stringify({ pid: 99999999, host: hostname(), token: 'old' }),
  );
  utimesSync(dead, 0, 0);
  const release = lockDir(dead, { root: dir, staleMs: 1 });
  release();
  assert.equal(existsSync(dead), false);
  const live = join(dir, '.live');
  mkdirSync(live);
  writeFileSync(
    join(live, 'owner.json'),
    JSON.stringify({ pid: process.pid, host: hostname(), token: 'live' }),
  );
  utimesSync(live, 0, 0);
  assert.throws(() => lockDir(live, { root: dir, staleMs: 1, timeoutMs: 20 }), /held by another/);
  assert.ok(existsSync(live));
});

test('concurrent processes serialize distinct writes and rebuild one consistent index', async () => {
  const target = join(root, 'concurrent');
  mkdirSync(target);
  initMemory(target);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'lib', 'memory.mjs')).href;
  const launch = (i) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import{writeMemory}from ${JSON.stringify(moduleUrl)};writeMemory(${JSON.stringify(target)},{name:'writer-${i}',content:'writer ${i}'});`,
        ],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let error = '';
      child.stderr.on('data', (c) => (error += c));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(error))));
    });
  await Promise.all(Array.from({ length: 8 }, (_, i) => launch(i)));
  assert.equal(listMemory(target).length, 8);
  assert.equal(doctorMemory(target).ok, true);
});

test('index rebuild is deterministic, line/byte capped, and injection never exceeds limits', () => {
  const target = join(root, 'caps');
  mkdirSync(target);
  for (let i = 0; i < 205; i += 1)
    writeMemory(target, {
      name: `topic-${String(i).padStart(3, '0')}`,
      description: 'D'.repeat(200),
      content: 'Useful fact',
    });
  const before = readMemory(target);
  const pointer = memoryPointer(target).uri;
  doctorMemory(target, { rebuild: true });
  assert.equal(readMemory(target), before);
  assert.equal(memoryPointer(target).uri, pointer);
  assert.ok(Buffer.byteLength(before) <= MEMORY_CAPS.indexBytes);
  assert.ok(before.split('\n').length <= MEMORY_CAPS.indexLines);
  assert.match(before, /Omitted topics:/);
  for (const record of listMemory(target)) {
    const parsed = parseMarkdown(readFileSync(record.file, 'utf8'));
    parsed.metadata.description = 'Short';
    writeFileSync(record.file, markdown(parsed.metadata, parsed.content));
  }
  assert.equal(doctorMemory(target, { rebuild: true }).ok, true);
  assert.ok(readMemory(target).split('\n').length <= MEMORY_CAPS.indexLines);
  assert.match(readMemory(target), /Omitted topics:/);
  const injected = injectMemory(target, {
    topics: ['topic-000', 'topic-204'],
    maxBytes: 512,
    maxLines: 10,
  });
  assert.ok(injected.bytes <= 512);
  assert.ok(injected.lines <= 10);
  assert.ok(injected.omitted.length > 0);
  assert.ok(injected.included.includes('project/pointer'));
  writeFileSync(memoryPaths(target).index, 'corrupt index');
  assert.equal(doctorMemory(target).ok, false);
  assert.equal(doctorMemory(target, { rebuild: true }).ok, true);
});
