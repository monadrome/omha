import { join } from 'node:path';
import { stateHome } from './core.mjs';
import { id } from './validation.mjs';

export const WORKER_FINAL_STATES = ['completed', 'failed', 'cancelled', 'timed_out'];

export function handoffsDir(root = stateHome()) {
  return join(root, 'handoffs');
}

export function handoffPaths(handoffId) {
  id(handoffId, 'handoff id');
  const root = stateHome();
  const dir = join(handoffsDir(root), handoffId);
  return {
    root,
    dir,
    recordFile: join(dir, 'record.json'),
    promptFile: join(dir, 'prompt.md'),
    finalFile: join(dir, 'final.json'),
    processFile: join(dir, 'process.json'),
    activityFile: join(dir, 'activity.json'),
    outputFile: join(dir, 'output.log'),
  };
}
