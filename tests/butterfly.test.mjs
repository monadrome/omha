import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { autoButterfly, detectDrift } from '../lib/butterfly.mjs';
import { createRuntime } from '../lib/runner.mjs';

const reliable = JSON.parse(
  readFileSync(new URL('./fixtures/butterfly-reliable.json', import.meta.url), 'utf8'),
);
const root = temp();
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);

test('reliable chronological rework supports a visible boundary and a standalone updated prompt', async () => {
  const result = await autoButterfly(cwd, reliable, { handoff: true, backend: 'file' });
  assert.equal(result.status, 'supported');
  assert.equal(result.conversationRewound, false);
  assert.equal(result.decisions[0].rewindBoundary.actionId, 'draft');
  assert.equal(result.decisions[0].evidence[0].feedbackEvent, 'feedback');
  assert.match(result.decisions[0].updatedPrompt, /Compare measured costs/);
  assert.equal(result.handoffs[0].state, 'awaiting');
});

test('ordinary evolution, post-version requirements, no content change and missing history are no-op fixtures', () => {
  const ordinary = structuredClone(reliable);
  ordinary.transcript.at(-1).reason = 'ordinary_evolution';
  const later = structuredClone(reliable);
  later.transcript[1].order = 3;
  later.transcript[3].order = 4;
  later.transcript[4].order = 5;
  later.transcript.sort((a, b) => a.order - b.order);
  const identical = structuredClone(reliable);
  identical.transcript.at(-1).hash = identical.transcript[2].hash;
  const missing = { version: 1, artifacts: reliable.artifacts, transcript: [] };
  for (const fixture of [ordinary, later, identical, missing]) {
    const result = detectDrift(fixture);
    assert.equal(result.status, 'no_op');
    assert.equal(result.decisions.length, 0);
  }
  const unordered = structuredClone(reliable);
  unordered.transcript.reverse();
  assert.throws(() => detectDrift(unordered), /chronological/);
});

test('independent artifact drifts retain separate causal boundaries', () => {
  const fixture = structuredClone(reliable);
  fixture.artifacts.push({ id: 'code', path: 'api.mjs' });
  fixture.transcript.push(
    ...reliable.transcript.slice(1).map((e) => ({
      ...e,
      id: `code-${e.id}`,
      order: e.order + 10,
      artifactId: 'code',
      feedbackId: e.feedbackId ? `code-${e.feedbackId}` : undefined,
      requirementIds: e.requirementIds?.map((r) => `code-${r}`),
    })),
  );
  const result = detectDrift(fixture);
  assert.equal(result.independentBoundaries, true);
  assert.deepEqual(
    result.decisions.map((d) => d.rewindBoundary.actionId),
    ['draft', 'code-draft'],
  );
});

test('sensitive history is redacted before prompts, handoffs or audit persistence', async () => {
  const fixture = structuredClone(reliable);
  fixture.transcript[1].text +=
    ' Contact private@example.invalid; api_key: confidential-credential-value';
  const result = await autoButterfly(cwd, fixture, { handoff: true, backend: 'file' });
  const persisted = readFileSync(result.file, 'utf8');
  for (const sensitive of ['private@example.invalid', 'confidential-credential-value'])
    assert.equal(persisted.includes(sensitive), false);
  assert.match(persisted, /REDACTED/);
  assert.match(persisted, /PRIVATE/);
});

test('analysis actually invokes the retained butterfly contract and rejects unsupported rewinds', async () => {
  const runtime = createRuntime(
    config({
      analyst: fake(
        '{"decisions":[{"artifactId":"report","rewindActionId":"invented","updatedPrompt":"wrong"}]}',
      ),
    }),
    { persistent: false },
  );
  let prompt;
  const original = runtime.attempt.bind(runtime);
  runtime.attempt = (name, p, options) => {
    prompt = p;
    return original(name, p, options);
  };
  const result = await autoButterfly(cwd, reliable, {
    analyze: true,
    providers: ['analyst'],
    runtime,
  });
  assert.match(prompt, /Decision Contract/);
  assert.match(prompt, /No reliable drift or rewind point detected/);
  assert.equal(result.decisions[0].rewindBoundary.actionId, 'draft');
  assert.match(result.analysisValidation, /rejected/);
  const noOp = await autoButterfly(
    cwd,
    { ...reliable, transcript: [] },
    { analyze: true, providers: ['analyst'], runtime, handoff: true, backend: 'file' },
  );
  assert.equal(noOp.analysis, undefined);
  assert.equal(noOp.handoffs, undefined);
});
