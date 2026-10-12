import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { BASE_ENV } from './profiles.mjs';
import { environment, environmentSecrets, redact } from './security.mjs';
import { check, OmhaError } from './validation.mjs';
import { stateHome } from './core.mjs';

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const worker = fileURLToPath(new URL('../bin/handoff-worker.mjs', import.meta.url));
const TMUX_SOCKET_PREFIX = 'omha-socket-';
const TMUX_SOCKET_NAME = 'tmux.sock';
const TMUX_OWNER_OPTION = '@omha-owner';
const CMUX_OWNER_KEY = 'omha-owner';

async function local(command, args, record, options = {}) {
  const result = await run(command, args, {
    cwd: record.cwd,
    timeoutMs: 5000,
    env: {
      ...environment([...BASE_ENV, 'CMUX_SOCKET_PATH', 'CMUX_SOCKET_PASSWORD', 'OMHA_HOME']),
      CMUX_QUIET: '1',
    },
    ...options,
  });
  if (result.code !== 0)
    throw new OmhaError(
      'backend',
      `${command} backend operation failed: ${redact(result.stderr, environmentSecrets(process.env)).trim()}`,
      { code: result.code },
    );
  return result.stdout;
}
const launch = (record, exec = false) =>
  `${exec ? 'exec ' : ''}env OMHA_HOME=${shellQuote(stateHome())} ${shellQuote(process.execPath)} ${shellQuote(worker)} ${shellQuote(record.recordFile)}`;
const tmux = (record, args, options) =>
  local('tmux', ['-S', record.socket, ...args], record, options);
const target = (record) => `=${record.session}:0.0`;

export const tmuxBackend = {
  async prepare(record) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), TMUX_SOCKET_PREFIX)));
    chmodSync(dir, 0o700);
    return {
      socket: join(dir, TMUX_SOCKET_NAME),
      socketDir: dir,
      session: `omha-${record.id}`,
      ref: `omha-${record.id}`,
    };
  },
  async start(record) {
    await tmux(record, [
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      record.session,
      '-c',
      record.cwd,
      '/bin/sh',
    ]);
    try {
      await tmux(record, [
        'set-option',
        '-t',
        record.session,
        TMUX_OWNER_OPTION,
        record.owner.token,
      ]);
      await tmux(record, ['set-option', '-p', '-t', target(record), 'remain-on-exit', 'on']);
      await tmux(record, ['respawn-pane', '-k', '-t', target(record), launch(record, true)]);
      const pid = Number(
        (await tmux(record, ['display-message', '-p', '-t', target(record), '#{pane_pid}'])).trim(),
      );
      return { pid: Number.isInteger(pid) ? pid : null };
    } catch (error) {
      await tmux(record, ['kill-session', '-t', `=${record.session}`]).catch(() => {});
      rmSync(record.socketDir, { recursive: true, force: true });
      throw error;
    }
  },
  async verify(record) {
    const owner = (
      await tmux(record, ['show-option', '-v', '-t', record.session, TMUX_OWNER_OPTION])
    ).trim();
    check(
      owner === record.owner.token,
      'Refusing to operate on an unowned tmux session',
      'ownership',
    );
  },
  async alive(record) {
    try {
      await this.verify(record);
      return (
        (
          await tmux(record, ['display-message', '-p', '-t', target(record), '#{pane_dead}'])
        ).trim() === '0'
      );
    } catch (error) {
      if (error.code === 'ownership') throw error;
      return false;
    }
  },
  async capture(record) {
    await this.verify(record);
    return tmux(record, ['capture-pane', '-p', '-t', target(record), '-S', '-2000']);
  },
  async send(record, value, enter) {
    await this.verify(record);
    const buffer = `omha-${record.id}`;
    await tmux(record, ['load-buffer', '-b', buffer, '-'], { input: value });
    await tmux(record, ['paste-buffer', '-d', '-p', '-b', buffer, '-t', target(record)]);
    if (enter) await tmux(record, ['send-keys', '-t', target(record), 'Enter']);
  },
  async close(record) {
    await this.verify(record);
    await tmux(record, ['kill-session', '-t', `=${record.session}`]);
    if (
      record.socketDir &&
      record.socket === join(record.socketDir, TMUX_SOCKET_NAME) &&
      record.socketDir.startsWith(join(realpathSync(tmpdir()), TMUX_SOCKET_PREFIX))
    )
      rmSync(record.socketDir, { recursive: true, force: true });
  },
};

