import { StringDecoder } from 'node:string_decoder';

import { check, OmhaError } from './validation.mjs';

export function invocation(profile, prompt, request = {}) {
  const mode = request.mode || 'readonly';
  check(mode === 'readonly' || mode === 'write', 'Unknown worker mode');
  if (mode === 'write')
    check(profile.sandbox !== 'read-only', `Profile ${profile.name} cannot execute a write task`);
  if (mode === 'readonly')
    check(
      profile.sandbox !== 'workspace-write',
      `Profile ${profile.name} does not enforce read-only execution`,
    );
  if (profile.adapter === 'command' && mode === 'readonly')
    check(
      profile.sandbox === 'external' && profile.sandboxCommand,
      `Command profile ${profile.name} requires sandboxCommand with sandbox: external`,
    );
  if (profile.adapter === 'kimi' && mode === 'readonly' && !profile.kimiProtocol)
    check(
      profile.sandbox === 'external' && profile.sandboxCommand,
      'Kimi read-only execution requires sandboxCommand with sandbox: external',
    );
  let args,
    input = '';
  if (profile.adapter === 'claude') {
    args = [
      '--print',
      '--output-format',
      'json',
      '--model',
      request.model || profile.model,
      '--no-session-persistence',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ];
    if (profile.effort) args.push('--effort', request.effort || profile.effort);
    if (mode === 'readonly')
      args.push('--tools', request.toolFree ? '' : 'Read,Grep,Glob', '--permission-mode', 'plan');
    else args.push('--permission-mode', 'acceptEdits');
    if (profile.budget.reserveCostUsd > 0)
      args.push('--max-budget-usd', String(profile.budget.reserveCostUsd));
    input = prompt;
  } else if (profile.adapter === 'codex') {
    args = [
      'exec',
      '-',
      '--json',
      '--ephemeral',
      '--color',
      'never',
      '--sandbox',
      mode === 'readonly' ? 'read-only' : 'workspace-write',
      '-m',
      request.model || profile.model,
    ];
    if (profile.effort)
      args.push('-c', `model_reasoning_effort=${JSON.stringify(request.effort || profile.effort)}`);
    if (request.toolFree) args.push('-c', 'tools.shell=false', '-c', 'mcp_servers={}');
    input = prompt;
  } else if (profile.adapter === 'kimi') {
    check(
      !request.toolFree || profile.kimiProtocol,
      'Kimi does not expose a verified tool-free CLI mode',
    );
    args = ['--output-format', 'stream-json', '-m', request.model || profile.model, '-p', prompt];
    if (profile.kimiProtocol)
      args.push(
        '--execution-mode',
        request.toolFree ? 'tool-free' : mode === 'readonly' ? 'read-only' : 'full',
      );
  } else {
    args = (profile.args || []).map((arg) =>
      arg.replaceAll('{model}', request.model || profile.model),
    );
    if (args.some((arg) => arg.includes('{prompt}')))
      args = args.map((arg) => arg.replaceAll('{prompt}', prompt));
    else input = prompt;
  }
  if (
    profile.sandboxCommand &&
    (mode === 'readonly' || (mode === 'write' && profile.sandboxWrite))
  ) {
    const sandboxArgs = [];
    for (const arg of profile.sandboxArgs || []) {
      if (arg === '{args}') sandboxArgs.push(...args);
      else {
        check(
          !arg.includes('{policy}') || request.sandboxPolicyPath,
          'External write executor requires a host policy',
        );
        sandboxArgs.push(
          arg
            .replaceAll('{command}', profile.command)
            .replaceAll('{policy}', request.sandboxPolicyPath || ''),
        );
      }
    }
    if (!sandboxArgs.includes(profile.command)) sandboxArgs.push(profile.command, ...args);
    return { command: profile.sandboxCommand, args: sandboxArgs, input };
  }
  return { command: profile.command, args, input };
}

function parseJson(input, jsonl) {
  try {
    if (!jsonl) return [JSON.parse(input)];
    const lines = input.split(/\r?\n/).filter((line) => line.trim());
    check(lines.length > 0, 'Empty JSONL response', 'malformed_output');
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    throw new OmhaError(
      'malformed_output',
      error.code === 'malformed_output' ? error.message : 'Invalid JSON/JSONL provider output',
    );
  }
}

