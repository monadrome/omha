import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { temp } from './helpers.mjs';
import { commandExists } from '../lib/core.mjs';
import {
  handoff,
  handoffStatus,
  handoffWorkerIdentity,
  sendHandoff,
  cancelHandoff,
  closeHandoff,
  reportHandoffActivity,
} from '../lib/terminal.mjs';
import { recoverTabs, discoverTabs, tabRecoveryStatus } from '../lib/tab-recovery.mjs';
import { handoffPaths } from '../lib/handoff-protocol.mjs';
import { atomicWrite } from '../lib/storage.mjs';
import { killOwnedTree, processFingerprint } from '../lib/process.mjs';

const supported = process.platform !== 'win32' && commandExists('tmux');
const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/tmux-agent.mjs', import.meta.url));

test(
  'non-interactive tmux workers never acquire recovery input claims',
  { skip: !supported },
  async (t) => {
    const root = temp('omha-tmux-noninteractive-');
    process.env.OMHA_HOME = join(root, 'state');
    const record = await handoff(root, 'Offline report-only worker', {
      backend: 'tmux',
      command: '/bin/sh',
      args: ['-c', "printf 'stream disconnected before completion\\n'; sleep 60"],
      interactive: false,
      timeoutMs: 60000,
    });
    t.after(async () => {
      await cancelHandoff(record.id).catch(() => {});
      const { tmuxBackend } = await import('../lib/backends.mjs');
      await tmuxBackend.close(record).catch(() => {});
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const worker = await waitFor(() => {
      try {
        return handoffWorkerIdentity(record);
      } catch {
        return null;
      }
    });
    const path = handoffPaths(record.id);
    atomicWrite(
      path.activityFile,
      JSON.stringify({
        agent: 'codex',
        state: 'idle',
        source: 'caller-reported',
        at: new Date().toISOString(),
        worker,
        ownerToken: record.owner.token,
      }),
      path.root,
    );
    const check = await recoverTabs(root, { backend: 'tmux', verifyMs: 0 });
    assert.equal(check.summary.skipped, 1, JSON.stringify(check));
    const report = await recoverTabs(root, { backend: 'tmux', allowSend: true, verifyMs: 0 });
    assert.equal(report.summary.skipped, 1, JSON.stringify(report));
    assert.equal(JSON.parse(readFileSync(path.activityFile)).recoveryClaim, undefined);
    assert.equal(
      tabRecoveryStatus().state.surfaces[report.tabs[0].surfaceId].pendingSubmission,
      undefined,
    );
  },
);

async function waitFor(fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail('tmux lifecycle fixture did not become ready');
}

async function setup(t) {
  const root = temp('omha-tmux-lifecycle-');
  process.env.OMHA_HOME = join(root, 'state');
  const record = await handoff(root, 'Offline terminal lifecycle', {
    backend: 'tmux',
    command: process.execPath,
    args: [fixture, cli, root],
    interactive: true,
    timeoutMs: 60000,
  });
  assert.equal(record.state, 'running', JSON.stringify(record));
  t.after(async () => {
    const current = handoffStatus(record.id);
    const path = handoffPaths(record.id);
    if (existsSync(path.processFile)) {
      const worker = JSON.parse(readFileSync(path.processFile));
      killOwnedTree(worker.childPid, worker.fingerprint, 'SIGKILL');
    }
    if (!current.backendClosed) {
      const { tmuxBackend } = await import('../lib/backends.mjs');
      try {
        await cancelHandoff(record.id);
      } catch {
        /* uncertainty is asserted by the test */
      }
      await tmuxBackend.close(current).catch(() => {});
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await waitFor(() => existsSync(join(root, 'ready')));
  const request = async (body) => {
    rmSync(join(root, 'reply'), { force: true });
    await sendHandoff(record.id, JSON.stringify(body));
    const response = await waitFor(
      () =>
        existsSync(join(root, 'reply')) && JSON.parse(readFileSync(join(root, 'reply'), 'utf8')),
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  return { root, record, request };
}

test(
  'real tmux recovery requires fresh activity from the owned worker',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    await assert.rejects(reportHandoffActivity(f.record.id, { agent: 'codex', state: 'idle' }), {
      code: 'ownership',
    });
    await f.request({ state: 'working' });
    const options = {
      backend: 'tmux',
      allowSend: true,
      verifyMs: 100,
      sendDelayMs: 0,
      cooldownMs: 0,
    };
    assert.equal((await recoverTabs(f.root, options)).summary.busy, 1);
    await f.request({ state: 'waiting' });
    assert.equal((await recoverTabs(f.root, options)).summary.skipped, 1);
    await f.request({ state: 'idle' });
    const path = handoffPaths(f.record.id);
    const activity = JSON.parse(readFileSync(path.activityFile));
    activity.at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    atomicWrite(path.activityFile, JSON.stringify(activity), path.root);
    const report = await recoverTabs(f.root, options);
    assert.equal(report.backend, 'tmux');
    assert.equal(report.summary.sent, 1, JSON.stringify(report));
    await waitFor(() => existsSync(join(f.root, 'received')));
    const repeated = await recoverTabs(f.root, options);
    assert.equal(repeated.summary.stalled, 1, JSON.stringify(repeated));
    assert.equal(readFileSync(join(f.root, 'received'), 'utf8'), 'go on');
    await f.request({ state: 'idle' });
    const longWatch = JSON.parse(readFileSync(path.activityFile));
    longWatch.at = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    atomicWrite(path.activityFile, JSON.stringify(longWatch), path.root);
    const extended = await recoverTabs(f.root, {
      ...options,
      intervalMs: 40 * 60 * 1000,
    });
    assert.equal(extended.summary.sent, 1, JSON.stringify(extended));
    await waitFor(() => readFileSync(join(f.root, 'received'), 'utf8') === 'go on');
    const claimed = JSON.parse(readFileSync(path.activityFile));
    claimed.at = new Date(Date.now() - 42 * 60 * 1000).toISOString();
    atomicWrite(path.activityFile, JSON.stringify(claimed), path.root);
    assert.equal((await discoverTabs(f.root, { backend: 'tmux' }))[0].hasAgent, false);
    assert.deepEqual(await discoverTabs(temp(), { backend: 'tmux' }), []);
  },
);

test(
  'an unreachable tmux handoff is reported without aborting recovery discovery',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    const serverPid = Number(
      execFileSync('tmux', ['-S', f.record.socket, 'display-message', '-p', '#{pid}'], {
        encoding: 'utf8',
      }).trim(),
    );
    process.kill(serverPid, 'SIGKILL');
    const report = await recoverTabs(f.root, { backend: 'tmux', allowSend: true });
    assert.equal(report.summary.unreadable, 1, JSON.stringify(report));
    assert.match(report.tabs[0].reason, /unreachable/);
    assert.equal(report.summary.sent, 0);
    const record = handoffStatus(f.record.id);
    record.state = 'interrupted';
    atomicWrite(record.recordFile, JSON.stringify(record), process.env.OMHA_HOME);
    assert.equal((await closeHandoff(record.id)).state, 'closed');
  },
);

test(
  'explicit close resolves an uncertain auto-close after its session disappears',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    await f.request({ close: true, delayMs: 1000 });
    execFileSync('tmux', ['-S', f.record.socket, 'kill-session', '-t', `=${f.record.session}`]);
    const uncertain = await waitFor(() => {
      const current = handoffStatus(f.record.id);
      return current.autoClose?.state === 'uncertain' && current;
    });
    assert.equal(uncertain.backendClosed, undefined);
    const closed = await closeHandoff(f.record.id);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.autoClose.state, 'closed');
    assert.equal(closed.backendClosed, true);
  },
);

test(
  'real tmux auto-close preserves other panes and records a detached outcome',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    const other = execFileSync(
      'tmux',
      [
        '-S',
        f.record.socket,
        'split-window',
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        '-t',
        `=${f.record.session}:0.0`,
        'sleep 60',
      ],
      { encoding: 'utf8' },
    ).trim();
    const scheduled = await f.request({ close: true });
    assert.equal(scheduled.autoClose.state, 'scheduled');
    const closed = await waitFor(() => {
      const current = handoffStatus(f.record.id);
      return ['closed', 'uncertain'].includes(current.autoClose?.state) && current;
    });
    assert.equal(closed.autoClose.state, 'closed', JSON.stringify(closed));
    const panes = execFileSync(
      'tmux',
      ['-S', f.record.socket, 'list-panes', '-t', `=${f.record.session}`, '-F', '#{pane_id}'],
      { encoding: 'utf8' },
    );
    assert.equal(panes.trim(), other);
    execFileSync('tmux', ['-S', f.record.socket, 'kill-session', '-t', `=${f.record.session}`]);
    rmSync(f.record.socketDir, { recursive: true, force: true });
  },
);

test(
  'tmux auto-close finishes after the worker exits normally',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    const scheduled = await f.request({ close: true, exitAfterClose: true });
    assert.equal(scheduled.autoClose.state, 'scheduled');
    const closed = await waitFor(() => {
      const current = handoffStatus(f.record.id);
      return ['closed', 'uncertain'].includes(current.autoClose?.state) && current;
    });
    assert.equal(closed.autoClose.state, 'closed', JSON.stringify(closed));
    assert.equal(closed.backendClosed, true);
  },
);

test(
  'tmux auto-close cleans a surviving child after its pane worker dies',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    await f.request({ close: true, delayMs: 2000 });
    const worker = JSON.parse(readFileSync(handoffPaths(f.record.id).processFile));
    process.kill(worker.pid, 'SIGKILL');
    const closed = await waitFor(() => {
      const current = handoffStatus(f.record.id);
      return ['closed', 'uncertain'].includes(current.autoClose?.state) && current;
    });
    assert.equal(closed.autoClose.state, 'closed', JSON.stringify(closed));
    await waitFor(() => processFingerprint(worker.childPid) !== worker.fingerprint);
  },
);

