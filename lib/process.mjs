import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export function processFingerprint(pid) {
  if (!pid || process.platform === 'win32') return null;
  try {
    return (
      execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function killOwnedTree(pid, fingerprint, signal = 'SIGTERM') {
  if (fingerprint && processFingerprint(pid) === fingerprint) killTree(pid, signal);
}

export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      /* already exited */
    }
  } else {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!['ESRCH', 'EPERM'].includes(error.code)) throw error;
    }
  }
}

export function run(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const limit = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const grace = options.killGraceMs ?? 150;
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    let timedOut = false,
      cancelled = false,
      outputLimited = false,
      spawnError = null,
      callbackError = null;
    let child,
      timeout,
      forceTimer,
      hardTimer,
      closed = false,
      forced = false,
      settled = false;
    let exitCode = null,
      exitSignal = null;
    const finish = () => {
      if (settled || !closed || (forceTimer && !forced)) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(hardTimer);
      options.signal?.removeEventListener('abort', abort);
      options.inputStream?.unpipe(child?.stdin);
      resolve({
        code: exitCode,
        signal: exitSignal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        cancelled,
        outputLimited,
        spawnError,
        callbackError,
        pid: child?.pid ?? null,
        latencyMs: Math.round(performance.now() - start),
      });
    };
    const stop = () => {
      if (forceTimer) return;
      child?.stdin.destroy();
      killTree(child?.pid);
      forceTimer = setTimeout(() => {
        killTree(child?.pid, 'SIGKILL');
        forced = true;
        finish();
      }, grace);
      hardTimer = setTimeout(() => {
        child?.stdout.destroy();
        child?.stderr.destroy();
        closed = true;
        forced = true;
        finish();
      }, grace + 2000);
    };
    const abort = () => {
      if (options.signal?.reason?.code === 'timeout') timedOut = true;
      else cancelled = true;
      stop();
    };
    if (options.signal?.aborted) {
      if (options.signal.reason?.code === 'timeout') timedOut = true;
      else cancelled = true;
      closed = true;
      finish();
      return;
    }
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      spawnError = { code: error.code, message: error.message };
      closed = true;
      finish();
      return;
    }
    try {
      options.onSpawn?.(child.pid);
    } catch (error) {
      callbackError = error.message;
      stop();
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (kind, chunk) => {
      const current = kind === 'stdout' ? stdout : stderr;
      const remaining = Math.max(0, limit - stdout.length - stderr.length);
      const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
      if (kind === 'stdout') stdout = next;
      else stderr = next;
      try {
        options.onOutput?.(kind, chunk);
      } catch (error) {
        callbackError = error.message;
        stop();
      }
      if (chunk.length > remaining) {
        outputLimited = true;
        stop();
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      spawnError = { code: error.code, message: error.message };
    });
    child.on('exit', (code, signal) => {
      // Preserve the normal exit observed before group cleanup. Immediate host
      // commands can emit `exit` before `close`; dropping it turns success into
      // a synthetic SIGTERM during bounded cleanup.
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timeout);
      try {
        options.onExit?.(code, signal);
      } catch (error) {
        callbackError ||= error.message;
      }
      // Even a normally exiting CLI must not leave its background tools running.
      if (process.platform !== 'win32') stop();
    });
    child.on('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closed = true;
      finish();
    });
    if (options.timeoutMs)
      timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
    if (options.signal?.aborted) abort();
    if (options.inputStream) options.inputStream.pipe(child.stdin);
    else child.stdin.end(options.input ?? '');
  });
}
