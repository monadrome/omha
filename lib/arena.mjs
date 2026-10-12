import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, now, projectIdentity, stateHome } from './core.mjs';
import {
  atomicWrite,
  appendEvent,
  assertSafePath,
  ensureDir,
  jsonRead,
  lockDir,
  safeRead,
} from './storage.mjs';
import { assertNoSecrets, environment, redact } from './security.mjs';
import { check, OmhaError, id, keys, number, text } from './validation.mjs';
import { createRuntime, delay } from './runner.mjs';
import { loadConfig, validateProfiles } from './profiles.mjs';
import { killOwnedTree, processFingerprint, run } from './process.mjs';
import { invocation } from './adapters.mjs';
import { assertDigest, digestRecord, outside, readOpenArena } from './open-arena.mjs';
import { authorization, validateArenaSpec } from './arena-spec.mjs';
import {
  cloneBundle,
  git,
  inspectBundle,
  materializeArtifact,
  readArtifact,
  sealArtifact,
  snapshotFiles,
} from './arena-artifacts.mjs';
import { probeWriteExecutor, requireWriteExecutor, writePolicy } from './arena-isolation.mjs';

export { validateArenaSpec };
const pathsFor = (batchId) => {
  id(batchId, 'batch id');
  return { root: stateHome(), dir: join(stateHome(), 'arena', 'batches', batchId) };
};
const candidateDir = (paths, candidateId) => join(paths.dir, 'artifacts', candidateId);
const readState = (paths) => {
  const state = jsonRead(join(paths.dir, 'state.json'), null, paths.root);
  check(state?.version === 1, 'Arena batch does not exist', 'invalid_record');
  return state;
};
const timeoutReason = () => new OmhaError('timeout', 'Arena deadline reached');

function freezeConfig(cwd, options) {
  const config = options.profiles
    ? validateProfiles({ version: 1, profiles: options.profiles })
    : loadConfig(cwd, options.config);
  // Separate accidental memory/cache writes while keeping one host budget runtime.
  for (const profile of Object.values(config.profiles))
    profile.envAllowlist = [
      ...new Set([...profile.envAllowlist, 'HOME', 'TMPDIR', 'OMHA_HOME', 'XDG_CACHE_HOME']),
    ];
  assertNoSecrets(config);
  return config;
}

function checkInputs(state, paths) {
  const spec = jsonRead(join(paths.dir, 'execution.json'), null, paths.root);
  validateArenaSpec(spec);
  assertDigest(digestRecord(spec), state.specHash, 'Execution specification');
  const config = jsonRead(join(paths.dir, 'profiles.json'), null, paths.root);
  validateProfiles(config);
  assertDigest(digestRecord(config), state.configHash, 'Provider configuration');
  const knowledge = readOpenArena(spec.knowledgeId);
  assertDigest(knowledge.contextHash, state.knowledgeHash, 'Knowledge context');
  for (const entry of knowledge.manifest.files)
    assertDigest(
      hash(safeRead(join(paths.dir, 'public', entry.path), paths.root)),
      entry.hash,
      'Batch public reference',
    );
  assertDigest(
    hash(safeRead(join(paths.dir, 'context.md'), paths.root)),
    state.prefixHash,
    'Batch prefix',
  );
  assertDigest(hash(readFileSync(spec.bundle.path)), spec.bundle.hash, 'Original snapshot bundle');
  assertDigest(
    hash(readFileSync(join(paths.dir, 'snapshot.bundle'))),
    spec.bundle.hash,
    'Frozen snapshot bundle',
  );
  for (const criterion of spec.verification.criteria) {
    assertSafePath(criterion.harnessPath);
    assertDigest(
      hash(readFileSync(criterion.harnessPath)),
      criterion.harnessHash,
      'Original host harness',
    );
    assertDigest(
      hash(readFileSync(join(paths.dir, 'harness', criterion.id))),
      criterion.harnessHash,
      'Frozen host harness',
    );
    assertDigest(
      hash(readFileSync(criterion.command)),
      state.toolchain.commands[criterion.id],
      'Host verification executable',
    );
  }
  for (const contender of state.contenders) {
    const owner = jsonRead(join(paths.dir, 'owners', `${contender.id}.json`), null, paths.root);
    check(
      owner?.token === contender.ownerToken && owner.workspace === contender.workspace,
      'Workspace ownership changed',
      'integrity',
    );
    assertSafePath(contender.workspace, paths.root);
    check(
      contender.workspace === join(paths.dir, 'workspaces', contender.id),
      'Workspace registry escapes owned batch',
      'integrity',
    );
    if (contender.artifactDigest)
      readArtifact(candidateDir(paths, contender.id), contender.artifactDigest, paths.root);
  }
  return { spec, config, knowledge };
}