export function parseEvents(adapter, input, format = 'text') {
  const raw = String(input ?? '').trim();
  check(raw.length > 0, 'Empty provider output', 'malformed_output');
  if (format === 'text' && !['claude', 'codex', 'kimi'].includes(adapter)) return [];
  const events = parseJson(raw, adapter === 'codex' || adapter === 'kimi' || format === 'jsonl');
  check(
    events.every((event) => event && typeof event === 'object' && !Array.isArray(event)),
    'Provider events must be objects',
    'malformed_output',
  );
  return events;
}

const STREAM_LIMITS = Object.freeze({
  maxEvents: 4096,
  maxLineBytes: 512 * 1024,
  maxBufferedBytes: 1024 * 1024,
});

// Frame provider JSONL without retaining raw payloads. The synchronous callback
// lets process.run stop a provider immediately when a host consumer rejects an event.
export function createEventFramer(adapter, format = 'jsonl', options = {}) {
  check(
    adapter === 'codex' || adapter === 'kimi' || format === 'jsonl',
    'Realtime provider events require JSONL output',
  );
  const limits = { ...STREAM_LIMITS, ...options };
  const onEvent = options.onEvent;
  let buffer = '',
    count = 0,
    closed = false;
  const decoder = new StringDecoder('utf8');
  const fail = (message) => {
    throw new OmhaError('malformed_output', message);
  };
  const consume = (line) => {
    const raw = line.trim();
    if (!raw) return;
    if (Buffer.byteLength(raw) > limits.maxLineBytes)
      fail('Provider event line exceeds stream limit');
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      fail('Invalid JSON/JSONL provider output');
    }
    check(
      event && typeof event === 'object' && !Array.isArray(event),
      'Provider events must be objects',
      'malformed_output',
    );
    if (count >= limits.maxEvents) fail('Provider event stream exceeds event limit');
    const summary = summarizeEvent(adapter, event);
    const sequence = count++;
    onEvent?.(summary, sequence);
  };
  return {
    push(chunk) {
      check(!closed, 'Provider event stream is already closed', 'malformed_output');
      const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      buffer += text;
      if (Buffer.byteLength(buffer) > limits.maxBufferedBytes)
        fail('Provider event stream buffer exceeds limit');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
      if (Buffer.byteLength(buffer) > limits.maxLineBytes)
        fail('Provider event line exceeds stream limit');
    },
    finish() {
      check(!closed, 'Provider event stream is already closed', 'malformed_output');
      closed = true;
      buffer += decoder.end();
      if (buffer.trim()) fail('Incomplete provider event line');
      return count;
    },
    get count() {
      return count;
    },
  };
}

function boundedText(value, max = 512) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function tokenCount(...values) {
  return values.find((value) => Number.isFinite(value) && value >= 0) ?? null;
}

export function normalizeUsage(adapter, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.raw && value.normalized) return value;
  const raw = structuredClone(value);
  const details =
    value.prompt_tokens_details && typeof value.prompt_tokens_details === 'object'
      ? value.prompt_tokens_details
      : {};
  let cacheCreationInputTokens = tokenCount(
    value.cache_creation_input_tokens,
    value.cache_write_input_tokens,
    value.cache_write_tokens,
    details.cache_creation_input_tokens,
    details.cache_write_input_tokens,
    details.cache_write_tokens,
  );
  let cacheReadInputTokens = tokenCount(
    value.cache_read_input_tokens,
    value.prompt_cache_hit_tokens,
    details.cached_tokens,
  );
  let cacheMissInputTokens = tokenCount(value.prompt_cache_miss_tokens);

  // These aliases are provider-specific evidence. Generic/Kimi streams retain
  // unrecognized fields in raw without treating them as cache proof.
  if (adapter === 'anthropic' || adapter === 'claude') {
    cacheReadInputTokens = tokenCount(value.cache_read_input_tokens);
    cacheCreationInputTokens = tokenCount(value.cache_creation_input_tokens);
    cacheMissInputTokens = null;
  } else if (adapter === 'deepseek') {
    cacheReadInputTokens = tokenCount(value.prompt_cache_hit_tokens);
    cacheMissInputTokens = tokenCount(value.prompt_cache_miss_tokens);
    cacheCreationInputTokens = null;
  }

  return {
    ...raw,
    raw,
    normalized: {
      inputTokens: tokenCount(value.input_tokens, value.prompt_tokens),
      outputTokens: tokenCount(value.output_tokens, value.completion_tokens),
      totalTokens: tokenCount(value.total_tokens, value.tokens),
      cacheCreationInputTokens,
      cacheReadInputTokens,
      cacheMissInputTokens,
      cacheStatus:
        cacheReadInputTokens === null ? 'unknown' : cacheReadInputTokens > 0 ? 'hit' : 'miss',
    },
  };
}

