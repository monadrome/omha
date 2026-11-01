// Shared team protocol for agent collaboration: named teams over the global
// agent registry, an append-only mailbox per member, and a claimable task
// list. Everything is host-validated state under the project directory; a
// message or claim never grants permission and task completion stays a
// claimant-bounded transition that the host records, not a provider verdict.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hash, now, projectDir, stateHome } from './core.mjs';
import { appendEvent, atomicWrite, ensureDir, jsonRead, lockDir, readEvents } from './storage.mjs';
import { check, choice, id, keys, object, text } from './validation.mjs';
import { assertNoSecrets } from './security.mjs';
import { loadAgents } from './agents.mjs';

export const TEAM_LIMITS = {
  nameBytes: 128,
  objectiveBytes: 100000,
  subjectBytes: 512,
  descriptionBytes: 20000,
  messageBytes: 64000,
  resultBytes: 20000,
  inboxMessages: 1024,
  maxTasks: 256,
  maxMembers: 16,
};
export const TASK_STATUSES = ['pending', 'claimed', 'completed', 'failed'];
export const COMPLETION_STATUSES = ['completed', 'failed'];
// `host` is the CLI itself: it may send but never receives, because host state
// lives in events.jsonl, not in a member mailbox.
export const HOST_SENDER = 'host';

const newId = (prefix) => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;

function teamPaths(cwd, teamId) {
  id(teamId, 'team id');
  const root = stateHome(),
    dir = join(projectDir(cwd), 'teams', teamId);
  return {
    root,
    dir,
    record: join(dir, 'team.json'),
    tasks: join(dir, 'tasks.json'),
    events: join(dir, 'events.jsonl'),
    inbox: (member) => join(dir, 'inbox', `${member}.jsonl`),
  };
}

function validateMembers(agents) {
  check(Array.isArray(agents), 'Team members must be an array');
  const unique = [...new Set(agents)];
  unique.forEach((name) => id(name, 'team member'));
  check(
    unique.length <= TEAM_LIMITS.maxMembers,
    `Team allows at most ${TEAM_LIMITS.maxMembers} members`,
  );
  const registry = loadAgents().agents;
  for (const name of unique)
    check(
      Object.hasOwn(registry, name),
      `Team member ${name} is not in the agent registry; add it with omha agents add`,
    );
  return unique;
}

function readTeamState(paths) {
  const record = jsonRead(paths.record, null, paths.root);
  check(
    record?.version === 1 && Array.isArray(record.members),
    'Team does not exist or its record is invalid',
  );
  const state = jsonRead(paths.tasks, null, paths.root);
  check(
    state?.version === 1 && Array.isArray(state.tasks),
    'Invalid team task state',
    'corrupt_state',
  );
  for (const task of state.tasks) {
    check(
      typeof task.id === 'string' &&
        TASK_STATUSES.includes(task.status) &&
        Array.isArray(task.dependsOn),
      'Invalid team task entry',
      'corrupt_state',
    );
  }
  return { record, state };
}

function derivedStatus(task, byId) {
  if (task.status !== 'pending') return null;
  const deps = task.dependsOn.map((dep) => byId[dep]?.status);
  if (deps.some((status) => status === 'failed' || status === undefined)) return 'blocked';
  if (deps.every((status) => status === 'completed')) return 'ready';
  return 'waiting';
}

function withDerived(state) {
  const byId = Object.fromEntries(state.tasks.map((task) => [task.id, task]));
  return {
    byId,
    view: state.tasks.map((task) => ({ ...task, derived: derivedStatus(task, byId) })),
  };
}

function taskView(tasks) {
  return tasks.map(
    ({ id, subject, description, dependsOn, status, assignee, result, derived }) => ({
      id,
      subject,
      ...(description !== undefined ? { description } : {}),
      dependsOn,
      status,
      ...(assignee ? { assignee } : {}),
      ...(result ? { result } : {}),
      ...(derived ? { derived } : {}),
    }),
  );
}

function event(paths, value) {
  appendEvent(paths.events, { ...value, at: now() }, paths.root);
}

function mutateTasks(cwd, teamId, taskId, mutate) {
  const paths = teamPaths(cwd, teamId);
  const release = lockDir(join(paths.dir, '.team.lock'), { root: paths.root, staleMs: 0 });
  try {
    const { record, state } = readTeamState(paths);
    const task = state.tasks.find((entry) => entry.id === taskId);
    check(task, 'Unknown team task');
    const result = mutate(task, state, record, paths);
    atomicWrite(paths.tasks, JSON.stringify(state, null, 2), paths.root);
    return result;
  } finally {
    release();
  }
}

