import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      validateReviewConfig({
        reviewers: { x: { command: 'x', args: [], env: { ['API' + '_KEY']: 'v' } } },
      }),
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

  await assert.rejects(
    closeReview(record.id, { backendAdapter: fake }),
    /still running: review:gamma/,
  );

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

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

test('prepare rejects credential-bearing inputs and leaves no ref, worktree or state', async () => {
  const reviewWorktrees = () =>
    gitIn('worktree', 'list')
      .split('\n')
      .filter((line) => line.includes('/reviews/'));
  const before = reviewWorktrees();
  const refsBefore = gitIn('for-each-ref', 'refs/omha-review');
  writeFileSync(join(repo, 'leak.txt'), `key=${'sk-' + 'x'.repeat(24)}\n`);
  gitIn('add', 'leak.txt');
  gitIn('commit', '-qm', 'leak');
  await assert.rejects(prepareReview(repo, { commit: 'HEAD', id: 'review-leak' }), /Credentials/);
  assert.deepEqual(reviewWorktrees(), before);
  assert.equal(gitIn('for-each-ref', 'refs/omha-review'), refsBefore);
  assert.equal(existsSync(join(stateHome(), 'reviews', 'review-leak')), false);
  gitIn('rm', '-q', 'leak.txt');
  gitIn('commit', '-qm', 'remove leak');
  await assert.rejects(
    prepareReview(repo, { commit: 'HEAD' }),
    /Credentials/,
    'removed lines count',
  );
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  gitIn('commit', '-qam', 'clean change');
  const record = await prepareReview(repo, { commit: 'HEAD' });
  fillContext(record);
  writeFileSync(record.context, `${readFileSync(record.context, 'utf8')}\npassword=hunter22\n`);
  await assert.rejects(
    startReview(record.id, {
      reviewConfig: reviewConfig({ solo: { command: 'rev-solo', args: [] } }),
      commandExists: always,
      backend: 'fake',
      backendAdapter: adapter(),
    }),
    /Credentials/,
  );
  assert.deepEqual(reviewRecord(record.id).jobs.review, {});
});

test('explicit redact secret policy freezes sanitized inputs and still screens the context', async () => {
  const token = 'sk-' + 'y'.repeat(24);
  writeFileSync(join(repo, 'fixture.txt'), `api_key=${token}\n`);
  gitIn('add', 'fixture.txt');
  gitIn('commit', '-qm', `fixture with ${token}`);
  await assert.rejects(prepareReview(repo, { commit: 'HEAD' }), /Credentials/, 'reject by default');
  await assert.rejects(
    prepareReview(repo, { commit: 'HEAD', secretPolicy: 'allow' }),
    /secret policy must be one of reject, redact/,
  );
  const record = await prepareReview(repo, { commit: 'HEAD', secretPolicy: 'redact' });
  assert.equal(record.secretPolicy, 'redact');
  assert.ok(record.redactions >= 2, 'diff and commit message are both redacted');
  for (const file of [record.diff, record.context]) {
    const body = readFileSync(file, 'utf8');
    assert.equal(body.includes(token), false);
    assert.match(body, /\[REDACTED\]/);
  }
  const events = readFileSync(join(record.dir, 'events.jsonl'), 'utf8');
  assert.match(events, /"secretPolicy":"redact"/);
  assert.equal(events.includes(token), false);
  fillContext(record);
  const options = {
    reviewConfig: reviewConfig({ solo: { command: 'rev-solo', args: [] } }),
    commandExists: always,
    backend: 'fake',
    backendAdapter: adapter(),
  };
  const clean = readFileSync(record.context, 'utf8');
  writeFileSync(record.context, `${clean}\npassword=hunter22\n`);
  await assert.rejects(startReview(record.id, options), /Credentials/, 'context stays fail-closed');
  writeFileSync(record.context, clean);
  const started = await startReview(record.id, options);
  assert.deepEqual(
    started.launched.map((x) => x.name),
    ['solo'],
  );
  gitIn('rm', '-q', 'fixture.txt');
  gitIn('commit', '-qm', 'drop fixture');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nfour\n');
  gitIn('commit', '-qam', 'clean change after fixture');
});

