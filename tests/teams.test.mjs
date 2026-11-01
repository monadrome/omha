// Offline coverage for teams: registry-validated membership, the claimable
// task list and member mailboxes. No provider is started anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.mjs';
import { addAgent } from '../lib/agents.mjs';
import { hash, projectDir } from '../lib/core.mjs';
import {
  TEAM_LIMITS,
  addTeamTask,
  claimTeamTask,
  completeTeamTask,
  createTeam,
  listTeams,
  readTeamMailbox,
  sendTeamMessage,
  teamStatus,
} from '../lib/teams.mjs';

const bin = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));

const root = temp('omha-teams-');
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);

const specs = {
  helper: {
    description: 'A helper worker for team tests.',
    command: 'helper-cli',
    args: ['--prompt', '{prompt}'],
  },
  peer: {
    description: 'A second helper worker for team tests.',
    command: 'helper-cli',
    args: ['--prompt', '{prompt}'],
  },
};
for (const [name, spec] of Object.entries(specs)) addAgent(name, spec);

const team = (members = ['helper']) =>
  createTeam(cwd, { name: 'Build the thing', agents: members });

const inboxFile = (teamId, member) =>
  join(projectDir(cwd), 'teams', teamId, 'inbox', `${member}.jsonl`);

test('team creation validates the name and registry membership', () => {
  const rejects = [
    [() => createTeam(cwd, { name: '' }), /team name must be nonempty/],
    [() => createTeam(cwd, { name: 'x', agents: ['ghost'] }), /not in the agent registry/],
    [() => createTeam(cwd, { name: 'x', agents: ['nope!'] }), /simple identifier/],
    [
      () => createTeam(cwd, { name: 'x', objective: 'password: hunter2', agents: [] }),
      /Credentials are not permitted/,
    ],
  ];
  for (const [call, pattern] of rejects) assert.throws(call, pattern);
  const created = team();
  assert.equal(created.version, 1);
  assert.match(created.teamId, /^team-[a-f0-9]{16}$/);
  assert.deepEqual(
    listTeams(cwd).map((entry) => entry.teamId),
    [created.teamId],
  );
});

test('task claims enforce membership, dependency readiness and claim exclusivity', () => {
  const { teamId } = team();
  const first = addTeamTask(cwd, teamId, { subject: 'Research' });
  const second = addTeamTask(cwd, teamId, { subject: 'Implement', dependsOn: [first.taskId] });
  assert.throws(
    () => addTeamTask(cwd, teamId, { subject: 'x', dependsOn: ['task-unknown'] }),
    /Unknown dependency/,
  );
  assert.throws(() => addTeamTask(cwd, teamId, { subject: '' }), /task subject must be nonempty/);
  assert.throws(
    () => claimTeamTask(cwd, teamId, second.taskId, 'helper'),
    /dependencies are not completed/,
  );
  assert.throws(
    () => claimTeamTask(cwd, teamId, first.taskId, 'ghost'),
    /not a member of this team/,
  );
  const claim = claimTeamTask(cwd, teamId, first.taskId, 'helper');
  assert.equal(claim.status, 'claimed');
  assert.throws(
    () => claimTeamTask(cwd, teamId, first.taskId, 'helper'),
    /Only pending tasks can be claimed/,
  );
  const status = teamStatus(cwd, teamId);
  assert.equal(status.tasks.find((task) => task.id === first.taskId).derived, undefined);
  assert.equal(status.tasks.find((task) => task.id === second.taskId).derived, 'waiting');
});

test('completion is owner-bounded and drives dependent task readiness', () => {
  const { teamId } = team(['helper', 'peer']);
  const first = addTeamTask(cwd, teamId, { subject: 'Research' });
  const third = addTeamTask(cwd, teamId, { subject: 'Verify', dependsOn: [first.taskId] });
  const second = addTeamTask(cwd, teamId, {
    subject: 'Implement',
    dependsOn: [first.taskId, third.taskId],
  });
  claimTeamTask(cwd, teamId, first.taskId, 'helper');
  assert.throws(
    () => completeTeamTask(cwd, teamId, first.taskId, 'peer', { status: 'completed' }),
    /Only the claiming agent/,
  );
  assert.throws(
    () => completeTeamTask(cwd, teamId, second.taskId, 'peer', { status: 'completed' }),
    /Only claimed tasks/,
  );
  assert.throws(
    () => completeTeamTask(cwd, teamId, first.taskId, 'helper', { status: 'weird' }),
    /completion status/,
  );
  completeTeamTask(cwd, teamId, first.taskId, 'helper', {
    status: 'completed',
    summary: 'Findings attached',
  });
  let status = teamStatus(cwd, teamId);
  assert.equal(status.tasks.find((task) => task.id === second.taskId).derived, 'waiting');
  assert.equal(status.tasks.find((task) => task.id === third.taskId).derived, 'ready');
  claimTeamTask(cwd, teamId, third.taskId, 'peer');
  completeTeamTask(cwd, teamId, third.taskId, 'peer', { status: 'failed' });
  status = teamStatus(cwd, teamId);
  assert.equal(status.tasks.find((task) => task.id === second.taskId).derived, 'blocked');
  assert.equal(
    status.tasks.find((task) => task.id === first.taskId).result.summary,
    'Findings attached',
  );
  assert.equal(
    status.events.some((entry) => entry.kind === 'task.completed'),
    true,
  );
  assert.equal(
    status.events.some((entry) => entry.kind === 'task.failed'),
    true,
  );
});

