import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp, fake } from './helpers.mjs';
import { hash } from '../lib/core.mjs';
import {
  ARENA_LABELS,
  ARENA_LIMITS,
  importOpenArena,
  readOpenArena,
  digestRecord,
} from '../lib/open-arena.mjs';
import {
  runArena,
  arenaStatus,
  cancelArena,
  resumeArena,
  arenaReviewPacket,
  validateArenaReview,
  recordArenaReview,
  validateArenaSpec,
} from '../lib/arena.mjs';
import { git, snapshotFiles } from '../lib/arena-artifacts.mjs';
import { invocation } from '../lib/adapters.mjs';
import { validateProfiles } from '../lib/profiles.mjs';
import { delay } from '../lib/runner.mjs';
import { forkStatus, forkTree, runFork } from '../lib/fork.mjs';
import {
  assertSealedForkRoot,
  forkNames,
  FORK_NAME_PATTERN,
  sanitizeForkName,
} from '../lib/session-fork.mjs';

const time = '2026-10-10T12:00:00.000Z';
const authorization = { by: 'fixture-user', source: 'offline-fixture-authorization', at: time };
const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const crashFixture = fileURLToPath(new URL('./fixtures/arena-crash.mjs', import.meta.url));

function knowledgeFixture(root) {
  const directory = join(root, 'knowledge');
  mkdirSync(join(directory, 'references'), { recursive: true });
  const body = `# Domain knowledge\n\nShared knowledge boundary.\n[Snapshot](references/domain.md)\n\n${ARENA_LABELS.map((label, index) => `${label}: statement-${index}.`).join('\n')}\n`;
  writeFileSync(join(directory, 'OPEN_ARENA.md'), body);
  writeFileSync(
    join(directory, 'references', 'domain.md'),
    '# Snapshot\nHistorical reference; deployment remains unknown.\n',
  );
  const metadata = {
    version: 1,
    authority: {
      requirementId: 'fixture-domain',
      generatedAt: time,
      worktree: 'logical-source',
      branch: 'baseline',
      baseline: 'fixture-base',
      revision: 'fixture-revision',
      sourcePrecedence: ['current user instruction', 'source snapshot', 'historical reference'],
    },
    sources: [
      {
        path: 'OPEN_ARENA.md',
        origin: 'reviewed-domain-document',
        snapshotAt: time,
        revision: 'fixture-revision',
        status: 'current',
      },
      {
        path: 'references/domain.md',
        origin: 'historical-domain-document',
        snapshotAt: time,
        revision: 'prior-revision',
        status: 'historical',
      },
    ],
    evidence: ARENA_LABELS.map((label, index) => ({
      id: `e${index}`,
      label,
      path: 'OPEN_ARENA.md',
      quote: `${label}: statement-${index}.`,
    })),
    semanticReview: {
      status: 'approved',
      ...authorization,
      knowledgeOnly: true,
      noEvidencePromotion: true,
    },
  };
  return { directory, metadata };
}

function fixture({ criteria = true, profiles } = {}) {
  const root = temp('omha-arena-');
  process.env.OMHA_HOME = join(root, 'state');
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, ['init', '--quiet', '-b', 'main']);
  writeFileSync(join(source, 'app.txt'), 'baseline\n');
  writeFileSync(join(source, 'delete.txt'), 'retained baseline\n');
  writeFileSync(join(source, 'mode.txt'), 'mode fixture\n');
  git(source, ['add', '.']);
  git(source, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'baseline',
  ]);
  const baseCommit = git(source, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(source, ['rev-parse', 'HEAD^{tree}']).trim();
  git(source, ['branch', 'baseline']);
  const objectIds = git(source, ['rev-list', '--objects', baseCommit])
    .trim()
    .split('\n')
    .map((line) => line.split(' ')[0])
    .sort();
  const bundle = join(root, 'snapshot.bundle');
  git(source, ['bundle', 'create', bundle, 'refs/heads/baseline']);
  writeFileSync(join(source, 'reference-solution.txt'), 'host-private reference solution\n');
  git(source, ['add', '.']);
  git(source, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'excluded reference',
  ]);
  const forbidden = git(source, ['rev-parse', 'HEAD']).trim();
  const knowledge = knowledgeFixture(root);
  const imported = importOpenArena(knowledge.directory, knowledge.metadata, { sourceCwd: source });
  const harness = join(root, 'host-harness.mjs');
  writeFileSync(
    harness,
    "import {readFileSync} from 'node:fs'; if (!readFileSync('app.txt','utf8').startsWith('implementation')) process.exit(1); console.log('host criterion observed');\n",
  );
  const spec = {
    version: 1,
    authorization,
    objective: 'Implement the explicitly authorized fixture behavior.',
    knowledgeId: imported.id,
    bundle: {
      path: bundle,
      hash: hash(readFileSync(bundle)),
      baseCommit,
      baseTree,
      allowedRefs: [{ ref: 'refs/heads/baseline', commit: baseCommit }],
      objectIds,
      forbiddenObjectIds: [forbidden],
    },
    contenders: [{ profile: 'alpha' }, { profile: 'beta' }],
    allowedPaths: ['.'],
    securityMode: 'cooperative',
    deadlineMs: 10000,
    attemptTimeoutMs: 3000,
    parallelism: 2,
    budget: {
      maxRequests: 2,
      maxTokens: 100,
      maxCostUsd: 2,
      reserveTokens: 10,
      reserveCostUsd: 0.1,
    },
    verification: {
      authorization: { ...authorization, source: 'fixed-host-harness-approval' },
      criteria: criteria
        ? [
            {
              id: 'behavior',
              command: process.execPath,
              args: ['{harness}'],
              harnessPath: harness,
              harnessHash: hash(readFileSync(harness)),
              timeoutMs: 1000,
            },
          ]
        : [],
    },
  };
  const providers = profiles || {
    alpha: fake('Agent self-report only.', {
      sandbox: 'workspace-write',
      model: 'fixture-model-alpha',
      responses: [
        { output: 'Agent self-report only.', latencyMs: 60, usage: { tokens: 12, costUsd: 0.2 } },
      ],
    }),
    beta: fake('Agent self-report only.', {
      sandbox: 'workspace-write',
      model: 'fixture-model-beta',
      responses: [
        { output: 'Agent self-report only.', latencyMs: 60, usage: { tokens: 11, costUsd: 0.2 } },
      ],
    }),
  };
  return {
    root,
    source,
    knowledge,
    imported,
    harness,
    spec,
    profiles: providers,
    forbidden,
    batchDir: (id) => join(root, 'state', 'arena', 'batches', id),
  };
}
const inject = ({ workspace, candidateId }) => {
  writeFileSync(join(workspace, 'app.txt'), `implementation ${candidateId}\n`);
  writeFileSync(join(workspace, `${candidateId}.txt`), 'Untracked fixture output\n');
};
const jsonFile = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('arena import freezes six evidence labels and source authority without execution or repository writes', () => {
  const f = fixture();
  assert.deepEqual(
    f.imported.manifest.metadata.evidence.map((entry) => entry.label),
    ARENA_LABELS,
  );
  assert.equal(f.imported.manifest.metadata.sources[1].status, 'historical');
  assert.match(f.imported.context, /Unresolved/);
  assert.match(f.imported.context, /deployment remains unknown/);
  assert.equal(git(f.source, ['status', '--porcelain']), '');
  assert.equal(existsSync(join(f.root, 'state', 'runtime')), false);
  assert.equal(existsSync(join(f.root, 'state', 'arena', 'batches')), false);
  const metadataFile = join(f.root, 'metadata.json');
  writeFileSync(metadataFile, JSON.stringify(f.knowledge.metadata));
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        'arena',
        'import',
        '--cwd',
        f.source,
        '--source',
        f.knowledge.directory,
        '--input',
        metadataFile,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(output.id, f.imported.id);
  assert.equal(readOpenArena(output.id).contextHash, f.imported.contextHash);
});

