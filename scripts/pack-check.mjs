import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const invokeNpm = (args, workdir) =>
  execFileSync(npm, args, {
    cwd: workdir,
    env,
    encoding: 'utf8',
    timeout: 120000,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
try {
  const packed = JSON.parse(
    invokeNpm(['pack', '--json', '--pack-destination', temporary], root),
  )[0];
  const names = packed.files.map((entry) => entry.path);
  for (const required of [
    'index.mjs',
    'bin/omha.mjs',
    'bin/handoff-worker.mjs',
    '.claude-plugin/plugin.json',
    'skills/hide/LICENSE',
    'skills/butterfly-effect/LICENSE',
    'schemas/plan.schema.json',
    'schemas/host-policy.schema.json',
    'examples/history.json',
    'docs/contracts.md',
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
      `import {createRuntime,projectStatus,watchStatus} from ${JSON.stringify(pathToFileURL(join(installed, 'index.mjs')).href)};console.log([createRuntime,projectStatus,watchStatus].map(value=>typeof value).join(','))`,
    ],
    { cwd, env, encoding: 'utf8' },
  );
  assert.match(api, /function,function,function/);
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
      examplesExecuted: true,
      uninstallVerified: true,
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
