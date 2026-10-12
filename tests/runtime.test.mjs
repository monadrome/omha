import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { parseOutput, invocation } from '../lib/adapters.mjs';
import { classify, retryAfter, retryAfterFromText } from '../lib/failures.mjs';
import { loadConfig, validateProfiles } from '../lib/profiles.mjs';
import { run } from '../lib/process.mjs';

const root = temp();
process.env.OMHA_HOME = join(root, 'state');
const local = (profiles, opts = {}) =>
  createRuntime(config(profiles), { persistent: false, ...opts });

test('strict configuration catches malformed, unknown, unsafe and cyclic profiles', () => {
  assert.throws(() => validateProfiles(config({ p: fake('ok', { timeoutMs: NaN }) })), /timeoutMs/);
  assert.throws(() => validateProfiles(config({ p: fake('ok', { typo: true }) })), /unknown field/);
  assert.throws(
    () => validateProfiles(config({ p: fake('ok', { fallback: ['missing'] }) })),
    /Unknown fallback/,
  );
  assert.throws(
    () =>
      validateProfiles(
        config({ p: fake('ok', { fallback: ['q'] }), q: fake('ok', { fallback: ['p'] }) }),
      ),
    /cycle/,
  );
  const file = join(root, 'bad.json');
  writeFileSync(file, '{');
  assert.throws(() => loadConfig(root, file), /Malformed/);
  assert.throws(
    () =>
      validateProfiles(
        config({
          p: fake('ok', {
            adapter: 'command',
            command: '/bin/sh',
            args: ['--api-key', 'raw-secret'],
          }),
        }),
      ),
    /Credentials/,
  );
});

test('adapters require completed, valid JSON/JSONL and extract provenance', () => {
  const claude = parseOutput(
    'claude',
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'answer',
      session_id: 'r1',
      modelUsage: { 'actual-model': {} },
      usage: { input_tokens: 2, output_tokens: 4 },
    }),
  );
  assert.equal(claude.servedModel, 'actual-model');
  assert.equal(claude.requestId, 'r1');
  const codex = parseOutput(
    'codex',
    [
      { type: 'thread.started', thread_id: 'r2' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n'),
  );
  assert.equal(codex.output, 'done');
  assert.equal(codex.requestId, 'r2');
  assert.equal(
    parseOutput('kimi', '{"role":"assistant","content":[{"type":"text","text":"yes"}]}').output,
    'yes',
  );
  for (const value of [
    '{bad}',
    '{"type":"turn.completed"}\ntrash',
    '{"type":"item.completed","item":{"type":"agent_message","text":"unfinished"}}',
  ])
    assert.throws(() => parseOutput('codex', value));
  assert.throws(() =>
    parseOutput('claude', '{"type":"result","subtype":"error_max_turns","result":"partial"}'),
  );
  assert.throws(() => parseOutput('command', '{"output":"unverified"}', 'json'));
});

test('failure taxonomy and Retry-After seconds/HTTP dates', () => {
  const cases = [
    ['429 too many requests', 'rate_limit'],
    ['503 capacity', 'capacity'],
    ['401 authentication', 'auth'],
    ['ECONNRESET', 'transport'],
    ['unknown model', 'configuration'],
    ['test failed', 'task'],
  ];
  for (const [stderr, kind] of cases) assert.equal(classify({ code: 1, stderr }).kind, kind);
  assert.equal(classify({ timedOut: true }).kind, 'timeout');
  assert.equal(classify({ cancelled: true }).kind, 'cancellation');
  assert.equal(classify({ spawnError: { code: 'ENOENT' } }).kind, 'spawn');
  assert.equal(retryAfter('1.5'), 1500);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000);
  assert.equal(retryAfter('bad'), null);
  assert.equal(retryAfterFromText('{"error":{"headers":{"Retry-After":"2"}}}'), 2000);
});

