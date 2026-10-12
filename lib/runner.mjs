import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { hash, now, stateHome } from './core.mjs';
import { run, processFingerprint } from './process.mjs';
import { atomicWrite, ensureDir, isAlive, jsonRead, lockDir } from './storage.mjs';
import { environment, environmentSecrets, redact, redactData } from './security.mjs';
import { check, OmhaError, keys, number } from './validation.mjs';
import {
  DEFAULT_PROFILES,
  loadConfig,
  loadProfiles,
  validateBudget,
  validateCapabilities,
  validateProfiles,
  validateRetry,
} from './profiles.mjs';
import { createEventFramer, invocation, parseOutput, summarizeEvent } from './adapters.mjs';
import { classify, FALLBACK, retryAfterFromText, TRANSIENT } from './failures.mjs';

export { loadProfiles };
export const defaults = DEFAULT_PROFILES;

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(
        new OmhaError(
          signal?.reason?.code === 'timeout' ? 'timeout' : 'cancellation',
          'Request interrupted',
        ),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function usageOf(value, reservation) {
  if (!value)
    return {
      tokens: reservation.reserveTokens,
      costUsd: reservation.reserveCostUsd,
      estimated: true,
    };
  const reportedTokens = value.tokens ?? value.total_tokens;
  for (const key of ['input_tokens', 'output_tokens'])
    if (value[key] !== undefined) number(value[key], `response ${key}`, 0, 1000000000);
  const completeTokenUsage =
    reportedTokens !== undefined ||
    (value.input_tokens !== undefined && value.output_tokens !== undefined);
  const partialTokens = (value.input_tokens ?? 0) + (value.output_tokens ?? 0);
  const tokens =
    reportedTokens ??
    (completeTokenUsage ? partialTokens : Math.max(reservation.reserveTokens, partialTokens));
  const costUsd = value.costUsd ?? value.cost_usd;
  number(tokens, 'response tokens', 0, 1000000000);
  if (costUsd !== undefined) number(costUsd, 'response cost', 0, 1000000, false);
  return {
    tokens,
    costUsd: costUsd ?? reservation.reserveCostUsd,
    estimated: !completeTokenUsage || costUsd === undefined,
  };
}

export class ProviderRuntime {
  constructor(config, options = {}) {
    this.config = validateProfiles(config);
    this.options = options;
    this.budget = validateBudget(options.budget);
    this.account = {
      requests: 0,
      tokens: 0,
      costUsd: 0,
      estimatedRequests: 0,
      ...(options.account || {}),
    };
    this.profileAccounts = options.profileAccounts || {};
    for (const account of [this.account, ...Object.values(this.profileAccounts)]) {
      keys(account, ['requests', 'tokens', 'costUsd', 'estimatedRequests'], 'budget account');
      number(account.requests, 'account.requests', 0, 1000000000);
      number(account.tokens, 'account.tokens', 0, 1000000000);
      number(account.costUsd, 'account.costUsd', 0, 1000000, false);
      number(account.estimatedRequests, 'account.estimatedRequests', 0, account.requests);
    }
    this.fakeOffsets = new Map();
    this.localGates = new Map();
    this.random = options.random || Math.random;
    this.clock = options.clock || Date.now;
    this.fingerprint = processFingerprint(process.pid);
  }

  gate(profile, mutate) {
    const key = hash(
      `${['fake', 'command'].includes(profile.adapter) ? profile.name : profile.adapter}:${profile.command}`,
    ).slice(0, 24);
    if (this.options.persistent === false) {
      const gate = this.localGates.get(key) || { active: [], failures: 0, openUntil: 0 };
      const result = mutate(gate);
      this.localGates.set(key, gate);
      return result;
    }
    const root = stateHome();
    const dir = join(root, 'runtime');
    ensureDir(dir, root);
    const release = lockDir(join(dir, `${key}.lock`), { root });
    try {
      const file = join(dir, `${key}.json`);
      const gate = jsonRead(file, { active: [], failures: 0, openUntil: 0 }, root);
      check(
        Array.isArray(gate.active) &&
          Number.isFinite(gate.openUntil) &&
          Number.isInteger(gate.failures),
        'Invalid runtime gate state',
        'corrupt_state',
      );
      gate.active = gate.active.filter(
        (lease) =>
          isAlive(lease.pid) &&
          (!lease.fingerprint || processFingerprint(lease.pid) === lease.fingerprint),
      );
      const result = mutate(gate);
      atomicWrite(file, JSON.stringify(gate), root);
      return result;
    } finally {
      release();
    }
  }

  async acquire(profile, signal, timeoutMs) {
    const start = this.clock();
    const token = randomUUID();
    while (true) {
      if (signal?.aborted)
        throw new OmhaError(
          signal.reason?.code === 'timeout' ? 'timeout' : 'cancellation',
          'Request interrupted',
        );
      if (this.clock() - start >= timeoutMs)
        throw new OmhaError('timeout', 'Provider concurrency queue timed out', {
          stage: 'queue',
        });
      const acquired = this.gate(profile, (gate) => {
        if (gate.openUntil > this.clock())
          return { open: true, retryAfterMs: gate.openUntil - this.clock() };
        if (gate.active.length >= profile.concurrency) return null;
        gate.active.push({ token, pid: process.pid, fingerprint: this.fingerprint });
        return { token };
      });
      if (acquired?.open) throw new OmhaError('circuit_open', 'Provider is cooling down', acquired);
      if (acquired?.token)
        return () =>
          this.gate(profile, (gate) => {
            gate.active = gate.active.filter((item) => item.token !== token);
          });
      const remaining = timeoutMs - (this.clock() - start);
      await delay(Math.min(20, Math.max(0, remaining)), signal);
    }
  }

  reserve(profile) {
    if (!Object.hasOwn(this.profileAccounts, profile.name))
      Object.defineProperty(this.profileAccounts, profile.name, {
        value: { requests: 0, tokens: 0, costUsd: 0, estimatedRequests: 0 },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    const per = this.profileAccounts[profile.name];
    for (const [account, budget] of [
      [this.account, this.budget],
      [per, profile.budget],
    ]) {
      check(
        account.requests + 1 <= budget.maxRequests &&
          account.tokens + profile.budget.reserveTokens <= budget.maxTokens &&
          account.costUsd + profile.budget.reserveCostUsd <= budget.maxCostUsd + 1e-9,
        'Provider request exceeds remaining budget',
        'budget',
      );
    }
    for (const account of [this.account, per]) {
      account.requests += 1;
      account.tokens += profile.budget.reserveTokens;
      account.costUsd += profile.budget.reserveCostUsd;
      account.estimatedRequests += 1;
    }
    return per;
  }

  settle(profile, per, usage) {
    for (const account of [this.account, per]) {
      account.tokens += usage.tokens - profile.budget.reserveTokens;
      account.costUsd = Math.max(
        0,
        account.costUsd + usage.costUsd - profile.budget.reserveCostUsd,
      );
      if (!usage.estimated) account.estimatedRequests -= 1;
    }
    check(
      this.account.tokens <= this.budget.maxTokens &&
        this.account.costUsd <= this.budget.maxCostUsd + 1e-9 &&
        per.tokens <= profile.budget.maxTokens &&
        per.costUsd <= profile.budget.maxCostUsd + 1e-9,
      'Reported usage exceeded reserved budget',
      'budget',
    );
  }

  snapshot() {
    return { account: { ...this.account }, profileAccounts: structuredClone(this.profileAccounts) };
  }

  async fake(profile, options) {
    const offset = this.fakeOffsets.get(profile.name) || 0;
    this.fakeOffsets.set(profile.name, offset + 1);
    const response = profile.responses?.[Math.min(offset, profile.responses.length - 1)] || {
      output: 'Offline fixture completed.',
    };
    check(response && typeof response === 'object', 'Invalid fake response');
    await delay(response.latencyMs || 0, options.signal);
    return {
      code: response.code ?? (response.failure ? 1 : 0),
      signal: null,
      stdout: response.stdout ?? response.output ?? '',
      stderr: response.stderr ?? '',
      latencyMs: response.latencyMs || 0,
      fakeFailure: response.failure,
      fakeUsage: response.usage,
      fakeModel: response.model,
      fakeRequestId: response.requestId,
    };
  }

  async attempt(name, prompt, options = {}) {
    const profile = this.config.profiles[name];
    check(profile, `Unknown provider profile: ${name}`);
    check(
      options.streamEvents === undefined || typeof options.streamEvents === 'boolean',
      'streamEvents must be boolean',
    );
    const declaredCapabilities = validateCapabilities(
      options.requires === undefined ? [] : options.requires,
      'required capabilities',
    );
    const requiredCapabilities = validateCapabilities(
      [...declaredCapabilities, ...(options.toolFree ? ['tool-free'] : [])].filter(
        (capability, index, all) => all.indexOf(capability) === index,
      ),
      'required capabilities',
    );
    const requestedModel = options.model || profile.model;
    const at = now();
    const start = performance.now();
    const localRequestId = randomUUID();
    const env = environment(profile.envAllowlist, options.envSource || process.env);
    const secrets = environmentSecrets(env);
    const metadata = {
      profile: name,
      provider: profile.adapter === 'command' ? name : profile.adapter,
      requestedModel,
      requiredCapabilities,
      servedModel: null,
      requestId: null,
      localRequestId,
      at,
      code: null,
      signal: null,
      responseHash: null,
      events: [],
      eventCount: 0,
      eventKinds: [],
      inputWait: false,
      stream: {
        requested: options.streamEvents === true,
        supported:
          options.streamEvents === true &&
          profile.adapter !== 'fake' &&
          (profile.adapter === 'codex' ||
            profile.adapter === 'kimi' ||
            profile.outputFormat === 'jsonl'),
        delivered: 0,
        complete: false,
      },
      latencyMs: 0,
      failureStage: null,
      failure: null,
      stdout: '',
      stderr: '',
      ok: false,
    };
    let release,
      per,
      settled = false,
      streamFramer,
      streamPromises = [],
      streamCallbackError = null,
      streamError = null;
    const streamEvent = (event, sequence) => {
      metadata.stream.delivered = sequence + 1;
      const pending = options.onProviderEvent?.({
        kind: 'provider.event',
        realtime: true,
        profile: name,
        requestId: event.requestId || localRequestId,
        sequence,
        event: redactData(event, secrets),
      });
      if (pending && typeof pending.then === 'function')
        streamPromises.push(
          Promise.resolve(pending).catch((error) => {
            streamCallbackError ||= error?.message || 'Provider event callback failed';
          }),
        );
    };
    try {
      const missing = requiredCapabilities.filter(
        (capability) => !profile.capabilities.includes(capability),
      );
      if (missing.length)
        throw new OmhaError(
          'capability',
          `Profile ${name} lacks required capability: ${missing.join(', ')}`,
          { stage: 'routing', missing },
        );
      check(
        process.platform !== 'win32' || profile.adapter === 'fake',
        'Native provider process supervision requires POSIX; use fake/file capabilities on Windows',
      );
      const spec = invocation(profile, prompt, options);
      const timeoutMs = Math.min(options.timeoutMs ?? profile.timeoutMs, profile.timeoutMs);
      number(timeoutMs, 'request timeoutMs', 10, 86400000);
      release = await this.acquire(profile, options.signal, timeoutMs);
      per = this.reserve(profile);
      await options.onEvent?.({
        kind: 'request.reserved',
        profile: name,
        requestId: localRequestId,
        ...this.snapshot(),
      });
      const result =
        profile.adapter === 'fake'
          ? await this.fake(profile, options)
          : await run(spec.command, spec.args, {
              cwd: options.cwd,
              input: spec.input,
              env,
              signal: options.signal,
              timeoutMs,
              maxOutputBytes: profile.maxOutputBytes,
              onSpawn: options.onSpawn,
              onOutput:
                metadata.stream.supported && profile.adapter !== 'fake'
                  ? (kind, chunk) => {
                      if (kind === 'stdout') {
                        streamFramer ||= createEventFramer(profile.adapter, profile.outputFormat, {
                          onEvent: streamEvent,
                        });
                        streamFramer.push(chunk);
                      }
                    }
                  : undefined,
            });
      if (streamFramer) {
        try {
          streamFramer.finish();
          metadata.stream.complete = true;
        } catch (error) {
          streamError = error;
        }
      }
      if (streamPromises.length) await Promise.all(streamPromises);
      if (streamCallbackError) result.callbackError ||= streamCallbackError;
      metadata.code = result.code;
      metadata.signal = result.signal;
      metadata.responseHash = hash(result.stdout);
      metadata.stderr = redact(result.stderr || '', secrets);
      let parsed, parseError;
      if (
        result.code === 0 &&
        !result.cancelled &&
        !result.timedOut &&
        !result.outputLimited &&
        !result.spawnError &&
        !result.callbackError &&
        !result.fakeFailure
      ) {
        try {
          parsed = parseOutput(profile.adapter, result.stdout, profile.outputFormat);
        } catch (error) {
          parseError = streamError || error;
        }
      } else if (streamError) parseError = streamError;
      if (!parsed) {
        const failure = result.fakeFailure
          ? { kind: result.fakeFailure, stage: 'provider' }
          : classify({ ...result, parseError, error: parseError?.message });
        metadata.failure = failure.kind;
        metadata.failureStage = failure.stage;
        metadata.stderr =
          metadata.stderr ||
          redact(
            parseError?.message || result.spawnError?.message || 'Provider execution failed',
            secrets,
          );
        metadata.retryAfterMs = retryAfterFromText(`${result.stderr}\n${result.stdout}`);
      } else {
        const summaries = (parsed.events || []).map((event) =>
          summarizeEvent(profile.adapter, event),
        );
        metadata.eventCount = summaries.length;
        metadata.eventKinds = [...new Set(summaries.map((event) => event.type))].slice(0, 64);
        metadata.inputWait = summaries.some((event) => event.inputWait);
        metadata.events = summaries.slice(0, 4096);
        metadata.eventsTruncated = summaries.length > metadata.events.length;
        if (!metadata.stream.supported)
          for (const [sequence, event] of metadata.events.entries())
            await options.onProviderEvent?.({
              kind: 'provider.event',
              profile: name,
              requestId: event.requestId || localRequestId,
              sequence,
              event: redactData(event, secrets),
            });
        metadata.stdout = redact(parsed.output, secrets);
        metadata.requestId = redact(
          result.fakeRequestId || parsed.requestId || localRequestId,
          secrets,
        );
        metadata.servedModel = result.fakeModel || parsed.servedModel || null;
        metadata.usage = usageOf(result.fakeUsage || parsed.usage, profile.budget);
        settled = true;
        this.settle(profile, per, metadata.usage);
        metadata.ok = true;
      }
      if (!settled) {
        metadata.usage = usageOf(null, profile.budget);
        settled = true;
        this.settle(profile, per, metadata.usage);
      }
      this.gate(profile, (gate) => {
        if (metadata.ok) {
          gate.failures = 0;
          gate.openUntil = 0;
        } else if (TRANSIENT.has(metadata.failure)) {
          gate.failures += 1;
          if (gate.failures >= profile.circuit.threshold || metadata.retryAfterMs > 0)
            gate.openUntil =
              this.clock() +
              Math.max(profile.circuit.cooldownMs, Math.min(metadata.retryAfterMs || 0, 86400000));
        }
      });
    } catch (error) {
      metadata.ok = false;
      metadata.failure = error.code || 'configuration';
      metadata.failureStage =
        error.details?.stage ||
        (metadata.failure === 'capability'
          ? 'routing'
          : metadata.failure === 'budget'
            ? 'admission'
            : per
              ? 'execution'
              : metadata.failure === 'cancellation'
                ? 'queue'
                : 'configuration');
      if (metadata.failure === 'circuit_open') {
        metadata.failureStage = 'routing';
        metadata.retryAfterMs = error.details.retryAfterMs;
      }
      metadata.stderr = redact(error.message, secrets);
      if (per && !settled) {
        metadata.usage = usageOf(null, profile.budget);
        // The reservation remains charged when completion/usage is uncertain.
      }
    } finally {
      release?.();
    }
    metadata.latencyMs = Math.round(performance.now() - start);
    metadata.requestId ||= localRequestId;
    return redactData(metadata, secrets);
  }

  async dispatch(prompt, providers, options = {}) {
    check(typeof prompt === 'string' && prompt.trim(), 'Provider prompt is required');
    const initial = providers?.length
      ? providers
      : this.config.fallbackOrder.length
        ? this.config.fallbackOrder
        : ['claude'];
    check(
      Array.isArray(initial) && initial.every((name) => Object.hasOwn(this.config.profiles, name)),
      'Unknown or missing routing profile',
    );
    const order = [];
    const add = (name) => {
      if (order.includes(name)) return;
      order.push(name);
      for (const fallback of this.config.profiles[name].fallback) add(fallback);
    };
    initial.forEach(add);
    const attempts = [],
      start = performance.now();
    const requested = this.config.profiles[order[0]];
    let last;
    for (const name of order) {
      const policy = validateRetry(options.retry || this.config.profiles[name].retry);
      for (let retry = 0; retry <= policy.maxRetries; retry += 1) {
        last = await this.attempt(name, prompt, {
          ...options,
          model: name === order[0] ? options.model : undefined,
        });
        attempts.push({ ...last, attempt: attempts.length + 1, retry });
        await options.onEvent?.({
          kind: 'request.finished',
          attempt: attempts.at(-1),
          ...this.snapshot(),
        });
        if (
          last.ok ||
          last.failure === 'capability' ||
          !TRANSIENT.has(last.failure) ||
          retry === policy.maxRetries
        )
          break;
        const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** retry);
        const jitter = backoff * policy.jitter * (this.random() * 2 - 1);
        const wait = Math.ceil(Math.max(0, backoff + jitter, last.retryAfterMs || 0));
        if (wait > policy.maxMs) break;
        try {
          await delay(wait, options.signal);
        } catch (error) {
          last = {
            ...last,
            ok: false,
            failure: error.code || 'cancellation',
            failureStage: 'backoff',
            stderr: 'Request interrupted during backoff',
          };
          break;
        }
      }
      if (last.ok || (last.failure !== 'capability' && !FALLBACK.has(last.failure))) break;
    }
    return {
      ...last,
      provider: last.provider,
      model: last.servedModel || last.requestedModel,
      requestedProvider: requested.adapter === 'command' ? requested.name : requested.adapter,
      requestedProfile: requested.name,
      requestedModel: options.model || requested.model,
      servedProvider: last.ok ? last.provider : null,
      servedProfile: last.ok ? last.profile : null,
      servedModel: last.servedModel,
      modelVerified: Boolean(last.servedModel),
      latencyMs: Math.round(performance.now() - start),
      attempts,
      budget: this.snapshot(),
    };
  }
}

const runtimes = new Map();
export function createRuntime(config, options) {
  return new ProviderRuntime(config, options);
}
export function runtimeFor(options = {}) {
  if (options.runtime) return options.runtime;
  const config = options.profiles
    ? { version: 1, profiles: options.profiles }
    : loadConfig(options.cwd, options.config);
  const key = hash(
    JSON.stringify({ config, budget: options.budget, persistent: options.persistent }) +
      stateHome(),
  );
  if (!runtimes.has(key)) runtimes.set(key, new ProviderRuntime(config, options));
  return runtimes.get(key);
}
export async function dispatch(prompt, providers, options = {}) {
  return runtimeFor(options).dispatch(prompt, providers, options);
}
export async function invoke(provider, prompt, spec = {}, options = {}) {
  const runtime = new ProviderRuntime({ version: 1, profiles: { [provider]: spec } }, options);
  return runtime.attempt(provider, prompt, options);
}
