import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, now, projectDir, stateHome } from './core.mjs';
import { atomicWrite, ensureDir, readEvents } from './storage.mjs';
import { assertNoSecrets, redactData } from './security.mjs';
import { check, choice, id, keys, number, object, text } from './validation.mjs';
import { dispatch } from './runner.mjs';
import { forkHandoff, handoff, validateFork } from './terminal.mjs';

const contractFile = fileURLToPath(new URL('../skills/butterfly-effect/SKILL.md', import.meta.url));
const sourceFile = fileURLToPath(
  new URL('../skills/butterfly-effect/references/source-resolution.md', import.meta.url),
);
const KINDS = [
  'objective',
  'requirement',
  'action',
  'produce',
  'feedback',
  'accept',
  'rework',
  'status',
];

export function validateButterfly(policy = {}) {
  keys(
    policy,
    ['enabled', 'handoff', 'backend', 'maxHandoffs', 'maxObservations', 'forks'],
    'butterfly policy',
  );
  const value = {
    enabled: true,
    handoff: true,
    backend: 'file',
    maxHandoffs: 3,
    maxObservations: 256,
    ...policy,
  };
  for (const key of ['enabled', 'handoff'])
    check(typeof value[key] === 'boolean', `butterfly ${key} must be boolean`);
  choice(value.backend, ['file', 'auto', 'cmux', 'tmux'], 'butterfly backend');
  number(value.maxHandoffs, 'butterfly maxHandoffs', 0, 3);
  number(value.maxObservations, 'butterfly maxObservations', 1, 1000);
  if (value.forks !== undefined) {
    object(value.forks, 'butterfly forks');
    check(Object.keys(value.forks).length <= 256, 'Too many butterfly fork bindings');
    for (const [taskId, spec] of Object.entries(value.forks)) {
      id(taskId, 'butterfly fork task id');
      validateFork(spec);
      id(spec.actionId, 'butterfly fork action id');
    }
  }
  return value;
}

function privateRedaction(value) {
  const safe = redactData(value);
  const visit = (input) => {
    if (typeof input === 'string')
      return input.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[PRIVATE]');
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object')
      return Object.fromEntries(Object.entries(input).map(([key, val]) => [key, visit(val)]));
    return input;
  };
  return visit(safe);
}