function uuid(value) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
const cmux = (record, args) => local('cmux', args, record);
export const cmuxBackend = {
  async prepare(record) {
    const output = await cmux(record, [
      '--id-format',
      'uuids',
      'rpc',
      'workspace.create',
      JSON.stringify({
        title: `Omha ${record.id} ${record.name}`,
        cwd: record.cwd,
        focus: false,
      }),
    ]);
    let created;
    try {
      created = JSON.parse(output);
    } catch {
      throw new OmhaError('backend', 'cmux did not return a JSON workspace reference');
    }
    const ref =
      created.workspace_id || created.workspace?.id || created.id || created.result?.workspace_id;
    check(uuid(ref), 'cmux must return a full workspace UUID', 'backend');
    const owned = { ...record, ref };
    try {
      await cmux(owned, ['set-status', CMUX_OWNER_KEY, record.owner.token, '--workspace', ref]);
    } catch (error) {
      await cmux(owned, ['close-workspace', '--workspace', ref]).catch(() => {});
      throw error;
    }
    return { ref, surfaceRef: created.surface_id || created.surface?.id || null };
  },
  async start(record) {
    await this.verify(record);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const targets = [
      '--workspace',
      record.ref,
      ...(record.surfaceRef ? ['--surface', record.surfaceRef] : []),
    ];
    await cmux(record, ['send', ...targets, launch(record)]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await cmux(record, ['send-key', ...targets, 'Enter']);
    return {};
  },
  async verify(record) {
    check(uuid(record.ref), 'Refusing an abbreviated cmux reference', 'ownership');
    const statuses = await cmux(record, ['list-status', '--workspace', record.ref]);
    check(
      statuses.includes(record.owner.token),
      'Refusing to operate on an unowned cmux workspace',
      'ownership',
    );
  },
  async alive(record) {
    try {
      await this.verify(record);
      return true;
    } catch (error) {
      if (error.code === 'ownership') throw error;
      return false;
    }
  },
  async capture(record) {
    await this.verify(record);
    return cmux(record, [
      'read-screen',
      '--workspace',
      record.ref,
      ...(record.surfaceRef ? ['--surface', record.surfaceRef] : []),
      '--scrollback',
      '--lines',
      '2000',
    ]);
  },
  async send(record, value, enter) {
    await this.verify(record);
    const target = [
      '--workspace',
      record.ref,
      ...(record.surfaceRef ? ['--surface', record.surfaceRef] : []),
    ];
    await cmux(record, ['send', ...target, value]);
    if (enter) {
      if (value.length >= 1024) await new Promise((resolve) => setTimeout(resolve, 1000));
      await cmux(record, ['send-key', ...target, 'Enter']);
    }
  },
  async close(record) {
    await this.verify(record);
    await cmux(record, ['close-workspace', '--workspace', record.ref]);
  },
};

export const fileBackend = {
  async start() {
    return {};
  },
  async verify() {},
  async alive() {
    return false;
  },
  async capture() {
    return '';
  },
  async send() {
    throw new OmhaError('backend', 'File handoffs cannot receive terminal input');
  },
  async close() {},
};

export function backendFor(record, options = {}) {
  if (options.backendAdapter) return options.backendAdapter;
  if (options.backends?.[record.backend]) return options.backends[record.backend];
  const backend = { file: fileBackend, tmux: tmuxBackend, cmux: cmuxBackend }[record.backend];
  check(backend, 'Unknown handoff backend');
  return backend;
}
