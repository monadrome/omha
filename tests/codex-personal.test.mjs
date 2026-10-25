import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './helpers.mjs';
import { validateProfiles } from '../lib/profiles.mjs';
import { invocation, parseOutput, summarizeEvent } from '../lib/adapters.mjs';

const protocol = 'codex-personal/1';
const expected = { codexProtocol: protocol, configuredModel: 'local-model' };
const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n');
function events(toolFree = false) {
  return [
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'session.configured',
      protocol,
      thread_id: 'thread-1',
      configured_model: 'local-model',
      model_provider: 'compatible',
      ephemeral: false,
      default_goal_enabled: !toolFree,
      tool_allowlist: toolFree ? [] : null,
    },
    ...(!toolFree ? [{ type: 'goal.updated', thread_id: 'thread-1', status: 'complete' }] : []),
    { type: 'item.completed', item: { type: 'agent_message', text: 'Verified answer.' } },
    {
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 },
    },
  ];
}

test('only an explicit personal Codex profile qualifies for tool-free routing', () => {
  const profiles = validateProfiles(
    config({
      codex: {},
      personal: {
        adapter: 'codex',
        command: 'personal-codex',
        model: 'local-model',
        codexProtocol: protocol,
      },
    }),
  ).profiles;
  assert.deepEqual(profiles.codex.capabilities, ['headless', 'read-only']);
  assert.deepEqual(profiles.personal.capabilities, ['headless', 'tool-free', 'read-only']);
  assert.throws(() => invocation(profiles.codex, 'vote', { toolFree: true }), /codexProtocol/);
  assert.throws(
    () => validateProfiles(config({ codex: { capabilities: ['tool-free'] } })),
    /cannot enforce/,
  );
  assert.throws(
    () => validateProfiles(config({ claude: { codexProtocol: protocol } })),
    /Codex adapter/,
  );
  const worker = invocation(profiles.personal, 'finish the artifact');
  assert.equal(worker.args.includes('--ephemeral'), false);
  assert.equal(worker.args[worker.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(worker.args[worker.args.indexOf('--personal-protocol') + 1], protocol);
  assert.ok(worker.args.includes('goals.default_mode=true'));
  const ceiling = worker.args.find((arg) => arg.startsWith('tools.allowed='));
  assert.ok(ceiling.includes('update_goal'));
  assert.ok(ceiling.includes('exec'));
  assert.equal(ceiling.includes('apply_patch'), false);
  assert.equal(ceiling.includes('mcp'), false);
  assert.equal(ceiling.includes('spawn_agent'), false);
  const voter = invocation(profiles.personal, 'vote', { toolFree: true });
  assert.ok(voter.args.includes('goals.default_mode=false'));
  assert.ok(voter.args.includes('tools.allowed=[]'));
  assert.equal(voter.args.includes('tools.shell=false'), false);
});

test('personal Codex read-only parsing rejects external and mutating tool ceilings', () => {
  const policy = { ...expected, executionMode: 'read-only' };
  const valid = events();
  valid[1].tool_allowlist = [
    { name: 'exec_command', namespace: 'functions' },
    { name: 'update_goal', namespace: null },
  ];
  assert.equal(parseOutput('codex', jsonl(valid), 'jsonl', policy).output, 'Verified answer.');
  for (const tool of [
    null,
    [{ name: 'apply_patch' }],
    [{ name: 'spawn_agent' }],
    [{ name: 'exec_command', namespace: 'external' }],
    [{ name: 'write', namespace: 'mcp' }],
  ]) {
    const invalid = structuredClone(valid);
    invalid[1].tool_allowlist = tool;
    assert.throws(() => parseOutput('codex', jsonl(invalid), 'jsonl', policy), /tool ceiling/);
  }
});

test('personal Codex requires matching persistent configuration and a complete Goal', () => {
  const valid = events();
  assert.equal(parseOutput('codex', jsonl(valid), 'jsonl', expected).output, 'Verified answer.');
  for (const status of ['active', 'paused', 'blocked', 'budget_limited', 'usage_limited']) {
    const invalid = structuredClone(valid);
    invalid[2].status = status;
    assert.throws(() => parseOutput('codex', jsonl(invalid), 'jsonl', expected), /Codex goal/);
  }
  for (const change of [
    { protocol: 'other/1' },
    { ephemeral: true },
    { thread_id: 'other' },
    { default_goal_enabled: false },
    { configured_model: 'other' },
  ]) {
    const invalid = structuredClone(valid);
    Object.assign(invalid[1], change);
    assert.throws(() => parseOutput('codex', jsonl(invalid), 'jsonl', expected));
  }
  assert.throws(
    () =>
      parseOutput(
        'codex',
        jsonl(valid.filter((event) => event.type !== 'goal.updated')),
        'jsonl',
        expected,
      ),
    /missing/,
  );
  assert.throws(
    () =>
      parseOutput(
        'codex',
        jsonl(valid.filter((event) => event.type !== 'session.configured')),
        'jsonl',
        expected,
      ),
    /protocol/,
  );
  const wrongGoal = structuredClone(valid);
  wrongGoal[2].thread_id = 'other';
  assert.throws(() => parseOutput('codex', jsonl(wrongGoal), 'jsonl', expected), /identity/);
  assert.throws(
    () => parseOutput('codex', jsonl([...valid, { type: 'turn.started' }]), 'jsonl', expected),
    /final Codex turn/,
  );
});

test('personal Codex tool-free output cannot enable tools or claim autonomous completion', () => {
  const valid = events(true);
  const policy = { ...expected, toolFree: true };
  assert.equal(parseOutput('codex', jsonl(valid), 'jsonl', policy).output, 'Verified answer.');
  const unrestricted = structuredClone(valid);
  unrestricted[1].tool_allowlist = null;
  assert.throws(() => parseOutput('codex', jsonl(unrestricted), 'jsonl', policy), /tool-free/);
  for (const extra of [
    { type: 'goal.updated', thread_id: 'thread-1', status: 'complete' },
    { type: 'tool.completed', tool: 'terminal' },
    { type: 'item.started', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call' } },
  ])
    assert.throws(
      () => parseOutput('codex', jsonl([...valid, extra]), 'jsonl', policy),
      /tool-free/,
    );
});

test('Codex keeps final cumulative usage without counting earlier turns twice', () => {
  const stream = events();
  stream.splice(2, 0, { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } });
  const parsed = parseOutput('codex', jsonl(stream), 'jsonl', expected);
  assert.equal(parsed.usage.normalized.totalTokens, 12);
  assert.equal(parsed.usage.normalized.cacheReadInputTokens, 4);
  assert.equal(parsed.requestId, 'thread-1');
  assert.equal(parsed.servedModel, null);
});

test('Codex timing and configuration summaries omit prompts, arguments and outputs', () => {
  const summary = summarizeEvent('codex', {
    type: 'tool.completed',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    item_id: 'call-1',
    tool: 'terminal',
    duration_ms: 42,
    command: 'private-command',
    arguments: { key: 'private-key' },
    output: 'private-output',
  });
  assert.equal(summary.durationMs, 42);
  assert.equal(summary.turnId, 'turn-1');
  assert.equal(summary.itemId, 'call-1');
  assert.equal(JSON.stringify(summary).includes('private-'), false);
  const configured = summarizeEvent('codex', {
    ...events()[1],
    config_sources: ['user', 'project', 'session_flags'],
  });
  assert.deepEqual(configured.configSources, ['user', 'project', 'session_flags']);
  assert.equal(configured.configuredModel, 'local-model');
  assert.equal(configured.model, null);
});