export function validateHistory(input) {
  keys(input, ['version', 'artifacts', 'transcript'], 'butterfly input');
  check(input.version === 1, 'Butterfly input version must be 1');
  check(
    Array.isArray(input.artifacts) && input.artifacts.length > 0 && input.artifacts.length <= 64,
    'Butterfly requires 1-64 artifacts',
  );
  check(
    Array.isArray(input.transcript) && input.transcript.length <= 10000,
    'Butterfly requires a chronological transcript array',
  );
  const artifacts = new Set();
  for (const artifact of input.artifacts) {
    keys(artifact, ['id', 'path'], 'artifact');
    id(artifact.id, 'artifact id');
    check(!artifacts.has(artifact.id), 'Duplicate artifact');
    artifacts.add(artifact.id);
    if (artifact.path !== undefined) text(artifact.path, 'artifact path', 4096);
  }
  const events = new Set();
  let lastOrder = -1;
  const versions = new Set();
  for (const event of input.transcript) {
    keys(
      event,
      [
        'id',
        'order',
        'actor',
        'kind',
        'text',
        'artifactId',
        'versionId',
        'hash',
        'replaces',
        'requirementIds',
        'feedbackId',
        'causeActionId',
        'reason',
        'authority',
      ],
      'transcript event',
    );
    id(event.id, 'event id');
    check(!events.has(event.id), 'Duplicate transcript event');
    events.add(event.id);
    number(event.order, 'event order', 0, 100000000);
    check(event.order > lastOrder, 'Transcript must be strictly chronological');
    lastOrder = event.order;
    choice(event.actor, ['user', 'agent', 'host'], 'transcript actor');
    choice(event.kind, KINDS, 'transcript kind');
    if (event.actor === 'host') {
      choice(event.kind, ['requirement', 'feedback', 'accept'], 'host history kind');
      keys(event.authority, ['source', 'policyHash', 'artifactHash', 'exitCode'], 'host authority');
      check(event.authority.source === 'acceptance', 'Unsupported host history authority');
      check(/^[a-f0-9]{64}$/.test(event.authority.policyHash), 'Missing host policy hash');
      if (event.kind !== 'requirement') {
        check(/^[a-f0-9]{64}$/.test(event.authority.artifactHash), 'Missing host artifact hash');
        number(event.authority.exitCode, 'host acceptance exitCode', 0, 255);
        check(
          (event.kind === 'accept') === (event.authority.exitCode === 0),
          'Host feedback must anchor a failed acceptance check',
        );
      }
    } else check(event.authority === undefined, 'Only host events may carry authority');
    if (event.text !== undefined) text(event.text, 'event text', 100000);
    if (event.artifactId !== undefined)
      check(artifacts.has(event.artifactId), 'Unknown event artifact');
    if (event.requirementIds !== undefined)
      check(
        Array.isArray(event.requirementIds) &&
          event.requirementIds.every((x) => typeof x === 'string'),
        'requirementIds must be IDs',
      );
    for (const key of ['versionId', 'replaces', 'feedbackId', 'causeActionId'])
      if (event[key] !== undefined) id(event[key], key);
    if (['produce', 'rework'].includes(event.kind)) {
      check(
        event.actor === 'agent' &&
          event.artifactId &&
          event.versionId &&
          /^[a-f0-9]{64}$/.test(event.hash),
        'Artifact production needs agent, artifactId, versionId and SHA-256',
      );
      const key = `${event.artifactId}:${event.versionId}`;
      check(!versions.has(key), 'Duplicate artifact version');
      versions.add(key);
    }
    if (['objective', 'requirement', 'feedback', 'accept'].includes(event.kind))
      check(
        (event.actor === 'user' || (event.actor === 'host' && event.kind !== 'objective')) &&
          event.text,
        'Authoritative history event requires user text or host acceptance evidence',
      );
    if (event.kind === 'rework')
      choice(event.reason, ['missed_requirement', 'ordinary_evolution'], 'rework reason');
  }
  return privateRedaction(input);
}

