import { performance } from 'node:perf_hooks';
import { check, keys, number } from './validation.mjs';

export const SCOPE_STATES = Object.freeze(['open', 'closed', 'cancelled']);

export const TASK_PHASES = Object.freeze([
  'prepared',
  'admitted',
  'queued',
  'running',
  'cancel_requested',
  'exited',
  'skipped',
  'settled',
]);

export const TASK_OUTCOMES = Object.freeze([
  'success',
  'user_failure',
  'submission_failure',
  'cancelled',
  'fail_fast',
  'timeout',
  'interrupted',
]);

const MAX_TIMER_DELAY = 2_147_483_647;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const TRANSITIONS = Object.freeze({
  prepared: ['admitted', 'queued', 'running', 'cancel_requested', 'skipped'],
  admitted: ['queued', 'running', 'cancel_requested', 'skipped'],
  queued: ['running', 'cancel_requested', 'skipped'],
  running: ['cancel_requested', 'exited'],
  cancel_requested: ['exited', 'skipped'],
  exited: ['settled'],
  skipped: ['settled'],
  settled: [],
});

const noOp = () => {};

function validCode(value, fallback) {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : fallback;
}

function boundedMessage(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.slice(0, 512);
}

export function normalizeCancellationReason(input, fallbackCode = 'cancelled') {
  const source = input && typeof input === 'object' ? input : {};
  const rawCode = typeof input === 'string' ? input : source.code;
  const code = validCode(rawCode, validCode(fallbackCode, 'cancelled'));
  return Object.freeze({
    code,
    source: validCode(source.source, 'caller'),
    message: boundedMessage(source.message, `Execution scope ${code}`),
  });
}

function deadlineFrom(parent, options, now) {
  const hasDuration = options.deadlineMs !== undefined;
  const hasAbsolute = options.deadlineAt !== undefined;
  check(!(hasDuration && hasAbsolute), 'scope cannot set both deadlineMs and deadlineAt');
  let requested = null;
  if (hasDuration) {
    number(options.deadlineMs, 'scope deadlineMs', 0, 8_640_000_000);
    requested = now + options.deadlineMs;
  }
  if (hasAbsolute) {
    number(options.deadlineAt, 'scope deadlineAt', 0, Number.MAX_SAFE_INTEGER, false);
    requested = options.deadlineAt;
  }
  const inherited = parent?.deadlineAt() ?? null;
  if (requested === null) return inherited;
  return inherited === null ? requested : Math.min(requested, inherited);
}

/**
 * A parent-aware lifecycle boundary for provider, acceptance, review and cleanup work.
 *
 * <p>Cancellation is first-wins and carries a bounded reason. Deadlines use one monotonic clock
 * domain and are capped by the parent deadline. Closing rejects new children without cancelling
 * already-created work; callers decide whether a close should also request cancellation.
 */
export class ExecutionScope {
  #id;
  #parent;
  #clock;
  #setTimeout;
  #clearTimeout;
  #controller = new AbortController();
  #state = 'open';
  #reason = null;
  #deadlineAt;
  #deadlineTimer = null;
  #parentUnsubscribe = noOp;
  #externalUnsubscribe = noOp;