function summary(state) {
  return {
    version: 1,
    batchId: state.id,
    status: state.status,
    sourceProjectId: state.sourceProjectId,
    specHash: state.specHash,
    knowledgeId: state.knowledgeId,
    prefixHash: state.prefixHash,
    prefixBytes: state.prefixBytes,
    toolchain: state.toolchain,
    mode: 'report-only',
    securityMode: state.securityMode,
    isolation:
      state.securityMode === 'cooperative'
        ? 'Trusted host collaboration; does not prevent reads by the same OS user'
        : 'External executor policies and host-observed probes; containment depends on the executor',
    budget: {
      ...state.budget,
      ledger: state.ledger,
      cache: 'unknown',
      semantics: 'admission reservations, not a provider billing cap',
      reviewRequests: 0,
      recoveryRequests: 0,
    },
    candidates: state.contenders.map((contender) => ({
      id: contender.id,
      attempt: 1,
      status: contender.status,
      artifactDigest: contender.artifactDigest || null,
      verification: contender.verification || [],
      verificationCoverage: contender.verification?.length
        ? 'recorded-criteria-only'
        : 'unknown-no-host-criteria',
      uncertainty: contender.uncertainty || null,
    })),
    selected: null,
    retained: state.contenders.filter((item) => item.artifactDigest).map((item) => item.id),
    resolution: {
      by: 'host',
      source: 'report-only-default',
      apply: 'not-requested',
      result:
        state.status === 'cancelled'
          ? 'cancelled'
          : state.contenders.some((item) => item.status === 'produced')
            ? 'insufficient-evidence'
            : 'no-eligible-artifact',
    },
  };
}

async function verifyCandidate(state, contender, criterion, paths, spec, config, signal, onSpawn) {
  const artifact = readArtifact(
    candidateDir(paths, contender.id),
    contender.artifactDigest,
    paths.root,
  );
  const directory = join(paths.dir, 'verification', contender.id, criterion.id);
  materializeArtifact(artifact.files, directory, paths.root);
  const harness = join(paths.dir, 'harness', criterion.id);
  assertDigest(
    hash(readFileSync(criterion.harnessPath)),
    criterion.harnessHash,
    'Original host harness',
  );
  assertDigest(hash(readFileSync(harness)), criterion.harnessHash, 'Frozen host harness');
  assertDigest(
    hash(readFileSync(criterion.command)),
    state.toolchain.commands[criterion.id],
    'Host verification executable',
  );
  const before = digestRecord(snapshotFiles(directory));
  const runtimeDir = join(paths.dir, 'runtime', contender.id);
  let policyPath, specInvocation;
  const args = criterion.args.map((arg) => (arg === '{harness}' ? harness : arg));
  const profile = config.profiles[contender.profile];
  if (spec.securityMode === 'strict') {
    policyPath = join(paths.dir, 'policies', `${contender.id}-${criterion.id}.json`);
    writePolicy(
      policyPath,
      {
        workspace: directory,
        runtimeDir,
        publicDir: join(paths.dir, 'public'),
        sourceRoot: state.sourceRoot,
        sibling: state.contenders.find((item) => item.id !== contender.id).workspace,
        home: paths.root,
        isolation: { ...spec.isolation, readOnlyPaths: [...spec.isolation.readOnlyPaths, harness] },
      },
      paths.root,
    );
    requireWriteExecutor(profile, spec.isolation);
    specInvocation = invocation(
      { ...profile, adapter: 'command', command: criterion.command, args },
      '',
      { mode: 'write', sandboxPolicyPath: policyPath },
    );
  } else specInvocation = { command: criterion.command, args };
  const env = {
    PATH: process.env.PATH,
    HOME: join(runtimeDir, 'home'),
    TMPDIR: join(runtimeDir, 'tmp'),
    XDG_CACHE_HOME: join(runtimeDir, 'cache'),
    OMHA_HOME: join(runtimeDir, 'state'),
    LANG: 'C',
  };
  const result = await run(specInvocation.command, specInvocation.args, {
    cwd: directory,
    env,
    signal,
    timeoutMs: criterion.timeoutMs,
    maxOutputBytes: 1048576,
    onSpawn,
  });
  assertDigest(
    hash(readFileSync(criterion.harnessPath)),
    criterion.harnessHash,
    'Original host harness',
  );
  assertDigest(hash(readFileSync(harness)), criterion.harnessHash, 'Frozen host harness');
  const unchanged = before === digestRecord(snapshotFiles(directory));
  const log = redact(`${result.stdout}\n${result.stderr}`);
  const logPath = join(candidateDir(paths, contender.id), `${criterion.id}.log`);
  atomicWrite(logPath, log, paths.root);
  return {
    criterionId: criterion.id,
    targetTree: artifact.manifest.candidateTree,
    harnessHash: criterion.harnessHash,
    origin: 'host-observed',
    command: criterion.command,
    args,
    cwd: directory,
    executableHash: state.toolchain.commands[criterion.id],
    envHash: digestRecord({
      LANG: 'C',
      isolatedHome: true,
      isolatedTmp: true,
      isolatedCache: true,
    }),
    toolchain: { node: process.versions.node, platform: process.platform },
    exit: result.code,
    signal: result.signal,
    timeout: result.timedOut,
    cancelled: result.cancelled,
    logHash: hash(log),
    logBytes: Buffer.byteLength(log),
    result:
      result.outputLimited ||
      result.spawnError ||
      result.callbackError ||
      result.cancelled ||
      result.timedOut ||
      !unchanged
        ? 'unknown'
        : result.code === 0
          ? 'pass'
          : 'fail',
    scope: 'Fixed host harness on a materialized candidate; no deployment or root-cause inference',
    candidateModifiedByHarness: !unchanged,
  };
}

