import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { invocation, kiroRunError, parseOutput, summarizeEvent } from '../lib/adapters.mjs';
import { validateProfiles } from '../lib/profiles.mjs';

const root = temp();
process.env.OMHA_HOME = join(root, 'state');
const SESSION = 'sess_fixture';

const update = (body, sessionId = SESSION) => ({
  type: 'sessionUpdate',
  data: { sessionId, update: body },
});
const info = (kiro) => update({ sessionUpdate: 'session_info_update', _meta: { kiro } });
const chunk = (text) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const modelOption = (currentValue) =>
  update({
    sessionUpdate: 'config_option_update',
    configOptions: [{ id: 'model', category: 'model', currentValue, options: [] }],
  });
const started = (engine = 'v3') => ({
  type: 'runStarted',
  data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine },
});
const finished = (finalText, extra = {}) => ({
  type: 'runFinished',
  data: {
    sessionId: SESSION,
    status: 'success',
    stopReason: 'end_turn',
    finalText,
    finalTextTruncated: false,
    ...extra,
  },
});
const turnCompletion = (usage) =>
  info({
    kind: 'turn_completion',
    status: 'success',
    elapsedTime: 4934,
    turnId: 'turn-1',
    promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage }],
  });
const toolCall = (id, kind, status = 'in_progress') =>
  update({
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: 'Secret command title',
    kind,
    status,
    locations: [{ path: '/work/file.txt' }],
    rawInput: { command: 'cat secret-token' },
  });
const toolUpdate = (id, status) =>
  update({ sessionUpdate: 'tool_call_update', toolCallId: id, status, rawOutput: { text: 'x' } });
const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const success = (events = [], text = 'OK') =>
  jsonl([
    started(),
    modelOption('auto'),
    modelOption('fixture-model'),
    ...events,
    chunk(text),
    turnCompletion(0.5),
    finished(text),
  ]);

const profiles = validateProfiles(
  config({
    kiro: {},
    writer: {
      adapter: 'kiro',
      command: 'kiro-cli',
      model: 'fixture-model',
      sandbox: 'workspace-write',
      effort: 'high',
    },
  }),
).profiles;

test('Kiro invocation pins the ACP v3 stream, passes the prompt on stdin and maps trust to mode', () => {
  assert.deepEqual(profiles.kiro.capabilities, ['headless', 'read-only']);
  assert.equal(profiles.kiro.model, 'auto');
  assert.deepEqual(invocation(profiles.kiro, 'inspect the tree'), {
    command: 'kiro-cli',
    args: [
      'chat',
      '--agent-engine',
      'v3',
      '--output-format',
      'stream-json',
      '--no-interactive',
      '--model',
      'auto',
      '--trust-tools=',
    ],
    input: 'inspect the tree',
  });
  const write = invocation(profiles.writer, 'edit it', {
    mode: 'write',
    model: 'other',
    effort: 'low',
  });
  assert.deepEqual(write.args.slice(-5), [
    '--model',
    'other',
    '--effort',
    'low',
    '--trust-all-tools',
  ]);
  assert.equal(write.input, 'edit it');
  assert.throws(() => invocation(profiles.kiro, 'vote', { toolFree: true }), /tool-free/);
  assert.throws(
    () => invocation(profiles.kiro, 'edit', { mode: 'write' }),
    /cannot execute a write/,
  );
  assert.throws(() => invocation(profiles.writer, 'read'), /does not enforce read-only/);
  assert.throws(() => invocation(profiles.kiro, 'read', { effort: 'minimal' }), /minimal effort/);
});

test('Kiro profiles reject unenforceable tiers and unsupported effort', () => {
  assert.deepEqual(profiles.writer.capabilities, ['headless']);
  assert.throws(
    () => validateProfiles(config({ kiro: { capabilities: ['headless', 'tool-free'] } })),
    /cannot enforce tool-free/,
  );
  assert.throws(() => validateProfiles(config({ kiro: { effort: 'minimal' } })), /minimal effort/);
});