  constructor(options = {}) {
    keys(
      options,
      ['id', 'parent', 'deadlineMs', 'deadlineAt', 'clock', 'setTimeout', 'clearTimeout', 'signal'],
      'scope',
    );
    if (options.id !== undefined)
      check(
        typeof options.id === 'string' && ID_PATTERN.test(options.id),
        'scope id must be a simple identifier',
      );
    if (options.parent !== undefined)
      check(options.parent instanceof ExecutionScope, 'scope parent must be an ExecutionScope');
    if (options.signal !== undefined)
      check(options.signal instanceof AbortSignal, 'scope signal must be an AbortSignal');
    if (options.clock !== undefined)
      check(typeof options.clock === 'function', 'scope clock must be a function');
    if (options.setTimeout !== undefined)
      check(typeof options.setTimeout === 'function', 'scope setTimeout must be a function');
    if (options.clearTimeout !== undefined)
      check(typeof options.clearTimeout === 'function', 'scope clearTimeout must be a function');

    this.#id = options.id || null;
    this.#parent = options.parent || null;
    if (this.#parent) check(this.#parent.open(), 'scope parent is not open', 'scope_closed');
    this.#clock = options.clock || this.#parent?.clock() || (() => performance.now());
    if (this.#parent && options.clock)
      check(options.clock === this.#parent.clock(), 'child scope must share the parent clock');
    this.#setTimeout = options.setTimeout || setTimeout;
    this.#clearTimeout = options.clearTimeout || clearTimeout;
    const now = this.#clock();
    check(Number.isFinite(now), 'scope clock must return a finite number');
    this.#deadlineAt = deadlineFrom(this.#parent, options, now);

    if (this.#parent)
      this.#parentUnsubscribe = this.#parent.onCancel((reason) =>
        this.cancel({ code: reason.code, source: 'parent', message: reason.message }),
      );
    if (options.signal && this.open())
      this.#externalUnsubscribe = this.#listen(options.signal, (reason) =>
        this.cancel({
          ...(reason && typeof reason === 'object' ? reason : { message: reason }),
          source: 'external',
        }),
      );
    this.#scheduleDeadline();
  }

  id() {
    return this.#id;
  }

  parent() {
    return this.#parent;
  }

  clock() {
    return this.#clock;
  }

  signal() {
    return this.#controller.signal;
  }

  state() {
    return this.#state;
  }

  open() {
    return this.#state === 'open';
  }

  closed() {
    return this.#state === 'closed';
  }

  cancelled() {
    return this.#state === 'cancelled';
  }

  reason() {
    return this.#reason;
  }

  deadlineAt() {
    return this.#deadlineAt;
  }

  remainingMs() {
    if (this.#deadlineAt === null) return null;
    return Math.max(0, this.#deadlineAt - this.#clock());
  }

  checkDeadline() {
    return this.#deadlineAt !== null && this.#clock() >= this.#deadlineAt
      ? this.cancel({
          code: 'timeout',
          source: 'deadline',
          message: 'Execution scope deadline reached',
        })
      : false;
  }

  child(options = {}) {
    check(this.open(), 'scope is closed', 'scope_closed');
    return new ExecutionScope({ ...options, parent: this });
  }

  close() {
    if (!this.open()) return false;
    this.#state = 'closed';
    return true;
  }

  cancel(input = {}) {
    if (this.cancelled()) return false;
    const reason = normalizeCancellationReason(input);
    this.#state = 'cancelled';
    this.#reason = reason;
    this.#clearDeadlineTimer();
    this.#controller.abort(reason);
    this.#parentUnsubscribe();
    this.#parentUnsubscribe = noOp;
    this.#externalUnsubscribe();
    this.#externalUnsubscribe = noOp;
    return true;
  }

  onCancel(listener) {
    check(typeof listener === 'function', 'scope cancellation listener must be a function');
    if (this.#reason) {
      listener(this.#reason);
      return noOp;
    }
    const wrapped = () => listener(this.#reason);
    this.#controller.signal.addEventListener('abort', wrapped, { once: true });
    return () => this.#controller.signal.removeEventListener('abort', wrapped);
  }

  #listen(signal, listener) {
    if (signal.aborted) {
      listener(signal.reason);
      return noOp;
    }
    const onAbort = () => listener(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return () => signal.removeEventListener('abort', onAbort);
  }

  #scheduleDeadline() {
    if (this.cancelled() || this.#deadlineAt === null) return;
    const remaining = Math.max(0, this.#deadlineAt - this.#clock());
    this.#deadlineTimer = this.#setTimeout(
      () => {
        this.#deadlineTimer = null;
        if (this.#clock() < this.#deadlineAt) {
          this.#scheduleDeadline();
          return;
        }
        this.checkDeadline();
      },
      Math.min(remaining, MAX_TIMER_DELAY),
    );
  }

  #clearDeadlineTimer() {
    if (this.#deadlineTimer !== null) {
      this.#clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = null;
    }
  }
}

/**
 * A caller-visible task lifecycle handle. The handle records phase transitions and settles once,
 * while the provider or terminal adapter remains responsible for executing the actual work.
 */
export class TaskHandle {
  #id;
  #kind;
  #scope;
  #phase = 'prepared';
  #submittedAt;
  #admittedAt = null;
  #startedAt = null;
  #endedAt = null;
  #cancelReason = null;
  #completion = null;
  #unsubscribe;

  constructor(id, scope, options = {}) {
    keys(options, ['kind'], 'task options');
    check(typeof id === 'string' && ID_PATTERN.test(id), 'task id must be a simple identifier');
    check(scope instanceof ExecutionScope, 'task scope must be an ExecutionScope');
    check(scope.open(), 'scope is closed', 'scope_closed');
    if (options.kind !== undefined)
      check(
        typeof options.kind === 'string' && ID_PATTERN.test(options.kind),
        'task kind must be a simple identifier',
      );
    this.#id = id;
    this.#kind = options.kind || 'task';
    this.#scope = scope;
    this.#submittedAt = scope.clock()();
    this.#unsubscribe = scope.onCancel((reason) => this.requestCancel(reason));
  }

  id() {
    return this.#id;
  }

  kind() {
    return this.#kind;
  }

  scope() {
    return this.#scope;
  }

  phase() {
    return this.#phase;
  }

  cancelReason() {
    return this.#cancelReason;
  }

  submittedAt() {
    return this.#submittedAt;
  }

  snapshot() {
    return Object.freeze({
      id: this.#id,
      kind: this.#kind,
      phase: this.#phase,
      submittedAt: this.#submittedAt,
      admittedAt: this.#admittedAt,
      startedAt: this.#startedAt,
      endedAt: this.#endedAt,
      cancelReason: this.#cancelReason,
      completion: this.#completion,
    });
  }

  completion() {
    return this.#completion;
  }

  transition(next) {
    check(TASK_PHASES.includes(next), `Unknown task phase: ${next}`);
    check(
      TRANSITIONS[this.#phase].includes(next),
      `Task ${this.#id} cannot transition from ${this.#phase} to ${next}`,
      'invalid_phase',
    );
    this.#phase = next;
    const at = this.#scope.clock()();
    if (next === 'admitted') this.#admittedAt = at;
    if (next === 'running') this.#startedAt = at;
    if (next === 'exited' || next === 'skipped') this.#endedAt = at;
    return this;
  }

  requestCancel(input = {}) {
    if (this.#completion) return false;
    if (!this.#cancelReason) this.#cancelReason = normalizeCancellationReason(input);
    if (['prepared', 'admitted', 'queued', 'running'].includes(this.#phase))
      this.transition('cancel_requested');
    return true;
  }

  skip(outcome = 'cancelled', failure = null) {
    check(
      this.#phase === 'cancel_requested' ||
        ['prepared', 'admitted', 'queued'].includes(this.#phase),
      `Task ${this.#id} cannot be skipped from ${this.#phase}`,
      'invalid_phase',
    );
    if (this.#phase !== 'skipped') this.transition('skipped');
    return this.settle(outcome, failure);
  }

  exit() {
    check(
      this.#phase === 'running' || this.#phase === 'cancel_requested',
      `Task ${this.#id} cannot exit from ${this.#phase}`,
      'invalid_phase',
    );
    if (this.#phase !== 'exited') this.transition('exited');
    return this;
  }

  settle(outcome, failure = null) {
    check(TASK_OUTCOMES.includes(outcome), `Unknown task outcome: ${outcome}`);
    check(
      this.#phase === 'exited' || this.#phase === 'skipped',
      `Task ${this.#id} cannot settle from ${this.#phase}`,
      'invalid_phase',
    );
    this.transition('settled');
    this.#completion = Object.freeze({
      id: this.#id,
      kind: this.#kind,
      outcome,
      failure: failure === null ? null : String(failure).slice(0, 512),
      submittedAt: this.#submittedAt,
      admittedAt: this.#admittedAt,
      startedAt: this.#startedAt,
      endedAt: this.#endedAt,
      cancelReason: this.#cancelReason,
    });
    this.#unsubscribe();
    this.#unsubscribe = noOp;
    return this.#completion;
  }
}