export function detectDrift(input) {
  const history = validateHistory(input);
  const events = history.transcript;
  const decisions = [],
    noOps = [];
  const objective = events.find((e) => e.kind === 'objective');
  for (const artifact of history.artifacts) {
    const drifts = [];
    for (const rework of events.filter(
      (e) => e.kind === 'rework' && e.artifactId === artifact.id,
    )) {
      const prior = events.find(
        (e) =>
          ['produce', 'rework'].includes(e.kind) &&
          e.artifactId === artifact.id &&
          e.versionId === rework.replaces &&
          e.order < rework.order,
      );
      const feedback = events.find(
        (e) =>
          e.id === rework.feedbackId &&
          e.kind === 'feedback' &&
          e.artifactId === artifact.id &&
          e.versionId === rework.replaces &&
          e.order > (prior?.order ?? Infinity) &&
          e.order < rework.order,
      );
      const requirements = (rework.requirementIds || []).map((name) =>
        events.find(
          (e) =>
            e.id === name &&
            e.kind === 'requirement' &&
            (!e.artifactId || e.artifactId === artifact.id),
        ),
      );
      const cause = feedback?.causeActionId
        ? events.find(
            (e) =>
              e.id === feedback.causeActionId &&
              e.actor === 'agent' &&
              ['action', 'produce', 'rework'].includes(e.kind) &&
              e.order <= (prior?.order ?? -1) &&
              e.artifactId === artifact.id,
          )
        : prior;
      let gap = null;
      if (!objective) gap = 'Missing original objective';
      else if (rework.reason === 'ordinary_evolution')
        gap = 'Ordinary evolution after acceptance or new requirements';
      else if (!prior || !feedback || !cause)
        gap = 'Missing produced version, authoritative feedback, or visible causal action';
      else if (prior.hash === rework.hash) gap = 'No artifact rework: identical content hash';
      else if (
        feedback.actor === 'host' &&
        (feedback.authority.artifactHash !== prior.hash ||
          requirements.some(
            (r) => r?.actor !== 'host' || r.authority.policyHash !== feedback.authority.policyHash,
          ))
      )
        gap = 'Host feedback does not match the produced artifact and original acceptance policy';
      else if (
        !requirements.length ||
        requirements.some(
          (r) => !r || r.order >= prior.order || !(feedback.requirementIds || []).includes(r.id),
        )
      )
        gap =
          'Feedback does not anchor a missed requirement that existed before the produced version';
      else if (
        events.some(
          (e) =>
            e.kind === 'accept' &&
            e.artifactId === artifact.id &&
            e.versionId === prior.versionId &&
            e.order > prior.order &&
            e.order < feedback.order,
        )
      )
        gap = 'Accepted artifact followed by ordinary evolution';
      if (gap) {
        noOps.push({ artifactId: artifact.id, eventId: rework.id, reason: gap });
        continue;
      }
      drifts.push({ rework, prior, feedback, cause, requirements });
    }
    if (!drifts.length) continue;
    drifts.sort((a, b) => a.cause.order - b.cause.order);
    const boundary = drifts[0].cause;
    const constraints = events.filter(
      (e) => e.kind === 'requirement' && (!e.artifactId || e.artifactId === artifact.id),
    );
    const accepted = events.filter((e) => e.kind === 'accept' && e.artifactId === artifact.id);
    const updatedPrompt = `Objective: ${objective.text}\n\nArtifact: ${artifact.path || artifact.id}\nBefore continuing, inspect the artifact and relevant history, reproduce the reported failure, and verify each constraint. Treat later discoveries as checks to perform.\n\nConstraints:\n${constraints.map((e) => `- ${e.text}`).join('\n')}\n\nAccepted decisions to retain:\n${accepted.length ? accepted.map((e) => `- ${e.text}`).join('\n') : '- Retain the original objective and supported choices.'}\n\nVerify the resulting artifact before claiming completion.`;
    decisions.push({
      artifactId: artifact.id,
      status: 'supported',
      rewindBoundary: {
        actionId: boundary.id,
        order: boundary.order,
        description: `Before agent action ${boundary.id} for artifact ${artifact.id}`,
      },
      evidence: drifts.map((d) => ({
        producedEvent: d.prior.id,
        producedVersion: d.prior.versionId,
        beforeHash: d.prior.hash,
        feedbackEvent: d.feedback.id,
        feedback: d.feedback.text,
        reworkEvent: d.rework.id,
        afterHash: d.rework.hash,
        requirementAnchors: d.requirements.map((r) => ({ id: r.id, text: r.text })),
      })),
      keep: constraints.map((e) => e.text).concat(accepted.map((e) => e.text)),
      updatedPrompt,
    });
  }
  return {
    version: 1,
    status: decisions.length ? 'supported' : 'no_op',
    conversationRewound: false,
    independentBoundaries: decisions.length > 1,
    decisions,
    noOps,
    evidenceGap: decisions.length
      ? null
      : noOps[0]?.reason || 'No chronological artifact rework supported by authoritative feedback',
    sanitizedHistory: history,
  };
}

