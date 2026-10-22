import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.mjs';
import { readEvents } from '../lib/storage.mjs';
import { recoverTabs, tabRecoveryStatus } from '../lib/tab-recovery.mjs';

const ERROR =
  '■ stream disconnected before completion: Our servers are currently overloaded. Please try again later.';
const bin = temp('omha-auto-recover-bin-');
copyFileSync(new URL('./fixtures/cmux.mjs', import.meta.url), join(bin, 'cmux'));
chmodSync(join(bin, 'cmux'), 0o700);
process.env.PATH = `${bin}:${process.env.PATH}`;
const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));

function tab(overrides = {}) {
  return {
    workspaceId: randomUUID(),
    surfaceId: randomUUID(),
    stableSurfaceId: randomUUID(),
    label: 'agent tab',
    agents: [{ kind: 'claude', state: 'idle', last_activity_at: null }],
    screen: 'ready\n❯\n',
    ...overrides,
  };
}

function harness(tabs) {
  const home = temp('omha-auto-recover-state-');
  process.env.OMHA_HOME = home;
  const calls = [];
  const screens = new Map(tabs.map((entry) => [entry.surfaceId, entry.screen]));
  let lastMessage = '';
  const cmux = {
    current: async () => ({
      items: tabs.map((entry) => ({
        durable_surface_id: entry.stableSurfaceId,
        label: entry.label,
        cwd: '/tmp/project',
        lifecycle: 'running',
        agents: entry.agents,
      })),
    }),
    surfaces: async () => ({
      projections: tabs.map((entry) => ({
        resource: `local/terminal/${entry.surfaceId}`,
        surface_id: entry.surfaceId,
        workspace_id: entry.workspaceId,
        stable_surface_id: entry.stableSurfaceId,
      })),
    }),
    readScreen: async (_cwd, target) => screens.get(target.surfaceId),
    send: async (_cwd, target, value) => {
      calls.push({ kind: 'send', surface: target.surfaceId, value });
      lastMessage = value;
    },
    sendKey: async (_cwd, target, key) => {
      calls.push({ kind: 'key', surface: target.surfaceId, key });
      screens.set(
        target.surfaceId,
        `${screens.get(target.surfaceId)}\n❯ ${lastMessage}\nWorking...\n`,
      );
    },
  };
  return { home, calls, screens, cmux };
}

const fast = { verifyMs: 0, sendDelayMs: 0 };

test('recovers a disconnected idle agent tab with one submitted message', async () => {
  const entry = tab({ screen: `working on task\n${ERROR}\n❯\n` });
  const f = harness([entry]);
  const report = await recoverTabs('/tmp/project', {
    cmux: f.cmux,
    allowSend: true,
    ...fast,
  });
  assert.equal(report.summary.recovered, 1);
  assert.equal(report.summary.sent, 1);
  assert.equal(report.summary.verified, 1);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['send', 'key'],
  );
  assert.equal(f.calls[0].value, 'go on');
  assert.equal(f.calls[1].key, 'Enter');
  const events = readEvents(join(f.home, 'auto-recover', 'events.jsonl'), f.home);
  assert.ok(events.some((event) => event.kind === 'auto_recover.sent' && event.verified));
});

test('never injects while the agent is working', async () => {
  const entry = tab({
    agents: [{ kind: 'codex', state: 'working' }],
    screen: `reading files\n${ERROR}\n`,
  });
  const f = harness([entry]);
  const report = await recoverTabs('/tmp/project', {
    cmux: f.cmux,
    allowSend: true,
    ...fast,
  });
  assert.equal(report.summary.busy, 1);
  assert.equal(f.calls.length, 0);
});

test('reports unregistered or ended tabs without typing into them', async () => {
  const shell = tab({ agents: [], label: 'shell', screen: `${ERROR}\n$ ` });
  const ended = tab({
    agents: [{ kind: 'claude', state: 'ended' }],
    label: 'ended',
    screen: `${ERROR}\n$ `,
  });
  const f = harness([shell, ended]);
  const report = await recoverTabs('/tmp/project', {
    cmux: f.cmux,
    allowSend: true,
    ...fast,
  });
  assert.equal(report.summary.detected, 2);
  assert.equal(report.summary.skipped, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.screens.get(shell.surfaceId), `${ERROR}\n$ `);
});

test('auth and quota failures are blocked, not retried', async () => {
  const auth = tab({ screen: 'API Error: 401 Unauthorized\n❯\n' });
  const quota = tab({ screen: 'insufficient_quota: credit balance is too low\n❯\n' });
  const f = harness([auth, quota]);
  const report = await recoverTabs('/tmp/project', {
    cmux: f.cmux,
    allowSend: true,
    ...fast,
  });
  assert.equal(report.summary.blocked, 2);
  assert.equal(f.calls.length, 0);
});

test('a client-owned retry is left alone', async () => {
  const entry = tab({ screen: 'API Error: 503 Service Unavailable\nRetrying in 5s\n' });
  const f = harness([entry]);
  const report = await recoverTabs('/tmp/project', { cmux: f.cmux, allowSend: true, ...fast });
  assert.equal(report.summary.retrying, 1);
  assert.equal(f.calls.length, 0);
});

