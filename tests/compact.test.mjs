import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.mjs';
import { validateProfiles, validateAutoCompact } from '../lib/profiles.mjs';
import {
  prepareCompact,
  compactRpc,
  observeCompactBridge,
  compactStatus,
  compactCapabilities,
  startCompactSession,
} from '../lib/terminal.mjs';
import { createCompactController } from '../hooks/controller.mjs';
import { register } from '../hooks/register.mjs';

const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const MINUTE = 60000;

function fixture(policy = {}, budget = {}) {
  const cwd = temp('omha-compact-project-');
  process.env.OMHA_HOME = join(temp('omha-compact-state-'), 'state');
  const configFile = join(cwd, 'providers.json');
  const config = {
    version: 1,
    profiles: {
      claude: {
        adapter: 'claude',
        command: 'claude',
        model: 'sonnet',
        budget: {
          maxRequests: 100,
          maxTokens: 1000000,
          maxCostUsd: 100,
          reserveTokens: 10000,
          reserveCostUsd: 0.1,
          ...budget,
        },
      },
    },
    maintenance: { autoCompact: { enabled: true, bridgeStatusLine: true, ...policy } },
  };
  writeFileSync(configFile, JSON.stringify(config));
  let now = 1800000000000;
  const options = {
    clock: () => now,
    ownerPid: process.pid,
    ...(process.platform === 'win32' ? { fingerprint: () => 'offline-owner' } : {}),
  };
  const prepared = prepareCompact(cwd, { ...options, config: configFile });
  const sessionId = randomUUID();
  const registration = {
    action: 'register',
    activationId: prepared.activationId,
    sessionId,
    data: {
      version: '2.1.290',
      model: 'claude-sonnet-test',
      idleCompaction: false,
      interactive: true,
      runtimeId: randomUUID(),
    },
  };
  const result = compactRpc(cwd, registration, options);
  const binding = { activationId: prepared.activationId, sessionId, ownerToken: result.ownerToken };
  const rpc = (action, data = {}) => compactRpc(cwd, { action, ...binding, data }, options);
  function bridge(start = now, tokens = 40000, requests = 1, overrides = {}) {
    return observeCompactBridge(
      cwd,
      prepared.activationId,
      {
        session_id: sessionId,
        prompt_cache: {
          requests,
          ttl: '1h',
          warm: true,
          caching_observed: true,
          expires_at: (start + 60 * MINUTE) / 1000,
          ...overrides,
        },
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 0,
            cache_read_input_tokens: tokens,
            cache_creation_input_tokens: 0,
          },
        },
      },
      options,
    );
  }
  function work({ start = now, tokens = 40000, requests = 1, revision = 1, input = true } = {}) {
    if (input) rpc('input', { id: randomUUID(), revision });
    const requestId = randomUUID();
    rpc('request_start', { id: requestId, revision, startedAt: start });
    rpc('request_complete', { id: requestId, cacheObserved: true });
    bridge(start, tokens, requests);
    return rpc('idle', {
      revision,
      model: 'claude-sonnet-test',
      idleCompaction: false,
      safe: true,
    });
  }
  return {
    cwd,
    configFile,
    config,
    prepared,
    sessionId,
    binding,
    registration,
    options,
    rpc,
    bridge,
    work,
    now: () => now,
    at: (value) => {
      now = value;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

function nativeBinding(f, sessionId) {
  const registered = compactRpc(
    f.cwd,
    { ...f.registration, sessionId, data: { ...f.registration.data, runtimeId: randomUUID() } },
    f.options,
  );
  const binding = {
    activationId: f.prepared.activationId,
    sessionId,
    ownerToken: registered.ownerToken,
  };
  return (action, data = {}) => compactRpc(f.cwd, { ...binding, action, data }, f.options);
}

test('compact policy defaults, timing bounds, provider mapping and capabilities fail closed', () => {
  const policy = validateAutoCompact();
  assert.equal(policy.afterMinutes, 57);
  assert.equal(policy.minContextPercent, 20);
  assert.equal(policy.enabled, false);
  for (const input of [
    { enabled: 'true' },
    { afterMinutes: 60 },
    { afterMinutes: 59, minRemainingSeconds: 60 },
    { minContextPercent: -1 },
    { minContextPercent: NaN },
    { maxCompactionsPerSession: 33 },
    { unknown: true },
  ])
    assert.throws(() => validateAutoCompact(input));
  assert.throws(() =>
    validateProfiles({
      version: 1,
      profiles: { fake: { command: 'fake', model: 'local' } },
      maintenance: { autoCompact: { enabled: true } },
    }),
  );
  assert.equal(compactCapabilities('2.1.220 (Claude Code)').supported, false);
  assert.equal(compactCapabilities('2.1.290').supported, true);
  assert.equal(compactCapabilities('2.1.290-dev').supported, false);
});

test('57 minute trigger uses exact input-token context floor and no cold replay', () => {
  const f = fixture();
  const start = f.now();
  f.work({ tokens: 39999 });
  f.advance(57 * MINUTE);
  assert.equal(f.rpc('claim').reason, 'context_below_threshold');
  f.bridge(start, 40000);
  const claimed = f.rpc('claim');
  assert.ok(claimed.operationId);
  const consumed = f.rpc('consume', { operationId: claimed.operationId });
  assert.equal(consumed.account.requests, 1);
  assert.throws(() => f.rpc('consume', { operationId: claimed.operationId }), /already consumed/);
  f.rpc('finish', { operationId: claimed.operationId, result: 'applied', boundary: randomUUID() });
  f.advance(60 * MINUTE);
  assert.equal(f.rpc('claim').reason, 'no_new_business');
  assert.equal(f.rpc('claim').account.estimatedRequests, 1);

  const second = fixture();
  second.work();
  second.advance(57 * MINUTE - 1);
  assert.equal(second.rpc('claim').reason, 'scheduled');
  second.advance(3 * MINUTE + 1);
  assert.equal(second.rpc('claim').reason, 'expired');
});

test('new input at minute 53 invalidates queued timers and only cache evidence rearms', () => {
  const f = fixture();
  const start = f.now();
  assert.equal(f.work().dueAt, start + 57 * MINUTE);
  f.advance(53 * MINUTE);
  f.rpc('input', { id: randomUUID(), revision: 2 });
  assert.equal(f.rpc('claim').dueAt, null);
  assert.equal(f.rpc('claim').reason, 'busy_or_pending_input');
  f.bridge(start, 40000, 1);
  assert.equal(f.rpc('claim').dueAt, null);
  const fresh = f.work({ input: false, revision: 2, requests: 2 });
  assert.equal(fresh.dueAt, start + 110 * MINUTE);
  f.advance(5 * MINUTE);
  assert.equal(
    f.rpc('idle', { revision: 2, model: 'claude-sonnet-test', idleCompaction: false, safe: true })
      .dueAt,
    start + 110 * MINUTE,
  );
  f.bridge(start, 40000, 1);
  assert.equal(f.rpc('refresh').dueAt, start + 110 * MINUTE);
});

test('unknown cache, five-minute TTL and incomplete requests never admit maintenance', () => {
  const f = fixture();
  f.work();
  const start = f.now();
  f.bridge(start, 40000, 1, { ttl: '5m', expires_at: (start + 5 * MINUTE) / 1000 });
  f.advance(57 * MINUTE);
  assert.equal(f.rpc('claim').reason, 'cache_not_warm_one_hour');
  f.rpc('input', { id: randomUUID(), revision: 2 });
  f.rpc('idle', { revision: 2, model: 'claude-sonnet-test', idleCompaction: false, safe: true });
  assert.equal(f.rpc('claim').reason, 'busy_or_pending_input');
  assert.throws(
    () =>
      f.rpc('idle', {
        revision: 1,
        model: 'claude-sonnet-test',
        idleCompaction: false,
        safe: true,
      }),
    /Stale/,
  );
});

test('manual compaction, precompute and unchanged summaries cannot cause repeated compact', () => {
  const f = fixture();
  f.work();
  f.advance(57 * MINUTE);
  const claim = f.rpc('claim');
  const boundary = randomUUID();
  f.rpc('external_start', { id: boundary });
  assert.throws(() => f.rpc('consume', { operationId: claim.operationId }), /stale/);
  f.rpc('external_finish', { id: boundary, result: 'applied', precompute: false });
  assert.equal(f.rpc('claim').reason, 'no_new_business');
  f.work({ revision: 2, requests: 2, tokens: 70000 });
  f.advance(57 * MINUTE);
  const precompute = randomUUID();
  f.rpc('external_start', { id: precompute });
  f.rpc('external_finish', { id: precompute, result: 'applied', precompute: true });
  f.bridge(f.now() - 57 * MINUTE, 70000, 2);
  f.rpc('idle', { revision: 2, model: 'claude-sonnet-test', idleCompaction: false, safe: true });
  assert.equal(f.rpc('claim').reason, 'summary_precomputed');
});

test('invocation uncertainty survives reload and preserves charged budget', () => {
  const f = fixture();
  f.work();
  f.advance(57 * MINUTE);
  const claim = f.rpc('claim');
  f.rpc('consume', { operationId: claim.operationId });
  const recovered = compactRpc(
    f.cwd,
    { ...f.registration, data: { ...f.registration.data, runtimeId: randomUUID() } },
    f.options,
  );
  f.binding.ownerToken = recovered.ownerToken;
  assert.equal(recovered.operation.status, 'unknown');
  assert.equal(recovered.account.requests, 1);
  f.work({ revision: 2, requests: 2 });
  f.advance(57 * MINUTE);
  assert.equal(f.rpc('claim').reason, 'execution_unknown');
  f.rpc('finish', { operationId: claim.operationId, result: 'applied', boundary: randomUUID() });
  assert.equal(f.rpc('claim').lastCompactedWorkRevision, 1);
  assert.equal(f.rpc('claim').workRevision, 2);
});

test('new work is allowed after confirmed execution with unknown usage; session cap persists', () => {
  const f = fixture({ maxCompactionsPerSession: 1 });
  f.work();
  f.advance(57 * MINUTE);
  const op = f.rpc('claim').operationId;
  f.rpc('consume', { operationId: op });
  f.rpc('finish', { operationId: op, result: 'applied', boundary: randomUUID() });
  f.work({ revision: 2, requests: 2 });
  f.advance(57 * MINUTE);
  assert.equal(f.rpc('claim').reason, 'session_limit');
  assert.equal(f.rpc('claim').operation.accounting, 'usage_unknown');
});

test('session/profile reservations survive independent RPCs and share a concurrency gate', () => {
  const f = fixture();
  f.config.profiles.claude.concurrency = 1;
  writeFileSync(f.configFile, JSON.stringify(f.config));
  // Policy hashes freeze the complete profile, so create a matching activation.
  f.prepared = prepareCompact(f.cwd, { ...f.options, config: f.configFile });
  f.registration.activationId = f.prepared.activationId;
  const firstId = randomUUID();
  const first = nativeBinding(f, firstId);
  const secondId = randomUUID();
  const second = nativeBinding(f, secondId);
  const start = f.now();
  function ready(rpc, sessionId) {
    rpc('input', { id: randomUUID(), revision: 1 });
    const request = randomUUID();
    rpc('request_start', { id: request, revision: 1, startedAt: start });
    rpc('request_complete', { id: request, cacheObserved: true });
    observeCompactBridge(
      f.cwd,
      f.prepared.activationId,
      {
        session_id: sessionId,
        prompt_cache: {
          requests: 1,
          ttl: '1h',
          warm: true,
          caching_observed: true,
          expires_at: (start + 60 * MINUTE) / 1000,
        },
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 40000,
          },
        },
      },
      f.options,
    );
    rpc('idle', { revision: 1, model: 'claude-sonnet-test', idleCompaction: false, safe: true });
  }
  ready(first, firstId);
  ready(second, secondId);
  f.advance(57 * MINUTE);
  const firstOp = first('claim').operationId;
  first('consume', { operationId: firstOp });
  const secondOp = second('claim').operationId;
  assert.throws(() => second('consume', { operationId: secondOp }), /concurrency/);
  first('finish', {
    operationId: firstOp,
    result: 'applied',
    boundary: randomUUID(),
    usage: { tokens: 1000, costUsd: 0.01 },
  });
  assert.equal(first('refresh').account.tokens, 1000);
  second('consume', { operationId: secondOp });
  assert.equal(second('refresh').account.requests, 1);
});