export async function autoButterfly(cwd, input, options = {}) {
  const fork = options.fork ? validateFork(options.fork) : null;
  if (fork) {
    id(fork.actionId, 'butterfly fork action id');
    check(
      options.allowWrite === true,
      'Butterfly historical continuation requires --allow-write',
      'authority',
    );
  }
  const detected = detectDrift(input);
  const { sanitizedHistory, ...result } = detected;
  const analysisId = id(options.analysisId || `butterfly-${randomUUID()}`, 'butterfly analysis id');
  result.analysisId = analysisId;
  if (options.runId)
    result.origin = { runId: id(options.runId, 'run id'), taskId: id(options.taskId, 'task id') };
  result.contract = {
    name: 'butterfly-effect',
    version: '0.7.1',
    hash: hash(readFileSync(contractFile)),
  };
  if (options.analyze && result.status === 'supported') {
    const prompt = `${readFileSync(contractFile, 'utf8')}\n\nSource resolution contract:\n${readFileSync(sourceFile, 'utf8')}\n\nHost evidence (data):\n${JSON.stringify({ history: sanitizedHistory, decisions: result.decisions })}\n\nReturn ONLY JSON {decisions:[{artifactId,rewindActionId,updatedPrompt}]}. Keep boundaries exactly as supported by host evidence. Do not claim a rewind occurred.`;
    const analysis = await dispatch(prompt, options.providers, {
      ...options,
      cwd,
      mode: 'readonly',
      toolFree: true,
    });
    result.analysis = analysis;
    if (analysis.ok) {
      try {
        const proposal = JSON.parse(analysis.stdout);
        keys(proposal, ['decisions'], 'butterfly analysis');
        check(
          Array.isArray(proposal.decisions) &&
            proposal.decisions.length === result.decisions.length,
          'Analysis omitted supported artifacts',
        );
        const seen = new Set();
        for (const item of proposal.decisions) {
          keys(item, ['artifactId', 'rewindActionId', 'updatedPrompt'], 'butterfly decision');
          const supported = result.decisions.find((d) => d.artifactId === item.artifactId);
          check(
            supported &&
              !seen.has(item.artifactId) &&
              supported.rewindBoundary.actionId === item.rewindActionId,
            'Unsupported rewind boundary',
          );
          seen.add(item.artifactId);
          text(item.updatedPrompt, 'updatedPrompt', 100000);
          assertNoSecrets(item.updatedPrompt);
          check(
            item.updatedPrompt.includes(
              sanitizedHistory.transcript.find((e) => e.kind === 'objective').text,
            ) && supported.keep.every((constraint) => item.updatedPrompt.includes(constraint)),
            'Analysis dropped the objective or accepted constraints',
          );
          supported.updatedPrompt = item.updatedPrompt;
        }
      } catch {
        result.analysisValidation =
          'Provider analysis rejected; retained evidence-based host recommendations';
      }
    }
  }
  if ((options.handoff || fork) && result.status === 'supported') {
    result.handoffs = [];
    if (fork)
      check(
        result.decisions.length === 1 &&
          result.decisions[0].rewindBoundary.actionId === fork.actionId,
        'Fork binding does not match the detected causal boundary',
        'authority',
      );
    for (const decision of result.decisions)
      result.handoffs.push(
        fork
          ? await forkHandoff(cwd, decision.updatedPrompt, fork, options)
          : await handoff(cwd, decision.updatedPrompt, {
              backend: options.backend || 'auto',
              timeoutMs: options.handoffTimeoutMs,
            }),
      );
  }
  ensureDir(join(projectDir(cwd), 'butterfly'), stateHome());
  const file = join(projectDir(cwd), 'butterfly', `${analysisId}.json`);
  const persisted = privateRedaction({ ...result, at: now() });
  atomicWrite(file, JSON.stringify(persisted, null, 2), stateHome());
  return { ...persisted, file };
}

// Only completed, stable host checks describe an acceptance miss. Transport and
// harness failures are observation gaps, never inferred feedback about the task.
function stableAcceptance(acceptance) {
  return (
    acceptance &&
    /^[a-f0-9]{64}$/.test(acceptance.policyHash) &&
    /^[a-f0-9]{64}$/.test(acceptance.artifactHash) &&
    acceptance.artifactHash === acceptance.afterArtifactHash &&
    acceptance.artifactUnchanged === true &&
    acceptance.policyUnchanged === true &&
    !acceptance.failure &&
    Number.isInteger(acceptance.exitCode) &&
    acceptance.exitCode >= 0 &&
    acceptance.exitCode <= 255 &&
    !acceptance.signal &&
    !acceptance.timedOut &&
    !acceptance.cancelled &&
    !acceptance.outputLimited &&
    !acceptance.spawnError &&
    !acceptance.callbackError &&
    acceptance.accepted === (acceptance.exitCode === 0)
  );
}