test('arena knowledge rejects changed references, missing dependencies, paths, links, size and source promotion', () => {
  const f = fixture();
  writeFileSync(join(f.knowledge.directory, 'references', 'domain.md'), 'changed');
  assert.throws(() => readOpenArena(f.imported.id), /hash changed/);
  const fresh = knowledgeFixture(join(f.root, 'fresh'));
  writeFileSync(join(fresh.directory, 'OPEN_ARENA.md'), '# Knowledge\n[Escape](../outside.md)\n');
  assert.throws(() => importOpenArena(fresh.directory, fresh.metadata), /escapes|Missing/);
  writeFileSync(
    join(fresh.directory, 'OPEN_ARENA.md'),
    '# Knowledge\n[Missing](references/missing.md)\n',
  );
  assert.throws(() => importOpenArena(fresh.directory, fresh.metadata), /Missing/);
  const linked = knowledgeFixture(join(f.root, 'linked'));
  symlinkSync(join(f.root, 'host-harness.mjs'), join(linked.directory, 'references', 'linked.md'));
  assert.throws(() => importOpenArena(linked.directory, linked.metadata), /Symlinks/);
  rmSync(join(linked.directory, 'references', 'linked.md'));
  linkSync(join(f.root, 'host-harness.mjs'), join(linked.directory, 'references', 'hard.md'));
  assert.throws(() => importOpenArena(linked.directory, linked.metadata), /Hardlinked/);
  const big = knowledgeFixture(join(f.root, 'big'));
  writeFileSync(
    join(big.directory, 'references', 'domain.md'),
    'x'.repeat(ARENA_LIMITS.fileBytes + 1),
  );
  assert.throws(() => importOpenArena(big.directory, big.metadata), /size limit/);
  const promotion = knowledgeFixture(join(f.root, 'promotion'));
  promotion.metadata.sources[0].status = 'unresolved';
  assert.throws(
    () => importOpenArena(promotion.directory, promotion.metadata),
    /cannot become current/,
  );
  assert.throws(() => importOpenArena(join(f.root, 'absent'), {}), /ENOENT/);
  const prior = process.env.OMHA_HOME;
  process.env.OMHA_HOME = join(f.source, '.state');
  assert.throws(
    () => importOpenArena(promotion.directory, promotion.metadata, { sourceCwd: f.source }),
    /outside/,
  );
  process.env.OMHA_HOME = prior;
});

test('arena credential rejection and explicit redaction retain distinct original and frozen hashes', () => {
  const f = fixture();
  const original = readFileSync(join(f.knowledge.directory, 'references', 'domain.md'), 'utf8');
  writeFileSync(
    join(f.knowledge.directory, 'references', 'domain.md'),
    `${original}\napi_key=sk-offlineFixtureValue123456\n`,
  );
  assert.throws(() => importOpenArena(f.knowledge.directory, f.knowledge.metadata), /Credentials/);
  const redacted = importOpenArena(f.knowledge.directory, f.knowledge.metadata, {
    secretPolicy: 'redact',
  });
  const reference = redacted.manifest.files.find((entry) => entry.path === 'references/domain.md');
  assert.equal(reference.redacted, true);
  assert.notEqual(reference.rawHash, reference.hash);
  assert.match(redacted.context, /REDACTED/);
  assert.equal(redacted.context.includes('sk-offlineFixtureValue123456'), false);
  assert.match(
    readFileSync(join(f.knowledge.directory, 'references', 'domain.md'), 'utf8'),
    /sk-offline/,
  );
});

