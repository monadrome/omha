// Offline CLI coverage for every `omha review` path referenced by the
// multi-review skill. File handoffs start no process and call no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.mjs';

const bin = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const root = temp('omha-review-cli-');
const repo = join(root, 'repo');
const tools = join(root, 'bin');
mkdirSync(repo);
mkdirSync(tools);
const env = {
  ...process.env,
  OMHA_HOME: join(root, 'state'),
  PATH: `${tools}:${process.env.PATH}`,
};
for (const name of ['rev-one', 'rev-two']) {
  writeFileSync(join(tools, name), '#!/bin/sh\nexit 0\n');
  chmodSync(join(tools, name), 0o755);
}
const git = (...args) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: repo,
  }).toString();
git('init', '-q');
writeFileSync(join(repo, 'a.txt'), 'one\n');
git('add', '.');
git('commit', '-qm', 'init');
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
git('commit', '-qam', 'change');
mkdirSync(join(repo, '.omha'));
const builtins = Object.fromEntries(
  ['claude', 'codex', 'kimi', 'kiro', 'ocr'].map((name) => [name, { enabled: false }]),
);
writeFileSync(
  join(repo, '.omha', 'review.json'),
  JSON.stringify({
    version: 1,
    backend: 'file',
    reviewers: {
      ...builtins,
      one: { command: 'rev-one', args: [] },
      two: { command: 'rev-two', args: [] },
    },
  }),
);

function omha(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: repo, env, encoding: 'utf8' });
  let body = null;
  try {
    body = JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  } catch {
    /* keep raw output for the assertion message */
  }
  return { code: result.status, body, raw: result.stdout + result.stderr };
}
function ok(...args) {
  const result = omha(...args);
  assert.equal(result.code, 0, result.raw);
  return result.body;
}
function fails(pattern, ...args) {
  const result = omha(...args);
  assert.equal(result.code, 1, result.raw);
  assert.match(result.body.error.message, pattern);
  return result.body;
}
const complete = (handoffId) => ok('handoff', 'complete', '--id', handoffId, '--exit-code', '0');

test('review CLI covers detect, prepare, start, status, wait, merge, vote, tally and close', () => {
  const detected = ok('review', 'detect').reviewers;
  assert.deepEqual(
    detected.filter((x) => x.available).map((x) => x.name),
    ['one', 'two'],
  );

  fails(/exactly one target/, 'review', 'prepare');
  fails(
    /secret policy must be one of/,
    'review',
    'prepare',
    '--commit',
    'HEAD',
    '--secret-policy',
    'off',
  );
  const prepared = ok('review', 'prepare', '--commit', 'HEAD');
  const id = prepared.id;
  fails(/Complete every TODO\(omha-review\)/, 'review', 'start', '--id', id);
  writeFileSync(
    prepared.context,
    readFileSync(prepared.context, 'utf8').replaceAll('TODO(omha-review)', 'Filled'),
  );
  for (const value of ['abc', 'Infinity', '0', '-1'])
    fails(/review waitMs/, 'review', 'start', '--id', id, '--wait-ms', value);
  assert.deepEqual(
    ok('review', 'status', '--id', id).reviewers,
    [],
    'invalid budgets launch nobody',
  );
  fails(/Duplicate reviewer name/, 'review', 'start', '--id', id, '--reviewers', 'one,one');

  const started = ok('review', 'start', '--id', id, '--backend', 'file');
  assert.deepEqual(
    started.launched.map((x) => [x.name, x.backend, x.state]),
    [
      ['one', 'file', 'awaiting'],
      ['two', 'file', 'awaiting'],
    ],
  );
  const status = ok('review', 'status', '--id', id);
  assert.deepEqual(
    status.reviewers.map((x) => x.view),
    ['awaiting_handoff', 'awaiting_handoff'],
  );
  assert.match(status.reviewers[0].resumeCommand, /'rev-one' < /);
  assert.equal(ok('review', 'wait', '--id', id, '--max-ms', '0').outcome, 'handoff_pending');
  assert.equal(ok('review', 'list')[0].id, id);

  const jobs = JSON.parse(readFileSync(join(root, 'state', 'reviews', id, 'review.json'), 'utf8'))
    .jobs.review;
  writeFileSync(
    jobs.one.out,
    JSON.stringify({ findings: [{ file: 'a.txt', line: 2, severity: 'P1', title: 'Issue' }] }),
  );
  complete(jobs.one.handoffId);
  complete(jobs.two.handoffId);
  assert.equal(ok('review', 'wait', '--id', id, '--max-ms', '0').outcome, 'finished');
  assert.deepEqual(ok('review', 'merge', '--id', id).sources, { one: 1, two: 'missing' });

  const disputed = join(root, 'disputed.json');
  writeFileSync(
    disputed,
    JSON.stringify([{ id: 'D1', title: 'Issue', claim: 'c', counter: 'k', proposed_fix: 'f' }]),
  );
  fails(
    /Duplicate voter name/,
    'review',
    'vote',
    '--id',
    id,
    '--input',
    disputed,
    '--voters',
    'one,one',
  );
  fails(
    /at least two voters/,
    'review',
    'vote',
    '--id',
    id,
    '--input',
    disputed,
    '--voters',
    'one',
  );
  const vote = ok('review', 'vote', '--id', id, '--input', disputed, '--backend', 'file');
  assert.equal(vote.round, 1);
  assert.deepEqual(
    vote.launched.map((x) => x.name),
    ['one', 'two'],
  );
  fails(/still running/, 'review', 'vote', '--id', id, '--input', disputed);
  const voters = JSON.parse(readFileSync(join(root, 'state', 'reviews', id, 'review.json'), 'utf8'))
    .jobs.vote;
  for (const name of ['one', 'two']) {
    writeFileSync(voters[name].out, JSON.stringify({ votes: [{ id: 'D1', verdict: 'fix' }] }));
    complete(voters[name].handoffId);
  }
  assert.equal(ok('review', 'status', '--id', id, '--kind', 'vote').round, 1);
  const tally = ok('review', 'tally', '--id', id);
  assert.equal(tally.items[0].decision, 'fix');
  assert.equal(tally.items[0].fixVotes, 2);

  const closed = ok('review', 'close', '--id', id);
  assert.equal(closed.state, 'closed');
  assert.equal(existsSync(prepared.worktree), false);
  assert.equal(git('for-each-ref', 'refs/omha-review').trim(), '');
  fails(/Review is closed/, 'review', 'start', '--id', id);
  fails(/Unknown review command/, 'review', 'bogus', '--id', id);
});