test('hardening: wait budget, relaunch history, concurrency, integrity, malformed output and close', async () => {
  const fake = adapter();
  const config = reviewConfig(
    {
      alpha: { command: 'rev-alpha', args: [] },
      beta: { command: 'rev-beta', args: [] },
    },
    { waitMs: 60000 },
  );
  const options = {
    reviewConfig: config,
    commandExists: always,
    backend: 'fake',
    backendAdapter: fake,
  };
  const record = await prepareReview(repo, { commit: 'HEAD' });
  fillContext(record);
  for (const waitMs of [Number.NaN, Infinity, 0, -5])
    await assert.rejects(startReview(record.id, { ...options, waitMs }), /review waitMs/);
  assert.deepEqual(reviewRecord(record.id).jobs.review, {}, 'invalid budgets launch nobody');

  await startReview(record.id, { ...options, reviewers: ['alpha'] });
  const first = reviewRecord(record.id).jobs.review.alpha;

  // A status call observing an old snapshot must not erase a job launched meanwhile.
  let release;
  const gate = new Promise((done) => (release = done));
  const slow = {
    ...fake,
    async capture(handoffRecord) {
      await gate;
      return fake.capture(handoffRecord);
    },
  };
  const observing = reviewStatus(record.id, { backendAdapter: slow });
  await pause(50);
  await startReview(record.id, { ...options, reviewers: ['beta'] });
  release();
  await observing;
  assert.ok(reviewRecord(record.id).jobs.review.beta, 'concurrent launch survives status');

  // Malformed payloads are not clean zero-finding reviews.
  writeFileSync(first.out, JSON.stringify({ findings: 'none' }));
  finish(fake, first.handoffId, 'no json here');
  let status = await reviewStatus(record.id, { backendAdapter: fake });
  const alpha = status.reviewers.find((x) => x.name === 'alpha');
  assert.equal(alpha.output, false);
  assert.equal(alpha.malformedOutput, true);
  assert.equal(mergeReview(record.id).sources.alpha, 'malformed');

  // Relaunching keeps the superseded handoff in history and closes it.
  await startReview(record.id, { ...options, reviewers: ['alpha'] });
  const latest = reviewRecord(record.id);
  assert.notEqual(latest.jobs.review.alpha.handoffId, first.handoffId);
  assert.equal(latest.history[0].handoffId, first.handoffId);
  assert.equal(handoffStatus(first.handoffId).state, 'closed');
  assert.ok(existsSync(first.out.replace(/\.json$/, '.attempt-1.json')));
  const live = latest.jobs.review.alpha;
  await startReview(record.id, { ...options, reviewers: ['alpha'], force: true });
  assert.equal(handoffStatus(live.handoffId).state, 'closed', '--force retires the live handoff');

  // Integrity covers HEAD moves, not only dirty files.
  status = await reviewStatus(record.id, { backendAdapter: fake });
  assert.equal(status.worktreeTampered, false);
  execFileSync('git', ['checkout', '-q', '--detach', 'HEAD~1'], { cwd: record.worktree });
  status = await reviewStatus(record.id, { backendAdapter: fake });
  assert.equal(status.worktreeTampered, true);
  execFileSync('git', ['checkout', '-q', '--detach', record.head], { cwd: record.worktree });

  // Duplicate voters cannot satisfy the quorum, and rounds do not mix ballots.
  const items = [{ id: 'D1', title: 't', claim: 'c', counter: 'k', proposed_fix: 'f' }];
  await assert.rejects(
    voteReview(record.id, items, { ...options, reviewers: ['alpha', 'alpha'] }),
    /Duplicate voter name/,
  );
  await voteReview(record.id, items, { ...options, reviewers: ['alpha', 'beta'] });
  const round1 = reviewRecord(record.id).jobs.vote;
  for (const name of ['alpha', 'beta']) {
    writeFileSync(round1[name].out, JSON.stringify({ votes: [{ id: 'D1', verdict: 'fix' }] }));
    finish(fake, round1[name].handoffId, 'voted');
  }
  assert.equal(tallyReview(record.id).items[0].decision, 'fix');
  await assert.rejects(
    voteReview(record.id, items, { ...options, reviewers: ['alpha'] }),
    /at least two voters/,
  );
  await voteReview(record.id, [{ ...items[0], claim: 'different claim' }], {
    ...options,
    reviewers: ['alpha', 'beta'],
  });
  const tally = tallyReview(record.id);
  assert.equal(tally.round, 2);
  assert.equal(tally.items[0].decision, 'no_fix', 'round-1 ballots do not count in round 2');
  assert.deepEqual(tally.pendingVoters.sort(), ['alpha', 'beta']);
  await assert.rejects(
    voteReview(record.id, items, { ...options, reviewers: ['alpha', 'beta'] }),
    /still running/,
  );

  // Cleanup failures are reported and retryable instead of claiming closure.
  execFileSync('git', ['worktree', 'lock', record.worktree], { cwd: repo });
  await assert.rejects(
    closeReview(record.id, { force: true, backendAdapter: fake }),
    /retry close/,
  );
  assert.equal(reviewRecord(record.id).state, 'cleanup_failed');
  execFileSync('git', ['worktree', 'unlock', record.worktree], { cwd: repo });
  const closed = await closeReview(record.id, { force: true, backendAdapter: fake });
  assert.equal(closed.state, 'closed');
  for (const job of reviewRecord(record.id).history)
    assert.equal(handoffStatus(job.handoffId).state, 'closed');
});

test('an unreadable Kimi catalog falls back to the first preference', () => {
  const config = validateReviewConfig({});
  const kimi = detectReviewers(config, {
    commandExists: always,
    kimiModels: () => {
      throw new Error('EACCES');
    },
  }).find((x) => x.name === 'kimi');
  assert.equal(kimi.available, true);
  assert.equal(kimi.model, 'kimi-code/k3.1');
  assert.match(kimi.note, /unreadable: EACCES/);
});
