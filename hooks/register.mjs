import { createCompactController } from './controller.mjs';

export function register(on) {
  let controller;
  let mainTurns = 0;
  let activationId;
  let cwd;
  const runtimeId = crypto.randomUUID();
  const id = () => crypto.randomUUID();

  on('session.start', async ($, e, next) => {
    activationId = await $.env.get('OMHA_COMPACT_ACTIVATION');
    if (!activationId || !e.isInteractive || e.surface !== 'terminal') return next(e);
    cwd = await $.session.cwd();
    const notice = (message) => $.ui.status(message);
    try {
      const api = {
        async rpc(request) {
          const result = await $.process.run(
            ['omha', 'compact', 'rpc', '--cwd', cwd, '--input', '-'],
            { cwd, stdin: JSON.stringify(request), timeoutMs: 2000 },
          );
          if (result.exitCode !== 0) throw new Error('host RPC rejected');
          const envelope = JSON.parse(result.stdout);
          if (envelope.version !== 1 || !envelope.ok || !envelope.result)
            throw new Error('invalid host response');
          return envelope.result;
        },
        id,
        now: () => $.clock.now(),
        after: (ms, fn) => $.clock.after(ms, fn),
        notice,
        compact: () => $.session.compact(),
        async idleState() {
          const settings = await $.settings.read();
          const agents = await $.agent.list();
          return {
            model: await $.session.model(),
            idleCompaction: settings.idleCompaction,
            safe:
              mainTurns === 0 &&
              !agents.some((agent) => !['completed', 'failed', 'killed'].includes(agent.status)),
          };
        },
      };
      controller = createCompactController(api);
      const settings = await $.settings.read();
      await controller.start({
        activationId,
        sessionId: await $.session.id(),
        data: {
          version: (await $.session.version()).version,
          model: await $.session.model(),
          idleCompaction: settings.idleCompaction,
          interactive: true,
          runtimeId,
        },
      });
      // The bridge is asynchronous; this local metadata refresh never calls a model.
      $.clock.every(15000, () => controller?.refresh());
    } catch {
      controller = undefined;
      notice('Auto compact unavailable; check omha compact status.');
    }
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    // Slash commands do not re-arm maintenance. Invalidation is synchronous,
    // before downstream hooks can start or queue the new model turn.
    if (
      controller &&
      (e.text?.trim() || e.attachments?.length) &&
      !/^\/(?:compact|status|context|cost|usage|help)(?:\s|$)/.test(e.text?.trim() || '')
    )
      void controller.input().catch(() => {});
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      mainTurns += 1;
      controller?.markBusy();
    }
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const requestId = id();
    const track = controller && !e.agentId && !controller.compacting;
    if (track) await controller.requestStart(requestId, await $.clock.now()).catch(() => {});
    const result = yield* next(e);
    if (track) {
      const usage = result?.usage;
      await controller
        .requestComplete(
          requestId,
          Boolean(
            usage && (usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0),
          ),
        )
        .catch(() => {});
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) mainTurns = Math.max(0, mainTurns - 1);
    if (controller) void controller.idle().catch(() => {});
    return result;
  });

  on('session.compact', async ($, e, next) => {
    if (!controller || e.agentId || controller.compacting) return next(e);
    const boundary = id();
    await controller.externalStart(boundary).catch(() => {});
    try {
      const result = await next(e);
      await controller
        .externalFinish(
          boundary,
          result?.skip ? 'skipped' : Array.isArray(result?.messages) ? 'applied' : 'unknown',
          e.trigger === 'precompute',
        )
        .catch(() => {});
      return result;
    } catch (error) {
      await controller
        .externalFinish(boundary, 'unknown', e.trigger === 'precompute')
        .catch(() => {});
      throw error;
    }
  });

  on('session.end', async ($, e, next) => {
    if (controller) await controller.stop().catch(() => {});
    controller = undefined;
    return next(e);
  });
}
