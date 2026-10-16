import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import {
  createEventFramer,
  parseEvents,
  parseOutput,
  summarizeEvent,
  invocation,
} from '../lib/adapters.mjs';
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

test('profiles expose verified capability tiers and reject impossible declarations', async () => {
  const profiles = validateProfiles({
    version: 1,
    profiles: {
      claude: {},
      kimi: {},
      command: {
        adapter: 'command',
        command: '/bin/sh',
        args: ['-c', 'printf ok'],
        model: 'local',
        sandbox: 'external',
        sandboxCommand: '/usr/bin/env',
        sandboxArgs: ['--'],
      },
    },
  }).profiles;
  assert.deepEqual(profiles.claude.capabilities, ['headless', 'tool-free', 'read-only']);
  assert.deepEqual(profiles.kimi.capabilities, ['headless']);
  assert.deepEqual(profiles.command.capabilities, []);
  assert.throws(
    () => validateProfiles(config({ p: fake('ok', { capabilities: ['tool-free', 'tool-free'] }) })),
    /duplicates/,
  );
  assert.throws(
    () =>
      validateProfiles(
        config({
          p: {
            adapter: 'command',
            command: '/bin/sh',
            args: ['-c', 'printf ok'],
            model: 'local',
            sandbox: 'external',
            capabilities: ['headless'],
          },
        }),
      ),
    /cannot enforce headless/,
  );
});