test(
  'storage symlinks and native settings/model changes stop maintenance',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    const saved = readFileSync(f.prepared.settingsFile, 'utf8');
    const other = join(f.cwd, 'overlay.json');
    writeFileSync(other, saved);
    const link = join(f.cwd, 'unsafe-settings.json');
    symlinkSync(other, link);
    assert.throws(() => prepareCompact(f.cwd, { ...f.options, config: link }), /Symlinks/);
    f.work();
    f.advance(57 * MINUTE);
    assert.equal(
      f.rpc('idle', { revision: 1, model: 'another-model', idleCompaction: false, safe: true })
        .reason,
      'native_settings_or_model_changed',
    );
  },
);

test('budget reservation, wrong owner, changed policy/settings and ledger tampering refuse execution', () => {
  assert.throws(() => fixture({}, { reserveTokens: 10000, maxTokens: 9999 }));
  const f = fixture({ maxCompactionsPerSession: 32 }, { maxRequests: 1 });
  f.work();
  f.advance(57 * MINUTE);
  const operationId = f.rpc('claim').operationId;
  f.rpc('consume', { operationId });
  f.rpc('finish', { operationId, result: 'skipped' });
  f.work({ revision: 2, requests: 2 });
  f.advance(57 * MINUTE);
  const second = f.rpc('claim').operationId;
  assert.throws(() => f.rpc('consume', { operationId: second }), /remaining budget/);
  assert.throws(
    () => compactRpc(f.cwd, { ...f.binding, ownerToken: 'wrong', action: 'claim' }, f.options),
    /ownership/,
  );
  f.config.maintenance.autoCompact.enabled = false;
  writeFileSync(f.configFile, JSON.stringify(f.config));
  assert.throws(() => f.rpc('claim'), /disabled/);
  const fresh = fixture();
  writeFileSync(fresh.prepared.settingsFile, '{}');
  assert.throws(() => fresh.rpc('claim'), /settings changed/);
  const tampered = fixture();
  const log = join(process.env.OMHA_HOME, 'compact', 'events.jsonl');
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  const event = JSON.parse(lines.at(-1));
  event.state.sessions[tampered.rpc('refresh').id].account.requests = 0;
  event.state.version = 2;
  lines[lines.length - 1] = JSON.stringify(event);
  writeFileSync(log, lines.join('\n') + '\n');
  assert.throws(() => compactStatus(tampered.cwd), /integrity/);
});