test('arena independent fake attempts share exact final prefix and preserve Git/source/memory boundaries', async () => {
  const f = fixture(),
    captures = [],
    starts = new Set();
  let overlap = false;
  const before = digestRecord(snapshotFiles(f.source));
  const result = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    onPrompt: (capture) => captures.push(capture),
    onEvent: (event) => {
      if (event.kind === 'request.reserved') {
        starts.add(event.candidateId);
        overlap ||= starts.size === 2;
      }
      if (event.kind === 'attempt.finished') starts.delete(event.candidateId);
    },
    offlineCollector: (entry) => {
      inject(entry);
      if (entry.candidateId === 'candidate-A') {
        git(entry.workspace, ['add', '.']);
        git(entry.workspace, [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture candidate',
        ]);
      }
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(overlap, true);
  assert.equal(captures.length, 2);
  assert.equal(captures[0].prefix, captures[1].prefix);
  assert.equal(hash(captures[0].prefix), result.prefixHash);
  assert.equal(Buffer.byteLength(captures[0].prefix), result.prefixBytes);
  assert.equal(captures[0].prefix.includes(captures[0].cwd), false);
  assert.equal(captures[0].prefix.includes('memory_index:'), false);
  assert.ok(captures[0].suffix.includes(captures[0].cwd));
  assert.equal(digestRecord(snapshotFiles(f.source)), before);
  assert.equal(git(f.source, ['status', '--porcelain']), '');
  const commitA = git(captures[0].cwd, ['rev-parse', 'HEAD']).trim();
  assert.throws(() => git(captures[1].cwd, ['cat-file', '-e', commitA]));
  for (const capture of captures) {
    assert.throws(() => git(capture.cwd, ['cat-file', '-e', f.forbidden]));
    assert.equal(existsSync(join(capture.cwd, 'reference-solution.txt')), false);
    assert.equal(git(capture.cwd, ['remote']), '');
    assert.equal(existsSync(join(capture.cwd, '.git', 'objects', 'info', 'alternates')), false);
  }
  const state = jsonFile(join(f.batchDir(result.batchId), 'state.json'));
  assert.notEqual(state.contenders[0].physicalProjectId, state.contenders[1].physicalProjectId);
  assert.notEqual(state.contenders[0].sessionId, state.contenders[1].sessionId);
  assert.deepEqual(
    result.candidates.map((item) => item.verification[0].result),
    ['pass', 'pass'],
  );
  assert.equal(result.selected, null);
  assert.deepEqual(result.retained, ['candidate-A', 'candidate-B']);
  assert.equal(result.budget.account.requests, 2);
  assert.equal(result.budget.reviewRequests, 0);
  assert.equal(result.budget.cache, 'unknown');
  const packet = arenaReviewPacket(result.batchId);
  assert.equal(packet.modelReviewRequests, 0);
  assert.equal(JSON.stringify(packet).includes('fixture-model-alpha'), false);
  assert.equal(JSON.stringify(packet).includes(f.source), false);
  assert.notEqual(
    packet.candidates[0].artifact.baseTree,
    packet.candidates[0].artifact.candidateTree,
  );
});

test('arena bundle refs and complete objects fail closed, including unapproved reference history', async () => {
  const f = fixture({ criteria: false });
  const incorrect = structuredClone(f.spec);
  incorrect.bundle.objectIds.pop();
  await assert.rejects(runArena(f.source, incorrect, { profiles: f.profiles }), /object inventory/);
  const refs = structuredClone(f.spec);
  refs.bundle.allowedRefs[0].ref = 'refs/heads/unapproved';
  await assert.rejects(runArena(f.source, refs, { profiles: f.profiles }), /refs differ/);
  const forbidden = structuredClone(f.spec);
  forbidden.bundle.forbiddenObjectIds.push(f.spec.bundle.baseCommit);
  await assert.rejects(
    runArena(f.source, forbidden, { profiles: f.profiles }),
    /excluded reference/,
  );
  const nonGit = temp();
  await assert.rejects(runArena(nonGit, f.spec, { profiles: f.profiles }), /Git source/);
  assert.throws(
    () => validateArenaSpec({ ...f.spec, contenders: [{ profile: 'alpha' }] }),
    /between 2 and 8/,
  );
  assert.throws(
    () =>
      validateArenaSpec({
        ...f.spec,
        contenders: Array.from({ length: 9 }, () => ({ profile: 'alpha' })),
      }),
    /between 2 and 8/,
  );
});

test('arena strict rejects absent or unverified write executors before provider reservations', async () => {
  const f = fixture({ criteria: false });
  f.spec.securityMode = 'strict';
  await assert.rejects(
    runArena(f.source, f.spec, { profiles: f.profiles }),
    /write-capable external executor/,
  );
  assert.equal(existsSync(join(f.root, 'state', 'runtime')), false);
  const wrapper = join(f.root, 'unenforced-executor');
  writeFileSync(
    wrapper,
    "#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const [policy,command,...args]=process.argv.slice(2);const child=spawn(command,args,{stdio:'inherit'});child.on('exit',code=>process.exit(code ?? 1));\n",
  );
  chmodSync(wrapper, 0o700);
  f.spec.isolation = {
    authorization,
    executorHash: hash(readFileSync(wrapper)),
    readOnlyPaths: ['/usr'],
    excludedPaths: [f.knowledge.directory],
  };
  const profiles = Object.fromEntries(
    ['alpha', 'beta'].map((name) => [
      name,
      {
        adapter: 'command',
        command: process.execPath,
        args: ['-e', 'console.log("local fixture")'],
        model: 'local-offline-command',
        sandbox: 'external',
        sandboxWrite: true,
        sandboxCommand: wrapper,
        sandboxArgs: ['{policy}', '{command}', '{args}'],
        budget: { reserveTokens: 10, reserveCostUsd: 0 },
      },
    ]),
  );
  const profile = validateProfiles({ version: 1, profiles }).profiles.alpha;
  assert.equal(
    invocation(profile, 'text', { mode: 'write', sandboxPolicyPath: '/host-policy' }).command,
    wrapper,
  );
  const result = await runArena(f.source, f.spec, { profiles });
  assert.equal(result.budget.account.requests, 0);
  assert.deepEqual(
    result.candidates.map((item) => item.uncertainty.code),
    ['strict_unavailable', 'strict_unavailable'],
  );
  assert.equal(git(f.source, ['status', '--porcelain']), '');
});

test('arena all terminal aggregation preserves failed, timed-out and unknown-usage attempts without retry or fallback', async () => {
  const f = fixture({ criteria: false });
  f.spec.attemptTimeoutMs = 1000;
  f.profiles.alpha.responses = [{ failure: 'rate_limit', output: 'text fixture', latencyMs: 5 }];
  f.profiles.alpha.retry = { maxRetries: 3 };
  f.profiles.alpha.fallback = ['beta'];
  f.profiles.beta.responses = [{ output: 'only text', latencyMs: 2500 }];
  const result = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: inject,
  });
  assert.equal(result.status, 'completed-with-partial-results');
  assert.deepEqual(
    result.candidates.map((item) => item.status),
    ['failed', 'timed-out'],
  );
  assert.equal(result.budget.account.requests, 2);
  assert.equal(result.budget.account.estimatedRequests, 2);
  assert.equal(result.budget.account.tokens, 20);
  assert.equal(result.retained.length, 2);
});

test('arena attempt timeout does not cancel a successful sibling and overall deadline retains partial artifacts', async () => {
  const f = fixture({ criteria: false });
  f.spec.attemptTimeoutMs = 1000;
  f.profiles.beta.responses = [{ output: 'only text', latencyMs: 2500 }];
  const first = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: inject,
  });
  assert.deepEqual(
    first.candidates.map((item) => item.status),
    ['produced', 'timed-out'],
  );
  const overall = fixture({ criteria: false });
  overall.spec.deadlineMs = 350;
  overall.spec.attemptTimeoutMs = 350;
  overall.profiles.alpha.responses = overall.profiles.beta.responses = [
    { output: 'text', latencyMs: 1000 },
  ];
  const result = await runArena(overall.source, overall.spec, {
    profiles: overall.profiles,
    offlineCollector: inject,
  });
  assert.equal(result.status, 'timed-out');
  assert.equal(result.retained.length, 2);
});

