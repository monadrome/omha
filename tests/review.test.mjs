import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp } from './helpers.mjs';
import { atomicWrite } from '../lib/storage.mjs';
import { hash, now, stateHome } from '../lib/core.mjs';
import { handoffPaths } from '../lib/handoff-protocol.mjs';
import { handoffStatus } from '../lib/terminal.mjs';
import {
  closeReview,
  detectReviewers,
  extractJson,
  mergeReview,
  prepareReview,
  reviewRecord,
  reviewStatus,
  startReview,
  tallyReview,
  validateReviewConfig,
  voteReview,
  waitReview,
} from '../lib/review.mjs';

const root = temp('omha-review-');
process.env.OMHA_HOME = join(root, 'state');
const repo = join(root, 'repo');
mkdirSync(repo);
const gitIn = (...args) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: repo,
  }).toString();
gitIn('init', '-q');
writeFileSync(join(repo, 'AGENTS.md'), 'rules\n');
writeFileSync(join(repo, 'a.txt'), 'one\n');
gitIn('add', '.');
gitIn('commit', '-qm', 'init');
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
gitIn('commit', '-qam', 'change a');

const disabled = Object.fromEntries(
  ['claude', 'codex', 'kimi', 'kiro', 'ocr'].map((name) => [name, { enabled: false }]),
);
const reviewConfig = (reviewers, extra = {}) =>
  validateReviewConfig({ reviewers: { ...disabled, ...reviewers }, ...extra });

function adapter() {
  const sessions = new Map();
  return {
    sessions,
    closed: [],
    async start(record) {
      sessions.set(record.id, { owner: record.owner.token, alive: true, output: 'starting' });
      return { ref: `fake-${record.id}`, pid: 4242 };
    },
    async verify(record) {
      assert.equal(sessions.get(record.id)?.owner, record.owner.token);
    },
    async alive(record) {
      return sessions.get(record.id).alive;
    },
    async capture(record) {
      return sessions.get(record.id).output;
    },
    async close(record) {
      this.closed.push(record.id);
      sessions.get(record.id).alive = false;
    },
  };
}

function finish(fake, handoffId, output, exitCode = 0) {
  const record = handoffStatus(handoffId);
  const path = handoffPaths(handoffId);
  fake.sessions.get(handoffId).output = output;
  atomicWrite(path.outputFile, output, stateHome());
  atomicWrite(
    path.finalFile,
    JSON.stringify({
      token: record.owner.token,
      state: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      responseHash: hash(output),
      at: now(),
    }),
    stateHome(),
  );
}

function fillContext(record) {
  const text = readFileSync(record.context, 'utf8').replaceAll('TODO(omha-review)', 'Filled');
  writeFileSync(record.context, text);
}

const always = () => true;

test('review config merges defaults, overrides and rejects unsafe entries', () => {
  const config = validateReviewConfig({
    reviewers: { claude: { model: 'opus' }, ocr: { enabled: false } },
  });
  assert.equal(config.waitMs, 51 * 60 * 1000);
  assert.equal(config.backend, 'auto');
  assert.equal(config.reviewers.claude.model, 'opus');
  assert.equal(config.reviewers.ocr.enabled, false);
  assert.deepEqual(config.reviewers.kimi.models, ['kimi-code/k3.1', 'kimi-code/k3.1-pro']);
  const pinned = validateReviewConfig({ reviewers: { kimi: { model: 'kimi-code/k3' } } });
  assert.equal(pinned.reviewers.kimi.model, 'kimi-code/k3');
  assert.equal(pinned.reviewers.kimi.models, undefined);
  assert.throws(
    () =>
      validateReviewConfig({ reviewers: { x: { command: 'x', args: [], env: { API_KEY: 'v' } } } }),
    /credentials/,
  );
  assert.throws(
    () => validateReviewConfig({ reviewers: { x: { command: 'x', args: ['--api-key', 'abc'] } } }),
    /Credentials/,
  );
  assert.throws(
    () =>
      validateReviewConfig({
        reviewers: { x: { command: 'x', args: [], model: 'a', models: ['b'] } },
      }),
    /model or models/,
  );
  assert.throws(() => validateReviewConfig({ voters: ['missing'] }), /Unknown or disabled voter/);
  assert.throws(() => validateReviewConfig({ waitMs: 5000, hardTimeoutMs: 1000 }), /hardTimeoutMs/);
});