test(
  'CLI setup/RPC/bridge/status use installed command shape and preserve statusline output',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    const settings = join(f.cwd, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: `${JSON.stringify(process.execPath)} -e 'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("kept");process.exitCode=7})'`,
        },
      }),
    );
    const prepared = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'compact', 'setup', '--cwd', f.cwd, '--config', f.configFile, '--input', settings],
        { encoding: 'utf8' },
      ),
    );
    const out = execFileSync(process.execPath, [cli, 'compact', 'status', '--cwd', f.cwd], {
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(out).length, 1);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [cli, 'compact', 'bridge', '--cwd', f.cwd, '--id', prepared.activationId],
          { input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        ),
      (error) => error.status === 7 && error.stdout === 'kept',
    );
  },
);

function controllerFixture() {
  const f = fixture();
  const timers = [];
  let compactions = 0;
  let controller;
  const api = {
    rpc: async (input) => compactRpc(f.cwd, input, f.options),
    id: randomUUID,
    now: async () => f.now(),
    after: (delay, callback) => {
      const timer = {
        at: f.now() + delay,
        callback,
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      timers.push(timer);
      return timer;
    },
    idleState: async () => ({ safe: true, model: 'claude-sonnet-test', idleCompaction: false }),
    compact: async () => {
      compactions += 1;
      return { messages: [] };
    },
    notice() {},
  };
  controller = createCompactController(api);
  return { f, timers, api, controller, count: () => compactions };
}

test('Mod controller cancels an already queued minute-57 callback when minute-53 input arrives', async () => {
  const c = controllerFixture();
  const { f, controller } = c;
  await controller.start(f.registration);
  await controller.input();
  const request = randomUUID();
  await controller.requestStart(request, f.now());
  await controller.requestComplete(request, true);
  f.bridge();
  await controller.idle();
  const old = c.timers.find((timer) => timer.at === f.now() + 57 * MINUTE);
  assert.ok(old);
  f.advance(53 * MINUTE);
  const accepted = controller.input();
  f.advance(4 * MINUTE);
  await old.callback();
  await accepted;
  await controller.flush();
  assert.equal(c.count(), 0);
  assert.equal(controller.state.dueAt, null);
});

test('Mod consumes a single host intent, confirms native result and never repeats without work', async () => {
  const c = controllerFixture();
  const { f, controller } = c;
  await controller.start(f.registration);
  await controller.input();
  const request = randomUUID();
  await controller.requestStart(request, f.now());
  await controller.requestComplete(request, true);
  f.bridge();
  await controller.idle();
  f.advance(57 * MINUTE);
  await c.timers[0].callback();
  await controller.flush();
  assert.equal(c.count(), 1);
  assert.equal(controller.state.operation.status, 'applied');
  await controller.refresh();
  assert.equal(c.count(), 1);
});

test('plugin registration is inert without explicit activation and does not require a CLI', async () => {
  const handlers = new Map();
  register((name, hook) => handlers.set(name, hook));
  let next = false;
  await handlers.get('session.start')(
    { env: { get: async () => undefined } },
    { isInteractive: true, surface: 'terminal' },
    async () => {
      next = true;
    },
  );
  assert.equal(next, true);
});

test(
  'independent host processes consume the same claim at most once',
  { skip: process.platform === 'win32' },
  async () => {
    const f = fixture();
    f.work();
    f.advance(57 * MINUTE);
    const operationId = f.rpc('claim').operationId;
    const request = { ...f.binding, action: 'consume', data: { operationId } };
    const modulePath = new URL('../lib/compact.mjs', import.meta.url).href;
    const source = `import {compactRpc} from ${JSON.stringify(modulePath)};
      try { const result=compactRpc(process.argv[1], JSON.parse(process.argv[2]),
        {clock:()=>Number(process.argv[3])}); console.log(JSON.stringify({ok:true,result})); }
      catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}`;
    const invoke = async () =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            ['--input-type=module', '-e', source, f.cwd, JSON.stringify(request), String(f.now())],
            { env: process.env },
          )
        ).stdout,
      );
    const results = await Promise.all([invoke(), invoke()]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(f.rpc('refresh').account.requests, 1);
  },
);