test('bounded retry, fallback and served model accounting are explicit', async () => {
  const runtime = local({
    p: fake('', {
      responses: [
        { failure: 'rate_limit', stderr: '429' },
        { failure: 'capacity', stderr: '503' },
      ],
      retry: { maxRetries: 1, baseMs: 1, maxMs: 2, jitter: 0 },
    }),
    q: fake('fallback', {
      responses: [
        {
          output: 'fallback',
          model: 'actual',
          requestId: 'request-17',
          usage: { tokens: 12, costUsd: 0 },
        },
      ],
    }),
  });
  const result = await runtime.dispatch('prompt', ['p', 'q']);
  assert.equal(result.ok, true);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.requestedModel, 'local-test');
  assert.equal(result.servedModel, 'actual');
  assert.equal(result.servedProfile, 'q');
  assert.equal(result.requestId, 'request-17');
  assert.equal(result.budget.account.requests, 3);
  assert.equal(result.budget.account.tokens, 32);
  assert.match(result.responseHash, /^[a-f0-9]{64}$/);
});

test('task, malformed output, auth and configuration failures never fall back', async () => {
  for (const failure of ['task', 'auth', 'configuration']) {
    const result = await local({ p: fake('', { responses: [{ failure }] }), q: fake() }).dispatch(
      'prompt',
      ['p', 'q'],
    );
    assert.equal(result.failure, failure);
    assert.equal(result.attempts.length, 1);
  }
  const runtime = local({
    p: fake('', { outputFormat: 'json', responses: [{ stdout: '{bad}' }] }),
    q: fake(),
  });
  const result = await runtime.dispatch('prompt', ['p', 'q']);
  assert.equal(result.failureStage, 'parse');
  assert.equal(result.attempts.length, 1);
});

test('circuit cooldown and long Retry-After prevent rapid repeated launches', async () => {
  let clock = 0;
  const runtime = local(
    {
      p: fake('', {
        responses: [{ failure: 'rate_limit', stderr: '429\nRetry-After: 90' }],
        circuit: { threshold: 1, cooldownMs: 100 },
      }),
      q: fake('ok'),
    },
    { clock: () => clock },
  );
  const first = await runtime.dispatch('p', ['p', 'q']);
  assert.equal(first.attempts[0].retryAfterMs, 90000);
  const next = await runtime.dispatch('p', ['p', 'q']);
  assert.equal(next.attempts[0].failure, 'circuit_open');
  assert.equal(runtime.fakeOffsets.get('p'), 1);
  clock = 90001;
  await runtime.dispatch('p', ['p', 'q']);
  assert.equal(runtime.fakeOffsets.get('p'), 2);
});

