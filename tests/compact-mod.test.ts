// Runs under `claude plugin test`: the real Claude Code engine loads
// hooks/register.mjs while this file fires events and stubs the mods API,
// including the `omha compact rpc` host, without a session or model call.
import { expect, mock, test } from 'claude-code/testing';

const ACTIVATION = 'compact-verify';
const OBSERVING = {
  state: 'observing',
  reason: 'cache_observation_unavailable',
  dueAt: null,
  latestStartAt: null,
};

type Step = { argv: string[]; request: any };

function setup(on: any, captures: { notices: string[]; compacts: number }, stepUsage: any = null) {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, { OMHA_COMPACT_ACTIVATION: ACTIVATION });
  on('session.start', () => ({ cwd: '/work' }));
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }));
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }));
  on('turn.step', async function* (_$: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: stepUsage,
    };
  });
  on('turn.complete', () => ({ text: '' }));
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'native-sess-1' }));
  on('session.version', () => ({ value: { version: '2.1.316 (Claude Code)' } }));
  on('session.model', () => ({ value: 'sonnet' }));
  on('settings.read', () => ({ value: { idleCompaction: false } }));
  on('agent.list', () => ({ value: [] }));
  on('ui.status', (_$: any, e: any) => {
    captures.notices.push(e.text);
    return { value: undefined };
  });
  on('session.compact', (_$: any, e: any) => {
    captures.compacts += 1;
    const messages = [{ role: 'assistant', text: 'summary', toolUses: [] }];
    // `value` answers the $.session.compact() call for the controller; the
    // top-level `messages` satisfy the same-name lifecycle event validation.
    return { ...e, value: { messages }, messages };
  });
  return clock;
}

async function consumeStep(stream: any) {
  let step = await stream.next();
  while (step.done !== true) step = await stream.next();
  return step.value;
}

function fakeHost(on: any, steps: Step[]) {
  // A canned version of the `omha compact rpc` contract in lib/compact.mjs:
  // version 1 envelopes, work-gated admission, and admission that turns off
  // after a finished operation so a second native compact cannot be admitted.
  let hasWork = false;
  let claimed = false;
  let finished = false;
  const view = (extra: Record<string, unknown> = {}) => ({ ...OBSERVING, ...extra });
  const armed = () =>
    view({ state: 'armed', reason: 'scheduled', dueAt: 1_120_000, latestStartAt: 1_150_000 });
  const responses: Record<string, () => any> = {
    register: () => view({ ownerToken: 'tok-1', inputRevision: 0 }),
    input: () => view({ reason: 'busy_or_pending_input' }),
    request_start: () => view({ reason: 'busy_or_pending_input' }),
    request_complete: () => {
      hasWork = true;
      return view({ reason: 'busy_or_pending_input' });
    },
    idle: () => (hasWork && !finished ? armed() : view()),
    refresh: () => (hasWork && !finished ? armed() : view()),
    claim: () => {
      if (!hasWork || claimed || finished)
        return view({ reason: finished ? 'no_new_business' : 'cache_observation_unavailable' });
      claimed = true;
      return view({ state: 'due', reason: null, operationId: 'op-1' });
    },
    consume: () => view({ state: 'due', reason: null }),
    finish: () => {
      finished = true;
      return view({ reason: 'no_new_business' });
    },
  };
  let fallback = 0;
  const order = [
    'register',
    'input',
    'request_start',
    'request_complete',
    'idle',
    'claim',
    'idle',
    'consume',
    'finish',
  ];
  on('process.run', (_$: any, e: any) => {
    let request = null;
    const raw = e?.init?.stdin ?? e?.stdin;
    if (typeof raw === 'string') {
      try {
        request = JSON.parse(raw);
      } catch {
        request = null;
      }
    }
    if (!request) request = { action: order[fallback] ?? 'refresh' };
    fallback += 1;
    steps.push({ argv: e.argv, request });
    const respond = responses[request.action] ?? (() => view());
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ version: 1, ok: true, result: respond() }),
        stderr: '',
      },
    };
  });
}

