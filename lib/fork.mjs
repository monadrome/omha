import { arenaStatus, cancelArena, resumeArena, runArena, validateArenaSpec } from './arena.mjs';
import { check } from './validation.mjs';

function sessionForkStatus(batchId) {
  const status = arenaStatus(batchId);
  check(status.executionKind === 'session-fork', 'Batch is not a session fork', 'invalid_record');
  return status;
}

export async function runFork(cwd, input, options = {}) {
  validateArenaSpec(input);
  return runArena(cwd, input, { ...options, sessionFork: true });
}

export function forkStatus(treeId) {
  return sessionForkStatus(treeId);
}

export function forkTree(treeId) {
  const status = sessionForkStatus(treeId);
  return {
    version: status.tree.version || 1,
    treeId: status.tree.treeId,
    name: status.tree.name,
    label: status.tree.label,
    status: status.status,
    root: status.tree.root,
    nodes: status.tree.nodes,
    cache: status.tree.cache,
    budget: status.budget,
  };
}

export function cancelFork(treeId) {
  sessionForkStatus(treeId);
  return cancelArena(treeId);
}

export async function resumeFork(treeId, options = {}) {
  sessionForkStatus(treeId);
  return resumeArena(treeId, options);
}