test('arena fixed host harness distinguishes agent self-report, failed criteria and candidate-modifying harness', async () => {
  const f = fixture();
  f.profiles.beta.responses = [{ output: 'tests passed', usage: { tokens: 10, costUsd: 0 } }];
  const result = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: (entry) => {
      if (entry.candidateId === 'candidate-A') inject(entry);
    },
  });
  assert.deepEqual(
    result.candidates.map((item) => item.verification[0].result),
    ['pass', 'fail'],
  );
  assert.equal(result.candidates[1].verification[0].origin, 'host-observed');
  const mutating = fixture();
  writeFileSync(
    mutating.harness,
    "import {writeFileSync} from 'node:fs';writeFileSync('app.txt','changed by harness');console.log('passed');\n",
  );
  mutating.spec.verification.criteria[0].harnessHash = hash(readFileSync(mutating.harness));
  const observed = await runArena(mutating.source, mutating.spec, {
    profiles: mutating.profiles,
    offlineCollector: inject,
  });
  assert.deepEqual(
    observed.candidates.map((item) => item.verification[0].result),
    ['unknown', 'unknown'],
  );
  assert.equal(observed.candidates[0].verification[0].candidateModifiedByHarness, true);
});

test('arena artifacts include committed, untracked, binary, executable-mode and deletion changes', async () => {
  const f = fixture({ criteria: false });
  const result = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: (entry) => {
      inject(entry);
      writeFileSync(join(entry.workspace, 'binary.bin'), Buffer.from([0, 255, 1, 128]));
      chmodSync(join(entry.workspace, 'mode.txt'), 0o755);
      rmSync(join(entry.workspace, 'delete.txt'));
    },
  });
  const packet = arenaReviewPacket(result.batchId),
    artifact = packet.candidates[0].artifact;
  assert.equal(artifact.files.find((file) => file.path === 'binary.bin').bytes, 4);
  assert.equal(artifact.files.find((file) => file.path === 'mode.txt').mode, '100755');
  assert.ok(artifact.files.find((file) => file.path === 'candidate-A.txt').added);
  assert.deepEqual(artifact.deleted, ['delete.txt']);
  assert.match(packet.candidates[0].patch, /GIT binary patch/);
  assert.match(packet.candidates[0].patch, /new mode 100755/);
});

test('arena tampered artifacts, omitted untracked payload and changed host harness are rejected', async () => {
  const f = fixture();
  const result = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: inject,
  });
  const artifactDir = join(f.batchDir(result.batchId), 'artifacts', 'candidate-A');
  const snapshotPath = join(artifactDir, 'snapshot.json'),
    original = readFileSync(snapshotPath, 'utf8');
  writeFileSync(
    snapshotPath,
    JSON.stringify(jsonFile(snapshotPath).filter((file) => file.path !== 'candidate-A.txt')),
  );
  assert.throws(() => arenaReviewPacket(result.batchId), /hash changed/);
  writeFileSync(snapshotPath, original);
  writeFileSync(join(artifactDir, 'patch.diff'), 'truncated patch');
  assert.throws(() => arenaReviewPacket(result.batchId), /hash changed/);
  const harnessFixture = fixture();
  const harnessResult = await runArena(harnessFixture.source, harnessFixture.spec, {
    profiles: harnessFixture.profiles,
    offlineCollector: inject,
  });
  writeFileSync(harnessFixture.harness, 'changed host harness');
  await assert.rejects(resumeArena(harnessResult.batchId), /harness hash changed/);
});

test('arena review rejects unknown candidates, invalid digest/line anchors and explicit identity leaks', async () => {
  const f = fixture();
  const result = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: inject,
  });
  const packet = arenaReviewPacket(result.batchId),
    candidate = packet.candidates[0],
    file = candidate.files.find((entry) => entry.path === 'app.txt');
  const review = {
    authorization: { ...authorization, source: 'independent-human-review' },
    assessments: [
      {
        candidateId: candidate.id,
        criterionId: 'behavior',
        artifactDigest: digestRecord(candidate.artifact),
        result: 'unknown',
        anchors: [
          { path: file.path, hash: file.hash, line: 1, quote: 'implementation candidate-A' },
        ],
      },
    ],
  };
  assert.equal(validateArenaReview(packet, review).apply, 'not-requested');
  const recorded = recordArenaReview(result.batchId, review);
  assert.equal(
    jsonFile(join(f.batchDir(result.batchId), 'reviews', `${recorded.digest}.json`)).authorization
      .source,
    'independent-human-review',
  );
  assert.equal(arenaStatus(result.batchId).budget.account.requests, 2);
  const logReview = structuredClone(review);
  logReview.assessments[0].anchors = [
    {
      criterionId: 'behavior',
      hash: candidate.verification[0].logHash,
      line: 1,
      quote: 'host criterion observed',
    },
  ];
  assert.equal(validateArenaReview(packet, logReview).packetDigest, packet.digest);
  const fakeLog = structuredClone(logReview);
  fakeLog.assessments[0].anchors[0].hash = '0'.repeat(64);
  assert.throws(() => validateArenaReview(packet, fakeLog), /changed file\/log/);
  const unknown = structuredClone(review);
  unknown.assessments[0].candidateId = 'candidate-C';
  assert.throws(() => validateArenaReview(packet, unknown), /Unknown/);
  const badLine = structuredClone(review);
  badLine.assessments[0].anchors[0].line = 999;
  assert.throws(() => validateArenaReview(packet, badLine), /outside/);
  const badHash = structuredClone(review);
  badHash.assessments[0].artifactDigest = '0'.repeat(64);
  assert.throws(() => validateArenaReview(packet, badHash), /hash changed/);
  const leak = fixture({ criteria: false });
  const leaked = await runArena(leak.source, leak.spec, {
    profiles: leak.profiles,
    offlineCollector: (entry) =>
      writeFileSync(join(entry.workspace, 'identity.txt'), 'requestedModel: fixture-model-alpha\n'),
  });
  assert.throws(() => arenaReviewPacket(leaked.batchId), /identity leakage/);
});

test('arena unsupported links, oversized artifacts and writes outside authorization remain explicitly uncertified', async () => {
  for (const kind of ['symlink', 'oversize', 'scope']) {
    const f = fixture({ criteria: false });
    if (kind === 'scope') f.spec.allowedPaths = ['app.txt'];
    const result = await runArena(f.source, f.spec, {
      profiles: f.profiles,
      offlineCollector: (entry) => {
        if (kind === 'symlink') symlinkSync(f.harness, join(entry.workspace, 'escaped-link'));
        if (kind === 'oversize')
          writeFileSync(join(entry.workspace, 'large.bin'), Buffer.alloc(1048577));
        if (kind === 'scope')
          writeFileSync(join(entry.workspace, 'unauthorized.txt'), 'outside scope');
      },
    });
    assert.equal(result.retained.length, 0);
    assert.ok(
      result.candidates.every(
        (item) => item.status === 'failed' && item.uncertainty.artifactCertified === false,
      ),
    );
  }
});