test(
  'explicit native activation preserves argv and refuses unsupported versions without a model',
  { skip: process.platform === 'win32' },
  async () => {
    const f = fixture();
    const bin = temp('omha-claude-fixture-');
    const command = join(bin, 'claude');
    const observed = join(f.cwd, 'argv.json');
    writeFileSync(
      command,
      `#!${process.execPath}
      const fs=require('node:fs');const args=process.argv.slice(2);
      if(args[0]==='--version'){console.log('2.1.290 (Claude Code)');}
      else fs.writeFileSync(args.at(-1),JSON.stringify(args));\n`,
    );
    chmodSync(command, 0o755);
    const oldPath = process.env.PATH;
    const oldConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.PATH = bin + delimiter + oldPath;
    process.env.CLAUDE_CONFIG_DIR = join(f.cwd, 'isolated-claude');
    try {
      const result = await startCompactSession(f.cwd, {
        config: f.configFile,
        args: ['--model', 'sonnet', observed],
      });
      assert.equal(result.exitCode, 0);
      const args = JSON.parse(readFileSync(observed, 'utf8'));
      assert.ok(args.includes('--settings'));
      assert.ok(args.includes('--plugin-dir'));
      assert.deepEqual(args.slice(-3), ['--model', 'sonnet', observed]);
      await assert.rejects(
        startCompactSession(f.cwd, { config: f.configFile, args: ['--settings', 'another.json'] }),
        /overrides/,
      );
      writeFileSync(command, `#!${process.execPath}\nconsole.log('2.1.220 (Claude Code)');\n`);
      await assert.rejects(startCompactSession(f.cwd, { config: f.configFile }), /2.1.290/);
    } finally {
      process.env.PATH = oldPath;
      if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    }
  },
);