test('routing records capability mismatches, skips them and never spawns them', async () => {
  const runtime = local({
    plain: {
      adapter: 'command',
      command: '/bin/sh',
      args: ['-c', 'printf should-not-run'],
      model: 'local',
      sandbox: 'external',
      sandboxCommand: '/usr/bin/env',
      sandboxArgs: ['--'],
    },
    compatible: fake('selected'),
  });
  const result = await runtime.dispatch('task', ['plain', 'compatible'], {
    requires: ['headless', 'tool-free'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'fake');
  assert.equal(result.attempts[0].failure, 'capability');
  assert.equal(result.attempts[0].failureStage, 'routing');
  assert.equal(result.attempts[0].requiredCapabilities.join(','), 'headless,tool-free');
  assert.equal(runtime.fakeOffsets.get('compatible'), 1);
  const refused = await runtime.dispatch('task', ['plain'], { requires: ['headless'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.failure, 'capability');
  assert.equal(refused.attempts.length, 1);
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

test('structured provider events expose bounded tool, file, usage and input-wait evidence', async () => {
  const events = parseEvents(
    'codex',
    [{ type: 'turn.started' }, { type: 'turn.completed', usage: { total_tokens: 4 } }]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  assert.equal(summarizeEvent('codex', events[1]).usage.total_tokens, 4);
  const seen = [];
  const runtime = local({
    p: fake('', {
      outputFormat: 'jsonl',
      responses: [
        {
          stdout: [
            {
              status: 'success',
              type: 'tool_call',
              tool: 'read_file',
              files: ['src/index.mjs'],
              output: 'progress',
            },
            {
              status: 'success',
              type: 'input_required',
              output: 'done',
              usage: { output_tokens: 3 },
            },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n'),
        },
      ],
    }),
  });
  const result = await runtime.dispatch('task', ['p'], {
    onProviderEvent: (event) => seen.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(result.eventCount, 2);
  assert.equal(result.inputWait, true);
  assert.deepEqual(result.events[0].files, ['src/index.mjs']);
  assert.equal(result.events[0].tool, 'read_file');
  assert.equal(result.events[1].inputWait, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, 'provider.event');
});

test('JSONL provider streams frame bounded events before completion', async () => {
  const marker = join(root, 'stream-callback.marker');
  const code = `const fs=require('node:fs');const marker=${JSON.stringify(marker)};process.stdout.write(JSON.stringify({status:'success',type:'progress',output:'progress'})+'\\n');setTimeout(()=>{const output=fs.existsSync(marker)?'done':'callback-was-late';process.stdout.write(JSON.stringify({status:'success',type:'result',output})+'\\n')},40)`;
  const runtime = local({
    p: {
      adapter: 'command',
      command: process.execPath,
      model: 'local',
      sandbox: 'workspace-write',
      outputFormat: 'jsonl',
      args: ['-e', code],
      retry: { maxRetries: 0 },
    },
  });
  const seen = [];
  const result = await runtime.dispatch('stream', ['p'], {
    mode: 'write',
    streamEvents: true,
    onProviderEvent: (event) => {
      seen.push(event);
      if (event.realtime) writeFileSync(marker, 'seen');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'done');
  assert.deepEqual(result.stream, {
    requested: true,
    supported: true,
    delivered: 2,
    complete: true,
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].realtime, true);
  assert.equal(seen[1].sequence, 1);
});

test('JSONL stream rejects incomplete and over-limit frames before acceptance', () => {
  const incomplete = createEventFramer('codex', 'jsonl');
  incomplete.push('{"type":"turn.started"}\n{"type":"turn.');
  assert.throws(() => incomplete.finish(), /Incomplete provider event line/);
  const limited = createEventFramer('codex', 'jsonl', { maxEvents: 1 });
  assert.throws(
    () => limited.push('{"type":"a"}\n{"type":"b"}\n'),
    /event stream exceeds event limit/,
  );
  const longLine = createEventFramer('codex', 'jsonl', { maxLineBytes: 8 });
  assert.throws(() => longLine.push('{"type":"a"}\n'), /event line exceeds stream limit/);
});

test('JSONL stream preserves UTF-8 characters split across output chunks', () => {
  let summary;
  const framer = createEventFramer('codex', 'jsonl', { onEvent: (event) => (summary = event) });
  const line = Buffer.from('{"type":"进展"}\n');
  const split = line.indexOf(Buffer.from('展'));
  framer.push(line.subarray(0, split + 1));
  framer.push(line.subarray(split + 1));
  framer.finish();
  assert.equal(summary.type, '进展');
});

test('runtime refuses incomplete and oversized streams even when completion JSON is parseable', async () => {
  for (const code of [
    'process.stdout.write(JSON.stringify({status:"success",type:"result",output:"done"}))',
    'process.stdout.write(JSON.stringify({status:"success",type:"result",output:"done"})+"\\n"+"{\\"type\\":")',
    'process.stdout.write(JSON.stringify({status:"success",type:"result",output:"x".repeat(524288)})+"\\n")',
    'for(let i=0;i<4097;i++)process.stdout.write(JSON.stringify({status:"success",type:"result",output:"done"})+"\\n")',
  ]) {
    const runtime = local({
      p: {
        adapter: 'command',
        command: process.execPath,
        model: 'local',
        sandbox: 'workspace-write',
        outputFormat: 'jsonl',
        args: ['-e', code],
        retry: { maxRetries: 0 },
      },
      fallback: fake('must not launch'),
    });
    const result = await runtime.dispatch('stream', ['p', 'fallback'], {
      mode: 'write',
      streamEvents: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, 'malformed_output');
    assert.equal(result.failureStage, 'parse');
    assert.equal(result.stream.complete, false);
    assert.equal(result.attempts.length, 1);
    assert.equal(runtime.account.requests, 1);
    assert.equal(runtime.fakeOffsets.has('fallback'), false);
  }
});

test('stream callback failure aborts the provider and settles as a host task failure', async () => {
  const code = `process.stdout.write(JSON.stringify({status:'success',type:'progress',output:'progress'})+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({status:'success',type:'result',output:'done'})+'\\n'),100)`;
  const runtime = local({
    p: {
      adapter: 'command',
      command: process.execPath,
      model: 'local',
      sandbox: 'workspace-write',
      outputFormat: 'jsonl',
      args: ['-e', code],
      retry: { maxRetries: 0 },
    },
  });
  const result = await runtime.dispatch('stream', ['p'], {
    mode: 'write',
    streamEvents: true,
    onProviderEvent: () => {
      throw new Error('reviewer rejected event');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'task');
  assert.equal(result.failureStage, 'host');
  assert.equal(result.budget.account.requests, 1);
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
  for (const failure of [
    'task',
    'auth',
    'configuration',
    'malformed_output',
    'budget',
    'cancellation',
    'backend',
  ]) {
    const rt = local({ p: fake('', { responses: [{ failure }], fallback: ['q'] }), q: fake() });
    const result = await rt.dispatch('prompt', ['p']);
    assert.equal(result.failure, failure);
    assert.equal(result.attempts.length, 1);
    assert.equal(rt.fakeOffsets.has('q'), false);
  }
  const runtime = local({
    p: fake('', { outputFormat: 'json', responses: [{ stdout: '{bad}' }] }),
    q: fake(),
  });
  const result = await runtime.dispatch('prompt', ['p', 'q']);
  assert.equal(result.failureStage, 'parse');
  assert.equal(result.failure, 'malformed_output');
  assert.equal(result.attempts.length, 1);
});

test('only the six documented failure classes trigger fallback', async () => {
  for (const failure of [
    'rate_limit',
    'capacity',
    'timeout',
    'transport',
    'spawn',
    'circuit_open',
  ]) {
    const rt = local({ p: fake('', { responses: [{ failure }], fallback: ['q'] }), q: fake() });
    const result = await rt.dispatch('prompt', ['p']);
    assert.equal(result.ok, true);
    assert.equal(result.servedProfile, 'q');
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.profile),
      ['p', 'q'],
    );
  }
});

test('budget admission and invocation configuration failures stop routing before fallback launches', async () => {
  for (const profile of [
    fake('ok', { budget: { maxRequests: 1, reserveTokens: 10 } }),
    fake('ok', { sandbox: 'workspace-write' }),
  ]) {
    const rt = local(
      { p: { ...profile, fallback: ['q'] }, q: fake() },
      {
        budget: { maxRequests: 1 },
        account: { requests: 1, tokens: 0, costUsd: 0, estimatedRequests: 0 },
      },
    );
    const result = await rt.dispatch('prompt', ['p']);
    assert.equal(
      result.failure,
      profile.sandbox === 'workspace-write' ? 'configuration' : 'budget',
    );
    assert.equal(result.attempts.length, 1);
    assert.equal(rt.fakeOffsets.size, 0);
    assert.equal(result.budget.account.requests, 1);
  }
});

test('unknown and partial usage retain token and cost reservations, including native Claude output', async () => {
  const budget = { reserveTokens: 100, reserveCostUsd: 0.5 };
  const cases = [
    { usage: undefined, tokens: 100, costUsd: 0.5, estimated: true },
    { usage: {}, tokens: 100, costUsd: 0.5, estimated: true },
    { usage: { costUsd: 0.1 }, tokens: 100, costUsd: 0.1, estimated: true },
    { usage: { input_tokens: 2 }, tokens: 100, costUsd: 0.5, estimated: true },
    { usage: { output_tokens: 150 }, tokens: 150, costUsd: 0.5, estimated: true },
    { usage: { total_tokens: 0, cost_usd: 0 }, tokens: 0, costUsd: 0, estimated: false },
    {
      usage: { input_tokens: 2, output_tokens: 3, costUsd: 0.1 },
      tokens: 5,
      costUsd: 0.1,
      estimated: false,
    },
  ];
  for (const item of cases) {
    const rt = local({
      p: fake('ok', { budget, responses: [{ output: 'ok', usage: item.usage }] }),
    });
    const result = await rt.dispatch('prompt', ['p']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, {
      tokens: item.tokens,
      costUsd: item.costUsd,
      estimated: item.estimated,
    });
    assert.equal(result.budget.account.tokens, item.tokens);
    assert.equal(result.budget.profileAccounts.p.tokens, item.tokens);
    assert.ok(Math.abs(result.budget.account.costUsd - item.costUsd) < 1e-9);
    assert.equal(result.budget.account.estimatedRequests, item.estimated ? 1 : 0);
  }
  const parsed = parseOutput(
    'claude',
    JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }),
  );
  const rt = local(
    { p: fake('ok', { budget, responses: [{ output: parsed.output, usage: parsed.usage }] }) },
    {
      budget: { maxTokens: 100, reserveTokens: 100 },
    },
  );
  assert.equal((await rt.dispatch('first', ['p'])).budget.account.tokens, 100);
  assert.equal((await rt.dispatch('second', ['p'])).failure, 'budget');
  assert.equal(rt.fakeOffsets.get('p'), 1);
});

test('invalid higher-priority configuration fails closed instead of loading a valid lower-priority config', () => {
  const cwd = join(root, 'config-project');
  mkdirSync(join(cwd, '.omha'), { recursive: true });
  mkdirSync(process.env.OMHA_HOME, { recursive: true });
  writeFileSync(
    join(process.env.OMHA_HOME, 'providers.json'),
    JSON.stringify(config({ valid: fake() })),
  );
  const projectConfig = join(cwd, '.omha', 'providers.json');
  for (const invalid of [
    '{',
    JSON.stringify({ version: 2, profiles: { p: fake() } }),
    JSON.stringify({ ...config({ p: fake() }), typo: true }),
  ]) {
    writeFileSync(projectConfig, invalid);
    assert.throws(() => loadConfig(cwd), { code: 'configuration' });
  }
  assert.throws(() => loadConfig(cwd, 'missing.json'), { code: 'configuration' });
  const explicit = join(cwd, 'explicit.json');
  writeFileSync(explicit, JSON.stringify(config({ explicit: fake() })));
  assert.deepEqual(Object.keys(loadConfig(cwd, explicit).profiles), ['explicit']);
});

test('automatic configuration discovery uses only providers.json', () => {
  const cwd = join(root, 'single-config-name');
  mkdirSync(join(cwd, '.omha'), { recursive: true });
  writeFileSync(join(cwd, '.omha', 'agents.json'), JSON.stringify(config({ legacy: fake() })));
  writeFileSync(
    join(process.env.OMHA_HOME, 'agents.json'),
    JSON.stringify(config({ legacy: fake() })),
  );
  writeFileSync(
    join(process.env.OMHA_HOME, 'providers.json'),
    JSON.stringify(config({ canonical: fake() })),
  );
  assert.deepEqual(Object.keys(loadConfig(cwd).profiles), ['canonical']);
  writeFileSync(join(cwd, '.omha', 'providers.json'), JSON.stringify(config({ project: fake() })));
  assert.deepEqual(Object.keys(loadConfig(cwd).profiles), ['project']);
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

test('provider queue checks its deadline before admitting a released lease', async () => {
  let clock = 0;
  const runtime = local({ p: fake('done', { concurrency: 1 }) }, { clock: () => clock });
  const profile = runtime.config.profiles.p;
  const release = await runtime.acquire(profile, null, 10);
  const queued = runtime.acquire(profile, null, 10);
  clock = 11;
  release();
  await assert.rejects(queued, { code: 'timeout' });
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
      const code = `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));console.log('ready:'+c.pid);setInterval(()=>{},1000)`;
      const controller = new AbortController();
      const pending = run(process.execPath, ['-e', code], {
        timeoutMs: 5000,
        signal: controller.signal,
        onOutput(kind, chunk) {
          if (kind === 'stdout' && chunk.toString().startsWith('ready:'))
            controller.abort({ code: cancel ? 'cancellation' : 'timeout' });
        },
      });
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
