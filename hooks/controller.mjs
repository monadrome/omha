// The host owns admission. This controller only invalidates local work and
// projects host deadlines onto native timers and the current native session.
export function createCompactController(api) {
  let binding;
  let revision = 0;
  let generation = 0;
  let busy = true;
  let stopped = false;
  let compacting = false;
  let externalCompacting = false;
  let tail = Promise.resolve();
  let timers = [];
  let currentRequest = null;
  let status;

  function cancelTimers() {
    generation += 1;
    for (const timer of timers) timer.cancel();
    timers = [];
  }

  function fail(error) {
    stopped = true;
    cancelTimers();
    api.notice(`Auto compact unavailable: ${error?.message || 'host communication failed'}`);
  }

  function serial(work) {
    const result = tail.then(() => (stopped ? undefined : work()));
    tail = result.catch(fail);
    return result;
  }

  async function rpc(action, data = {}) {
    const result = await api.rpc({ action, ...binding, data });
    status = result;
    return result;
  }

  async function schedule(result) {
    cancelTimers();
    if (
      !result ||
      stopped ||
      busy ||
      compacting ||
      externalCompacting ||
      !result.dueAt ||
      !['scheduled', null].includes(result.reason)
    )
      return;
    const now = await api.now();
    const epoch = generation;
    if (now >= result.latestStartAt) return;
    const evaluate = () =>
      serial(async () => {
        if (generation !== epoch || busy || compacting) return;
        await evaluateNow(epoch);
      });
    timers.push(await api.after(Math.max(1, result.dueAt - now), evaluate));
    timers.push(
      await api.after(Math.max(1, result.latestStartAt - now), () =>
        serial(async () => {
          if (generation !== epoch) return;
          cancelTimers();
          await rpc('refresh');
        }),
      ),
    );
  }

  async function evaluateNow(epoch) {
    const result = await rpc('claim');
    if (generation !== epoch || stopped || busy || compacting || !result?.operationId) return;
    const fresh = await api.idleState();
    if (generation !== epoch || !fresh.safe) {
      await rpc('cancel', { operationId: result.operationId });
      return;
    }
    await rpc('idle', { ...fresh, revision });
    if (generation !== epoch) return;
    await rpc('consume', { operationId: result.operationId });
    // A consume response may race a prompt accepted locally. Preserve the
    // invocation intent as unknown instead of pretending it was never spent.
    if (generation !== epoch || busy || stopped) {
      await rpc('finish', { operationId: result.operationId, result: 'unknown' });
      return;
    }
    compacting = true;
    cancelTimers();
    try {
      const nativeResult = await api.compact();
      const applied = nativeResult && Array.isArray(nativeResult.messages) && !nativeResult.skip;
      const outcome = applied ? 'applied' : nativeResult?.skip ? 'skipped' : 'unknown';
      await rpc('finish', {
        operationId: result.operationId,
        result: outcome,
        ...(applied ? { boundary: api.id() } : {}),
      });
      if (applied) api.notice('Auto compact completed.');
    } catch {
      await rpc('finish', { operationId: result.operationId, result: 'unknown' });
    } finally {
      compacting = false;
    }
  }

  return {
    async start(data) {
      const registered = await api.rpc({ action: 'register', ...data });
      binding = {
        activationId: data.activationId,
        sessionId: data.sessionId,
        ownerToken: registered.ownerToken,
      };
      revision = registered.inputRevision;
      status = registered;
      return registered;
    },
    markBusy() {
      cancelTimers();
      busy = true;
    },
    input(inputId = api.id()) {
      if (!binding || stopped || compacting) {
        if (compacting && binding && !stopped) {
          cancelTimers();
          const nextRevision = ++revision;
          busy = true;
          return serial(() => rpc('input', { id: inputId, revision: nextRevision }));
        }
        return Promise.resolve();
      }
      cancelTimers();
      busy = true;
      const nextRevision = ++revision;
      return serial(() => rpc('input', { id: inputId, revision: nextRevision }));
    },
    requestStart(requestId, startedAt) {
      if (!binding || stopped || compacting) return Promise.resolve();
      cancelTimers();
      busy = true;
      currentRequest = requestId;
      const inputRevision = revision;
      return serial(() =>
        rpc('request_start', { id: requestId, revision: inputRevision, startedAt }),
      );
    },
    requestComplete(requestId, cacheObserved) {
      if (!binding || stopped || compacting || requestId !== currentRequest)
        return Promise.resolve();
      return serial(() => rpc('request_complete', { id: requestId, cacheObserved }));
    },
    idle() {
      if (!binding || stopped || compacting) return Promise.resolve();
      const expected = revision;
      return serial(async () => {
        const fresh = await api.idleState();
        if (expected !== revision) return;
        busy = !fresh.safe;
        await schedule(await rpc('idle', { ...fresh, revision: expected }));
      });
    },
    refresh() {
      if (!binding || stopped || compacting) return Promise.resolve();
      return serial(async () => {
        if (busy) return;
        await schedule(await rpc('refresh'));
      });
    },
    externalStart(boundary) {
      if (!binding || stopped || compacting) return Promise.resolve();
      cancelTimers();
      busy = true;
      externalCompacting = true;
      return serial(() => rpc('external_start', { id: boundary }));
    },
    externalFinish(boundary, result, precompute) {
      if (!binding || stopped || compacting) return Promise.resolve();
      return serial(async () => {
        const finished = await rpc('external_finish', { id: boundary, result, precompute });
        externalCompacting = false;
        return finished;
      });
    },
    async stop() {
      cancelTimers();
      busy = true;
      if (binding && !stopped) await serial(() => rpc('close'));
      stopped = true;
    },
    get compacting() {
      return compacting || externalCompacting;
    },
    get state() {
      return status;
    },
    flush() {
      return tail;
    },
  };
}