test('stale claims, busy windows, skip outcomes and profile concurrency are bounded', () => {
  const f = fixture();
  const start = f.now();
  f.work();
  f.advance(57 * MINUTE);
  const prepared = f.rpc('claim').operationId;
  f.advance(2000);
  assert.throws(() => f.rpc('consume', { operationId: prepared }), /stale/);
  const next = f.rpc('claim').operationId;
  f.rpc('input', { id: randomUUID(), revision: 2 });
  assert.throws(() => f.rpc('consume', { operationId: next }), /stale/);
  f.work({ revision: 2, requests: 2, input: false });
  f.advance(57 * MINUTE);
  f.rpc('idle', { revision: 2, model: 'claude-sonnet-test', idleCompaction: false, safe: false });
  assert.equal(f.rpc('claim').reason, 'busy_or_pending_input');
  f.at(start + 120 * MINUTE);
  f.rpc('idle', { revision: 2, model: 'claude-sonnet-test', idleCompaction: false, safe: true });
  assert.equal(f.rpc('claim').reason, 'expired');

  const g = fixture();
  g.work();
  g.advance(57 * MINUTE);
  const op = g.rpc('claim').operationId;
  g.rpc('consume', { operationId: op });
  g.rpc('finish', { operationId: op, result: 'skipped' });
  assert.equal(g.rpc('claim').reason, 'already_attempted');
  const ledger = readFileSync(join(process.env.OMHA_HOME, 'compact/events.jsonl'), 'utf8');
  assert.ok(ledger.includes('compact.consume'));
  assert.equal(ledger.includes('raw conversation sentinel'), false);
});