test(
  'tmux auto-close refuses a changed worker binding during the grace period',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    await f.request({ close: true, delayMs: 1500 });
    const path = handoffPaths(f.record.id);
    const worker = JSON.parse(readFileSync(path.processFile));
    worker.workerFingerprint = 'changed worker';
    atomicWrite(path.processFile, JSON.stringify(worker), path.root);
    const result = await waitFor(() => {
      const current = handoffStatus(f.record.id);
      return current.autoClose?.state === 'uncertain' && current;
    });
    assert.equal(result.autoClose.failure, 'ownership');
    assert.equal(result.backendClosed, undefined);
    await assert.rejects(closeHandoff(f.record.id), { code: 'ownership' });
  },
);

test(
  'tmux auto-close refuses a replacement process in the same pane',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    await f.request({ close: true, delayMs: 2000 });
    const worker = JSON.parse(readFileSync(handoffPaths(f.record.id).processFile));
    execFileSync('tmux', [
      '-S',
      f.record.socket,
      'respawn-pane',
      '-k',
      '-t',
      f.record.surfaceRef,
      'sleep 60',
    ]);
    t.after(() => killOwnedTree(worker.childPid, worker.fingerprint, 'SIGKILL'));
    const result = await waitFor(() => {
      const current = handoffStatus(f.record.id);
      return ['closed', 'uncertain'].includes(current.autoClose?.state) && current;
    });
    assert.equal(result.autoClose.state, 'uncertain');
    assert.equal(result.autoClose.failure, 'ownership');
    assert.equal(result.backendClosed, undefined);
    await assert.rejects(closeHandoff(f.record.id), { code: 'ownership' });
  },
);

test(
  'explicit close verifies the owner of a live interrupted tmux worker',
  { skip: !supported },
  async (t) => {
    const f = await setup(t);
    const record = handoffStatus(f.record.id);
    record.state = 'interrupted';
    atomicWrite(record.recordFile, JSON.stringify(record), process.env.OMHA_HOME);
    execFileSync('tmux', [
      '-S',
      record.socket,
      'set-option',
      '-t',
      record.session,
      '@omha-owner',
      'changed-owner',
    ]);
    await assert.rejects(closeHandoff(record.id), { code: 'ownership' });
    execFileSync('tmux', [
      '-S',
      record.socket,
      'set-option',
      '-t',
      record.session,
      '@omha-owner',
      record.owner.token,
    ]);
    assert.equal((await closeHandoff(record.id)).state, 'closed');
  },
);