export async function runArena(cwd, input, options = {}) {
  check(process.platform !== 'win32', 'Arena implementation batches require Git/POSIX');
  const identity = projectIdentity(cwd);
  check(identity.kind === 'git', 'Arena implementation batches require a Git source repository');
  outside(stateHome(), identity.root);
  const spec = validateArenaSpec(input);
  const config = freezeConfig(cwd, options);
  const knowledge = readOpenArena(spec.knowledgeId);
  check(
    knowledge.manifest.metadata.semanticReview.status === 'approved',
    'Execution requires an approved knowledge-boundary review',
  );
  for (const contender of spec.contenders) {
    const profile = config.profiles[contender.profile];
    check(profile, 'Unknown contender profile');
    check(profile.sandbox !== 'read-only', 'Arena contender requires a write profile');
    if (spec.securityMode === 'strict') requireWriteExecutor(profile, spec.isolation);
  }
  check(
    !options.offlineCollector ||
      spec.contenders.every((item) => config.profiles[item.profile].adapter === 'fake'),
    'Offline artifact injection requires fake adapters',
  );
  const batchId = options.batchId || randomUUID(),
    paths = pathsFor(batchId);
  check(!existsSync(paths.dir), 'Arena batch already exists; use resume', 'conflict');
  ensureDir(paths.dir, paths.root);
  const release = lockDir(join(paths.dir, 'execution.lock'), {
    root: paths.root,
    staleMs: 0,
    timeoutMs: 50,
  });
  const controller = new AbortController();
  let timer, poll, runtime;
  const state = {
    version: 1,
    id: batchId,
    startedAt: now(),
    deadlineAt: Date.now() + spec.deadlineMs,
    status: 'preparing',
    sourceRoot: identity.root,
    sourceProjectId: identity.projectId,
    knowledgeId: knowledge.id,
    knowledgeHash: knowledge.contextHash,
    specHash: digestRecord(spec),
    configHash: digestRecord(config),
    securityMode: spec.securityMode,
    toolchain: { node: process.versions.node, platform: process.platform, git: null, commands: {} },
    contenders: [],
    ledger: {},
    budget: {
      account: { requests: 0, tokens: 0, costUsd: 0, estimatedRequests: 0 },
      profileAccounts: {},
    },
  };
  const persist = (kind, detail = {}) => {
    if (runtime) state.budget = runtime.snapshot();
    atomicWrite(join(paths.dir, 'state.json'), JSON.stringify(state, null, 2), paths.root);
    appendEvent(join(paths.dir, 'events.jsonl'), { kind, at: now(), ...detail }, paths.root);
    options.onEvent?.({ kind, batchId, ...detail });
  };
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    atomicWrite(join(paths.dir, 'execution.json'), JSON.stringify(spec, null, 2), paths.root);
    atomicWrite(join(paths.dir, 'profiles.json'), JSON.stringify(config, null, 2), paths.root);
    assertSafePath(spec.bundle.path);
    check(
      lstatSync(spec.bundle.path).size <= 16 * 1024 * 1024,
      'Snapshot bundle exceeds size limit',
      'payload_limit',
    );
    const bundle = readFileSync(spec.bundle.path);
    assertDigest(hash(bundle), spec.bundle.hash, 'Original snapshot bundle');
    atomicWrite(join(paths.dir, 'snapshot.bundle'), bundle, paths.root);
    inspectBundle(
      join(paths.dir, 'snapshot.bundle'),
      spec.bundle,
      join(paths.dir, 'repository'),
      paths.root,
    );
    state.toolchain.git = git(paths.dir, ['--version']).trim();
    const prefix = `Omha independent implementation context v1\nsource_project_id: ${identity.projectId}\nbase_commit: ${spec.bundle.baseCommit}\nbase_tree: ${spec.bundle.baseTree}\n\n${knowledge.context}`;
    state.prefixHash = hash(prefix);
    state.prefixBytes = Buffer.byteLength(prefix);
    check(
      state.prefixBytes <= 2 * 1048576 + 4096,
      'Public prefix exceeds byte limit',
      'payload_limit',
    );
    atomicWrite(join(paths.dir, 'context.md'), prefix, paths.root);
    for (const entry of knowledge.manifest.files)
      atomicWrite(
        join(paths.dir, 'public', entry.path),
        safeRead(
          join(paths.root, 'arena', 'knowledge', knowledge.id, 'files', entry.path),
          paths.root,
        ),
        paths.root,
      );
    for (const criterion of spec.verification.criteria) {
      assertSafePath(criterion.harnessPath);
      const harness = readFileSync(criterion.harnessPath);
      assertDigest(hash(harness), criterion.harnessHash, 'Host harness');
      atomicWrite(join(paths.dir, 'harness', criterion.id), harness, paths.root);
      state.toolchain.commands[criterion.id] = hash(readFileSync(criterion.command));
    }
    for (let index = 0; index < spec.contenders.length; index += 1) {
      const candidateId = `candidate-${String.fromCharCode(65 + index)}`;
      const workspace = join(paths.dir, 'workspaces', candidateId);
      ensureDir(join(paths.dir, 'workspaces'), paths.root);
      cloneBundle(join(paths.dir, 'snapshot.bundle'), workspace, spec.bundle.baseCommit);
      const physical = projectIdentity(workspace);
      const contender = {
        id: candidateId,
        profile: spec.contenders[index].profile,
        workspace,
        ownerToken: randomUUID(),
        physicalProjectId: physical.projectId,
        worktreeId: physical.worktreeId,
        sessionId: `${batchId}-${candidateId}-1`,
        status: 'prepared',
      };
      state.contenders.push(contender);
      atomicWrite(
        join(paths.dir, 'owners', `${candidateId}.json`),
        JSON.stringify({
          token: contender.ownerToken,
          workspace,
          sourceProjectId: identity.projectId,
          physicalProjectId: physical.projectId,
          sessionId: contender.sessionId,
        }),
        paths.root,
      );
      for (const name of ['home', 'tmp', 'cache', 'state'])
        ensureDir(join(paths.dir, 'runtime', candidateId, name), paths.root);
      persist('workspace.prepared', { candidateId });
    }
    runtime = createRuntime(config, { budget: spec.budget });
    state.status = 'running';
    persist('batch.started');
    timer = setTimeout(
      () => controller.abort(timeoutReason()),
      Math.max(0, state.deadlineAt - Date.now()),
    );
    poll = setInterval(() => {
      if (existsSync(join(paths.dir, 'cancel.json'))) controller.abort();
    }, 25);
    const execute = async (contender) => {
      if (Date.now() >= state.deadlineAt) controller.abort(timeoutReason());
      const lane = new AbortController();
      const parentAbort = () => lane.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', parentAbort, { once: true });
      if (controller.signal.aborted || Date.now() >= state.deadlineAt)
        lane.abort(controller.signal.reason || timeoutReason());
      const laneTimer = setTimeout(() => lane.abort(timeoutReason()), spec.attemptTimeoutMs);
      try {
        const runtimeDir = join(paths.dir, 'runtime', contender.id);
        const envSource = {
          ...process.env,
          HOME: join(runtimeDir, 'home'),
          TMPDIR: join(runtimeDir, 'tmp'),
          XDG_CACHE_HOME: join(runtimeDir, 'cache'),
          OMHA_HOME: join(runtimeDir, 'state'),
        };
        const profile = config.profiles[contender.profile];
        let sandboxPolicyPath;
        if (spec.securityMode === 'strict') {
          ensureDir(join(paths.dir, 'probes'), paths.root);
          sandboxPolicyPath = join(paths.dir, 'policies', `${contender.id}.json`);
          const policy = writePolicy(
            sandboxPolicyPath,
            {
              workspace: contender.workspace,
              runtimeDir,
              publicDir: join(paths.dir, 'public'),
              sourceRoot: identity.root,
              sibling: state.contenders.find((item) => item.id !== contender.id).workspace,
              home: paths.root,
              isolation: spec.isolation,
            },
            paths.root,
          );
          contender.isolationEvidence = await probeWriteExecutor(
            profile,
            sandboxPolicyPath,
            policy,
            {
              env: environment(profile.envAllowlist, envSource),
              probeDir: join(paths.dir, 'probes'),
              signal: lane.signal,
            },
          );
          requireWriteExecutor(profile, spec.isolation);
        }
        const suffix = `\n\nExecution specification (separately authorized):\nobjective: ${spec.objective}\nallowed_paths: ${JSON.stringify(spec.allowedPaths)}\nsecurity_mode: ${spec.securityMode}\nworkspace: ${contender.workspace}\nknowledge_path: ${join(paths.dir, 'public')}\nattempt: 1\nsession: ${contender.sessionId}\nNo retries or fallback. Return an agent self-report; host verification is separate.\n`;
        contender.suffixBytes = Buffer.byteLength(suffix);
        check(
          contender.suffixBytes <= 131072,
          'Execution suffix exceeds byte limit',
          'payload_limit',
        );
        options.onPrompt?.({ candidateId: contender.id, prefix, suffix, cwd: contender.workspace });
        contender.status = 'running';
        persist('attempt.started', { candidateId: contender.id, attempt: 1 });
        const result = await runtime.attempt(contender.profile, prefix + suffix, {
          mode: 'write',
          cwd: contender.workspace,
          signal: lane.signal,
          timeoutMs: spec.attemptTimeoutMs,
          envSource,
          sandboxPolicyPath,
          onEvent: (event) => {
            contender.requestId = event.requestId;
            state.ledger[event.requestId] = {
              candidateId: contender.id,
              phase: 'implementation',
              status: 'active',
              admitted: {
                tokens: profile.budget.reserveTokens,
                costUsd: profile.budget.reserveCostUsd,
              },
              reportedUsage: null,
              cache: 'unknown',
            };
            persist('request.reserved', { candidateId: contender.id, requestId: event.requestId });
          },
          onSpawn: (pid) => {
            contender.process = { pid, fingerprint: processFingerprint(pid) };
            persist('process.spawned', { candidateId: contender.id, ...contender.process });
          },
        });
        clearTimeout(laneTimer);
        contender.result = result;
        if (contender.requestId)
          Object.assign(state.ledger[contender.requestId], {
            status: 'finished',
            reportedUsage: result.usage || null,
            usageStatus:
              !result.usage || result.usage.estimated ? 'estimated-or-unknown' : 'reported',
          });
        contender.status = result.ok
          ? 'produced'
          : result.failure === 'timeout'
            ? 'timed-out'
            : result.failure === 'cancellation'
              ? 'cancelled'
              : 'failed';
        if (result.failure === 'budget')
          controller.abort(new OmhaError('budget', 'Shared arena admission budget exceeded'));
        persist('attempt.finished', { candidateId: contender.id, status: contender.status });
        await options.offlineCollector?.({
          candidateId: contender.id,
          workspace: contender.workspace,
          result,
          signal: lane.signal,
        });
        const artifact = sealArtifact({
          workspace: contender.workspace,
          dir: candidateDir(paths, contender.id),
          repository: join(paths.dir, 'repository'),
          candidateId: contender.id,
          batchId,
          status: contender.status,
          baseCommit: spec.bundle.baseCommit,
          baseTree: spec.bundle.baseTree,
          allowedPaths: spec.allowedPaths,
          root: paths.root,
          executionSpecHash: state.specHash,
        });
        contender.artifactDigest = artifact.digest;
        persist('artifact.sealed', { candidateId: contender.id, digest: artifact.digest });
        contender.verification = [];
        for (const criterion of spec.verification.criteria) {
          if (Date.now() >= state.deadlineAt) controller.abort(timeoutReason());
          if (contender.status !== 'produced' || controller.signal.aborted)
            contender.verification.push({
              criterionId: criterion.id,
              targetTree: artifact.candidateTree,
              harnessHash: criterion.harnessHash,
              result: 'unknown',
              origin: 'host',
              reason: 'Attempt incomplete or batch stopped',
            });
          else {
            persist('verification.started', {
              candidateId: contender.id,
              criterionId: criterion.id,
            });
            contender.verification.push(
              await verifyCandidate(
                state,
                contender,
                criterion,
                paths,
                spec,
                config,
                controller.signal,
                (pid) => {
                  contender.verificationProcess = {
                    pid,
                    fingerprint: processFingerprint(pid),
                    criterionId: criterion.id,
                    active: true,
                  };
                  persist('verification.process.spawned', {
                    candidateId: contender.id,
                    ...contender.verificationProcess,
                  });
                },
              ),
            );
            if (contender.verificationProcess) contender.verificationProcess.active = false;
          }
        }
        persist('verification.finished', { candidateId: contender.id });
      } catch (error) {
        contender.status = lane.signal.aborted
          ? lane.signal.reason?.code === 'timeout'
            ? 'timed-out'
            : 'cancelled'
          : 'failed';
        contender.uncertainty = {
          code: error.code || 'error',
          message: redact(error.message),
          artifactCertified: Boolean(contender.artifactDigest),
        };
        contender.verification ||= [];
        for (const criterion of spec.verification.criteria)
          if (!contender.verification.some((entry) => entry.criterionId === criterion.id))
            contender.verification.push({
              criterionId: criterion.id,
              result: 'unknown',
              origin: 'host',
              reason: 'Attempt or verification did not complete',
            });
        persist('attempt.unresolved', { candidateId: contender.id, code: error.code || 'error' });
      } finally {
        clearTimeout(laneTimer);
        controller.signal.removeEventListener('abort', parentAbort);
      }
    };
    // One in-flight operation per lane bounds providers and verification together.
    if (spec.parallelism === 1) for (const contender of state.contenders) await execute(contender);
    else {
      const outcomes = await Promise.allSettled(state.contenders.map(execute));
      check(
        outcomes.every((outcome) => outcome.status === 'fulfilled'),
        'Host persistence failed during arena execution',
        'interrupted',
      );
    }
    if (Date.now() >= state.deadlineAt) controller.abort(timeoutReason());
    state.status =
      controller.signal.aborted && controller.signal.reason?.code !== 'budget'
        ? controller.signal.reason?.code === 'timeout'
          ? 'timed-out'
          : 'cancelled'
        : state.contenders.every((item) => item.status === 'produced')
          ? 'completed'
          : 'completed-with-partial-results';
    state.completedAt = now();
    persist('batch.finished', { status: state.status });
    atomicWrite(
      join(paths.dir, 'report.json'),
      JSON.stringify(summary(state), null, 2),
      paths.root,
    );
    return arenaStatus(batchId);
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    options.signal?.removeEventListener('abort', abort);
    release();
  }
}

