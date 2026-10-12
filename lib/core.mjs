import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export { atomicWrite, assertSafePath, ensureDir, jsonRead, lockDir } from './storage.mjs';
export { run } from './process.mjs';
export const now = () => new Date().toISOString();
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const FINAL_MARKER = 'OMHA_FINAL:';
export function stateHome() {
  return resolve(
    process.env.OMHA_HOME ||
      join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'omha'),
  );
}
export const home = stateHome();

export function commandExists(command) {
  const executable = (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (command.includes('/') || command.includes('\\')) return executable(command);
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (executable(join(dir, command))) return true;
    if (
      process.platform === 'win32' &&
      (process.env.PATHEXT || '.EXE;.CMD;.BAT')
        .split(';')
        .some((ext) => executable(join(dir, command + ext.toLowerCase())))
    )
      return true;
  }
  return false;
}

export function projectIdentity(cwd = process.cwd()) {
  const input = realpathSync(resolve(cwd));
  let root = input,
    common = null,
    kind = 'path';
  const git = (args) =>
    execFileSync('git', ['-C', input, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  try {
    root = realpathSync(git(['rev-parse', '--show-toplevel']));
    const raw = git(['rev-parse', '--git-common-dir']);
    common = realpathSync(isAbsolute(raw) ? raw : resolve(input, raw));
    kind = 'git';
  } catch {
    root = input;
    common = null;
  }
  const canonicalRoot =
    common && common.endsWith(`${process.platform === 'win32' ? '\\' : '/'}.git`)
      ? dirname(common)
      : common || root;
  return {
    kind,
    root,
    canonicalRoot,
    commonDir: common,
    projectId: hash(`${kind}:${common || root}`).slice(0, 24),
    worktreeId: hash(root).slice(0, 24),
  };
}

export function projectDir(cwd) {
  return join(stateHome(), 'projects', projectIdentity(cwd).projectId);
}
export function stablePrefix(cwd, task = '', publicContext = '') {
  const identity = projectIdentity(cwd);
  return `Omha public context v1\nproject_id: ${identity.projectId}\nproject_root: ${identity.root}\nmemory_index: ${join(stateHome(), 'projects', identity.projectId, 'memory', 'MEMORY.md')}\n\nObjective:\n${task}\n\nPublic evidence:\n${publicContext}`;
}
export function rateLimited(value = '') {
  return /\b429\b|rate[ -]?limit|too many requests/i.test(value);
}