export function observeButterfly({
  task,
  result,
  beforeHash,
  attempt,
  policyHash,
  events,
  emit,
  policy,
}) {
  if (!policy.enabled || task.mode !== 'write' || !task.acceptance) return;
  const count = events.filter((entry) => entry.kind === 'butterfly.observed').length;
  if (count >= policy.maxObservations) {
    if (!events.some((entry) => entry.kind === 'butterfly.limit'))
      emit({ kind: 'butterfly.limit', maxObservations: policy.maxObservations });
    return;
  }
  const acceptance = result.acceptance;
  const { command, args, ...acceptanceMetadata } = acceptance || {};
  const valid =
    result.executionOk === true &&
    stableAcceptance(acceptance) &&
    acceptance.policyHash === policyHash &&
    /^[a-f0-9]{64}$/.test(beforeHash);
  emit({
    kind: 'butterfly.observed',
    taskId: task.id,
    attempt,
    beforeHash: beforeHash || null,
    resultHash: hash(JSON.stringify(redactData(result))),
    responseHash: result.responseHash || null,
    valid,
    evidenceGap: valid ? null : 'Missing stable host acceptance or pre-execution artifact evidence',
    acceptance: valid ? acceptanceMetadata : null,
  });
}

function lifecycleHistory(plan, task, observations, policyHash, runId) {
  const artifactId = task.id;
  const history = {
    version: 1,
    artifacts: [{ id: artifactId, path: `Worktree output of Omha run ${runId}, task ${task.id}` }],
    transcript: [],
  };
  const add = (event) => history.transcript.push({ ...event, order: history.transcript.length });
  add({ id: 'objective', actor: 'user', kind: 'objective', text: plan.objective });
  for (const [index, chunk] of (plan.publicContext.match(/[\s\S]{1,25000}/gu) || []).entries()) {
    if (!chunk.trim()) continue;
    add({
      id: `context-${index}`,
      actor: 'user',
      kind: 'requirement',
      text: chunk,
    });
  }
  const requirementId = 'host-acceptance';
  add({
    id: requirementId,
    actor: 'host',
    kind: 'requirement',
    artifactId,
    text: `Pass the original host acceptance check for task ${task.id}: ${JSON.stringify({ command: task.acceptance.command, args: task.acceptance.args })}. Inspect the task instructions and frozen harness before continuing; preserve the harness and verify the resulting worktree.`,
    authority: { source: 'acceptance', policyHash },
  });
  let previous;
  for (const observation of observations) {
    if (!observation.valid || observation.acceptance?.policyHash !== policyHash) {
      previous = null;
      continue;
    }
    const acceptance = observation.acceptance;
    check(stableAcceptance(acceptance), 'Invalid butterfly observation', 'corrupt_state');
    if (observation.beforeHash === acceptance.artifactHash) {
      if (acceptance.accepted || previous?.acceptance.artifactHash !== acceptance.artifactHash)
        previous = null;
      continue;
    }
    const versionId = `attempt-${observation.attempt}`;
    const eventId = `produced-${observation.attempt}`;
    const rework =
      previous &&
      !previous.acceptance.accepted &&
      observation.beforeHash === previous.acceptance.artifactHash;
    add({ id: `action-${observation.attempt}`, actor: 'agent', kind: 'action', artifactId });
    add({
      id: eventId,
      actor: 'agent',
      kind: rework ? 'rework' : 'produce',
      artifactId,
      versionId,
      hash: acceptance.artifactHash,
      ...(rework
        ? {
            replaces: `attempt-${previous.attempt}`,
            feedbackId: `checked-${previous.attempt}`,
            requirementIds: [requirementId],
            reason: 'missed_requirement',
          }
        : {}),
    });
    add({
      id: `checked-${observation.attempt}`,
      actor: 'host',
      kind: acceptance.accepted ? 'accept' : 'feedback',
      artifactId,
      versionId,
      requirementIds: [requirementId],
      ...(acceptance.accepted ? {} : { causeActionId: `action-${observation.attempt}` }),
      text: `Frozen host acceptance check ${acceptance.accepted ? 'passed' : 'failed'} with exit code ${acceptance.exitCode}; re-run it against the resulting artifact.`,
      authority: {
        source: 'acceptance',
        policyHash,
        artifactHash: acceptance.artifactHash,
        exitCode: acceptance.exitCode,
      },
    });
    previous = observation;
  }
  return history;
}