test('Kiro streams require run start, final result and a stable session', () => {
  const parsed = parseOutput(
    'kiro',
    success([toolCall('r1', 'read'), toolUpdate('r1', 'completed')]),
    'text',
    {
      configuredModel: 'fixture-model',
      executionMode: 'read-only',
    },
  );
  assert.equal(parsed.output, 'OK');
  assert.equal(parsed.requestId, SESSION);
  assert.equal(parsed.servedModel, null);
  assert.equal(parsed.usage.raw.credits, 0.5);
  assert.equal(parsed.usage.normalized.totalTokens, null);
  assert.equal(parsed.usage.normalized.cacheStatus, 'unknown');

  const truncated = jsonl([
    started(),
    chunk('full '),
    chunk('answer'),
    finished('full', { finalTextTruncated: true }),
  ]);
  assert.equal(parseOutput('kiro', truncated).output, 'full answer');

  const failures = [
    [jsonl([chunk('OK'), finished('OK')]), /Missing Kiro run start/],
    [jsonl([started('v2'), chunk('OK'), finished('OK')]), /ACP v3 engine/],
    [jsonl([started(), chunk('OK')]), /Missing final Kiro run result/],
    [
      jsonl([started(), chunk('OK'), finished('OK'), chunk('late')]),
      /Missing final Kiro run result/,
    ],
    [jsonl([started(), started(), finished('OK')]), /Unexpected Kiro run event/],
    [
      jsonl([started(), { type: 'metadata', data: {} }, finished('OK')]),
      /Unexpected Kiro run event/,
    ],
    [jsonl([started(), { type: 'sessionUpdate' }, finished('OK')]), /data object/],
    [jsonl([started(), update({ content: 'x' }), finished('OK')]), /Invalid Kiro session update/],
    [
      jsonl([
        started(),
        chunk('OK'),
        update({ sessionUpdate: 'plan' }, 'sess_other'),
        finished('OK'),
      ]),
      /session identity changed/,
    ],
    [
      jsonl([started(), chunk('OK'), finished('OK', { sessionId: 'sess_other' })]),
      /session identity changed/,
    ],
    [jsonl([started(), chunk('OK'), finished('OK', { status: 'failed' })]), /Kiro run is failed/],
    [
      jsonl([started(), chunk('OK'), finished('OK', { stopReason: 'max_tokens' })]),
      /stopped with max_tokens/,
    ],
    [jsonl([started(), finished('   ')]), /Missing completed provider response/],
    [
      jsonl([
        started(),
        { type: 'runError', data: { stage: 'prompt', message: 'InvalidModelError' } },
      ]),
      /InvalidModelError/,
    ],
    [
      jsonl([started(), update({ sessionUpdate: 'tool_call', kind: 'read' }), finished('OK')]),
      /missing its id/,
    ],
  ];
  for (const [input, pattern] of failures) assert.throws(() => parseOutput('kiro', input), pattern);
  assert.throws(
    () => parseOutput('kiro', success(), 'text', { configuredModel: 'requested-model' }),
    /configured model did not match/,
  );
});

test('Kiro read-only results fail closed when a non-read tool completed', () => {
  const readOnly = { executionMode: 'read-only' };
  const denied = success([
    toolCall('w1', 'edit'),
    toolUpdate('w1', 'pending'),
    toolUpdate('w1', 'failed'),
  ]);
  assert.equal(parseOutput('kiro', denied, 'text', readOnly).output, 'OK');
  for (const events of [
    [toolCall('w2', 'edit'), toolUpdate('w2', 'completed')],
    [toolCall('x1', 'execute', 'completed')],
    [toolCall('f1', 'fetch'), toolUpdate('f1', 'completed')],
    [toolUpdate('u1', 'completed')],
  ])
    assert.throws(
      () => parseOutput('kiro', success(events), 'text', readOnly),
      /non-read tool call/,
    );
  assert.equal(
    parseOutput('kiro', success([toolCall('w3', 'edit'), toolUpdate('w3', 'completed')]), 'text', {
      executionMode: 'full',
    }).output,
    'OK',
  );
});

test('Kiro event summaries flatten ACP updates without tool arguments or message text', () => {
  const tool = summarizeEvent('kiro', toolCall('t1', 'execute'));
  assert.equal(tool.type, 'tool_call');
  assert.equal(tool.tool, 'execute');
  assert.equal(tool.status, 'in_progress');
  assert.equal(tool.requestId, SESSION);
  assert.deepEqual(tool.files, ['/work/file.txt']);
  assert.equal(JSON.stringify(tool).includes('secret-token'), false);
  assert.equal(JSON.stringify(tool).includes('Secret command title'), false);
  const message = summarizeEvent('kiro', chunk('private answer'));
  assert.equal(message.type, 'agent_message_chunk');
  assert.equal(JSON.stringify(message).includes('private answer'), false);
  const waiting = summarizeEvent(
    'kiro',
    info({ kind: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 't1' }),
  );
  assert.equal(waiting.type, 'pending_interaction');
  assert.equal(waiting.inputWait, true);
  const done = summarizeEvent('kiro', turnCompletion(0.25));
  assert.equal(done.type, 'turn_completion');
  assert.equal(done.turnId, 'turn-1');
  assert.equal(done.durationMs, 4934);
  assert.equal(done.usage.normalized.cacheStatus, 'unknown');
  assert.equal(summarizeEvent('kiro', started()).type, 'runStarted');
  assert.equal(summarizeEvent('kiro', { type: 'sessionUpdate', data: null }).type, 'sessionUpdate');
  assert.equal(
    kiroRunError(jsonl([started(), { type: 'runError', data: { message: 'boom' } }])),
    'boom',
  );
  assert.equal(kiroRunError(jsonl([started(), chunk('runError')])), null);
  assert.equal(kiroRunError('not json'), null);
});