export function arenaStatus(batchId) {
  const paths = pathsFor(batchId),
    state = readState(paths);
  checkInputs(state, paths);
  return { ...summary(state), reportPath: join(paths.dir, 'report.json') };
}

export function cancelArena(batchId) {
  const paths = pathsFor(batchId),
    state = readState(paths);
  atomicWrite(
    join(paths.dir, 'cancel.json'),
    JSON.stringify({ at: now(), requestedBy: 'host-api' }),
    paths.root,
  );
  for (const contender of state.contenders)
    for (const owned of [
      contender.status === 'running' ? contender.process : null,
      contender.verificationProcess?.active ? contender.verificationProcess : null,
    ])
      if (owned) killOwnedTree(owned.pid, owned.fingerprint);
  return { batchId, cancellationRequested: true, evidenceRetained: true };
}

export async function resumeArena(batchId, options = {}) {
  const paths = pathsFor(batchId);
  const release = lockDir(join(paths.dir, 'execution.lock'), {
    root: paths.root,
    staleMs: 0,
    timeoutMs: 50,
  });
  try {
    const state = readState(paths),
      { spec } = checkInputs(state, paths);
    if (options.spec)
      assertDigest(
        digestRecord(validateArenaSpec(options.spec)),
        state.specHash,
        'Supplied execution specification',
      );
    if (
      ['completed', 'completed-with-partial-results', 'cancelled', 'timed-out'].includes(
        state.status,
      )
    )
      return arenaStatus(batchId);
    for (const contender of state.contenders) {
      for (const owned of [
        contender.status === 'running' ? contender.process : null,
        contender.verificationProcess?.active ? contender.verificationProcess : null,
      ]) {
        if (owned?.fingerprint && processFingerprint(owned.pid) === owned.fingerprint) {
          killOwnedTree(owned.pid, owned.fingerprint);
          await delay(180);
          killOwnedTree(owned.pid, owned.fingerprint, 'SIGKILL');
        }
      }
      if (contender.verificationProcess) contender.verificationProcess.active = false;
      if (contender.artifactDigest) {
        contender.verification ||= [];
        for (const criterion of spec.verification.criteria)
          if (!contender.verification.some((entry) => entry.criterionId === criterion.id))
            contender.verification.push({
              criterionId: criterion.id,
              result: 'unknown',
              origin: 'host',
              reason: 'Host interrupted before verification; sealed artifact retained',
            });
      } else {
        contender.status = 'interrupted';
        contender.uncertainty = {
          reason: 'Unsealed write workspace retained; no automatic replay',
          cleanup: 'Fingerprint-checked process group cleanup; escaped processes remain unverified',
          workspace: existsSync(contender.workspace) ? 'retained' : 'missing',
        };
      }
    }
    for (const entry of Object.values(state.ledger))
      if (entry.status === 'active') {
        entry.status = 'uncertain';
        entry.usageStatus = 'estimated-or-unknown';
      }
    state.status = 'completed-with-partial-results';
    state.completedAt = now();
    atomicWrite(join(paths.dir, 'state.json'), JSON.stringify(state, null, 2), paths.root);
    appendEvent(
      join(paths.dir, 'events.jsonl'),
      { kind: 'batch.recovered', at: now(), replayed: false },
      paths.root,
    );
    atomicWrite(
      join(paths.dir, 'report.json'),
      JSON.stringify(summary(state), null, 2),
      paths.root,
    );
    return arenaStatus(batchId);
  } finally {
    release();
  }
}

