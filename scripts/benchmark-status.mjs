import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { projectDir } from '../lib/core.mjs';
import { listRuns } from '../lib/orchestrator.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'omha-status-benchmark-'));
const previous = process.env.OMHA_HOME;
process.env.OMHA_HOME = join(temporary, 'state');
try {
  const cwd = join(temporary, 'project');
  mkdirSync(cwd);
  const root = join(projectDir(cwd), 'runs');
  for (let i = 0; i < 20; i += 1) {
    const dir = join(root, `run-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plan.json'),
      JSON.stringify({ plan: { tasks: [{ id: 'job', role: 'inspect', mode: 'readonly' }] } }),
    );
    writeFileSync(join(dir, 'context.md'), 'Immutable benchmark context');
    writeFileSync(
      join(dir, 'events.jsonl'),
      Array.from({ length: 100 }, (_, sequence) =>
        JSON.stringify({
          kind: 'request.finished',
          taskId: 'job',
          at: '2026-10-16T00:00:00.000Z',
          attempt: { profile: 'p', ok: true, latencyMs: 10, retry: 0 },
          sequence,
        }),
      ).join('\n') + '\n',
    );
  }
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    const runs = listRuns(cwd);
    if (runs.length !== 20) throw new Error('Incomplete benchmark replay');
    samples.push(performance.now() - start);
  }
  console.log(
    JSON.stringify({
      runs: 20,
      eventsPerRun: 100,
      samplesMs: samples.map((value) => Math.round(value)),
      meanMs: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
    }),
  );
} finally {
  if (previous === undefined) delete process.env.OMHA_HOME;
  else process.env.OMHA_HOME = previous;
  rmSync(temporary, { recursive: true, force: true });
}