export function createTeam(cwd, { name, objective, agents = [] } = {}) {
  text(name, 'team name', TEAM_LIMITS.nameBytes);
  assertNoSecrets(name);
  if (objective !== undefined) {
    text(objective, 'team objective', TEAM_LIMITS.objectiveBytes);
    assertNoSecrets(objective);
  }
  const members = validateMembers(agents);
  const teamId = newId('team'),
    paths = teamPaths(cwd, teamId);
  ensureDir(join(paths.dir, 'inbox'), paths.root);
  const record = {
    version: 1,
    teamId,
    name,
    ...(objective !== undefined ? { objective } : {}),
    members,
    createdAt: now(),
  };
  const state = { version: 1, teamId, tasks: [] };
  atomicWrite(paths.record, JSON.stringify(record, null, 2), paths.root);
  atomicWrite(paths.tasks, JSON.stringify(state, null, 2), paths.root);
  event(paths, { kind: 'team.created', teamId, members });
  return { ...record, dir: paths.dir };
}

export function listTeams(cwd) {
  const dir = join(projectDir(cwd), 'teams');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^team-[a-f0-9]{16}$/.test(name))
    .sort()
    .map((teamId) => {
      const paths = teamPaths(cwd, teamId);
      const { record, state } = readTeamState(paths);
      return {
        teamId,
        name: record.name,
        members: record.members,
        createdAt: record.createdAt,
        tasks: state.tasks.length,
        open: state.tasks.filter((task) => !COMPLETION_STATUSES.includes(task.status)).length,
      };
    });
}

export function teamStatus(cwd, teamId) {
  const paths = teamPaths(cwd, teamId);
  const { record, state } = readTeamState(paths);
  const { view } = withDerived(state);
  return {
    ...record,
    tasks: taskView(view),
    mailbox: Object.fromEntries(
      record.members.map((member) => [
        member,
        existsSync(paths.inbox(member)) ? readEvents(paths.inbox(member), paths.root).length : 0,
      ]),
    ),
    events: readEvents(paths.events, paths.root).slice(-50),
  };
}

export function addTeamTask(cwd, teamId, { subject, description, dependsOn = [] } = {}) {
  text(subject, 'task subject', TEAM_LIMITS.subjectBytes);
  assertNoSecrets(subject);
  if (description !== undefined) {
    text(description, 'task description', TEAM_LIMITS.descriptionBytes);
    assertNoSecrets(description);
  }
  id(teamId, 'team id');
  const deps = [...new Set(dependsOn)];
  deps.forEach((dep) => id(dep, 'dependency'));
  const paths = teamPaths(cwd, teamId);
  const release = lockDir(join(paths.dir, '.team.lock'), { root: paths.root, staleMs: 0 });
  try {
    const { state } = readTeamState(paths);
    check(
      state.tasks.length < TEAM_LIMITS.maxTasks,
      `Team allows at most ${TEAM_LIMITS.maxTasks} tasks`,
    );
    const byId = new Set(state.tasks.map((task) => task.id));
    for (const dep of deps) check(byId.has(dep), `Unknown dependency ${dep}`);
    const task = {
      id: newId('task'),
      subject,
      ...(description !== undefined ? { description } : {}),
      dependsOn: deps,
      status: 'pending',
      assignee: null,
      createdAt: now(),
    };
    state.tasks.push(task);
    atomicWrite(paths.tasks, JSON.stringify(state, null, 2), paths.root);
    event(paths, { kind: 'task.added', teamId, taskId: task.id, dependsOn: deps });
    return { teamId, taskId: task.id, subject };
  } finally {
    release();
  }
}

export function claimTeamTask(cwd, teamId, taskId, agent) {
  id(agent, 'claiming agent');
  return mutateTasks(cwd, teamId, taskId, (task, state, record) => {
    check(record.members.includes(agent), `Agent ${agent} is not a member of this team`);
    check(task.status === 'pending', 'Only pending tasks can be claimed');
    const { byId } = withDerived(state);
    check(derivedStatus(task, byId) === 'ready', 'Task dependencies are not completed yet');
    task.status = 'claimed';
    task.assignee = agent;
    task.claimedAt = now();
    const paths = teamPaths(cwd, teamId);
    event(paths, { kind: 'task.claimed', teamId, taskId, agent });
    return { teamId, taskId, agent, status: 'claimed' };
  });
}

