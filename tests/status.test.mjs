import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { executePlan, projectStatus, watchStatus } from '../lib/orchestrator.mjs';
import { handoff } from '../lib/terminal.mjs';
import { appendEvent, atomicWrite } from '../lib/storage.mjs';
import { projectDir } from '../lib/core.mjs';

const root = temp('omha-status-');
process.env.OMHA_HOME = join(root, 'state');
const cwd = temp('omha-status-project-');
const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const plan = {
  version: 1,
  objective: 'Inspect',
  tasks: [
    {
      id: 'job',
      role: 'inspect',
      prompt: 'Inspect',
      profile: 'p',
      mode: 'readonly',
      acceptance: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    },
  ],
};

test('consolidated status replays current outcomes and budgets without exposing task payloads', async () => {
  const runtime = createRuntime(
    config({
      p: fake('private output', { fallback: ['q'], responses: [{ failure: 'rate_limit' }] }),
      q: fake(),
    }),
    { persistent: false },
  );
  const run = await executePlan(cwd, plan, { runtime });
  const owned = await handoff(cwd, 'private handoff prompt', { backend: 'file' });
  await handoff(temp('omha-other-project-'), 'unrelated prompt', { backend: 'file' });
  atomicWrite(
    join(projectDir(cwd), 'decisions', 'fixture.json'),
    JSON.stringify({
      decisionId: 'fixture',
      status: 'completed',
      tally: { outcome: 'decided', recommendation: 'A' },
      gate: { required: true, status: 'approved' },
      votes: [{ private: 'private vote' }],
    }),
    process.env.OMHA_HOME,
  );
  const status = projectStatus(cwd);
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].runId, run.runId);
  assert.equal(status.runs[0].tasks.job.executionOk, true);
  assert.equal(status.runs[0].tasks.job.acceptanceAccepted, true);
  assert.equal(status.metrics.workerAttempts, 2);
  assert.equal(status.metrics.workerFailures, 1);
  assert.equal(status.metrics.fallbacks, 1);
  assert.equal(status.metrics.accepted, 1);
  assert.equal(status.handoffs.length, 1);
  assert.equal(status.handoffs[0].id, owned.id);
  assert.equal(status.decisions[0].gate.status, 'approved');
  for (const sentinel of [
    'private output',
    'private handoff prompt',
    'unrelated prompt',
    'private vote',
  ])
    assert.equal(JSON.stringify(status).includes(sentinel), false);
});

test('watch emits changed snapshots, preserves the authoritative event source and cancels promptly', async () => {
  const controller = new AbortController();
  const watcher = watchStatus(cwd, {
    intervalMs: 10,
    durationMs: 10000,
    signal: controller.signal,
  });
  const first = (await watcher.next()).value;
  const run = first.runs[0];
  appendEvent(
    join(run.dir, 'events.jsonl'),
    {
      kind: 'task.escalated',
      taskId: 'job',
      reason: 'stalled',
      profile: 'q',
      at: '2026-10-16T00:00:00.000Z',
    },
    process.env.OMHA_HOME,
  );
  const second = (await watcher.next()).value;
  assert.equal(second.metrics.escalations, 1);
  assert.equal(second.runs[0].tasks.job.escalation.reason, 'stalled');
  controller.abort();
  assert.equal((await watcher.next()).done, true);
  const bounded = [];
  for await (const snapshot of watchStatus(cwd, { intervalMs: 10, durationMs: 30 }))
    bounded.push(snapshot);
  assert.equal(bounded.length, 1);
  await assert.rejects(async () => {
    for await (const _ of watchStatus(cwd, { intervalMs: 0 })) {
      /* invalid */
    }
  });
});

test('installed command shape supports one-shot JSON and bounded JSONL watching', () => {
  const invoke = (args) =>
    execFileSync(process.execPath, [cli, ...args, '--cwd', cwd], {
      encoding: 'utf8',
      timeout: 10000,
    });
  assert.equal(JSON.parse(invoke(['status'])).runs.length, 1);
  const lines = invoke(['status', '--watch', '--wait-ms', '30', '--interval-ms', '10'])
    .trim()
    .split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).metrics.accepted, 1);
});