function eventFiles(event, item) {
  const values = [];
  const add = (value) => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') add(value.path || value.file || value.filename);
  };
  for (const value of [
    event.file,
    event.path,
    event.filePath,
    event.files,
    event.file_changes,
    event.changes,
    item?.file,
    item?.path,
    item?.files,
    item?.changes,
  ])
    add(value);
  return [...new Set(values.map((value) => boundedText(value)).filter(Boolean))].slice(0, 32);
}

export function summarizeEvent(adapter, event) {
  const item = event.item && typeof event.item === 'object' ? event.item : null;
  const type = boundedText(event.type) || boundedText(event.role) || 'event';
  const status = boundedText(event.status) || boundedText(event.subtype);
  const itemType = boundedText(item?.type);
  const toolEvent = [type, itemType, status]
    .filter(Boolean)
    .some((value) => /tool|command|function/i.test(value));
  const tool = toolEvent
    ? boundedText(event.tool || event.tool_name || event.name || item?.name || item?.tool_name)
    : null;
  const usageEvidence = normalizeUsage(adapter, event.usage);
  const usage = usageEvidence
    ? {
        ...Object.fromEntries(
          [
            'input_tokens',
            'output_tokens',
            'prompt_tokens',
            'completion_tokens',
            'total_tokens',
            'tokens',
            'costUsd',
            'cost_usd',
          ]
            .filter((key) => Number.isFinite(usageEvidence.raw[key]))
            .map((key) => [key, usageEvidence.raw[key]]),
        ),
        normalized: usageEvidence.normalized,
      }
    : {};
  const inputWait =
    event.input_required === true ||
    event.inputRequired === true ||
    [type, status].some((value) =>
      ['input_required', 'awaiting_input', 'permission_request', 'elicitation'].some((marker) =>
        value?.toLowerCase().includes(marker),
      ),
    );
  return {
    adapter,
    type,
    subtype: boundedText(event.subtype),
    status,
    requestId: boundedText(
      event.request_id || event.requestId || event.session_id || event.thread_id,
    ),
    model: boundedText(event.model),
    tool,
    files: eventFiles(event, item),
    inputWait,
    usage,
    executionMode: adapter === 'kimi' ? boundedText(event.execution_mode) : undefined,
    goalRequired:
      adapter === 'kimi' && typeof event.goal_required === 'boolean'
        ? event.goal_required
        : undefined,
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((part) => part.type === 'text' || part.type === 'output_text')
      .map((part) => part.text || '')
      .join('');
  return '';
}

export function parseOutput(adapter, input, format = 'text', expected = {}) {
  const events = parseEvents(adapter, input, format);
  if (!events.length)
    return { output: input, usage: null, servedModel: null, requestId: null, events };
  let output = '',
    requestId = null,
    servedModel = null,
    usage = null,
    completed = false;
  let kimiProtocol = false,
    kimiRequestId = null,
    kimiRunFinished = false,
    kimiGoalRequired = true,
    kimiGoalStatus;
  for (const event of events) {
    if (event.is_error || event.type === 'error' || event.type === 'turn.failed' || event.error)
      throw new OmhaError(
        'provider_error',
        contentText(event.error?.message || event.error || event.result || event.message) ||
          'Provider reported a failed response',
      );
    requestId =
      event.request_id || event.requestId || event.session_id || event.thread_id || requestId;
    servedModel = event.model || servedModel;
    if (adapter === 'claude') {
      if (event.type === 'result') {
        check(event.subtype === 'success', 'Claude result is not successful', 'provider_error');
        output = contentText(event.result);
        usage = normalizeUsage(adapter, { ...event.usage, costUsd: event.total_cost_usd });
        completed = true;
      } else if (event.type === 'system' && event.subtype === 'init')
        servedModel = event.model || servedModel;
      if (event.modelUsage && Object.keys(event.modelUsage).length === 1)
        servedModel = Object.keys(event.modelUsage)[0];
    } else if (adapter === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        output = contentText(event.item.text ?? event.item.content);
      if (event.type === 'turn.completed') {
        usage = normalizeUsage(adapter, event.usage);
        completed = true;
      }
    } else if (adapter === 'kimi') {
      if (expected.kimiProtocol && expected.executionMode === 'tool-free') {
        check(
          event.type !== 'tool.call.started' &&
            event.type !== 'tool.call.delta' &&
            !(Array.isArray(event.tool_calls) && event.tool_calls.length > 0),
          'Tool-free Kimi output contains a model tool call',
          'malformed_output',
        );
      }
      if (
        event.role === 'assistant' ||
        (event.type === 'assistant' && event.message) ||
        (event.type === 'message' && event.message?.role === 'assistant')
      ) {
        const text = contentText(event.content ?? event.message?.content);
        if (text.trim()) {
          output = text;
          completed = true;
        }
      }
      if (event.type === 'run.started' && event.protocol) {
        check(
          event.protocol === 'kimi-personal/1',
          'Unsupported Kimi event protocol',
          'malformed_output',
        );
        kimiProtocol = true;
        kimiRequestId = event.request_id || null;
        if (expected.kimiProtocol) {
          check(
            typeof kimiRequestId === 'string' && kimiRequestId.length > 0,
            'Missing personal Kimi run identity',
            'malformed_output',
          );
          check(
            event.execution_mode === expected.executionMode,
            'Kimi execution mode did not match the request',
            'malformed_output',
          );
          kimiGoalRequired = expected.executionMode !== 'tool-free';
          check(
            event.goal_required === kimiGoalRequired,
            'Kimi Goal policy did not match the request',
            'malformed_output',
          );
        } else {
          check(
            event.goal_required !== false,
            'Tool-free Kimi output requires an explicit personal runtime request',
            'malformed_output',
          );
        }
      }
      if (event.type === 'run.completed' && kimiProtocol) {
        check(event.status === 'finished', 'Kimi run did not finish successfully', 'task');
        if (expected.kimiProtocol) {
          check(
            event.request_id === kimiRequestId,
            'Kimi final run identity did not match',
            'malformed_output',
          );
          check(
            event.execution_mode === expected.executionMode,
            'Kimi final execution mode did not match the request',
            'malformed_output',
          );
        }
        usage = normalizeUsage(adapter, event.usage);
        kimiRunFinished = true;
      }
      if (event.type === 'goal.summary') kimiGoalStatus = event.status ?? null;
      if (event.type === 'result') {
        output = contentText(event.result || event.output);
        usage = normalizeUsage(adapter, event.usage);
        completed = true;
      }
    } else {
      check(
        event.status === 'success' && typeof event.output === 'string',
        'Expected {status:"success",output:string} response',
        'malformed_output',
      );
      output = event.output;
      usage = normalizeUsage(adapter, event.usage);
      completed = true;
    }
  }
  if (adapter === 'kimi') {
    if (expected.kimiProtocol)
      check(kimiProtocol, 'Missing declared Kimi personal protocol', 'malformed_output');
    if (kimiRequestId !== null) requestId = kimiRequestId;
    if (kimiGoalStatus !== undefined && kimiGoalRequired)
      check(kimiGoalStatus === 'complete', `Kimi goal is ${kimiGoalStatus ?? 'missing'}`, 'task');
    if (!kimiGoalRequired)
      check(
        kimiGoalStatus === undefined,
        'Tool-free Kimi output must not claim autonomous Goal completion',
        'malformed_output',
      );
    if (kimiProtocol)
      check(
        kimiRunFinished && (!kimiGoalRequired || kimiGoalStatus === 'complete'),
        'Missing final Kimi run or goal summary',
        'malformed_output',
      );
  }
  check(
    completed && output.trim().length > 0,
    'Missing completed provider response',
    'malformed_output',
  );
  if (requestId !== null)
    check(
      typeof requestId === 'string' && requestId.length <= 512,
      'Invalid provider request id',
      'malformed_output',
    );
  if (servedModel !== null)
    check(
      typeof servedModel === 'string' && servedModel.length <= 256,
      'Invalid served model',
      'malformed_output',
    );
  return { output, usage, servedModel, requestId, events };
}