test('deadlines and native failure do not replay; local RPC failure stops automatic maintenance', async () => {
  const c = controllerFixture();
  const { f, controller } = c;
  c.api.compact = async () => {
    throw new Error('uncertain native error');
  };
  await controller.start(f.registration);
  await controller.input();
  const request = randomUUID();
  await controller.requestStart(request, f.now());
  await controller.requestComplete(request, true);
  f.bridge();
  await controller.idle();
  f.advance(57 * MINUTE);
  await c.timers[0].callback();
  await controller.flush();
  assert.equal(controller.state.operation.status, 'unknown');
  await controller.refresh();
  assert.equal(controller.state.reason, 'execution_unknown');
  const end = c.timers.find((timer) => timer.at === f.now() + 150000);
  assert.ok(end?.cancelled);
  let notices = 0;
  const failed = createCompactController({
    ...c.api,
    notice() {
      notices += 1;
    },
    rpc: async (input) => {
      if (input.action === 'register') return { ownerToken: 'fixture', inputRevision: 0 };
      throw new Error('CLI unavailable');
    },
  });
  await failed.start(f.registration);
  await failed.input().catch(() => {});
  await failed.flush();
  await failed.refresh();
  assert.equal(notices, 1);
});

test('native Mod event wiring executes a full offline cycle and excludes internal compaction', async () => {
  const f = fixture();
  const handlers = new Map();
  const timers = [];
  let count = 0;
  let refresh;
  register((event, callback) => handlers.set(event, callback));
  const $ = {
    env: { get: async () => f.prepared.activationId },
    ui: { status() {} },
    agent: { list: async () => [] },
    settings: { read: async () => ({ idleCompaction: false }) },
    session: {
      cwd: async () => f.cwd,
      id: async () => f.sessionId,
      version: async () => ({ version: '2.1.290' }),
      model: async () => 'claude-sonnet-test',
      compact: async () => {
        count += 1;
        return { messages: [] };
      },
    },
    clock: {
      now: async () => f.now(),
      every(ms, callback) {
        refresh = callback;
      },
      after(ms, callback) {
        const timer = { at: f.now() + ms, callback, cancel() {} };
        timers.push(timer);
        return timer;
      },
    },
    process: {
      run: async (argv, init) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          version: 1,
          ok: true,
          result: compactRpc(f.cwd, JSON.parse(init.stdin), f.options),
        }),
      }),
    },
  };
  await handlers.get('session.start')(
    $,
    { isInteractive: true, surface: 'terminal' },
    async () => ({}),
  );
  await handlers.get('prompt.submit')($, { text: '/omha:leader-agent do work' }, async () => ({}));
  await handlers.get('turn.start')($, {}, async () => ({}));
  const generator = handlers.get('turn.step')($, {}, async function* () {
    return { usage: { cache_read_input_tokens: 40000 } };
  });
  await generator.next();
  f.bridge();
  await handlers.get('turn.complete')($, {}, async () => ({}));
  await refresh();
  f.advance(57 * MINUTE);
  const due = timers.filter((timer) => timer.at === f.now()).at(-1);
  assert.ok(due);
  await due.callback();
  assert.equal(count, 1);
});
