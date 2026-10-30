import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandExists } from '../lib/core.mjs';
import { parseMarkdown } from '../lib/frontmatter.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'omha-pack-')));
const cleanHome = join(temporary, 'home'),
  prefix = join(temporary, 'prefix'),
  cwd = join(temporary, 'project');
for (const dir of [cleanHome, prefix, cwd]) mkdirSync(dir);
const env = {
  ...process.env,
  HOME: cleanHome,
  USERPROFILE: cleanHome,
  OMHA_HOME: join(cleanHome, 'state'),
  npm_config_cache: join(temporary, 'npm-cache'),
  npm_config_update_notifier: 'false',
  CLAUDE_CONFIG_DIR: join(cleanHome, '.claude'),
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  NO_COLOR: '1',
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const invokeNpm = (args, workdir) =>
  execFileSync(npm, args, {
    cwd: workdir,
    env,
    encoding: 'utf8',
    timeout: 300000,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
try {
  const packResult = JSON.parse(
    invokeNpm(['pack', '--json', '--pack-destination', temporary], root),
  );
  const packed = Array.isArray(packResult) ? packResult[0] : packResult['@huatalk/omha'];
  assert.ok(packed, 'npm pack did not report the @huatalk/omha tarball');
  const names = packed.files.map((entry) => entry.path);
  for (const required of [
    'index.mjs',
    'bin/omha.mjs',
    'bin/handoff-worker.mjs',
    'bin/auto-close-worker.mjs',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'skills/hide/LICENSE',
    'skills/butterfly-effect/LICENSE',
    'schemas/plan.schema.json',
    'schemas/host-policy.schema.json',
    'examples/history.json',
    'docs/contracts.md',
    'docs/plugin.md',
    'hooks/hooks.json',
    'hooks/register.mjs',
    'hooks/controller.mjs',
    'lib/compact.mjs',
    'docs/auto-compact.md',
    'docs/adr/README.md',
    'docs/auto-close.md',
    'skills/auto-close/SKILL.md',
    'lib/tab-recovery.mjs',
    'docs/auto-recover.md',
    'lib/review.mjs',
    'skills/multi-review/SKILL.md',
    'schemas/review.schema.json',
    'examples/review.json',
    'lib/agents.mjs',
    'schemas/agents.schema.json',
    'examples/agents.json',
    'lib/preflight.mjs',
    'schemas/preflight.schema.json',
    'examples/preflight.json',
    'skills/task-preflight/SKILL.md',
    'docs/task-preflight.md',
  ])
    assert.ok(names.includes(required), `tarball missing ${required}`);
  assert.equal(
    names.some(
      (name) =>
        name.includes('node_modules') || name.startsWith('tests/') || name.startsWith('.omha/'),
    ),
    false,
  );
  invokeNpm(
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(temporary, packed.filename),
    ],
    cwd,
  );
  const installed = join(
    prefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    '@huatalk/omha',
  );
  const cli = join(installed, 'bin', 'omha.mjs');
  assert.ok(existsSync(cli));
  const skillNames = (directory) =>
    readdirSync(join(directory, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  const skills = skillNames(root);
  assert.deepEqual(skillNames(installed), skills);
  for (const name of skills) {
    const source = readFileSync(join(installed, 'skills', name, 'SKILL.md'), 'utf8');
    assert.equal(parseMarkdown(source).metadata.name, name);
  }
  const claudePlugin = {
    available: commandExists('claude'),
    installed: false,
    inventoryVerified: false,
  };
  if (claudePlugin.available) {
    const invokeClaude = (args) =>
      execFileSync('claude', args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 60000,
        ...(process.platform === 'win32' ? { shell: true } : {}),
      });
    for (const manifest of ['plugin.json', 'marketplace.json'])
      invokeClaude(['plugin', 'validate', join(installed, '.claude-plugin', manifest), '--strict']);
    invokeClaude(['plugin', 'marketplace', 'add', installed]);
    invokeClaude(['plugin', 'install', 'omha@omha']);
    const entry = JSON.parse(invokeClaude(['plugin', 'list', '--json'])).find(
      (plugin) => plugin.id === 'omha@omha',
    );
    assert.equal(entry?.enabled, true);
    assert.equal(entry.version, packed.version);
    assert.ok(entry.installPath.startsWith(env.CLAUDE_CONFIG_DIR));
    for (const name of skills)
      assert.ok(existsSync(join(entry.installPath, 'skills', name, 'SKILL.md')));
    claudePlugin.installed = true;
    if (invokeClaude(['plugin', '--help']).includes('details')) {
      const inventory = invokeClaude(['plugin', 'details', 'omha@omha']);
      const listed = inventory.match(/^\s*Skills \((\d+)\)\s+(.+)$/m);
      assert.ok(listed, 'Claude did not report a skill inventory');
      assert.equal(Number(listed[1]), skills.length);
      assert.deepEqual(listed[2].split(', ').sort(), skills);
      claudePlugin.inventoryVerified = true;
    }
    invokeClaude(['plugin', 'uninstall', 'omha@omha']);
    invokeClaude(['plugin', 'marketplace', 'remove', 'omha']);
    assert.equal(JSON.parse(invokeClaude(['plugin', 'list', '--json'])).length, 0);
  }
  const installedBin =
    process.platform === 'win32' ? join(prefix, 'omha.cmd') : join(prefix, 'bin', 'omha');
  assert.ok(existsSync(installedBin));
  assert.equal(
    execFileSync(installedBin, ['--version'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30000,
    }).trim(),
    packed.version,
  );
  const run = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 60000,
      }),
    );
  assert.equal(run(['doctor', '--json']).ok, true);
  assert.deepEqual(run(['compact', 'status']), []);
  const preflight = run([
    'preflight',
    '--input',
    join(installed, 'examples/preflight.json'),
    '--json',
  ]);
  assert.equal(preflight.mode, 'shadow');
  assert.equal(preflight.autonomy.level, 'L2_candidate');
  assert.equal(preflight.prediction.successProbability, null);
  const compactConfig = join(temporary, 'compact-providers.json');
  writeFileSync(
    compactConfig,
    JSON.stringify({
      version: 1,
      profiles: { claude: { adapter: 'claude', command: 'claude', model: 'sonnet' } },
      maintenance: { autoCompact: { enabled: true, bridgeStatusLine: true } },
    }),
  );
  const compactSetup = run(['compact', 'setup', '--config', compactConfig]);
  assert.equal(compactSetup.policy.afterMinutes, 57);
  assert.equal(compactSetup.policy.minContextPercent, 20);
  const compactSettings = JSON.parse(readFileSync(compactSetup.settingsFile, 'utf8'));
  assert.equal(compactSettings.idleCompaction, false);
  assert.ok(compactSettings.statusLine.command.includes(cli));
  const compactHook = JSON.parse(readFileSync(join(installed, 'hooks/hooks.json'), 'utf8'));
  assert.deepEqual(compactHook.hooks, {});
  assert.deepEqual(compactHook.modules, ['./register.mjs']);
  assert.equal(run(['run', '--profile', 'fake', '--prompt', 'Packed offline check']).ok, true);
  assert.equal(
    run(['memory', 'put', '--name', 'packed', '--content', 'Installed package works']).scope,
    'project',
  );
  assert.equal(
    run([
      'leader',
      '--plan',
      join(installed, 'examples/plan.json'),
      '--config',
      join(installed, 'examples/providers.fake.json'),
    ]).status,
    'completed',
  );
  assert.equal(
    run([
      'roundtable',
      '--input',
      join(installed, 'examples/decision.json'),
      '--config',
      join(installed, 'examples/providers.fake.json'),
    ]).tally.recommendation,
    'A',
  );
  assert.equal(
    run(['auto-butterfly', '--input', join(installed, 'examples/history.json')]).status,
    'supported',
  );
  const h = run(['handoff', '--prompt', 'Installed handoff', '--backend', 'file']);
  assert.equal(h.state, 'awaiting');
  assert.equal(run(['handoff', 'complete', '--id', h.id]).state, 'completed');
  assert.equal(run(['handoff', 'close', '--id', h.id]).state, 'closed');
  assert.equal(run(['memory', 'doctor']).ok, true);
  const workflowConfig = join(temporary, 'workflow-providers.json');
  const policy = join(temporary, 'host-policy.json');
  const workflowPlan = {
    version: 1,
    objective: 'Verify installed workflow',
    tasks: [
      {
        id: 'job',
        role: 'verify',
        prompt: 'Inspect installed artifact',
        profile: 'worker',
        mode: 'readonly',
      },
    ],
  };
  writeFileSync(
    workflowConfig,
    JSON.stringify({
      version: 1,
      profiles: {
        planner: {
          adapter: 'fake',
          command: 'fake',
          model: 'local',
          responses: [{ output: JSON.stringify(workflowPlan) }],
        },
        worker: {
          adapter: 'fake',
          command: 'fake',
          model: 'local',
          responses: [{ output: 'Completed installed check' }],
        },
        reviewer: {
          adapter: 'fake',
          command: 'fake',
          model: 'local',
          responses: [
            {
              output: JSON.stringify({
                summary: 'Installed evidence matches',
                assessments: [{ id: 'spec', status: 'pass', finding: 'Verified' }],
              }),
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    policy,
    JSON.stringify({
      supervision: { stallMs: 1000 },
      tasks: {
        job: {
          acceptance: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
          review: {
            reviewerProfile: 'reviewer',
            diff: 'Frozen installed workflow',
            testEvidence: [
              { name: 'host', status: 'passed', summary: 'Installed host verification' },
            ],
            criteria: [{ id: 'spec', description: 'Match installed contract' }],
          },
        },
      },
    }),
  );
  const workflow = run([
    'leader',
    '--task',
    workflowPlan.objective,
    '--profile',
    'planner',
    '--config',
    workflowConfig,
    '--policy',
    policy,
  ]);
  assert.equal(workflow.status, 'completed');
  assert.equal(workflow.tasks.job.acceptanceAccepted, true);
  assert.equal(workflow.tasks.job.reviewApproved, true);
  assert.equal(workflow.budget.account.requests, 3);
  assert.equal(run(['memory', 'list', '--scope', 'worktree']).length, 1);
  assert.equal(run(['status']).metrics.accepted, 1);
  const watch = execFileSync(
    process.execPath,
    [cli, 'status', '--watch', '--wait-ms', '30', '--interval-ms', '10'],
    { cwd, env, encoding: 'utf8', timeout: 30000 },
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(watch.length, 1);
  assert.equal(watch[0].metrics.reviewApproved, 1);
  const api = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {validatePreflight,assessPreflight,createRuntime,projectStatus,watchStatus,adoptHandoff,handoffCheckpoints,forkHandoff,messageHandoff,acceptHandoff,autoCloseHandoff,discoverTabs,recoverTabs,watchTabRecovery,tabRecoveryStatus} from ${JSON.stringify(pathToFileURL(join(installed, 'index.mjs')).href)};console.log([validatePreflight,assessPreflight,createRuntime,projectStatus,watchStatus,adoptHandoff,handoffCheckpoints,forkHandoff,messageHandoff,acceptHandoff,autoCloseHandoff,discoverTabs,recoverTabs,watchTabRecovery,tabRecoveryStatus].map(value=>typeof value).join(','))`,
    ],
    { cwd, env, encoding: 'utf8' },
  );
  assert.match(api, /function,function,function/);
  if (process.platform !== 'win32') {
    const nativeBin = join(temporary, 'native-bin');
    const nativeHome = join(cleanHome, 'native-state');
    mkdirSync(nativeBin);
    mkdirSync(nativeHome);
    copyFileSync(join(root, 'tests/fixtures/cmux.mjs'), join(nativeBin, 'cmux'));
    chmodSync(join(nativeBin, 'cmux'), 0o700);
    const ref = randomUUID(),
      surfaceRef = randomUUID();
    writeFileSync(
      join(nativeHome, 'cmux-fixture.json'),
      JSON.stringify({
        cwd,
        agent: 'codex',
        calls: [],
        forks: [],
        messages: [],
        closed: [],
        owners: {},
        checkpoints: [{ id: 'turn:ordinal:8', turn: 1, source: 'turn', anchor: 'ordinal:8' }],
        surfaces: { [surfaceRef]: { ref, agent: 'codex', sessionId: randomUUID(), source: true } },
      }),
    );
    const nativeEnv = {
      ...env,
      PATH: `${nativeBin}${delimiter}${env.PATH}`,
      OMHA_HOME: nativeHome,
      CMUX_WORKSPACE_ID: ref,
      CMUX_SURFACE_ID: surfaceRef,
    };
    const nativeRun = (args) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, ...args], {
          cwd,
          env: nativeEnv,
          encoding: 'utf8',
          timeout: 30000,
        }),
      );
    const source = nativeRun(['handoff', 'adopt']);
    assert.equal(nativeRun(['handoff', 'checkpoints', '--id', source.id]).checkpoints.length, 1);
    const fork = nativeRun([
      'handoff',
      'fork',
      '--id',
      source.id,
      '--turn',
      '1',
      '--allow-write',
      '--close-source',
      '--prompt',
      'Verify installed native continuation.',
    ]);
    assert.equal(fork.fork.state, 'awaiting_acceptance');
    assert.equal(
      nativeRun(['handoff', 'message', '--id', fork.id, '--prompt', 'Installed message.']).state,
      'queued',
    );
    nativeEnv.CMUX_WORKSPACE_ID = fork.ref;
    nativeEnv.CMUX_SURFACE_ID = fork.surfaceRef;
    assert.equal(nativeRun(['handoff', 'accept', '--id', fork.id]).fork.sourceClose, 'closed');
    const closing = nativeRun([
      'auto-close',
      '--completed',
      '--reason',
      'Installed goal and checks completed',
      '--delay-ms',
      '100',
    ]);
    assert.equal(closing.id, fork.id);
    assert.equal(closing.autoClose.state, 'scheduled');
    let closed = closing;
    const closeDeadline = Date.now() + 15000;
    while (closed.autoClose.state === 'scheduled' || closed.autoClose.state === 'closing') {
      assert.ok(Date.now() < closeDeadline, 'Installed auto-close worker timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
      closed = nativeRun(['handoff', 'status', '--id', fork.id]);
    }
    assert.equal(closed.autoClose.state, 'closed');
    assert.equal(closed.backendClosed, true);
  }
  const butterflyConfig = join(temporary, 'butterfly-providers.json');
  const butterflyPlanFile = join(temporary, 'butterfly-plan.json');
  const localWriter = join(temporary, 'butterfly-writer.cjs');
  writeFileSync(join(cwd, 'butterfly.txt'), 'original');
  writeFileSync(
    localWriter,
    `const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  const previous = fs.readFileSync('butterfly.txt', 'utf8');
  fs.writeFileSync('butterfly.txt', previous === 'original' ? 'bad' : 'good');
  console.log(JSON.stringify({status:'success',output:'Local candidate produced'}));
});`,
  );
  writeFileSync(
    butterflyConfig,
    JSON.stringify({
      version: 1,
      profiles: {
        writer: {
          adapter: 'command',
          command: process.execPath,
          args: [localWriter],
          model: 'local',
          sandbox: 'workspace-write',
          outputFormat: 'json',
          retry: { maxRetries: 0 },
        },
      },
    }),
  );
  writeFileSync(
    butterflyPlanFile,
    JSON.stringify({
      version: 1,
      objective: 'Verify installed automatic butterfly',
      tasks: [
        {
          id: 'build',
          role: 'writer',
          prompt: 'Produce butterfly.txt containing good',
          profile: 'writer',
          mode: 'write',
          acceptance: {
            command: process.execPath,
            args: [
              '-e',
              "process.exit(require('node:fs').readFileSync('butterfly.txt','utf8') === 'good' ? 0 : 1)",
            ],
          },
        },
      ],
    }),
  );
  let firstButterfly;
  try {
    run(['leader', '--plan', butterflyPlanFile, '--config', butterflyConfig, '--allow-write']);
    assert.fail('Bad installed candidate must fail host acceptance');
  } catch (error) {
    assert.equal(error.status, 1);
    firstButterfly = JSON.parse(error.stdout);
  }
  assert.equal(firstButterfly.tasks.build.acceptanceAccepted, false);
  const butterflyResume = [
    'leader',
    '--resume',
    firstButterfly.runId,
    '--config',
    butterflyConfig,
    '--allow-write',
    '--retry-failed',
    '--retry-interrupted-writes',
  ];
  const repaired = run(butterflyResume);
  assert.equal(repaired.status, 'completed');
  assert.equal(repaired.metrics.butterflyDetections, 1);
  assert.equal(repaired.metrics.butterflyHandoffs, 1);
  assert.equal(repaired.budget.account.requests, 2);
  const automaticReport = JSON.parse(readFileSync(repaired.tasks.build.butterfly.file, 'utf8'));
  assert.equal(automaticReport.decisions[0].rewindBoundary.actionId, 'action-1');
  assert.equal(
    run(['handoff', 'status', '--id', repaired.tasks.build.butterfly.handoffId]).state,
    'awaiting',
  );
  assert.equal(run(butterflyResume).metrics.butterflyHandoffs, 1);
  invokeNpm(
    ['uninstall', '--global', '--prefix', prefix, '@huatalk/omha', '--ignore-scripts'],
    cwd,
  );
  assert.equal(existsSync(cli), false);
  console.log(
    JSON.stringify({
      ok: true,
      version: packed.version,
      filename: packed.filename,
      files: packed.files.length,
      cleanHome: true,
      skills,
      claudePlugin,
      examplesExecuted: true,
      automaticButterflyVerified: true,
      uninstallVerified: true,
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