test('session.start registers with the host and stays observing without cache evidence', async ($: any, on: any) => {
  const captures = { notices: [] as string[], compacts: 0 };
  const steps: Step[] = [];
  const clock = setup(on, captures);
  fakeHost(on, steps);

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  // A non-terminal surface never registers even with the activation present.
  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work' });
  await clock.settle();

  expect(steps.length).toBe(1);
  expect(steps[0].argv.slice(0, 3)).toEqual(['omha', 'compact', 'rpc']);
  expect(steps[0].request.action).toBe('register');
  expect(steps[0].request.activationId).toBe(ACTIVATION);
  expect(steps[0].request.sessionId).toBe('native-sess-1');
  expect(steps[0].request.data).toMatchObject({
    version: '2.1.316 (Claude Code)',
    model: 'sonnet',
    idleCompaction: false,
    interactive: true,
  });
  expect(typeof steps[0].request.data.runtimeId).toBe('string');

  // The session stays busy before an observed idle turn, so the 15-second
  // metadata refresh timer must not reach the host either.
  await clock.advance(60_000);
  await clock.settle();
  expect(steps.length).toBe(1);
  expect(captures.compacts).toBe(0);
});

test('a business turn arms, claims, consumes and applies one native compact', async ($: any, on: any) => {
  const captures = { notices: [] as string[], compacts: 0 };
  const steps: Step[] = [];
  const clock = setup(on, captures, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 1200,
    cache_creation_input_tokens: 40,
  });
  fakeHost(on, steps);

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  await $.prompt.submit({ text: 'please work' });
  await $.turn.start({ turnId: 't1' });
  await consumeStep($.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1 }));
  await $.turn.complete({
    turnId: 't1',
    answer: 'done',
    durationMs: 4,
    isAborted: false,
    usage: null,
  });
  await clock.settle();
  await clock.advance(120_000);
  await clock.settle();

  const actions = steps.map((step) => step.request.action);
  expect(actions).toContain('input');
  expect(actions).toContain('request_start');
  expect(actions.indexOf('claim')).toBeLessThan(actions.lastIndexOf('idle'));
  expect(actions.indexOf('consume')).toBeLessThan(actions.indexOf('finish'));
  const complete = steps.find((step) => step.request.action === 'request_complete');
  expect(complete.request.data.cacheObserved).toBe(true);
  const finish = steps.find((step) => step.request.action === 'finish');
  expect(finish.request.data.result).toBe('applied');
  expect(typeof finish.request.data.boundary).toBe('string');
  expect(captures.compacts).toBe(1);
  expect(captures.notices).toContain('Auto compact completed.');
});

test('slash commands and subagent turns do not re-arm maintenance', async ($: any, on: any) => {
  const captures = { notices: [] as string[], compacts: 0 };
  const steps: Step[] = [];
  const clock = setup(on, captures);
  fakeHost(on, steps);

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  await $.prompt.submit({ text: '/status' });
  await $.turn.start({ turnId: 't-sub', agentId: 'agent-1' });
  await consumeStep(
    $.turn.step({
      turnId: 't-sub',
      index: 0,
      agentId: 'agent-1',
      model: 'claude-test',
      messageCount: 1,
    }),
  );
  await $.turn.complete({
    turnId: 't-sub',
    agentId: 'agent-1',
    answer: '',
    durationMs: 1,
    isAborted: false,
    usage: null,
  });
  await clock.settle();

  const business = steps.filter((step) =>
    ['input', 'request_start', 'request_complete'].includes(step.request.action),
  );
  expect(business).toEqual([]);
  expect(captures.compacts).toBe(0);

  await $.prompt.submit({ text: 'real work' });
  await clock.settle();
  const input = steps.find((step) => step.request.action === 'input');
  expect(input.request.data.revision).toBe(1);
});