test('detection skips missing commands and unconfigured Kimi models', () => {
  const config = validateReviewConfig({ reviewers: { ocr: { enabled: false } } });
  const found = detectReviewers(config, {
    commandExists: (command) => command !== 'kiro-cli',
    kimiModels: () => ['kimi-code/k3', 'kimi-code/k3.1-pro'],
  });
  const by = Object.fromEntries(found.map((x) => [x.name, x]));
  assert.equal(by.kiro.available, false);
  assert.equal(by.kiro.reason, 'command not found');
  assert.equal(by.kimi.available, true);
  assert.equal(by.kimi.model, 'kimi-code/k3.1-pro');
  assert.equal(by.ocr.reason, 'disabled');
  const none = detectReviewers(config, {
    commandExists: always,
    kimiModels: () => ['kimi-code/k3'],
  });
  assert.match(none.find((x) => x.name === 'kimi').reason, /none of kimi-code\/k3.1/);
  const unknown = detectReviewers(config, { commandExists: always, kimiModels: () => null });
  assert.equal(unknown.find((x) => x.name === 'kimi').model, 'kimi-code/k3.1');
});

test('extractJson tolerates fenced blocks and trailing text', () => {
  assert.deepEqual(extractJson('noise ```json\n{"findings":[]}\n``` done', 'findings'), {
    findings: [],
  });
  assert.deepEqual(extractJson('x {"votes":[{"id":"D1"}]} trailing', 'votes'), {
    votes: [{ id: 'D1' }],
  });
  assert.equal(extractJson('{"other":1}', 'findings'), null);
});

test('review lifecycle: launch, observe, wait without cancelling, merge, vote and close', async () => {
  const record = await prepareReview(repo, { commit: 'HEAD' });
  assert.equal(record.mode, 'commit');
  assert.match(readFileSync(record.diff, 'utf8'), /\+two/);
  assert.match(readFileSync(record.context, 'utf8'), /AGENTS\.md/);
  const fake = adapter();
  const config = reviewConfig(
    {
      alpha: {
        command: 'rev-alpha',
        args: ['--model-flag', '{model_args}', '{prompt}'],
        modelArgs: ['-m', '{model}'],
        model: 'm1',
      },
      beta: { command: 'rev-beta', args: ['-p'], env: { HTTPS_PROXY: 'http://127.0.0.1:9' } },
      gamma: { command: 'rev-gamma', args: [] },
      scan: { command: 'rev-scan', role: 'static', args: ['{range_args}', '-o', '{out}'] },
    },
    { waitMs: 1000, stallMs: 1000 },
  );
  const options = {
    reviewConfig: config,
    commandExists: always,
    backend: 'fake',
    backendAdapter: fake,
  };
  await assert.rejects(startReview(record.id, options), /Complete every TODO\(omha-review\)/);
  fillContext(record);
  const started = await startReview(record.id, options);
  assert.deepEqual(
    started.launched.map((x) => x.name),
    ['alpha', 'beta', 'gamma', 'scan'],
  );
  const jobs = reviewRecord(record.id).jobs.review;
  const alpha = handoffStatus(jobs.alpha.handoffId);
  assert.equal(alpha.args[0], '--model-flag');
  assert.deepEqual(alpha.args.slice(1, 3), ['-m', 'm1']);
  assert.match(alpha.args[3], /independent code reviewer "alpha"/);
  assert.equal(alpha.interactive, false);
  const beta = handoffStatus(jobs.beta.handoffId);
  assert.equal(beta.command, 'env');
  assert.deepEqual(beta.args.slice(0, 2), ['HTTPS_PROXY=http://127.0.0.1:9', 'rev-beta']);
  assert.ok(beta.envAllowlist.includes('HTTPS_PROXY'));
  const scan = handoffStatus(jobs.scan.handoffId);
  assert.deepEqual(scan.args.slice(0, 2), ['--commit', record.head]);

  const again = await startReview(record.id, { ...options, reviewers: ['alpha'] });
  assert.equal(again.launched.length, 0);
  assert.match(again.skipped[0].reason, /already running/);

  writeFileSync(
    jobs.alpha.out,
    JSON.stringify({
      findings: [{ file: 'a.txt', line: 2, severity: 'high', title: 'Alpha issue' }],
    }),
  );
  finish(fake, jobs.alpha.handoffId, 'reviewed');
  finish(
    fake,
    jobs.beta.handoffId,
    'log\n```json\n{"findings":[{"file":"a.txt","line":3,"severity":"P2","title":"Beta issue"}]}\n```\n',
  );
  writeFileSync(jobs.scan.out, JSON.stringify({ comments: [] }));
  finish(fake, jobs.scan.handoffId, 'scan done');

  let status = await reviewStatus(record.id, { backendAdapter: fake });
  const view = Object.fromEntries(status.reviewers.map((x) => [x.name, x]));
  assert.equal(view.alpha.view, 'done');
  assert.equal(view.alpha.outputSource, 'file');
  assert.equal(view.beta.outputSource, 'output');
  assert.equal(view.gamma.view, 'running');
  assert.equal(view.gamma.alive, true);
  assert.equal(status.worktreeTampered, false);

  const waited = await waitReview(record.id, { backendAdapter: fake, intervalMs: 50 });
  assert.equal(waited.outcome, 'deadline');
  assert.deepEqual(waited.stillRunning, ['gamma']);
  assert.equal(handoffStatus(jobs.gamma.handoffId).state, 'running');
  assert.deepEqual(fake.closed, [], 'deadline must not close running reviewers');
  await new Promise((done) => setTimeout(done, 1100));
  status = await reviewStatus(record.id, { backendAdapter: fake });
  assert.equal(status.reviewers.find((x) => x.name === 'gamma').view, 'stalled');
  fake.sessions.get(jobs.gamma.handoffId).output = 'new progress';
  status = await reviewStatus(record.id, { backendAdapter: fake });
  assert.equal(status.reviewers.find((x) => x.name === 'gamma').view, 'running');

  const merged = mergeReview(record.id);
  assert.deepEqual(merged.sources, { alpha: 1, beta: 1, gamma: 'pending', scan: 0 });
  assert.equal(merged.clusters, 1, 'nearby lines in one file share a cluster');
  assert.match(readFileSync(merged.findings, 'utf8'), /\[P1\] a\.txt:2,3 reviewers=alpha\+beta/);

  await assert.rejects(closeReview(record.id), /still running: review:gamma/);

  const disputed = [
    { id: 'D1', title: 'one', claim: 'c', counter: 'k', proposed_fix: 'f' },
    { id: 'D2', title: 'two', claim: 'c', counter: 'k', proposed_fix: 'f' },
  ];
  await assert.rejects(
    voteReview(record.id, disputed, { ...options, reviewers: ['alpha'] }),
    /at least two voters/,
  );
  assert.deepEqual(reviewRecord(record.id).jobs.vote, {}, 'a rejected vote launches nobody');
  const votes = await voteReview(record.id, disputed, {
    ...options,
    reviewers: ['alpha', 'beta', 'gamma', 'scan'],
  });
  assert.deepEqual(
    votes.launched.map((x) => x.name),
    ['alpha', 'beta', 'gamma'],
  );
  assert.equal(votes.skipped.find((x) => x.name === 'scan').reason, 'reviewer cannot vote');
  const voteJobs = reviewRecord(record.id).jobs.vote;
  writeFileSync(
    voteJobs.beta.out,
    JSON.stringify({
      votes: [
        { id: 'D1', verdict: 'fix' },
        { id: 'D2', verdict: 'no_fix' },
      ],
    }),
  );
  let tally = tallyReview(record.id);
  assert.deepEqual(tally.pendingVoters, ['alpha', 'gamma']);
  assert.equal(tally.items[0].decision, 'no_fix', 'one ballot is not a majority');
  writeFileSync(
    voteJobs.gamma.out,
    JSON.stringify({
      votes: [
        { id: 'D1', verdict: 'fix' },
        { id: 'D2', verdict: 'fix' },
      ],
    }),
  );
  tally = tallyReview(record.id);
  assert.equal(tally.items[0].decision, 'fix');
  assert.equal(tally.items[1].decision, 'no_fix', 'a 1:1 tie does not fix');
  assert.deepEqual(tally.pendingVoters, ['alpha']);
  assert.equal(
    (await reviewStatus(record.id, { kind: 'vote', backendAdapter: fake })).reviewers.length,
    3,
  );

  const closed = await closeReview(record.id, { force: true, backendAdapter: fake });
  assert.equal(closed.state, 'closed');
  assert.ok(!gitIn('worktree', 'list').includes(record.id));
  assert.equal(gitIn('for-each-ref', 'refs/omha-review').trim(), '');
});

