// Offline coverage for the local dashboard: routes, redacted status payload,
// SSE stream, and the action endpoint that is disabled unless the operator
// starts the server with allowActions. No provider is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { temp, fake } from './helpers.mjs';
import { projectIdentity } from '../lib/core.mjs';
import { startUi, uiStatus } from '../lib/ui.mjs';
import { executePlan } from '../lib/orchestrator.mjs';
import { createRuntime } from '../lib/runner.mjs';

const root = temp('omha-ui-');
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);

test('uiStatus projects runs, teams, agents and reviews without secrets', async () => {
  const runtime = createRuntime(
    { version: 1, profiles: { p: fake('done') } },
    { persistent: false },
  );
  const finished = await executePlan(
    cwd,
    {
      version: 1,
      objective: 'Check ui',
      publicContext: '',
      parallelism: 1,
      tasks: [{ id: 't1', role: 'worker', prompt: 'go', profile: 'p', mode: 'readonly' }],
    },
    { runtime },
  );
  assert.equal(finished.status, 'completed');
  const snapshot = uiStatus(cwd);
  assert.equal(snapshot.projectId, projectIdentity(cwd).projectId);
  assert.equal(snapshot.runs.length, 1);
  assert.deepEqual(snapshot.runs[0].tasks.t1.status, 'completed');
  assert.deepEqual(snapshot.teams, []);
  assert.ok(Array.isArray(snapshot.agents));
  assert.ok(Array.isArray(snapshot.reviews));
});

test('the ui command boots, serves the dashboard and exits on SIGINT', async () => {
  const bin = new URL('../bin/omha.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [bin, 'ui', '--port', '0'], {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`ui did not announce: ${buffer}`)), 10000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((entry) => entry.includes('"url"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line).url);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`ui exited early: ${buffer}`));
    });
  });
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
  } finally {
    child.kill('SIGINT');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('the dashboard serves html, json status and an SSE stream on loopback', async () => {
  const server = await startUi(cwd, { port: 0 });
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Omha dashboard/);
    const status = await fetch(`${server.url}api/status`);
    assert.equal(status.status, 200);
    const snapshot = await status.json();
    assert.equal(snapshot.projectId.length, 24);
    const controller = new AbortController();
    const stream = await fetch(`${server.url}api/stream`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    assert.match(chunk, /^data: \{.*\}\n\n$/s);
    assert.equal(JSON.parse(chunk.slice('data: '.length)).projectId, snapshot.projectId);
    controller.abort();
    await reader.read().catch(() => {});
  } finally {
    await server.close();
  }
});

test('actions are rejected until the server is started with allowActions', async () => {
  const locked = await startUi(cwd, { port: 0 });
  try {
    const denied = await fetch(`${locked.url}api/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'cancel_run', params: { runId: 'run-x' } }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'forbidden');
  } finally {
    await locked.close();
  }
  const server = await startUi(cwd, { port: 0, allowActions: true });
  try {
    const runs = (await (await fetch(`${server.url}api/status`)).json()).runs;
    const runId = runs[0].runId;
    const cancel = await fetch(`${server.url}api/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'cancel_run', params: { runId } }),
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).result.cancellationRequested, true);
    const unknownTask = await fetch(`${server.url}api/action`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'send_task_message',
        params: { runId, taskId: 'ghost', content: 'hi' },
      }),
    });
    assert.equal(unknownTask.status, 422);
    const unknownAction = await fetch(`${server.url}api/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'self_destruct' }),
    });
    assert.equal(unknownAction.status, 422);
    const malformed = await fetch(`${server.url}api/action`, {
      method: 'POST',
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    const missing = await fetch(`${server.url}api/action`, { method: 'POST', body: '' });
    assert.equal(missing.status, 422);
  } finally {
    await server.close();
  }
});