test('arena shared admission budget, unknown usage and resume count use only fake usage fixtures', async () => {
  const f = fixture({ criteria: false });
  f.profiles.alpha.responses = [
    { output: 'text', latencyMs: 20, usage: { tokens: 15, costUsd: 0.3 } },
  ];
  f.profiles.beta.responses = [{ output: 'text', latencyMs: 20 }];
  const result = await runArena(f.source, f.spec, { profiles: f.profiles });
  assert.equal(result.budget.account.requests, 2);
  assert.equal(result.budget.account.tokens, 25);
  assert.equal(result.budget.account.estimatedRequests, 1);
  assert.equal(result.budget.cache, 'unknown');
  assert.equal(Object.keys(result.budget.ledger).length, 2);
  const recovered = await resumeArena(result.batchId);
  assert.deepEqual(recovered.budget, result.budget);
  const cap = fixture({ criteria: false });
  cap.spec.budget.maxRequests = 1;
  const capped = await runArena(cap.source, cap.spec, { profiles: cap.profiles });
  assert.equal(capped.budget.account.requests, 1);
  assert.equal(capped.budget.account.tokens, 10);
  assert.equal(capped.budget.account.estimatedRequests, 1);
});

test('arena reported budget breach stops new launches and preserves charged usage', async () => {
  const f = fixture({ criteria: false });
  f.spec.parallelism = 1;
  f.spec.budget.maxTokens = 25;
  f.profiles.alpha.responses = [{ output: 'text', usage: { tokens: 50, costUsd: 0.5 } }];
  const result = await runArena(f.source, f.spec, { profiles: f.profiles });
  assert.equal(result.budget.account.requests, 1);
  assert.equal(result.budget.account.tokens, 50);
  assert.equal(result.candidates[0].status, 'failed');
  assert.equal(result.budget.recoveryRequests, 0);
});

test('arena SIGKILL recovery retains sealed results, uncertain workspace and reservation without write replay', async () => {
  const f = fixture();
  f.profiles.alpha.responses = [
    { output: 'text', latencyMs: 10, usage: { tokens: 12, costUsd: 0.2 } },
  ];
  f.profiles.beta.responses = [{ output: 'text', latencyMs: 5000 }];
  f.spec.attemptTimeoutMs = 6000;
  const input = join(f.root, 'execution.json'),
    config = join(f.root, 'providers.json');
  writeFileSync(input, JSON.stringify(f.spec));
  writeFileSync(config, JSON.stringify(f.profiles));
  const batchId = 'crashed-batch';
  const child = spawn(process.execPath, [crashFixture, f.source, input, config, batchId], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exit = await new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  assert.equal(exit.signal, 'SIGKILL', stderr);
  const old = jsonFile(join(f.batchDir(batchId), 'state.json'));
  assert.ok(old.contenders[0].artifactDigest);
  assert.equal(Object.values(old.ledger).filter((entry) => entry.status === 'active').length, 1);
  const recovered = await resumeArena(batchId);
  assert.equal(recovered.candidates[0].artifactDigest, old.contenders[0].artifactDigest);
  assert.equal(recovered.candidates[1].status, 'interrupted');
  assert.equal(recovered.candidates[0].verification[0].result, 'unknown');
  assert.deepEqual(recovered.budget.account, old.budget.account);
  assert.equal(recovered.budget.account.requests, 2);
  assert.equal(
    Object.values(recovered.budget.ledger).filter((entry) => entry.status === 'uncertain').length,
    1,
  );
  assert.ok(existsSync(old.contenders[1].workspace));
  assert.deepEqual((await resumeArena(batchId)).budget, recovered.budget);
  const changed = structuredClone(f.spec);
  changed.objective = 'Changed authorization';
  await assert.rejects(resumeArena(batchId, { spec: changed }), /hash changed/);
});

test('arena cancellation cleans owned local process groups and retains partial artifact evidence', async () => {
  const f = fixture({ criteria: false });
  const script = join(f.root, 'local-process.mjs');
  writeFileSync(
    script,
    "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});writeFileSync('child.pid',String(child.pid));writeFileSync('partial.txt','partial evidence');setInterval(()=>{},1000);\n",
  );
  const profiles = Object.fromEntries(
    ['alpha', 'beta'].map((name) => [
      name,
      {
        adapter: 'command',
        command: process.execPath,
        args: [script],
        model: 'local-process-fixture',
        sandbox: 'workspace-write',
        budget: { reserveTokens: 10, reserveCostUsd: 0 },
        timeoutMs: 5000,
      },
    ]),
  );
  const batchId = 'cancel-local';
  const pending = runArena(f.source, f.spec, { profiles, batchId });
  for (
    let wait = 0;
    wait < 100 && !existsSync(join(f.batchDir(batchId), 'workspaces', 'candidate-B', 'child.pid'));
    wait += 1
  )
    await delay(20);
  assert.ok(existsSync(join(f.batchDir(batchId), 'workspaces', 'candidate-B', 'child.pid')));
  assert.equal(cancelArena(batchId).evidenceRetained, true);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.retained.length, 2);
  for (const candidate of ['candidate-A', 'candidate-B']) {
    const pid = readFileSync(
      join(f.batchDir(batchId), 'workspaces', candidate, 'child.pid'),
      'utf8',
    );
    let status = '';
    try {
      status = execFileSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).trim();
    } catch {
      /* exited */
    }
    assert.ok(!status || status.startsWith('Z'), `Owned child remains active: ${pid}`);
    assert.equal(
      existsSync(join(f.batchDir(batchId), 'workspaces', candidate, 'partial.txt')),
      true,
    );
  }
  assert.equal(arenaStatus(batchId).selected, null);
});

test('arena knowledge review and execution authority stay separate and no planner is invoked', async () => {
  const f = fixture({ criteria: false });
  const unreviewed = knowledgeFixture(join(f.root, 'unreviewed'));
  unreviewed.metadata.semanticReview = {
    ...authorization,
    status: 'unresolved',
    knowledgeOnly: false,
    noEvidencePromotion: false,
  };
  const imported = importOpenArena(unreviewed.directory, unreviewed.metadata);
  await assert.rejects(
    runArena(f.source, { ...f.spec, knowledgeId: imported.id }, { profiles: f.profiles }),
    /approved knowledge-boundary review/,
  );
  const missing = structuredClone(f.spec);
  delete missing.authorization;
  assert.throws(() => validateArenaSpec(missing), /authorization/);
  const extra = { ...f.spec, plannerProfile: 'should-never-run' };
  assert.throws(() => validateArenaSpec(extra), /unknown field/);
  const changed = structuredClone(f.knowledge.metadata);
  changed.authority.revision = 'new-version';
  const newer = importOpenArena(f.knowledge.directory, changed);
  assert.notEqual(newer.id, f.imported.id);
  assert.equal(
    readOpenArena(f.imported.id).manifest.metadata.authority.revision,
    'fixture-revision',
  );
});