test('backend order falls back from cmux to tmux to a file handoff', async () => {
  const failing = {
    async start() {
      throw new Error('unavailable');
    },
  };
  const ok = adapter();
  const config = reviewConfig({ solo: { command: 'rev-solo', args: [] } });
  const first = await prepareReview(repo, { base: 'HEAD~1' });
  fillContext(first);
  const tmuxRun = await startReview(first.id, {
    reviewConfig: config,
    commandExists: always,
    backends: { cmux: failing, tmux: ok },
  });
  assert.equal(tmuxRun.launched[0].backend, 'tmux');
  const attempts = reviewRecord(first.id).jobs.review.solo.launchAttempts;
  assert.deepEqual(
    attempts.map((x) => [x.backend, x.state]),
    [
      ['cmux', 'failed'],
      ['tmux', 'running'],
    ],
  );

  const second = await prepareReview(repo, { working: true });
  fillContext(second);
  const fileRun = await startReview(second.id, {
    reviewConfig: config,
    commandExists: always,
    backends: { cmux: failing, tmux: failing },
  });
  assert.equal(fileRun.launched[0].backend, 'file');
  const status = await reviewStatus(second.id);
  assert.equal(status.reviewers[0].view, 'awaiting_handoff');
  assert.match(status.reviewers[0].resumeCommand, /'rev-solo' < '.*prompt\.md'/);
  const waited = await waitReview(second.id, { intervalMs: 10 });
  assert.equal(waited.outcome, 'handoff_pending');
});
