#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const file = join(process.env.OMHA_HOME, 'cmux-fixture.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--id-format') args.splice(0, 2);
if (args[0] === '--json') args.shift();
const option = (key) => args[args.indexOf(key) + 1];
const fail = (message = 'fixture operation rejected') => {
  save();
  process.stderr.write(message);
  process.exit(1);
};
const output = (value) => {
  save();
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
};
function save() {
  const pending = `${file}.${process.pid}`;
  writeFileSync(pending, JSON.stringify(state));
  renameSync(pending, file);
}
state.calls.push(args);
state.events ||= [];
const emit = (name, surfaceId, payload) => {
  const surface = state.surfaces[surfaceId];
  state.events.push({
    type: 'event',
    protocol: 'cmux-events',
    seq: state.events.length + 1,
    category: 'agent',
    name,
    surface_id: surfaceId,
    workspace_id: surface?.ref,
    payload: { session_id: surface?.sessionId, surface_id: surfaceId, ...payload },
  });
};
if (args[0] === 'events') {
  if (state.fail === 'events') fail('events unavailable');
  if (args.includes('--snapshot'))
    output({
      type: 'ack',
      protocol: 'cmux-events',
      resume: { latest_seq: state.events.length },
    });
  else {
    const after = Number(option('--after'));
    const names = args.flatMap((value, index) => (args[index - 1] === '--name' ? [value] : []));
    const event = state.events.find((item) => item.seq > after && names.includes(item.name));
    if (!event) fail('Error: Timed out waiting for a matching event');
    output(`${JSON.stringify(event)}\n`);
  }
} else if (args[0] === 'current') {
  output({
    items: (state.tabs || []).map((tab) => ({
      durable_surface_id: tab.stable,
      label: tab.label,
      cwd: state.cwd,
      lifecycle: 'running',
      agents: tab.agents || [],
    })),
  });
} else if (args[0] === 'surface' && args[1] === 'ls') {
  output({
    projections: (state.tabs || []).map((tab) => ({
      resource: `local/terminal/${tab.surface}`,
      surface_id: tab.surface,
      workspace_id: tab.workspace,
      stable_surface_id: tab.stable,
    })),
  });
} else if (args[0] === 'read-screen') {
  output(state.screens?.[option('--surface')] || '');
} else if (args[0] === 'send') {
  const surface = option('--surface');
  (state.sent ||= []).push({ surface, text: args.at(-1) });
  if (args.at(-1) === '/compact') (state.pendingCompact ||= {})[surface] = true;
  output('OK');
} else if (args[0] === 'send-key') {
  const surface = option('--surface');
  (state.keys ||= []).push({ surface, key: args.at(-1) });
  if (state.pendingCompact?.[surface]) {
    delete state.pendingCompact[surface];
    if (state.fail !== 'compact-timeout') {
      emit('agent.hook.PreCompact', surface, { hook_event_name: 'PreCompact', trigger: 'manual' });
      const last = state.checkpoints.at(-1);
      if (state.fail === 'compact-rewrite') last.anchor = 'ordinal:rewritten';
      state.checkpoints.push({
        id: `turn:ordinal:${last.turn * 100}`,
        turn: last.turn + 1,
        source: 'turn',
        anchor: `ordinal:${last.turn * 100}`,
      });
      emit('agent.hook.SessionStart', surface, {
        hook_event_name: 'SessionStart',
        source: 'compact',
      });
    }
  }
  const message = (state.sent || []).findLast((entry) => entry.surface === surface)?.text || '';
  state.screens ||= {};
  state.screens[surface] =
    `${state.screens[surface] || ''}\n❯ ${message}\nWorking (1s • esc to interrupt)\n`;
  output('OK');
} else if (args[0] === 'rename-workspace' || args[0] === 'rename-tab') {
  if (state.fail === `rename-${args[0] === 'rename-tab' ? 'source' : 'target'}`) fail();
  (state.renames ||= []).push({
    scope: args[0] === 'rename-tab' ? 'tab' : 'workspace',
    workspace: option('--workspace'),
    ...(args[0] === 'rename-tab' ? { surface: option('--surface') } : {}),
    title: args.at(-1),
  });
  output('OK');
} else if (args[0] === 'identify') {
  output({
    caller: {
      workspace_id: process.env.CMUX_WORKSPACE_ID,
      surface_id: process.env.CMUX_SURFACE_ID,
    },
  });
} else if (args[0] === 'list-status') {
  output(
    Object.entries(state.owners[option('--workspace')] || {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
} else if (args[0] === 'set-status') {
  const owners = (state.owners[option('--workspace')] ||= {});
  owners[args[1]] = args[2];
  output('OK');
} else if (args[0] === 'surface' && args[1] === 'resume') {
  const surface = state.surfaces[option('--surface')];
  if (!surface || state.fail === 'binding' || (!surface.source && state.fail === 'ready')) fail();
  output({
    workspace_id: surface.ref,
    surface_id: option('--surface'),
    resume_binding: { kind: surface.agent, checkpoint_id: surface.sessionId, cwd: state.cwd },
    restore_record: {
      kind: surface.agent,
      checkpoint_id: surface.sessionId,
      mode: 'resumeAgent',
      launch_command: { executable_path: `/native-fixture/bin/${surface.agent}` },
      prepared_arguments:
        surface.agent === 'codex'
          ? ['codex', 'resume', surface.sessionId, '--sandbox', 'workspace-write']
          : ['claude', '--resume', surface.sessionId, '--permission-mode', 'acceptEdits'],
      prepared_arguments_working_directory: state.cwd,
      environment: {
        TEST_THREADS: '1',
        ...(surface.agent === 'claude'
          ? { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' }
          : {}),
      },
    },
  });
} else if (args[0] === 'respawn-pane') {
  if (state.fail === 'launch') fail();
  const surface = state.surfaces[option('--surface')];
  surface.sessionId = state.forks.at(-1);
  emit('agent.hook.SessionStart', option('--surface'), {
    hook_event_name: 'SessionStart',
    source: 'resume',
  });
  output('OK');
} else if (args[0] === 'close-surface') {
  if (state.fail === 'close') fail();
  state.closed.push(option('--surface'));
  delete state.surfaces[option('--surface')];
  if (state.fail === 'close-response') fail('response lost after close');
  output('OK');
} else if (args[0] === 'rpc') {
  const params = JSON.parse(args[2]);
  if (args[1] === 'vault.checkpoints') {
    output({
      agent: params.agent,
      session_id: params.session,
      supports_fork: state.fail !== 'unsupported',
      truncated: state.fail === 'truncated',
      checkpoints: state.checkpoints,
    });
  } else if (args[1] === 'vault.fork') {
    if (state.fail === 'fork') fail();
    const sessionId = randomUUID();
    state.forks.push(sessionId);
    if (state.fail === 'fork-response') output('not-json');
    else
      output({
        agent: params.agent,
        session_id: sessionId,
        parent_session_id: params.session,
        opened: false,
        cwd: state.cwd,
      });
  } else if (args[1] === 'workspace.create') {
    const ref = randomUUID(),
      surfaceRef = randomUUID();
    state.surfaces[surfaceRef] = { ref, sessionId: null, agent: state.agent };
    output({ workspace_id: ref, surface_id: surfaceRef });
  } else if (args[1] === 'agent.message.send') {
    if (state.fail === 'message') fail();
    const surface = state.surfaces[params.target];
    const receipt = {
      id: randomUUID(),
      state: 'queued',
      recipient_surface_id: params.target,
      recipient_workspace_id: surface.ref,
      body: params.body,
    };
    state.messages.push(receipt);
    output(state.fail === 'receipt' ? { ...receipt, recipient_surface_id: randomUUID() } : receipt);
  } else fail('unsupported fixture RPC');
} else fail('unsupported fixture command');
