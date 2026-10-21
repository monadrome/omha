#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const file = join(process.env.OMHA_HOME, 'cmux-fixture.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--id-format') args.splice(0, 2);
if (args[0] === '--json') args.shift();
const option = (key) => args[args.indexOf(key) + 1];
const fail = (message = 'fixture operation rejected') => {
  writeFileSync(file, JSON.stringify(state));
  process.stderr.write(message);
  process.exit(1);
};
const output = (value) => {
  writeFileSync(file, JSON.stringify(state));
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
};
state.calls.push(args);
if (args[0] === 'identify') {
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