export async function processButterfly(
  cwd,
  { plan, paths, runId, emit, signal, acceptancePolicies, allowWrite, nativeForkApproved = false },
) {
  const policy = validateButterfly(plan.butterfly);
  if (!policy.enabled) return;
  let events = readEvents(paths.events, paths.root);
  for (const task of plan.tasks.filter((item) => item.mode === 'write' && item.acceptance)) {
    const observations = events.filter(
      (entry) => entry.kind === 'butterfly.observed' && entry.taskId === task.id,
    );
    if (!observations.length) continue;
    const policyHash = hash(JSON.stringify(acceptancePolicies[task.id]));
    let history, detected;
    try {
      history = lifecycleHistory(plan, task, observations, policyHash, runId);
      detected = detectDrift(history);
    } catch (error) {
      if (error.code !== 'configuration') throw error;
      const observationHash = hash(JSON.stringify(observations));
      if (
        !events.some(
          (entry) =>
            entry.kind === 'butterfly.skipped' &&
            entry.taskId === task.id &&
            entry.observationHash === observationHash,
        )
      )
        emit({
          kind: 'butterfly.skipped',
          taskId: task.id,
          observationHash,
          evidenceGap: 'Lifecycle evidence exceeds the chronological history contract',
        });
      continue;
    }
    const decision = detected.decisions[0];
    if (!decision) continue;
    const fork = policy.forks?.[task.id];
    const reworkId = decision.evidence.at(-1).reworkEvent;
    const analysisId = `butterfly-${hash(`${runId}:${task.id}:${reworkId}`).slice(0, 32)}`;
    const recorded = events.some(
      (entry) => entry.kind === 'butterfly.detected' && entry.analysisId === analysisId,
    );
    if (!recorded) {
      const report = await autoButterfly(cwd, history, { analysisId, runId, taskId: task.id });
      emit({
        kind: 'butterfly.detected',
        taskId: task.id,
        analysisId,
        file: report.file,
        rewindBoundary: decision.rewindBoundary,
        evidence: decision.evidence,
      });
    }
    const requested = events.filter((entry) => entry.kind === 'butterfly.handoff_requested');
    if (
      !policy.handoff ||
      signal?.aborted ||
      requested.length >= policy.maxHandoffs ||
      requested.some((entry) => entry.analysisId === analysisId)
    )
      continue;
    if (
      fork &&
      (allowWrite !== true ||
        !nativeForkApproved ||
        fork.actionId !== decision.rewindBoundary.actionId)
    ) {
      emit({
        kind: 'butterfly.skipped',
        taskId: task.id,
        analysisId,
        evidenceGap:
          'Native fork requires completed host gates, write authorization and an exact causal action binding',
      });
      continue;
    }
    // Claim before the side effect. A crash leaves an observable uncertain action
    // that is never automatically repeated, even when no terminal result exists.
    const handoffId = `handoff-${analysisId}`;
    emit({
      kind: 'butterfly.handoff_requested',
      taskId: task.id,
      analysisId,
      handoffId,
      backend: fork ? 'cmux' : policy.backend,
    });
    try {
      const result = fork
        ? await forkHandoff(cwd, decision.updatedPrompt, fork, {
            id: handoffId,
            signal,
            allowWrite,
          })
        : await handoff(cwd, decision.updatedPrompt, {
            id: handoffId,
            backend: policy.backend,
            signal,
          });
      emit({
        kind: !['running', 'awaiting'].includes(result.state)
          ? 'butterfly.handoff_failed'
          : 'butterfly.handed_off',
        taskId: task.id,
        analysisId,
        handoffId: result.id,
        backend: result.backend,
        state: result.state,
      });
    } catch (error) {
      emit({
        kind: 'butterfly.handoff_failed',
        taskId: task.id,
        analysisId,
        handoffId,
        failure: error.code || 'handoff',
      });
    }
    events = readEvents(paths.events, paths.root);
  }
}