test('old errors outside the current screen window are ignored', async () => {
  const entry = tab({
    screen: `${ERROR}\n${Array.from({ length: 30 }, (_, i) => `fresh output ${i}`).join('\n')}\n`,
  });
  const f = harness([entry]);
  const report = await recoverTabs('/tmp/project', { cmux: f.cmux, allowSend: true, ...fast });
  assert.equal(report.summary.ok, 1);
  assert.equal(f.calls.length, 0);
});

test('cooldown prevents duplicate sends and bounded attempts stop the loop', async () => {
  const entry = tab({ screen: `${ERROR}\n❯\n` });
  const f = harness([entry]);
  let clock = Date.now();
  const now = () => clock;
  const options = {
    cmux: f.cmux,
    allowSend: true,
    cooldownMs: 1000,
    maxAttempts: 2,
    now,
    ...fast,
  };
  const first = await recoverTabs('/tmp/project', options);
  assert.equal(first.summary.recovered, 1);
  assert.equal(f.calls.filter((call) => call.kind === 'send').length, 1);

  const duplicate = await recoverTabs('/tmp/project', options);
  assert.equal(duplicate.summary.cooldown, 1);
  assert.equal(f.calls.filter((call) => call.kind === 'send').length, 1);

  clock += 1000;
  const second = await recoverTabs('/tmp/project', options);
  assert.equal(second.summary.recovered, 1);
  assert.equal(f.calls.filter((call) => call.kind === 'send').length, 2);

  clock += 1000;
  const exhausted = await recoverTabs('/tmp/project', options);
  assert.equal(exhausted.summary.stalled, 1);
  assert.equal(f.calls.filter((call) => call.kind === 'send').length, 2);
});

test('an uncertain Enter is never retyped on later passes', async () => {
  const entry = tab({ screen: `${ERROR}\n❯\n` });
  const f = harness([entry]);
  f.cmux.sendKey = async () => {
    throw new Error('enter failed');
  };
  const options = {
    cmux: f.cmux,
    allowSend: true,
    cooldownMs: 0,
    maxAttempts: 5,
    ...fast,
  };
  const first = await recoverTabs('/tmp/project', options);
  assert.equal(first.summary.enter_failed, 1);
  const second = await recoverTabs('/tmp/project', options);
  assert.equal(second.summary.stalled, 1);
  assert.equal(f.calls.filter((call) => call.kind === 'send').length, 1);
});

test('check mode reports the failure without sending', async () => {
  const entry = tab({ screen: `${ERROR}\n❯\n` });
  const f = harness([entry]);
  const report = await recoverTabs('/tmp/project', { cmux: f.cmux, ...fast });
  assert.equal(report.summary.recoverable, 1);
  assert.equal(report.summary.sent, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(report.tabs[0].match.line, ERROR);
});

test('persisted state and events never contain raw screen output', async () => {
  const marker = 'SECRET-PROMPT-MARKER-9f3a';
  const entry = tab({ screen: `${marker}\n${ERROR}\n❯\n` });
  const f = harness([entry]);
  await recoverTabs('/tmp/project', { cmux: f.cmux, allowSend: true, ...fast });
  const state = readFileSync(join(f.home, 'auto-recover', 'state.json'), 'utf8');
  const events = readFileSync(join(f.home, 'auto-recover', 'events.jsonl'), 'utf8');
  assert.ok(!state.includes(marker));
  assert.ok(!events.includes(marker));
  assert.equal(tabRecoveryStatus().state.version, 1);
});

test('CLI discovers every local tab and recovers through the cmux fixture', () => {
  const cwd = temp('omha-auto-recover-cli-');
  const home = temp('omha-auto-recover-cli-state-');
  process.env.OMHA_HOME = home;
  const entry = tab({ label: 'live agent', screen: `task\n${ERROR}\n❯\n` });
  const shell = tab({ agents: [], label: 'shell', screen: 'hello\n' });
  writeFileSync(
    join(home, 'cmux-fixture.json'),
    JSON.stringify({
      cwd,
      tabs: [entry, shell].map((item) => ({
        stable: item.stableSurfaceId,
        surface: item.surfaceId,
        workspace: item.workspaceId,
        label: item.label,
        agents: item.agents,
      })),
      screens: {
        [entry.surfaceId]: entry.screen,
        [shell.surfaceId]: shell.screen,
      },
      sent: [],
      keys: [],
      calls: [],
    }),
  );
  const result = JSON.parse(
    execFileSync(process.execPath, [cli, 'auto-recover', '--allow-send', '--verify-ms', '0'], {
      cwd,
      env: process.env,
      encoding: 'utf8',
      timeout: 15000,
    }),
  );
  assert.equal(result.summary.checked, 2);
  assert.equal(result.summary.agents, 1);
  assert.equal(result.summary.recovered, 1);
  const fixture = JSON.parse(readFileSync(join(home, 'cmux-fixture.json'), 'utf8'));
  assert.deepEqual(fixture.sent, [{ surface: entry.surfaceId, text: 'go on' }]);
  assert.deepEqual(fixture.keys, [{ surface: entry.surfaceId, key: 'Enter' }]);
});
