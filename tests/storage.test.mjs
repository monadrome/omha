import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { linkSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temp } from './helpers.mjs';
import { atomicWrite, safeRead } from '../lib/storage.mjs';
import { writeMemory, doctorMemory, readMemory } from '../lib/memory.mjs';

function launch(t, source, env = process.env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
  const ready = Promise.race([
    new Promise((resolve) => child.once('message', resolve)),
    done.then((result) => {
      throw new Error(`Fixture exited before readiness: ${JSON.stringify(result)}`);
    }),
  ]);
  return { child, ready, done };
}

test('concurrent atomic replacement preserves complete snapshots and rejects actual hardlinks', async (t) => {
  const root = temp('omha-atomic-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'snapshot.json');
  const data = 'x'.repeat(8192);
  atomicWrite(file, JSON.stringify({ writer: -1, data }), root);
  const module = pathToFileURL(join(process.cwd(), 'lib', 'storage.mjs')).href;
  const writers = Array.from({ length: 4 }, (_, writer) =>
    launch(
      t,
      `import { atomicWrite } from ${JSON.stringify(module)};
       process.once('message', () => {
         for (let i = 0; i < 50; i++)
           atomicWrite(${JSON.stringify(file)}, JSON.stringify({writer:${writer},data:'x'.repeat(8192)}), ${JSON.stringify(root)});
         process.disconnect();
       });
       process.send('ready');`,
    ),
  );
  await Promise.all(writers.map((writer) => writer.ready));
  writers.forEach((writer) => writer.child.send('start'));
  for (let i = 0; i < 2000; i++) assert.equal(JSON.parse(safeRead(file, root)).data, data);
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.ok(
    results.every((result) => result.code === 0),
    JSON.stringify(results),
  );
  assert.equal(JSON.parse(safeRead(file, root)).data, data);
  assert.deepEqual(readdirSync(root), ['snapshot.json']);
  if (process.platform !== 'win32') {
    linkSync(file, join(root, 'hardlink.json'));
    assert.throws(() => safeRead(file, root), { code: 'unsafe_path' });
    assert.throws(() => atomicWrite(file, 'replacement', root), { code: 'unsafe_path' });
  }
});

test('simultaneous expected-hash writers admit exactly one update and retain a consistent index', async (t) => {
  const root = temp('omha-cas-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const before = process.env.OMHA_HOME;
  process.env.OMHA_HOME = join(root, 'state');
  t.after(() => {
    if (before === undefined) delete process.env.OMHA_HOME;
    else process.env.OMHA_HOME = before;
  });
  const first = writeMemory(cwd, { name: 'shared', content: 'initial' });
  const module = pathToFileURL(join(process.cwd(), 'lib', 'memory.mjs')).href;
  const writers = Array.from({ length: 8 }, (_, writer) =>
    launch(
      t,
      `import { writeMemory } from ${JSON.stringify(module)};
       process.once('message', () => {
         try {
           writeMemory(${JSON.stringify(cwd)}, {name:'shared',content:'writer ${writer}',expectedHash:${JSON.stringify(first.hash)}});
         } catch (error) {
           if (error.code === 'memory_conflict') process.exitCode = 2;
           else { console.error(error); process.exitCode = 1; }
         }
         process.disconnect();
       });
       process.send('ready');`,
    ),
  );
  await Promise.all(writers.map((writer) => writer.ready));
  writers.forEach((writer) => writer.child.send('start'));
  const results = await Promise.all(writers.map((writer) => writer.done));
  assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.code === 2).length, 7, JSON.stringify(results));
  assert.equal(doctorMemory(cwd).ok, true);
  assert.match(readMemory(cwd, 'shared'), /writer [0-7]/);
});
