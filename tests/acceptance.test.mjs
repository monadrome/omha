import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { executePlan } from '../lib/orchestrator.mjs';

const root = temp('omha-acceptance-');
process.env.OMHA_HOME = join(root, 'state');
const plan = (acceptance) => ({
  version: 1,
  objective: 'Verify artifact',
  tasks: [
    {
      id: 'job',
      role: 'verify',
      prompt: 'Implement',
      profile: 'p',
      mode: 'readonly',
      acceptance,
    },
  ],
});
const runtime = () => createRuntime(config({ p: fake('completed') }), { persistent: false });
const resultOf = (status) => JSON.parse(readFileSync(join(status.dir, 'job.result.json'), 'utf8'));

test('acceptance binds immutable harness and artifact digests and detects modified candidates', async () => {
  const cwd = temp('omha-accepted-project-');
  const artifact = join(cwd, 'source.txt');
  const harness = join(root, 'harness.mjs');
  writeFileSync(artifact, 'original');
  writeFileSync(harness, 'process.exit(0)');
  const rt = runtime();
  const spec = { command: process.execPath, args: [harness], harnessFiles: [harness] };
  const accepted = await executePlan(cwd, plan(spec), { runtime: rt });
  const evidence = resultOf(accepted).acceptance;
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.artifactHash, evidence.afterArtifactHash);
  assert.equal(evidence.policyUnchanged, true);
  writeFileSync(harness, `require('node:fs').writeFileSync(${JSON.stringify(artifact)},'changed')`);
  spec.args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(artifact)},'changed')`];
  const modified = await executePlan(cwd, plan(spec), { runtime: rt });
  assert.equal(modified.status, 'failed');
  assert.equal(resultOf(modified).executionOk, true);
  assert.equal(resultOf(modified).acceptance.artifactUnchanged, false);
});

test('provider changes to frozen harness are rejected before the acceptance process starts', async () => {
  const cwd = temp('omha-harness-project-');
  const harness = join(cwd, 'verify.mjs');
  const marker = join(root, 'must-not-run');
  writeFileSync(harness, 'process.exit(1)');
  const rt = runtime(),
    attempt = rt.attempt.bind(rt);
  rt.attempt = async (...args) => {
    writeFileSync(harness, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
    return attempt(...args);
  };
  const status = await executePlan(
    cwd,
    plan({
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
      harnessFiles: [harness],
    }),
    { runtime: rt },
  );
  assert.equal(status.status, 'failed');
  assert.equal(resultOf(status).acceptance.failure, 'acceptance_policy');
  assert.equal(resultOf(status).acceptance.exitCode, undefined);
  assert.equal(existsSync(marker), false);
});

test('acceptance cannot rewrite its own frozen harness and still pass', async () => {
  const cwd = temp('omha-self-modifying-check-');
  const harness = join(root, 'self-modifying.cjs');
  writeFileSync(harness, "require('node:fs').writeFileSync(__filename,'process.exit(0)')");
  const status = await executePlan(cwd, plan({ command: process.execPath, args: [harness] }), {
    runtime: runtime(),
  });
  assert.equal(status.status, 'failed');
  assert.equal(resultOf(status).acceptance.artifactUnchanged, true);
  assert.equal(resultOf(status).acceptance.policyUnchanged, false);
});

test('resume rejects changed host policy hashes before any worker starts', async () => {
  const cwd = temp('omha-policy-project-'),
    rt = runtime();
  const first = await executePlan(
    cwd,
    plan({ command: process.execPath, args: ['-e', 'process.exit(0)'] }),
    { runtime: rt },
  );
  const savedFile = join(first.dir, 'plan.json');
  const saved = JSON.parse(readFileSync(savedFile, 'utf8'));
  saved.acceptancePolicies.job.files[0].hash = 'changed';
  writeFileSync(savedFile, JSON.stringify(saved));
  await assert.rejects(
    executePlan(cwd, null, { runtime: rt, resume: true, runId: first.runId }),
    /Immutable acceptance policy/,
  );
  assert.equal(rt.fakeOffsets.get('p'), 1);
});

test('unsupported or oversized artifacts cannot become accepted exit-zero results', async () => {
  for (const kind of ['symlink', 'oversized']) {
    const cwd = temp('omha-unsupported-project-');
    if (kind === 'symlink') symlinkSync(process.execPath, join(cwd, 'linked'));
    else writeFileSync(join(cwd, 'large'), Buffer.alloc(1048577));
    const status = await executePlan(
      cwd,
      plan({ command: process.execPath, args: ['-e', 'process.exit(0)'] }),
      { runtime: runtime() },
    );
    assert.equal(status.status, 'failed');
    assert.equal(resultOf(status).acceptance.accepted, false);
  }
});