test('arena frozen package/prefix/public copies, ownership and supplied execution spec reject tampering', async () => {
  const f = fixture({ criteria: false });
  const result = await runArena(f.source, f.spec, { profiles: f.profiles });
  const batch = f.batchDir(result.batchId),
    context = join(batch, 'context.md');
  const original = readFileSync(context, 'utf8');
  writeFileSync(context, 'changed public prefix');
  await assert.rejects(resumeArena(result.batchId), /prefix hash changed/);
  writeFileSync(context, original);
  const publicReference = join(batch, 'public', 'references', 'domain.md');
  const reference = readFileSync(publicReference, 'utf8');
  writeFileSync(publicReference, 'changed public dependency');
  assert.throws(() => arenaStatus(result.batchId), /reference hash changed/);
  writeFileSync(publicReference, reference);
  const owner = join(batch, 'owners', 'candidate-A.json'),
    registry = jsonFile(owner);
  writeFileSync(owner, JSON.stringify({ ...registry, token: 'not-the-owner' }));
  await assert.rejects(resumeArena(result.batchId), /ownership changed/);
  writeFileSync(owner, JSON.stringify(registry));
  const frozen = join(
    f.root,
    'state',
    'arena',
    'knowledge',
    f.imported.id,
    'files',
    'OPEN_ARENA.md',
  );
  writeFileSync(frozen, 'changed frozen source');
  assert.throws(() => readOpenArena(f.imported.id), /hash changed/);
  const alias = join(f.root, 'source-alias');
  symlinkSync(f.source, alias);
  process.env.OMHA_HOME = join(alias, 'new-state');
  assert.throws(
    () => importOpenArena(f.knowledge.directory, f.knowledge.metadata, { sourceCwd: f.source }),
    /outside/,
  );
  assert.equal(existsSync(join(f.source, 'new-state')), false);
});

test('arena non-UTF8 patch transport preserves bytes and textual review excludes shared baseline identities', async () => {
  const f = fixture({ criteria: false });
  // The publicly supplied baseline identity is domain data, not candidate provenance.
  f.profiles.alpha.model = 'baseline';
  const result = await runArena(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: (entry) =>
      writeFileSync(join(entry.workspace, 'non-utf8.txt'), Buffer.from([97, 255, 98, 10])),
  });
  const packet = arenaReviewPacket(result.batchId),
    candidate = packet.candidates[0];
  assert.equal(candidate.artifact.patchEncoding, 'base64');
  assert.equal(candidate.patch, null);
  assert.equal(hash(Buffer.from(candidate.patchBase64, 'base64')), candidate.artifact.patchHash);
  assert.equal(candidate.files.find((entry) => entry.path === 'non-utf8.txt').binary, true);
  assert.equal(
    candidate.files.find((entry) => entry.path === 'non-utf8.txt').content,
    Buffer.from([97, 255, 98, 10]).toString('base64'),
  );
  assert.equal(result.candidates[0].verificationCoverage, 'unknown-no-host-criteria');
});

test('arena host crash during verification cleans its recorded process and retains sealed unknown results', async () => {
  const f = fixture();
  writeFileSync(
    f.harness,
    "process.on('SIGTERM',()=>{});process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000);\n",
  );
  f.spec.verification.criteria[0].harnessHash = hash(readFileSync(f.harness));
  const specPath = join(f.root, 'execution.json'),
    profilesPath = join(f.root, 'profiles.json');
  writeFileSync(specPath, JSON.stringify(f.spec));
  writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles: f.profiles }));
  const batchId = 'verification-crash';
  const child = spawn(
    process.execPath,
    [
      cli,
      'arena',
      'run',
      '--cwd',
      f.source,
      '--input',
      specPath,
      '--config',
      profilesPath,
      '--allow-write',
      '--id',
      batchId,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exit = await new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  assert.equal(exit.signal, 'SIGKILL', stderr);
  const state = jsonFile(join(f.batchDir(batchId), 'state.json'));
  const sealed = state.contenders.find((item) => item.verificationProcess?.active);
  assert.ok(sealed?.artifactDigest);
  const result = await resumeArena(batchId);
  assert.equal(
    result.candidates.find((item) => item.id === sealed.id).artifactDigest,
    sealed.artifactDigest,
  );
  assert.equal(
    result.candidates.find((item) => item.id === sealed.id).verification[0].result,
    'unknown',
  );
  let status = '';
  try {
    status = execFileSync('ps', ['-o', 'stat=', '-p', String(sealed.verificationProcess.pid)], {
      encoding: 'utf8',
    }).trim();
  } catch {
    /* exited */
  }
  assert.ok(!status || status.startsWith('Z'), 'Recorded verification process remains active');
  assert.equal(result.budget.account.requests, state.budget.account.requests);
});

test('session fork runs three isolated fake branches with stable names, one sealed prefix and cache evidence', async () => {
  const f = fixture();
  f.spec.objective = '缓存分叉';
  f.spec.contenders = [
    { profile: 'one', name: '../../Writer One', label: '实现一' },
    { profile: 'two' },
    { profile: 'three' },
  ];
  f.spec.parallelism = 3;
  f.spec.warmFirst = true;
  f.spec.budget.maxRequests = 3;
  f.profiles = {
    one: fake('one', {
      sandbox: 'workspace-write',
      model: 'shared-model',
      responses: [
        {
          output: 'one',
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 5,
            costUsd: 0.1,
          },
        },
      ],
    }),
    two: fake('two', {
      sandbox: 'workspace-write',
      model: 'shared-model',
      responses: [
        {
          output: 'two',
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            costUsd: 0.1,
          },
        },
      ],
    }),
    three: fake('three', {
      sandbox: 'workspace-write',
      model: 'shared-model',
      responses: [{ output: 'three', usage: { input_tokens: 10, output_tokens: 1, costUsd: 0.1 } }],
    }),
  };
  const prompts = [];
  const events = [];
  const result = await runFork(f.source, f.spec, {
    profiles: f.profiles,
    name: '../../KV Fork!!!',
    onPrompt: (entry) => prompts.push(entry),
    onEvent: (entry) => events.push(entry),
    offlineCollector: inject,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.executionKind, 'session-fork');
  assert.equal(result.tree.nodes.length, 3);
  assert.equal(new Set(prompts.map((entry) => entry.prefix)).size, 1);
  assert.equal(hash(prompts[0].prefix), result.prefixHash);
  assert.ok(prompts.every((entry) => !entry.prefix.includes(entry.name)));
  assert.ok(prompts.every((entry) => entry.suffix.includes(`branch_name: ${entry.name}`)));
  assert.ok(result.tree.nodes.every((node) => FORK_NAME_PATTERN.test(node.name)));
  assert.equal(new Set(result.tree.nodes.map((node) => node.name)).size, 3);
  assert.equal(result.tree.nodes[0].name, 'writer-one');
  assert.deepEqual(
    result.tree.nodes.map((node) => node.cache.status),
    ['hit', 'miss', 'unknown'],
  );
  assert.equal(result.tree.cache.status, 'unknown');
  assert.equal(result.tree.cache.readInputTokens, 5);
  assert.ok(
    events.findIndex(
      (event) => event.kind === 'attempt.finished' && event.candidateId === 'candidate-A',
    ) <
      events.findIndex(
        (event) => event.kind === 'attempt.started' && event.candidateId === 'candidate-B',
      ),
  );
  assert.equal(forkStatus(result.batchId).tree.nodes[0].name, 'writer-one');
  assert.deepEqual(
    forkTree(result.batchId).nodes.map((node) => node.name),
    result.tree.nodes.map((node) => node.name),
  );

  const cliTree = JSON.parse(
    execFileSync(process.execPath, [cli, 'fork', 'tree', '--id', result.batchId], {
      encoding: 'utf8',
      env: process.env,
    }),
  );
  assert.equal(cliTree.treeId, result.batchId);
  assert.equal(cliTree.nodes.length, 3);

  const packet = arenaReviewPacket(result.batchId);
  assert.equal(packet.candidates[0].name, 'writer-one');
  writeFileSync(join(f.batchDir(result.batchId), 'context.md'), 'changed prefix');
  assert.throws(() => forkStatus(result.batchId), /prefix|parent/i);
});

