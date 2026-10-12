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
  if (profile.adapter === 'kimi' && mode === 'readonly')
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
    check(!request.toolFree, 'Kimi does not expose a verified tool-free CLI mode');
    args = [
      '--auto',
      '--output-format',
      'stream-json',
      '-m',
      request.model || profile.model,
      '-p',
      prompt,
    ];
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

function boundedText(value, max = 512) {
  return typeof value === 'string' && value.length <= max ? value : null;
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
  const usageSource = event.usage && typeof event.usage === 'object' ? event.usage : null;
  const usage = usageSource
    ? Object.fromEntries(
        ['input_tokens', 'output_tokens', 'total_tokens', 'tokens', 'costUsd', 'cost_usd']
          .filter((key) => Number.isFinite(usageSource[key]))
          .map((key) => [key, usageSource[key]]),
      )
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

export function parseOutput(adapter, input, format = 'text') {
  const events = parseEvents(adapter, input, format);
  if (!events.length)
    return { output: input, usage: null, servedModel: null, requestId: null, events };
  let output = '',
    requestId = null,
    servedModel = null,
    usage = null,
    completed = false;
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
        usage = { ...event.usage, costUsd: event.total_cost_usd };
        completed = true;
      } else if (event.type === 'system' && event.subtype === 'init')
        servedModel = event.model || servedModel;
      if (event.modelUsage && Object.keys(event.modelUsage).length === 1)
        servedModel = Object.keys(event.modelUsage)[0];
    } else if (adapter === 'codex') {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        output = contentText(event.item.text ?? event.item.content);
      if (event.type === 'turn.completed') {
        usage = event.usage;
        completed = true;
      }
    } else if (adapter === 'kimi') {
      if (event.role === 'assistant') {
        output = contentText(event.content);
        completed = true;
      }
      if (event.type === 'assistant' && event.message) {
        output = contentText(event.message.content);
        completed = true;
      }
      if (
        event.type === 'message' &&
        (event.role === 'assistant' || event.message?.role === 'assistant')
      ) {
        output = contentText(event.content ?? event.message?.content);
        completed = true;
      }
      if (event.type === 'result') {
        output = contentText(event.result || event.output);
        usage = event.usage;
        completed = true;
      }
    } else {
      check(
        event.status === 'success' && typeof event.output === 'string',
        'Expected {status:"success",output:string} response',
        'malformed_output',
      );
      output = event.output;
      usage = event.usage;
      completed = true;
    }
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