export function completeTeamTask(cwd, teamId, taskId, agent, { status, summary } = {}) {
  id(agent, 'completing agent');
  choice(status, COMPLETION_STATUSES, 'task completion status');
  if (summary !== undefined) {
    text(summary, 'task result summary', TEAM_LIMITS.resultBytes);
    assertNoSecrets(summary);
  }
  return mutateTasks(cwd, teamId, taskId, (task, _state, _record, paths) => {
    check(task.status === 'claimed', 'Only claimed tasks can be completed');
    check(task.assignee === agent, 'Only the claiming agent may complete the task', 'ownership');
    task.status = status;
    task.result = { summary: summary ?? null, by: agent, at: now() };
    event(paths, {
      kind: status === 'completed' ? 'task.completed' : 'task.failed',
      teamId,
      taskId,
      agent,
    });
    return { teamId, taskId, agent, status, result: task.result };
  });
}

export function sendTeamMessage(cwd, teamId, { from = HOST_SENDER, to, taskId, content } = {}) {
  if (from !== HOST_SENDER) id(from, 'message sender');
  id(to, 'message recipient');
  text(content, 'message content', TEAM_LIMITS.messageBytes);
  assertNoSecrets(content);
  const paths = teamPaths(cwd, teamId);
  const release = lockDir(join(paths.dir, '.team.lock'), { root: paths.root, staleMs: 0 });
  try {
    const { record, state } = readTeamState(paths);
    check(
      from === HOST_SENDER || record.members.includes(from),
      `Sender ${from} is not a member of this team`,
    );
    check(record.members.includes(to), `Recipient ${to} is not a member of this team`);
    check(from !== to, 'A member cannot message itself');
    if (taskId !== undefined) {
      id(taskId, 'message task id');
      check(
        state.tasks.some((task) => task.id === taskId),
        'Message references an unknown task',
      );
    }
    const existing = existsSync(paths.inbox(to))
      ? readEvents(paths.inbox(to), paths.root).length
      : 0;
    check(
      existing < TEAM_LIMITS.inboxMessages,
      `Mailbox for ${to} is full (max ${TEAM_LIMITS.inboxMessages} messages)`,
      'mailbox_full',
    );
    const message = {
      version: 1,
      messageId: newId('msg'),
      teamId,
      from,
      to,
      taskId: taskId ?? null,
      content,
      contentHash: hash(content),
      at: now(),
    };
    appendEvent(paths.inbox(to), message, paths.root);
    event(paths, {
      kind: 'message.created',
      teamId,
      messageId: message.messageId,
      from,
      to,
      ...(taskId !== undefined ? { taskId } : {}),
      contentHash: message.contentHash,
    });
    return { teamId, messageId: message.messageId, from, to };
  } finally {
    release();
  }
}

function validateMessage(message, agent, paths) {
  object(message, 'mailbox message');
  keys(
    message,
    ['version', 'messageId', 'teamId', 'from', 'to', 'taskId', 'content', 'contentHash', 'at'],
    'mailbox message',
  );
  check(message.version === 1, 'Unknown mailbox message version', 'corrupt_state');
  id(message.messageId, 'message id');
  check(message.to === agent, 'Mailbox message addressed to another member', 'corrupt_state');
  check(
    hash(message.content) === message.contentHash,
    'Mailbox message content was changed',
    'corrupt_state',
  );
  check(typeof message.at === 'string', 'Invalid mailbox message timestamp', 'corrupt_state');
  return message;
}

export function readTeamMailbox(cwd, teamId, agent, { since } = {}) {
  id(agent, 'mailbox reader');
  const paths = teamPaths(cwd, teamId);
  const { record } = readTeamState(paths);
  check(record.members.includes(agent), `Agent ${agent} is not a member of this team`);
  const file = paths.inbox(agent);
  const messages = existsSync(file)
    ? readEvents(file, paths.root).map((message) => validateMessage(message, agent, paths))
    : [];
  let start = 0;
  if (since !== undefined) {
    id(since, 'mailbox cursor');
    const index = messages.findIndex((message) => message.messageId === since);
    check(index >= 0, 'Unknown mailbox cursor; the message may have been trimmed', 'configuration');
    start = index + 1;
  }
  return {
    teamId,
    agent,
    messages: messages.slice(start).map(({ version, ...rest }) => rest),
    cursor: messages.length ? messages.at(-1).messageId : null,
  };
}
