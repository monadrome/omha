import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
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
      ...environment([
        ...BASE_ENV,
        'CMUX_SOCKET_PATH',
        'CMUX_SOCKET_PASSWORD',
        'CMUX_WORKSPACE_ID',
        'CMUX_SURFACE_ID',
        'OMHA_HOME',
      ]),
      CMUX_QUIET: '1',
    },
    ...options,
  });
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.cancelled ||
    result.outputLimited ||
    result.spawnError ||
    result.callbackError
  )
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

export async function runCmux(cwd, args, options = {}) {
  const result = await run('cmux', args, {
    cwd,
    timeoutMs: 5000,
    env: {
      ...environment([
        ...BASE_ENV,
        'CMUX_SOCKET_PATH',
        'CMUX_SOCKET_PASSWORD',
        'CMUX_WORKSPACE_ID',
        'CMUX_SURFACE_ID',
        'OMHA_HOME',
      ]),
      CMUX_QUIET: '1',
    },
    ...options,
  });
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.cancelled ||
    result.outputLimited ||
    result.spawnError ||
    result.callbackError
  )
    throw new OmhaError(
      'backend',
      `cmux backend operation failed: ${redact(result.stderr, environmentSecrets(process.env)).trim()}`,
      { code: result.code },
    );
  return result.stdout;
}

export async function cmuxJsonCommand(cwd, args, options = {}) {
  try {
    return JSON.parse(await runCmux(cwd, args, options));
  } catch (error) {
    if (error instanceof SyntaxError) throw new OmhaError('backend', 'cmux returned invalid JSON');
    throw error;
  }
}
const target = (record) => record.surfaceRef || `=${record.session}:0.0`;

function socketAbsent(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(true);
      else reject(new OmhaError('backend', 'Cannot verify tmux socket absence'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new OmhaError('backend', 'tmux socket absence probe timed out'));
    });
  });
}

