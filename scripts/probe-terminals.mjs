import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  cancelHandoff,
  closeHandoff,
  completeHandoff,
  handoff,
  pollHandoff,
  readHandoff,
  sendHandoff,
} from '../lib/terminal.mjs';
import { commandExists } from '../lib/core.mjs';
import { run } from '../lib/process.mjs';
import { redact } from '../lib/security.mjs';
import { temp } from '../tests/helpers.mjs';

const root = temp('omha-probes-');
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);
const evidence = [];
const diagnostic = (error, result) => ({
  code: error?.code || 'protocol',
  message: redact(error?.message || 'cmux probe failed').slice(0, 300),
  commandCode: result?.code ?? null,
  stderr: redact(result?.stderr || '').slice(-500),
  stdoutPreview: redact(result?.stdout || '').slice(0, 500),
});
async function verifyFileFallback(reason) {
  let record;
  try {
    record = await handoff(cwd, 'cmux compatibility fallback probe', {
      backend: 'file',
      timeoutMs: 5000,
    });
    assert.equal(record.state, 'awaiting');
    completeHandoff(record.id, 0);
    const completed = await readHandoff(record.id);
    assert.equal(completed.state, 'completed');
    evidence.push({
      backend: 'file',
      probe: 'cmux compatibility fallback',
      state: completed.state,
      reason,
    });
  } finally {
    if (
      record &&
      !['closed', 'completed', 'failed', 'cancelled', 'timed_out'].includes(record.state)
    ) {
      await cancelHandoff(record.id).catch(() => {});
    }
    if (record) await closeHandoff(record.id).catch(() => {});
  }
}
for (const backend of ['tmux', 'cmux']) {
  if (process.platform === 'win32' || !commandExists(backend)) {
    evidence.push({ backend, skipped: 'not available' });
    continue;
  }
  let baseline = null;
  if (backend === 'cmux') {
    const available = await run('cmux', ['--id-format', 'uuids', 'rpc', 'workspace.list', '{}'], {
      timeoutMs: 5000,
    });
    if (available.code !== 0) {
      const details = diagnostic(new Error('cmux workspace.list unavailable'), available);
      evidence.push({ backend, status: 'degraded', diagnostics: details });
      await verifyFileFallback('workspace.list unavailable');
      continue;
    }
    try {
      baseline = JSON.parse(available.stdout);
    } catch (error) {
      const details = diagnostic(error, available);
      evidence.push({ backend, status: 'degraded', diagnostics: details });
      await verifyFileFallback('workspace.list returned non-JSON output');
      continue;
    }
  }
  let record;
  try {
    record = await handoff(cwd, 'Local detached printf probe', {
      backend,
      command: '/usr/bin/printf',
      args: [`OMHA_${backend}_PRINTF_OK\n`],
      timeoutMs: 10000,
    });
    assert.equal(record.state, 'running', JSON.stringify(record));
    const done = await pollHandoff(record.id, { waitMs: 12000 });
    assert.equal(done.state, 'completed', JSON.stringify(done));
    assert.ok(done.output.includes(`OMHA_${backend}_PRINTF_OK`));
    evidence.push({
      backend,
      probe: 'detached printf',
      ref: record.ref,
      socket: record.socket || null,
      pid: done.pid,
      state: done.state,
      promptHash: done.promptHash,
    });
  } catch (error) {
    if (backend !== 'cmux') throw error;
    evidence.push({ backend, status: 'degraded', diagnostics: diagnostic(error) });
    await verifyFileFallback(error.message);
    continue;
  } finally {
    if (record?.state === 'running') await closeHandoff(record.id);
  }
  let interactive;
  try {
    const fixture =
      'process.stdout.write("READY\\n");process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",c=>{text+=c;if(text.includes("\\n")){console.log("RECEIVED:"+text.trim());process.exit(0)}})';
    interactive = await handoff(cwd, 'Local input probe', {
      backend,
      command: process.execPath,
      args: ['-e', fixture],
      interactive: true,
      timeoutMs: 15000,
    });
    assert.equal(interactive.state, 'running');
    let ready;
    for (let i = 0; i < 30; i += 1) {
      ready = await readHandoff(interactive.id);
      if (ready.output.includes('READY')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready.output.includes('READY'), 'fixture did not become ready');
    const value = `begin-${backend}-` + 'x'.repeat(2048) + `-end-${backend}`;
    await sendHandoff(interactive.id, value);
    const done = await pollHandoff(interactive.id, { waitMs: 15000 });
    assert.equal(done.state, 'completed', JSON.stringify(done));
    const output = readFileSync(
      join(root, 'state', 'handoffs', interactive.id, 'output.log'),
      'utf8',
    );
    assert.ok(output.includes(`RECEIVED:${value}`), 'paste/Enter did not arrive intact');
    evidence.push({
      backend,
      probe: 'long paste + separate Enter',
      ref: interactive.ref,
      state: done.state,
      receivedBytes: value.length,
    });
  } catch (error) {
    if (backend !== 'cmux') throw error;
    evidence.push({ backend, status: 'degraded', diagnostics: diagnostic(error) });
    await verifyFileFallback(error.message);
    continue;
  } finally {
    if (interactive?.state === 'running') await closeHandoff(interactive.id);
  }
  if (backend === 'cmux') {
    const after = await run('cmux', ['--id-format', 'uuids', 'rpc', 'workspace.list', '{}'], {
      timeoutMs: 5000,
    });
    try {
      assert.equal(after.code, 0, after.stderr);
      const getIds = (value) =>
        (value.workspaces || value.result?.workspaces || [])
          .map((w) => w.id || w.workspace_id)
          .sort();
      assert.deepEqual(
        getIds(JSON.parse(after.stdout)),
        getIds(baseline),
        'pre-existing cmux workspace set changed',
      );
      evidence.push({ backend, existingWorkspacesPreserved: true });
    } catch (error) {
      evidence.push({ backend, status: 'degraded', diagnostics: diagnostic(error, after) });
      await verifyFileFallback('workspace preservation check failed');
    }
  }
}
console.log(JSON.stringify({ ok: true, evidence, stateRoot: root }, null, 2));
rmSync(root, { recursive: true, force: true });