test('session fork naming, sealed-parent and full-budget gates fail closed before launch', async () => {
  assert.equal(sanitizeForkName('../你好/../../'), 'fork');
  assert.ok(FORK_NAME_PATTERN.test(sanitizeForkName(`${'very-long/'.repeat(100)}objective`)));
  assert.throws(
    () =>
      forkNames({
        treeId: 'tree',
        prefixHash: hash('prefix'),
        objective: 'objective',
        branches: [
          { profile: 'a', name: 'same' },
          { profile: 'b', name: 'same' },
        ],
      }),
    /Duplicate/,
  );
  const root = {
    kind: 'root',
    sealed: true,
    pendingToolCalls: 0,
    pendingApproval: false,
    backgroundProcesses: false,
    prefixHash: hash('prefix'),
    prefixBytes: Buffer.byteLength('prefix'),
  };
  assert.doesNotThrow(() => assertSealedForkRoot(root, 'prefix'));
  assert.throws(() => assertSealedForkRoot({ ...root, sealed: false }, 'prefix'), /sealed/);
  assert.throws(
    () => assertSealedForkRoot({ ...root, pendingToolCalls: 1 }, 'prefix'),
    /pending tool/,
  );
  assert.throws(() => assertSealedForkRoot(root, 'changed'), /prefix changed/);

  const f = fixture();
  f.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  f.spec.parallelism = 3;
  f.spec.budget.maxRequests = 2;
  f.profiles = Object.fromEntries(
    ['one', 'two', 'three'].map((name) => [
      name,
      fake(name, { sandbox: 'workspace-write', model: 'shared-model' }),
    ]),
  );
  let launched = 0;
  await assert.rejects(
    runFork(f.source, f.spec, {
      profiles: f.profiles,
      onPrompt: () => (launched += 1),
      offlineCollector: inject,
    }),
    /cannot reserve every branch/,
  );
  assert.equal(launched, 0);
});

test('session fork preserves successful sibling evidence when one branch fails', async () => {
  const f = fixture({ criteria: false });
  f.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  f.spec.parallelism = 3;
  f.spec.budget.maxRequests = 3;
  f.profiles = {
    one: fake('one', { sandbox: 'workspace-write', model: 'shared-model' }),
    two: fake('two', {
      sandbox: 'workspace-write',
      model: 'shared-model',
      responses: [{ failure: 'transport' }],
    }),
    three: fake('three', { sandbox: 'workspace-write', model: 'shared-model' }),
  };
  const result = await runFork(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: inject,
  });
  assert.equal(result.status, 'completed-with-partial-results');
  assert.deepEqual(result.tree.nodes.map((node) => node.status).sort(), [
    'failed',
    'produced',
    'produced',
  ]);
  assert.equal(Object.keys(result.budget.ledger).length, 3);
  assert.equal(result.tree.nodes.filter((node) => node.artifactDigest).length, 3);
});

test('session fork CLI runs an offline three-branch tree and prints observable names', () => {
  const f = fixture({ criteria: false });
  f.spec.objective = 'CLI fork demonstration';
  f.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  f.spec.parallelism = 2;
  f.spec.budget.maxRequests = 3;
  f.profiles = Object.fromEntries(
    ['one', 'two', 'three'].map((name) => [
      name,
      fake(`offline-${name}`, {
        sandbox: 'workspace-write',
        model: 'shared-cli-model',
        responses: [
          {
            output: `offline-${name}`,
            usage: { input_tokens: 2, output_tokens: 1, costUsd: 0 },
          },
        ],
      }),
    ]),
  );
  const specPath = join(f.root, 'fork.json');
  const profilesPath = join(f.root, 'fork-profiles.json');
  writeFileSync(specPath, JSON.stringify(f.spec));
  writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles: f.profiles }));
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        'fork',
        'run',
        '--cwd',
        f.source,
        '--input',
        specPath,
        '--config',
        profilesPath,
        '--allow-write',
        '--name',
        'CLI Demo',
      ],
      { encoding: 'utf8', env: process.env },
    ),
  );
  assert.equal(output.status, 'completed');
  assert.equal(output.tree.nodes.length, 3);
  assert.ok(output.tree.name.startsWith('cli-demo-'));
  assert.ok(output.tree.nodes.every((node) => FORK_NAME_PATTERN.test(node.name)));
  assert.deepEqual(
    output.tree.nodes.map((node) => node.cache.status),
    ['unknown', 'unknown', 'unknown'],
  );
});