export function arenaReviewPacket(batchId) {
  const paths = pathsFor(batchId),
    state = readState(paths),
    { spec, config } = checkInputs(state, paths);
  check(
    ['completed', 'completed-with-partial-results', 'cancelled', 'timed-out'].includes(
      state.status,
    ),
    'Review packet requires all attempts to be terminal',
  );
  const pathIdentities = [
    state.sourceRoot,
    paths.dir,
    ...state.contenders.map((item) => item.workspace),
  ];
  const identities = [
    ...new Set([
      ...Object.values(config.profiles)
        .flatMap((profile) => [profile.name, profile.model])
        .filter((value) => value.length >= 4),
      ...state.contenders
        .flatMap((item) => [item.result?.requestedModel, item.result?.servedModel])
        .filter((value) => value?.length >= 4),
    ]),
  ];
  let baseline = '';
  try {
    baseline = git(join(paths.dir, 'repository'), [
      'grep',
      '-I',
      '-h',
      '-e',
      '.',
      spec.bundle.baseTree,
      '--',
    ]);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const candidates = state.contenders.map((contender) => {
    if (!contender.artifactDigest)
      return {
        id: contender.id,
        status: contender.status,
        artifact: null,
        verification: [],
        coverage: 'unknown',
      };
    const { manifest, files } = readArtifact(
      candidateDir(paths, contender.id),
      contender.artifactDigest,
      paths.root,
      join(paths.dir, 'repository'),
    );
    const patchBytes = safeRead(
      join(candidateDir(paths, contender.id), 'patch.diff'),
      paths.root,
      null,
    );
    const patch = manifest.patchEncoding === 'utf8' ? patchBytes.toString('utf8') : null;
    const verification = (contender.verification || []).map(({ command, args, cwd, ...entry }) => {
      entry.cwd = `verification/${contender.id}/${entry.criterionId}`;
      if (entry.logHash) {
        const log = safeRead(
          join(candidateDir(paths, contender.id), `${entry.criterionId}.log`),
          paths.root,
        );
        assertDigest(hash(log), entry.logHash, 'Verification log');
        return { ...entry, log };
      }
      return entry;
    });
    const publicFiles = files.map(({ content, ...file }) => ({ ...file, content }));
    const decoded = files
      .map((file) => Buffer.from(file.content, 'base64').toString('utf8'))
      .join('\n');
    const envelope = JSON.stringify({ manifest, patch, verification });
    const added =
      patch
        ?.split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .join('\n') || '';
    const explicit = added
      .split('\n')
      .filter((line) =>
        /(?:requested|served)(?:Model|Profile)|implemented by|author\s*[:=]/i.test(line),
      )
      .join('\n');
    check(
      !pathIdentities.some(
        (identity) => decoded.includes(identity) || envelope.includes(identity),
      ) &&
        !identities.some(
          (identity) =>
            (!baseline.includes(identity) &&
              (decoded.includes(identity) || envelope.includes(identity))) ||
            explicit.includes(identity) ||
            verification.some((entry) => entry.log?.includes(identity)),
        ),
      'Explicit identity leakage in review artifact',
      'identity_leak',
    );
    return {
      id: contender.id,
      status: contender.status,
      artifact: manifest,
      patch,
      patchBase64: manifest.patchEncoding === 'base64' ? patchBytes.toString('base64') : null,
      files: publicFiles,
      verification,
      coverage: 'complete-file-inventory',
    };
  });
  const packet = {
    version: 1,
    batchId,
    specHash: state.specHash,
    criteria: spec.verification.criteria.map((criterion) => ({
      id: criterion.id,
      harnessHash: criterion.harnessHash,
    })),
    candidates,
    selected: null,
    modelReviewRequests: 0,
  };
  return { ...packet, digest: digestRecord(packet) };
}

export function validateArenaReview(packet, review) {
  keys(review, ['authorization', 'assessments'], 'arena review record');
  authorization(review.authorization, 'review authorization');
  check(
    Buffer.byteLength(JSON.stringify(review)) <= 1048576,
    'Review record exceeds size limit',
    'payload_limit',
  );
  check(
    digestRecord(Object.fromEntries(Object.entries(packet).filter(([key]) => key !== 'digest'))) ===
      packet.digest,
    'Review packet digest changed',
    'integrity',
  );
  check(Array.isArray(review.assessments), 'Review assessments are required');
  for (const assessment of review.assessments) {
    keys(
      assessment,
      [
        'candidateId',
        'criterionId',
        'artifactDigest',
        'result',
        'confidence',
        'reason',
        'risks',
        'tradeoffs',
        'anchors',
      ],
      'review assessment',
    );
    if (assessment.confidence !== undefined)
      number(assessment.confidence, 'review confidence', 0, 1, false);
    if (assessment.reason !== undefined) text(assessment.reason, 'review reason', 10000);
    for (const key of ['risks', 'tradeoffs'])
      if (assessment[key] !== undefined) {
        check(
          Array.isArray(assessment[key]) && assessment[key].length <= 32,
          `review ${key} must be a bounded array`,
        );
        assessment[key].forEach((value) => text(value, `review ${key}`, 10000));
      }
    const candidate = packet.candidates.find((item) => item.id === assessment.candidateId);
    check(candidate?.artifact, 'Unknown or unavailable review candidate', 'invalid_record');
    check(
      packet.criteria.some((criterion) => criterion.id === assessment.criterionId),
      'Unknown review criterion',
      'invalid_record',
    );
    assertDigest(
      assessment.artifactDigest,
      digestRecord(candidate.artifact),
      'Review artifact anchor',
    );
    check(
      ['pass', 'fail', 'unknown', 'not-applicable'].includes(assessment.result),
      'Invalid review result',
    );
    check(
      Array.isArray(assessment.anchors) && assessment.anchors.length > 0,
      'Review requires evidence anchors',
    );
    for (const anchor of assessment.anchors) {
      keys(anchor, ['path', 'criterionId', 'hash', 'line', 'quote'], 'review anchor');
      check(
        Boolean(anchor.path) !== Boolean(anchor.criterionId),
        'Review anchor requires exactly one file or log target',
        'invalid_record',
      );
      const file = anchor.path ? candidate.files.find((item) => item.path === anchor.path) : null;
      const log = anchor.criterionId
        ? candidate.verification.find(
            (item) => item.criterionId === anchor.criterionId && typeof item.log === 'string',
          )
        : null;
      check(
        (file && anchor.hash === file.hash) || (log && anchor.hash === log.logHash),
        'Unknown or changed file/log anchor',
        'invalid_record',
      );
      if (anchor.line === undefined && anchor.quote === undefined) continue;
      check(!file?.binary, 'Binary files require a whole-file hash anchor', 'invalid_record');
      const lines = (file ? Buffer.from(file.content, 'base64').toString('utf8') : log.log).split(
        '\n',
      );
      check(
        Number.isInteger(anchor.line) &&
          anchor.line >= 1 &&
          anchor.line <= lines.length &&
          lines[anchor.line - 1] === anchor.quote,
        'Review line/quote is outside the artifact',
        'invalid_record',
      );
    }
  }
  assertNoSecrets(review);
  return { ...review, packetDigest: packet.digest, apply: 'not-requested' };
}

export function recordArenaReview(batchId, review) {
  const packet = arenaReviewPacket(batchId);
  const validated = validateArenaReview(packet, review);
  const paths = pathsFor(batchId);
  const record = { version: 1, batchId, recordedAt: now(), ...validated };
  const digest = digestRecord(record);
  atomicWrite(
    join(paths.dir, 'reviews', `${digest}.json`),
    JSON.stringify(record, null, 2),
    paths.root,
  );
  appendEvent(
    join(paths.dir, 'events.jsonl'),
    {
      kind: 'review.recorded',
      at: now(),
      digest,
      packetDigest: packet.digest,
      source: review.authorization.source,
    },
    paths.root,
  );
  return { ...record, digest };
}