export const tmuxBackend = {
  async caller(record) {
    await this.verify(record);
    const socket = process.env.TMUX?.replace(/,\d+,\d+$/, '');
    check(
      socket === record.socket && /^%\d+$/.test(process.env.TMUX_PANE || ''),
      'Only the calling owned tmux pane is permitted',
      'ownership',
    );
    const surfaceRef = (
      await tmux(record, ['display-message', '-p', '-t', target(record), '#{pane_id}'])
    ).trim();
    check(
      surfaceRef === process.env.TMUX_PANE && surfaceRef === record.surfaceRef,
      'tmux caller pane changed',
      'ownership',
    );
    return { ref: record.ref, surfaceRef };
  },
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
    let launchRequested = false;
    try {
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
      await tmux(record, [
        'set-option',
        '-t',
        record.session,
        TMUX_OWNER_OPTION,
        record.owner.token,
      ]);
      await tmux(record, ['set-option', '-p', '-t', target(record), 'remain-on-exit', 'on']);
      launchRequested = true;
      await tmux(record, ['respawn-pane', '-k', '-t', target(record), launch(record, true)]);
      const pid = Number(
        (await tmux(record, ['display-message', '-p', '-t', target(record), '#{pane_pid}'])).trim(),
      );
      const surfaceRef = (
        await tmux(record, ['display-message', '-p', '-t', target(record), '#{pane_id}'])
      ).trim();
      return { pid: Number.isInteger(pid) ? pid : null, surfaceRef };
    } catch (error) {
      let cleanedUp = false;
      try {
        await tmux(record, ['kill-session', '-t', `=${record.session}`]);
        cleanedUp = true;
      } catch {
        cleanedUp = !existsSync(record.socket);
      }
      if (cleanedUp) rmSync(record.socketDir, { recursive: true, force: true });
      error.details = { ...error.details, launchNotStarted: !launchRequested, cleanedUp };
      throw error;
    }
  },
  async absent(record) {
    if (!existsSync(record.socket)) return true;
    try {
      const sessions = await tmux(record, ['list-sessions', '-F', '#{session_name}']);
      return !sessions.trim().split(/\r?\n/).includes(record.session);
    } catch (error) {
      if (await socketAbsent(record.socket)) return true;
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
  async paneState(record) {
    await this.verify(record);
    const values = (
      await tmux(record, [
        'display-message',
        '-p',
        '-t',
        target(record),
        '#{pane_dead}:#{pane_pid}',
      ])
    )
      .trim()
      .split(':');
    check(
      values.length === 2 && ['0', '1'].includes(values[0]) && /^\d+$/.test(values[1]),
      'Invalid tmux pane state',
      'backend',
    );
    return { dead: values[0] === '1', pid: Number(values[1]) };
  },
  async capture(record, options = {}) {
    await this.verify(record);
    return tmux(record, [
      'capture-pane',
      '-p',
      '-t',
      target(record),
      ...(options.visibleOnly ? [] : ['-S', '-2000']),
    ]);
  },
  async send(record, value, enter) {
    await this.verify(record);
    const buffer = `omha-${record.id}`;
    await tmux(record, ['load-buffer', '-b', buffer, '-'], { input: value });
    await tmux(record, ['paste-buffer', '-d', '-p', '-b', buffer, '-t', target(record)]);
    if (enter) await tmux(record, ['send-keys', '-t', target(record), 'Enter']);
  },
  async sendKey(record, key) {
    await this.verify(record);
    check(key === 'Enter', 'Only Enter is supported');
    await tmux(record, ['send-keys', '-t', target(record), key]);
  },
  async close(record, options = {}) {
    await this.verify(record);
    if (options.completed) {
      const closeAfter = Date.parse(record.autoClose?.closeAfter);
      check(
        record.state === 'completed' &&
          record.autoClose?.state === 'closing' &&
          Number.isFinite(closeAfter) &&
          Date.now() >= closeAfter &&
          Date.now() <= closeAfter + 10000,
        'Auto-close completion claim is invalid or expired',
        'authority',
      );
      await tmux(record, ['kill-pane', '-t', target(record)]);
    } else if (options.paneOnly) await tmux(record, ['kill-pane', '-t', target(record)]);
    else await tmux(record, ['kill-session', '-t', `=${record.session}`]);
    if (
      record.socketDir &&
      record.socket === join(record.socketDir, TMUX_SOCKET_NAME) &&
      record.socketDir.startsWith(join(realpathSync(tmpdir()), TMUX_SOCKET_PREFIX))
    ) {
      if (options.completed || options.paneOnly) {
        const deadline = Date.now() + 500;
        while (existsSync(record.socket) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        if (existsSync(record.socket)) return;
      }
      rmSync(record.socketDir, { recursive: true, force: true });
    }
  },
};

export function uuid(value) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
const cmux = (record, args) => runCmux(record.cwd, args);
const cmuxJson = (record, args) => cmuxJsonCommand(record.cwd, ['--id-format', 'uuids', ...args]);
const ownerKey = (record) =>
  record.native ? `${CMUX_OWNER_KEY}-${record.surfaceRef.toLowerCase()}` : CMUX_OWNER_KEY;

export const cmuxBackend = {
  async caller(record) {
    const { caller } = await cmuxJson(record, ['--json', 'identify']);
    check(
      uuid(caller?.workspace_id) && uuid(caller?.surface_id),
      'No calling cmux surface',
      'ownership',
    );
    return { ref: caller.workspace_id, surfaceRef: caller.surface_id };
  },
  async session(record) {
    check(uuid(record.ref) && uuid(record.surfaceRef), 'Full cmux UUIDs are required', 'ownership');
    const data = await cmuxJson(record, [
      'surface',
      'resume',
      'get',
      '--workspace',
      record.ref,
      '--surface',
      record.surfaceRef,
      '--json',
    ]);
    check(
      data.workspace_id?.toLowerCase() === record.ref.toLowerCase() &&
        data.surface_id?.toLowerCase() === record.surfaceRef.toLowerCase(),
      'cmux session target changed',
      'ownership',
    );
    const binding = data.resume_binding;
    const restore = data.restore_record;
    check(
      binding &&
        restore &&
        binding.kind === restore.kind &&
        binding.checkpoint_id === restore.checkpoint_id &&
        restore.mode === 'resumeAgent',
      'No verified resumable cmux agent session',
      'backend',
    );
    check(
      ['claude', 'codex'].includes(binding.kind),
      'cmux historical forks require Claude or Codex',
      'backend',
    );
    const args = restore.prepared_arguments;
    const executable = restore.launch_command?.executable_path || args?.[0];
    check(
      Array.isArray(args) &&
        args.length > 1 &&
        args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
        basename(args[0]) === binding.kind &&
        typeof executable === 'string' &&
        isAbsolute(executable) &&
        basename(executable) === binding.kind &&
        args.filter((arg) => arg === binding.checkpoint_id).length === 1,
      'cmux must supply structured native resume arguments',
      'backend',
    );
    check(
      realpathSync(binding.cwd) === record.cwd &&
        realpathSync(restore.prepared_arguments_working_directory || restore.working_directory) ===
          record.cwd,
      'cmux session belongs to another worktree',
      'ownership',
    );
    const captured = restore.environment || {};
    check(
      captured &&
        typeof captured === 'object' &&
        !Array.isArray(captured) &&
        Object.entries(captured).every(
          ([key, value]) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
            typeof value === 'string' &&
            !value.includes('\0'),
        ),
      'Invalid cmux session environment',
      'backend',
    );
    const nativeEnvironment = {
      ...captured,
      [`CMUX_CUSTOM_${binding.kind.toUpperCase()}_PATH`]: executable,
    };
    if (binding.kind === 'claude') {
      const selected = [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CONFIG_DIR',
      ].filter((key) => Object.hasOwn(captured, key));
      if (selected.length) {
        nativeEnvironment.CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV = '1';
        nativeEnvironment.CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV_KEYS = selected.join(',');
      }
    }
    return {
      agent: binding.kind,
      sessionId: binding.checkpoint_id,
      executable,
      args: [binding.kind, ...args.slice(1)],
      environment: nativeEnvironment,
    };
  },
  async claim(record) {
    const statuses = await cmux(record, ['list-status', '--workspace', record.ref]);
    const key = ownerKey(record);
    check(
      !statuses.split(/\r?\n/).some((line) => line.startsWith(`${key}=`)),
      'cmux surface already has an owner',
      'ownership',
    );
    await cmux(record, ['set-status', key, record.owner.token, '--workspace', record.ref]);
  },
  async checkpoints(record) {
    const data = await cmuxJson(record, [
      'rpc',
      'vault.checkpoints',
      JSON.stringify({
        agent: record.native.agent,
        session: record.native.sessionId,
      }),
    ]);
    check(
      data.agent === record.native.agent &&
        data.session_id === record.native.sessionId &&
        data.supports_fork === true &&
        data.truncated === false &&
        Array.isArray(data.checkpoints),
      'cmux has no complete forkable checkpoint timeline',
      'backend',
    );
    return data.checkpoints;
  },
  async forkSession(record, checkpoint) {
    const data = await cmuxJson(record, [
      'rpc',
      'vault.fork',
      JSON.stringify({
        agent: record.native.agent,
        session: record.native.sessionId,
        checkpoint: checkpoint.id,
      }),
    ]);
    check(
      data.agent === record.native.agent &&
        data.parent_session_id === record.native.sessionId &&
        uuid(data.session_id) &&
        data.session_id !== data.parent_session_id &&
        data.opened === false &&
        realpathSync(data.cwd) === record.cwd,
      'Invalid cmux historical fork result',
      'backend',
    );
    return data.session_id;
  },
  async startSession(record, session) {
    await this.verify(record);
    const command = [
      ...Object.entries(session.environment).map(([key, value]) => {
        check(
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string',
          'Invalid cmux session environment',
        );
        return shellQuote(`${key}=${value}`);
      }),
      ...session.args.map(shellQuote),
    ].join(' ');
    await cmux(record, [
      'respawn-pane',
      '--workspace',
      record.ref,
      '--surface',
      record.surfaceRef,
      '--command',
      `exec env ${command}`,
    ]);
  },
  async message(record, value) {
    await this.verify(record);
    const data = await cmuxJson(record, [
      'rpc',
      'agent.message.send',
      JSON.stringify({
        target: record.surfaceRef,
        from: 'Omha',
        body: value,
      }),
    ]);
    check(
      uuid(data.id) &&
        data.recipient_surface_id?.toLowerCase() === record.surfaceRef.toLowerCase() &&
        data.recipient_workspace_id?.toLowerCase() === record.ref.toLowerCase() &&
        ['queued', 'delivered', 'read'].includes(data.state),
      'Invalid cmux message receipt',
      'backend',
    );
    return { id: data.id, state: data.state };
  },
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
      owned.surfaceRef = created.surface_id || created.surface?.id || null;
      check(
        !record.native || uuid(owned.surfaceRef),
        'cmux must return the new surface UUID',
        'backend',
      );
      await cmux(owned, ['set-status', ownerKey(owned), record.owner.token, '--workspace', ref]);
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
    if (record.native)
      check(uuid(record.surfaceRef), 'Refusing an abbreviated cmux surface', 'ownership');
    const statuses = await cmux(record, ['list-status', '--workspace', record.ref]);
    check(
      statuses
        .split(/\r?\n/)
        .some((line) => line.split(/\s/)[0] === `${ownerKey(record)}=${record.owner.token}`),
      'Refusing to operate on an unowned cmux workspace',
      'ownership',
    );
  },
  async alive(record) {
    try {
      await this.verify(record);
      if (record.native) {
        const session = await this.session(record);
        check(
          session.agent === record.native.agent && session.sessionId === record.native.sessionId,
          'cmux agent session changed',
          'ownership',
        );
      }
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
  async close(record, options = {}) {
    await this.verify(record);
    if (record.native) {
      const session = await this.session(record);
      check(
        session.agent === record.native.agent && session.sessionId === record.native.sessionId,
        'Refusing to close a changed cmux agent session',
        'ownership',
      );
      if (options.completed === true) {
        const closeAfter = Date.parse(record.autoClose?.closeAfter);
        check(
          record.state === 'completed' &&
            record.autoClose?.state === 'closing' &&
            Number.isFinite(closeAfter) &&
            Date.now() >= closeAfter &&
            Date.now() <= closeAfter + 10000,
          'Auto-close completion claim is invalid or expired',
          'authority',
        );
      }
      await cmux(record, [
        'close-surface',
        '--workspace',
        record.ref,
        '--surface',
        record.surfaceRef,
        ...(options.completed === true ? ['--force'] : []),
      ]);
    } else await cmux(record, ['close-workspace', '--workspace', record.ref]);
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