function executable(name, events, { code = 0, stderr = '' } = {}) {
  const file = join(root, name);
  const record = join(root, `${name}.json`);
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), input }));
  process.stdout.write(${JSON.stringify(jsonl(events))});
  if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
  process.exitCode = ${code};
});
`,
  );
  chmodSync(file, 0o755);
  return { file, record };
}

const runtimeFor = (command, extra = {}) =>
  createRuntime(
    config({
      p: {
        adapter: 'kiro',
        command,
        model: 'fixture-model',
        retry: { maxRetries: 0, baseMs: 0, maxMs: 1, jitter: 0 },
        budget: { reserveTokens: 10, reserveCostUsd: 0 },
        fallback: ['q'],
        ...extra,
      },
      q: fake('fallback'),
    }),
    { persistent: false },
  );

test('Kiro runtime dispatch validates the real process stream and streams summaries', async () => {
  const { file, record } = executable('kiro-ok', [
    started(),
    modelOption('fixture-model'),
    toolCall('r1', 'read'),
    toolUpdate('r1', 'completed'),
    chunk('The answer mentions 429 rate limit.'),
    turnCompletion(0.75),
    finished('The answer mentions 429 rate limit.'),
  ]);
  const runtime = runtimeFor(file);
  const delivered = [];
  const result = await runtime.dispatch('read the tree', ['p'], {
    streamEvents: true,
    onProviderEvent: (event) => delivered.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'kiro');
  assert.equal(result.stdout, 'The answer mentions 429 rate limit.');
  assert.equal(result.requestId, SESSION);
  assert.equal(result.servedModel, null);
  assert.equal(result.stream.supported, true);
  assert.equal(result.stream.complete, true);
  assert.equal(result.stream.delivered, 7);
  assert.equal(
    delivered.every((event) => event.realtime),
    true,
  );
  assert.equal(result.usage.raw.credits, 0.75);
  assert.equal(result.usage.estimated, true);
  const seen = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(seen.input, 'read the tree');
  assert.equal(seen.args.includes('--trust-tools='), true);
  assert.equal(seen.args.includes('--trust-all-tools'), false);
  assert.equal(runtime.fakeOffsets.has('q'), false);
});

test('Kiro failures classify from runError, not model or tool text', async () => {
  const noisy = [
    started(),
    chunk('upstream said 503 capacity, 401 unauthorized and retry-after: 999'),
  ];
  const invalid = executable(
    'kiro-invalid',
    [
      ...noisy,
      {
        type: 'runError',
        data: {
          stage: 'prompt',
          message:
            'The model \'x\' is not available (code -32000): {"errorType":"InvalidModelError"}',
        },
      },
    ],
    { code: 1, stderr: '[INFO] kas.server.starting\n' },
  );
  const refused = await runtimeFor(invalid.file).dispatch('task', ['p']);
  assert.equal(refused.ok, false);
  assert.equal(refused.failure, 'configuration');
  assert.equal(refused.attempts.length, 1);
  assert.match(refused.attempts[0].stderr, /InvalidModelError/);
  assert.equal(refused.attempts[0].retryAfterMs, null);

  const crashed = executable('kiro-crash', noisy, { code: 1 });
  const unknown = await runtimeFor(crashed.file).dispatch('task', ['p']);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.failure, 'task');
  assert.equal(unknown.attempts.length, 1);

  const limited = executable(
    'kiro-limited',
    [started(), { type: 'runError', data: { message: 'Too many requests' } }],
    {
      code: 1,
    },
  );
  const fallback = await runtimeFor(limited.file).dispatch('task', ['p']);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.attempts[0].failure, 'rate_limit');
  assert.equal(fallback.servedProfile, 'q');

  const wrote = executable('kiro-wrote', [
    started(),
    toolCall('w1', 'edit', 'completed'),
    chunk('done'),
    finished('done'),
  ]);
  const rejected = await runtimeFor(wrote.file).dispatch('task', ['p']);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failure, 'malformed_output');
  assert.equal(rejected.attempts.length, 1);
});