test('session fork rejects mixed provider routes or models before any launch', async () => {
  const f = fixture({ criteria: false });
  f.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  f.spec.parallelism = 3;
  f.spec.budget.maxRequests = 3;
  f.profiles = {
    one: fake('one', { sandbox: 'workspace-write', model: 'shared-model' }),
    two: fake('two', { sandbox: 'workspace-write', model: 'different-model' }),
    three: fake('three', { sandbox: 'workspace-write', model: 'shared-model' }),
  };
  let launched = 0;
  await assert.rejects(
    runFork(f.source, f.spec, {
      profiles: f.profiles,
      onPrompt: () => (launched += 1),
      offlineCollector: inject,
    }),
    /same provider route and model/,
  );
  assert.equal(launched, 0);
  assert.equal(existsSync(join(f.root, 'state', 'arena', 'batches')), false);
  f.profiles.two = {
    adapter: 'command',
    command: process.execPath,
    args: ['-e', 'console.log("local fixture")'],
    model: 'shared-model',
    sandbox: 'workspace-write',
    budget: { reserveTokens: 10, reserveCostUsd: 0 },
  };
  await assert.rejects(
    runFork(f.source, f.spec, {
      profiles: f.profiles,
      onPrompt: () => (launched += 1),
      offlineCollector: inject,
    }),
    /same provider route and model/,
  );
  assert.equal(launched, 0);
  assert.equal(existsSync(join(f.root, 'state', 'arena', 'batches')), false);
});

test('session fork rejects tampered branch suffix evidence on status and resume', async () => {
  const f = fixture({ criteria: false });
  f.profiles.alpha.model = 'shared-model';
  f.profiles.beta.model = 'shared-model';
  const result = await runFork(f.source, f.spec, {
    profiles: f.profiles,
    offlineCollector: inject,
  });
  assert.equal(result.status, 'completed');
  const suffixPath = join(f.batchDir(result.batchId), 'suffixes', 'candidate-A.txt');
  const original = readFileSync(suffixPath, 'utf8');
  writeFileSync(suffixPath, `${original}tampered\n`);
  assert.throws(() => forkStatus(result.batchId), /suffix hash changed/);
  await assert.rejects(resumeArena(result.batchId), /suffix hash changed/);
});

test('session fork defaults to warm-first for three or more branches and records scheduling', async () => {
  const f = fixture({ criteria: false });
  f.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  f.spec.parallelism = 3;
  f.spec.budget.maxRequests = 3;
  f.profiles = Object.fromEntries(
    ['one', 'two', 'three'].map((name) => [
      name,
      fake(name, { sandbox: 'workspace-write', model: 'shared-model' }),
    ]),
  );
  const events = [];
  const result = await runFork(f.source, f.spec, {
    profiles: f.profiles,
    onEvent: (event) => events.push(event),
    offlineCollector: inject,
  });
  assert.equal(result.status, 'completed');
  assert.equal(events.find((event) => event.kind === 'fork.tree.created').scheduling, 'warm-first');
  assert.ok(
    events.findIndex(
      (event) => event.kind === 'attempt.finished' && event.candidateId === 'candidate-A',
    ) <
      events.findIndex(
        (event) => event.kind === 'attempt.started' && event.candidateId === 'candidate-B',
      ),
  );

  const pair = fixture({ criteria: false });
  pair.profiles.alpha.model = 'shared-model';
  pair.profiles.beta.model = 'shared-model';
  const pairEvents = [];
  await runFork(pair.source, pair.spec, {
    profiles: pair.profiles,
    onEvent: (event) => pairEvents.push(event),
    offlineCollector: inject,
  });
  assert.equal(
    pairEvents.find((event) => event.kind === 'fork.tree.created').scheduling,
    'parallel',
  );

  const explicit = fixture({ criteria: false });
  explicit.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  explicit.spec.parallelism = 3;
  explicit.spec.warmFirst = false;
  explicit.spec.budget.maxRequests = 3;
  explicit.profiles = Object.fromEntries(
    ['one', 'two', 'three'].map((name) => [
      name,
      fake(name, { sandbox: 'workspace-write', model: 'shared-model' }),
    ]),
  );
  const parallelEvents = [];
  await runFork(explicit.source, explicit.spec, {
    profiles: explicit.profiles,
    onEvent: (event) => parallelEvents.push(event),
    offlineCollector: inject,
  });
  assert.equal(
    parallelEvents.find((event) => event.kind === 'fork.tree.created').scheduling,
    'parallel',
  );
  assert.ok(
    parallelEvents.findIndex(
      (event) => event.kind === 'attempt.started' && event.candidateId === 'candidate-B',
    ) <
      parallelEvents.findIndex(
        (event) => event.kind === 'attempt.finished' && event.candidateId === 'candidate-A',
      ),
  );
});

test('session fork upgrades root cache evidence only from a provider-reported warm write', async () => {
  const f = fixture({ criteria: false });
  f.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  f.spec.parallelism = 3;
  f.spec.budget.maxRequests = 3;
  f.profiles = {
    one: fake('one', {
      sandbox: 'workspace-write',
      model: 'shared-model',
      responses: [
        {
          output: 'one',
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: 40,
            costUsd: 0.1,
          },
        },
      ],
    }),
    two: fake('two', { sandbox: 'workspace-write', model: 'shared-model' }),
    three: fake('three', { sandbox: 'workspace-write', model: 'shared-model' }),
  };
  const events = [];
  const result = await runFork(f.source, f.spec, {
    profiles: f.profiles,
    onEvent: (event) => events.push(event),
    offlineCollector: inject,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.tree.root.cache.status, 'write-reported');
  assert.equal(typeof result.tree.root.cache.epoch, 'string');
  assert.equal(result.tree.root.cache.ttlMs, null);
  assert.equal(result.tree.root.cache.expiresAt, null);
  const evidence = events.find((event) => event.kind === 'fork.root.cache');
  assert.equal(evidence.cacheCreationInputTokens, 40);
  assert.equal(forkStatus(result.batchId).tree.root.cache.status, 'write-reported');

  const control = fixture({ criteria: false });
  control.spec.contenders = [{ profile: 'one' }, { profile: 'two' }, { profile: 'three' }];
  control.spec.parallelism = 3;
  control.spec.budget.maxRequests = 3;
  control.profiles = Object.fromEntries(
    ['one', 'two', 'three'].map((name) => [
      name,
      fake(name, { sandbox: 'workspace-write', model: 'shared-model' }),
    ]),
  );
  const controlEvents = [];
  const controlResult = await runFork(control.source, control.spec, {
    profiles: control.profiles,
    onEvent: (event) => controlEvents.push(event),
    offlineCollector: inject,
  });
  assert.equal(controlResult.tree.root.cache.status, 'unknown');
  assert.equal(controlResult.tree.root.cache.epoch, null);
  assert.equal(
    controlEvents.some((event) => event.kind === 'fork.root.cache'),
    false,
  );

  const statePath = join(control.batchDir(controlResult.batchId), 'state.json');
  const tampered = jsonFile(statePath);
  tampered.tree.root.cache = {
    epoch: tampered.tree.root.createdAt,
    ttlMs: null,
    expiresAt: null,
    status: 'write-reported',
  };
  writeFileSync(statePath, JSON.stringify(tampered, null, 2));
  assert.throws(() => forkStatus(controlResult.batchId), /cache evidence/);
});