test('provider semaphore enforces concurrency and queued cancellation', async () => {
  const runtime = local({
    p: fake('done', { concurrency: 1, responses: [{ output: 'done', latencyMs: 70 }] }),
  });
  const controller = new AbortController();
  const a = runtime.dispatch('first', ['p']);
  const b = runtime.dispatch('second', ['p'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 15);
  assert.equal((await b).failure, 'cancellation');
  assert.equal((await a).ok, true);
  const start = Date.now();
  await Promise.all([runtime.dispatch('a', ['p']), runtime.dispatch('b', ['p'])]);
  assert.ok(Date.now() - start >= 130);
});

test('provider concurrency gate spans independent runtime instances and leaves no active lease', async () => {
  const first = createRuntime(
    config({ p: fake('done', { concurrency: 1, responses: [{ output: 'done', latencyMs: 80 }] }) }),
    { persistent: true },
  );
  const second = createRuntime(
    config({ p: fake('done', { concurrency: 1, responses: [{ output: 'done', latencyMs: 1 }] }) }),
    { persistent: true },
  );
  const started = Date.now();
  const a = first.dispatch('first', ['p']);
  const b = second.dispatch('second', ['p']);
  const [one, two] = await Promise.all([a, b]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.ok(Date.now() - started >= 70);
  const leases = second.localGates.get([...second.localGates.keys()][0]);
  assert.equal(leases?.active.length || 0, 0);
});

test('request and token budget reservations cap launches including failed attempts', async () => {
  const runtime = local(
    { p: fake() },
    { budget: { maxRequests: 1, maxTokens: 10, reserveTokens: 10, reserveCostUsd: 0 } },
  );
  assert.equal((await runtime.dispatch('one', ['p'])).ok, true);
  assert.equal((await runtime.dispatch('two', ['p'])).failure, 'budget');
  assert.equal((await runtime.dispatch('three', ['p'])).failureStage, 'admission');
  assert.equal(runtime.fakeOffsets.get('p'), 1);
});

test(
  'environment allowlist drops unrelated secrets and redacts allowed secrets',
  { skip: process.platform === 'win32' },
  async () => {
    const runtime = local({
      p: {
        adapter: 'command',
        command: process.execPath,
        model: 'local',
        sandbox: 'external',
        sandboxCommand: '/usr/bin/env',
        sandboxArgs: ['--'],
        args: ['-e', 'console.log(JSON.stringify(process.env))'],
        envAllowlist: ['PATH', 'AUTH_TOKEN'],
        retry: { maxRetries: 0 },
      },
    });
    const result = await runtime.dispatch('p', ['p'], {
      envSource: {
        PATH: process.env.PATH,
        AUTH_TOKEN: 'opaque-sensitive-value',
        UNLISTED: 'must-not-leak',
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.stdout.includes('must-not-leak'), false);
    assert.equal(JSON.stringify(result).includes('opaque-sensitive-value'), false);
  },
);

test('read-only requests reject write-only profiles before spawning', async () => {
  const profile = validateProfiles(
    config({ p: { adapter: 'kimi', command: 'kimi', model: 'test', sandbox: 'workspace-write' } }),
  ).profiles.p;
  assert.throws(() => invocation(profile, 'prompt', { mode: 'readonly' }), /read-only/);
  const result = await local({ p: fake('ok', { sandbox: 'workspace-write' }) }).dispatch('p', [
    'p',
  ]);
  assert.equal(result.failure, 'configuration');
  const kimi = validateProfiles(
    config({
      k: {
        adapter: 'kimi',
        command: 'kimi',
        model: 'test',
        sandbox: 'external',
      },
    }),
  ).profiles.k;
  assert.throws(() => invocation(kimi, 'prompt', { mode: 'readonly' }), /sandboxCommand/);
  const wrapped = validateProfiles(
    config({
      k: {
        adapter: 'kimi',
        command: 'kimi',
        model: 'test',
        sandbox: 'external',
        sandboxCommand: 'bwrap',
        sandboxArgs: ['--ro-bind', '{command}', '{args}'],
      },
    }),
  ).profiles.k;
  assert.equal(invocation(wrapped, 'prompt', { mode: 'readonly' }).command, 'bwrap');
});

test(
  'timeouts and cancellation kill the whole process group, including TERM-ignoring grandchildren',
  { skip: process.platform === 'win32' },
  async () => {
    for (const cancel of [false, true]) {
      const pidFile = join(root, `grandchild-${cancel}.pid`);
      const code = `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
      const controller = new AbortController();
      const pending = run(process.execPath, ['-e', code], {
        timeoutMs: cancel ? 3000 : 120,
        signal: controller.signal,
      });
      if (cancel) setTimeout(() => controller.abort(), 120);
      const result = await pending;
      assert.equal(cancel ? result.cancelled : result.timedOut, true);
      assert.ok(existsSync(pidFile));
      const pid = readFileSync(pidFile, 'utf8');
      let status = '';
      try {
        status = execFileSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).trim();
      } catch {
        /* no process */
      }
      assert.ok(!status || status.startsWith('Z'), `Grandchild ${pid} remains running: ${status}`);
    }
  },
);
