import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { OmhaError, check } from './validation.mjs';

export function assertSafePath(file, root = dirname(file)) {
  check(typeof file === 'string' && !file.includes('\0'), 'Invalid path', 'unsafe_path');
  const base = resolve(root);
  const target = resolve(file);
  const rel = relative(base, target);
  check(
    rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    'Path escapes storage root',
    'unsafe_path',
  );
  let current = base;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      const stat = lstatSync(current);
      check(!stat.isSymbolicLink(), 'Symlinks are not permitted in storage', 'unsafe_path');
      check(
        // Concurrent unlink/rename can return a zero-link stat on APFS.
        !stat.isFile() || stat.nlink <= 1,
        'Hardlinked files are not permitted in storage',
        'unsafe_path',
      );
      check(
        current === target || stat.isDirectory(),
        'Storage parent must be a directory',
        'unsafe_path',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return target;
}

export function ensureDir(dir, root = dir) {
  assertSafePath(dir, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafePath(dir, root);
  return dir;
}

function syncDirectory(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function atomicWrite(file, content, root = dirname(file)) {
  assertSafePath(file, root);
  ensureDir(dirname(file), root);
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertSafePath(file, root);
    renameSync(tmp, file);
    syncDirectory(dirname(file));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

export function safeRead(file, root = dirname(file), encoding = 'utf8') {
  assertSafePath(file, root);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink <= 1, 'Unsafe storage file', 'unsafe_path');
    return readFileSync(fd, encoding);
  } finally {
    closeSync(fd);
  }
}

export function jsonRead(file, fallback, root = dirname(file)) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(safeRead(file, root));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new OmhaError('corrupt_state', `Invalid JSON state: ${file}`);
    throw error;
  }
}

export function appendEvent(file, event, root = dirname(file)) {
  assertSafePath(file, root);
  ensureDir(dirname(file), root);
  const release = lockDir(`${file}.append.lock`, { root, staleMs: 0 });
  let fd;
  try {
    fd = openSync(
      file,
      constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    const size = fstatSync(fd).size,
      last = Buffer.alloc(1);
    if (size) {
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) {
        const content = readFileSync(fd, 'utf8'),
          newline = content.lastIndexOf('\n');
        try {
          JSON.parse(content.slice(newline + 1));
          writeFileSync(fd, '\n');
        } catch {
          ftruncateSync(fd, Buffer.byteLength(content.slice(0, newline + 1)));
        }
      }
    }
    writeFileSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    release();
  }
}

export function readEvents(file, root = dirname(file)) {
  if (!existsSync(file)) return [];
  const input = safeRead(file, root);
  const lines = input.split('\n');
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1 && !input.endsWith('\n')) break;
      throw new OmhaError('corrupt_state', `Invalid event at line ${i + 1}`);
    }
  }
  return events;
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function lockDir(lock, options = {}) {
  const root = options.root || dirname(lock);
  ensureDir(dirname(lock), root);
  const start = Date.now();
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 120000;
  while (Date.now() - start <= timeoutMs) {
    assertSafePath(lock, root);
    try {
      mkdirSync(lock, { mode: 0o700 });
      atomicWrite(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() }),
        root,
      );
      return () => {
        const owner = jsonRead(join(lock, 'owner.json'), null, root);
        if (owner?.token === token) rmSync(lock, { recursive: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let stat;
    try {
      stat = lstatSync(lock);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    let owner;
    try {
      owner = jsonRead(join(lock, 'owner.json'), null, root);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code !== 'corrupt_state') throw error;
    }
    const dead = owner?.host === hostname() && !isAlive(owner.pid);
    if (
      (dead && Date.now() - stat.mtimeMs >= staleMs) ||
      (!owner && Date.now() - stat.mtimeMs >= Math.max(staleMs, 1000))
    ) {
      const recovery = `${lock}.recovery`;
      let claim;
      try {
        claim = openSync(
          recovery,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
          0o600,
        );
        writeFileSync(claim, JSON.stringify({ pid: process.pid, token }));
        closeSync(claim);
        claim = undefined;
        const current = jsonRead(join(lock, 'owner.json'), null, root);
        if (
          (!current || (current.host === hostname() && !isAlive(current.pid))) &&
          lstatSync(lock).ino === stat.ino
        ) {
          const abandoned = `${lock}.stale-${token}`;
          renameSync(lock, abandoned);
          rmSync(abandoned, { recursive: true });
        }
      } catch (error) {
        if (error.code === 'EEXIST') {
          const recovering = jsonRead(recovery, null, root);
          if (recovering && !isAlive(recovering.pid)) rmSync(recovery, { force: true });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        } else if (!['ENOENT'].includes(error.code)) throw error;
      } finally {
        if (claim !== undefined) closeSync(claim);
        if (existsSync(recovery)) {
          const recovering = jsonRead(recovery, null, root);
          if (recovering?.token === token) rmSync(recovery, { force: true });
        }
      }
      continue;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new OmhaError('lock_timeout', 'Storage lock is held by another writer');
}