test('mailboxes are per-member, hash-checked and cursor-addressable', () => {
  const { teamId } = team(['helper', 'peer']);
  const rejects = [
    [
      () => sendTeamMessage(cwd, teamId, { from: 'ghost', to: 'helper', content: 'hi' }),
      /not a member/,
    ],
    [() => sendTeamMessage(cwd, teamId, { to: 'ghost', content: 'hi' }), /not a member/],
    [
      () => sendTeamMessage(cwd, teamId, { from: 'helper', to: 'helper', content: 'hi' }),
      /cannot message itself/,
    ],
    [
      () => sendTeamMessage(cwd, teamId, { to: 'helper', content: 'sk-abcdefghijklmnop' }),
      /Credentials are not permitted/,
    ],
    [
      () => sendTeamMessage(cwd, teamId, { to: 'helper', content: 'x', taskId: 'task-unknown' }),
      /unknown task/,
    ],
  ];
  for (const [call, pattern] of rejects) assert.throws(call, pattern);
  const first = sendTeamMessage(cwd, teamId, { to: 'helper', content: 'hello' });
  const second = sendTeamMessage(cwd, teamId, {
    from: 'peer',
    to: 'helper',
    content: 'from peer',
  });
  const unread = readTeamMailbox(cwd, teamId, 'helper');
  assert.deepEqual(
    unread.messages.map((message) => [message.from, message.content]),
    [
      ['host', 'hello'],
      ['peer', 'from peer'],
    ],
  );
  assert.equal(unread.cursor, second.messageId);
  assert.equal(readTeamMailbox(cwd, teamId, 'peer').messages.length, 0);
  const since = readTeamMailbox(cwd, teamId, 'helper', { since: first.messageId });
  assert.deepEqual(
    since.messages.map((message) => message.content),
    ['from peer'],
  );
  assert.throws(
    () => readTeamMailbox(cwd, teamId, 'helper', { since: 'msg-unknown' }),
    /Unknown mailbox cursor/,
  );
  assert.throws(() => readTeamMailbox(cwd, teamId, 'ghost'), /not a member/);
});

test('tampered mailbox content fails closed with a corruption error', () => {
  const { teamId } = team(['helper']);
  sendTeamMessage(cwd, teamId, { to: 'helper', content: 'original' });
  const file = inboxFile(teamId, 'helper');
  const raw = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1));
  writeFileSync(file, `${JSON.stringify({ ...raw, content: 'changed but hash stale' })}\n`);
  assert.throws(() => readTeamMailbox(cwd, teamId, 'helper'), /content was changed/);
});

test('mailbox depth is bounded', () => {
  const { teamId } = team(['helper']);
  const original = TEAM_LIMITS.inboxMessages;
  TEAM_LIMITS.inboxMessages = 2;
  try {
    sendTeamMessage(cwd, teamId, { to: 'helper', content: 'one' });
    sendTeamMessage(cwd, teamId, { to: 'helper', content: 'two' });
    assert.throws(
      () => sendTeamMessage(cwd, teamId, { to: 'helper', content: 'three' }),
      /Mailbox for helper is full/,
    );
  } finally {
    TEAM_LIMITS.inboxMessages = original;
  }
});

test('team CLI subcommands parse, validate and fail closed', () => {
  const run = (args) =>
    spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env },
    });
  const list = run(['teams', 'list']);
  assert.equal(list.status, 0);
  assert.ok(JSON.parse(list.stdout).length >= 1);
  const created = JSON.parse(
    run(['teams', 'create', '--name', 'CLI team', '--agents', 'helper,peer']).stdout,
  );
  assert.match(created.teamId, /^team-[a-f0-9]{16}$/);
  const missing = run(['teams', 'create', '--name', 'x', '--agents', 'ghost']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /not in the agent registry/);
  const task = JSON.parse(
    run(['teams', 'task', 'add', '--id', created.teamId, 'Ship the feature']).stdout,
  );
  assert.match(task.taskId, /^task-[a-f0-9]{16}$/);
  const claim = JSON.parse(
    run(['teams', 'claim', '--id', created.teamId, '--task', task.taskId, '--agent', 'helper'])
      .stdout,
  );
  assert.equal(claim.status, 'claimed');
  const sent = JSON.parse(
    run(['teams', 'send', '--id', created.teamId, '--to', 'helper', '--content', 'nudge']).stdout,
  );
  assert.match(sent.messageId, /^msg-/);
  const mailbox = JSON.parse(
    run(['teams', 'read', '--id', created.teamId, '--agent', 'helper', '--json']).stdout,
  );
  assert.equal(mailbox.messages.at(-1).content, 'nudge');
  const finished = JSON.parse(
    run([
      'teams',
      'complete',
      '--id',
      created.teamId,
      '--task',
      task.taskId,
      '--agent',
      'helper',
      '--status',
      'completed',
      '--summary',
      'done',
    ]).stdout,
  );
  assert.equal(finished.status, 'completed');
  const shown = JSON.parse(run(['teams', 'show', '--id', created.teamId]).stdout);
  assert.equal(shown.tasks.at(0).status, 'completed');
  const unknown = run(['teams', 'nonsense']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown teams command/);
});
