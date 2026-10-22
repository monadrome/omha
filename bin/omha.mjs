#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, keys, OmhaError } from '../lib/validation.mjs';
import { commandExists, hash, projectIdentity, stateHome } from '../lib/core.mjs';
import { redactData, environmentSecrets } from '../lib/security.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { loadConfig } from '../lib/profiles.mjs';
import {
  initMemory,
  memoryPointer,
  memoryStatus,
  listMemory,
  readMemory,
  searchMemory,
  writeMemory,
  forgetMemory,
  injectMemory,
  doctorMemory,
} from '../lib/memory.mjs';
import {
  leader,
  listRuns,
  runStatus,
  cancelRun,
  sendTaskMessage,
  projectStatus,
  watchStatus,
} from '../lib/orchestrator.mjs';
import { roundtable, decisionStatus, resolveDecision } from '../lib/roundtable.mjs';
import {
  handoff,
  handoffStatus,
  listHandoffs,
  readHandoff,
  pollHandoff,
  sendHandoff,
  resumeHandoff,
  cancelHandoff,
  closeHandoff,
  completeHandoff,
  adoptHandoff,
  handoffCheckpoints,
  forkHandoff,
  messageHandoff,
  acceptHandoff,
  autoCloseHandoff,
  compactRpc,
  compactStatus,
  observeCompactBridge,
  compactBridgeCommand,
  prepareCompact,
  startCompactSession,
} from '../lib/terminal.mjs';
import { run } from '../lib/process.mjs';
import {
  discoverTabs,
  recoverTabs,
  watchTabRecovery,
  tabRecoveryStatus,
} from '../lib/tab-recovery.mjs';
import { autoButterfly } from '../lib/butterfly.mjs';
import { importOpenArena, readOpenArena } from '../lib/open-arena.mjs';
import {
  runArena,
  arenaStatus,
  cancelArena,
  resumeArena,
  arenaReviewPacket,
  recordArenaReview,
} from '../lib/arena.mjs';
import { cancelFork, forkStatus, forkTree, resumeFork, runFork } from '../lib/fork.mjs';

const BOOLEAN = new Set([
  'json',
  'allow_write',
  'retry_failed',
  'retry_interrupted_writes',
  'human_gate',
  'include_private',
  'rebuild',
  'create_only',
  'analyze',
  'handoff',
  'interactive',
  'no_enter',
  'help',
  'watch',
  'close_source',
  'completed',
  'allow_send',
]);
const ALLOWED = new Set([
  ...BOOLEAN,
  'cwd',
  'config',
  'profile',
  'providers',
  'fallback',
  'prompt',
  'prompt_file',
  'task',
  'task_id',
  'sender',
  'public_context',
  'model',
  'mode',
  'timeout_ms',
  'parallelism',
  'budget',
  'plan',
  'policy',
  'resume',
  'id',
  'name',
  'description',
  'content',
  'file',
  'type',
  'source',
  'author',
  'reference',
  'ttl_days',
  'status',
  'expected_hash',
  'scope',
  'scopes',
  'session',
  'role',
  'query',
  'topics',
  'max_bytes',
  'max_lines',
  'input',
  'evidence',
  'voters',
  'chair',
  'method',
  'reason',
  'backend',
  'command',
  'args',
  'env_allowlist',
  'wait_ms',
  'interval_ms',
  'exit_code',
  'transcript',
  'artifact',
  'secret_policy',
  'fork',
  'checkpoint',
  'turn',
  'run_id',
  'delay_ms',
  'message',
  'cooldown_ms',
  'max_attempts',
  'screen_lines',
  'error_window',
  'verify_ms',
]);

function parse(args) {
  const options = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const key = (equal >= 0 ? arg.slice(2, equal) : arg.slice(2)).replaceAll('-', '_');
    check(ALLOWED.has(key), `Unknown option --${key.replaceAll('_', '-')}`);
    check(!Object.hasOwn(options, key), `Duplicate option --${key}`);
    if (BOOLEAN.has(key)) {
      check(equal < 0, `--${key} is a boolean flag`);
      options[key] = true;
      continue;
    }
    const value = equal >= 0 ? arg.slice(equal + 1) : args[++i];
    check(typeof value === 'string' && !value.startsWith('--'), `--${key} requires a value`);
    options[key] = value;
  }
  return options;
}
const csv = (value) =>
  value
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
function inputFile(file) {
  const value = readFileSync(file === '-' ? 0 : file, 'utf8');
  check(Buffer.byteLength(value) <= 8 * 1024 * 1024, 'Input file exceeds 8 MiB');
  return value;
}
function inputJson(file) {
  try {
    return JSON.parse(inputFile(file));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new OmhaError('configuration', 'Invalid JSON input file');
    throw error;
  }
}
function json(value) {
  process.stdout.write(
    `${JSON.stringify(redactData(value, environmentSecrets(process.env)), null, 2)}\n`,
  );
}
function prompt(o) {
  return o.prompt_file ? inputFile(o.prompt_file) : o.prompt || o.task || o._.join(' ');
}
function recoveryLine(report) {
  if (report.error)
    return `[${report.checkedAt}] auto-recover error (${report.error.code}): ${report.error.message}`;
  const s = report.summary;
  return `[${report.checkedAt}] checked ${s.checked} tabs (${s.agents} agents): ${s.recovered} recovered, ${s.recoverable || 0} recoverable, ${s.cooldown || 0} cooldown, ${s.stalled || 0} stalled, ${s.blocked || 0} blocked, ${s.busy || 0} busy, ${s.detected || 0} unregistered, ${s.ok} ok`;
}
function memoryOptions(o) {
  const options = {
    scope: o.scope,
    session: o.session,
    role: o.role,
    includePrivate: o.include_private,
    rebuild: o.rebuild,
  };
  if (o.expected_hash !== undefined) options.expectedHash = o.expected_hash;
  return options;
}
function runtimeOptions(cwd, o, controller) {
  return {
    cwd,
    config: o.config,
    signal: controller.signal,
    timeoutMs: o.timeout_ms === undefined ? undefined : Number(o.timeout_ms),
    budget: o.budget ? inputJson(o.budget) : undefined,
    allowWrite: Boolean(o.allow_write),
    parallelism: o.parallelism ? Number(o.parallelism) : undefined,
  };
}

const HELP = `Omha: portable provider runtime, durable DAGs, blind decisions and memory.

  omha run --profile fake --prompt 'Offline check'
  omha leader --plan plan.json [--allow-write]
  omha leader --task TEXT --profile planner --config providers.json [--policy host-policy.json]
  omha leader --resume RUN_ID [--retry-failed --retry-interrupted-writes]
  omha runs list|status|cancel [--id RUN_ID]
  omha status [--watch --wait-ms 30000 --interval-ms 1000]
  omha roundtable --input decision.json --config providers.json
  omha decision status|approve|reject --id ID [--reason TEXT]
  omha handoff --prompt TEXT --backend auto|cmux|tmux|file
  omha handoff list|status|read|poll|send|resume|cancel|close|complete --id ID
  omha handoff adopt
  omha handoff checkpoints|accept --id ID
  omha handoff fork --id SOURCE_ID (--checkpoint ID | --turn N) --prompt TEXT --allow-write [--close-source]
  omha handoff message --id ID --prompt TEXT
  omha auto-close --completed --reason TEXT [--id HANDOFF_ID] [--run-id RUN_ID] [--delay-ms 1500]
  omha auto-recover [--allow-send] [--watch --interval-ms 1500000] [--message 'go on']
  omha auto-recover status|list
  omha auto-butterfly --input history.json [--analyze --profile analyst]
  omha auto-butterfly --input history.json --fork fork.json --allow-write
  omha arena import --source DIRECTORY --input knowledge-metadata.json
  omha arena knowledge --id KNOWLEDGE_ID
  omha arena run --input execution.json --config providers.json --allow-write
  omha arena status|resume|cancel|review --id BATCH_ID
  omha arena review-record --id BATCH_ID --input human-review.json
  omha fork create|run --input execution.json --config providers.json --allow-write [--name NAME]
  omha fork status|tree|resume|cancel --id TREE_ID
  omha compact status
  omha compact setup|start --config providers.json [--input claude-settings.json --args JSON]
  omha compact rpc --input -
  omha compact bridge --id ACTIVATION_ID
  omha memory init|status|list|read|search|put|forget|inject|doctor
  omha doctor --json
  omha --version

All state lives under OMHA_HOME or the platform-independent XDG state path.
See docs/contracts.md and examples/ for versioned input contracts.
`;

async function main() {
  const args = process.argv.slice(2),
    command = args.shift() || 'help';
  if (command === '--version' || command === 'version') {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
    return;
  }
  const o = parse(args),
    cwd = resolve(o.cwd || process.cwd());
  if (command === 'help' || command === '--help' || o.help) {
    process.stdout.write(HELP);
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const options = runtimeOptions(cwd, o, controller);
    if (command === 'compact') {
      const sub = o._[0] || 'status';
      if (sub === 'status') return json(compactStatus(cwd));
      if (sub === 'setup' || sub === 'start') {
        const settings = o.input ? inputJson(o.input) : {};
        if (sub === 'setup') return json(prepareCompact(cwd, { config: o.config, settings }));
        const result = await startCompactSession(cwd, {
          config: o.config,
          settings,
          args: o.args ? JSON.parse(o.args) : [],
          signal: controller.signal,
        });
        process.exitCode = result.exitCode;
        return;
      }
      if (sub === 'rpc')
        return json({ version: 1, ok: true, result: compactRpc(cwd, inputJson(o.input)) });
      if (sub === 'bridge') {
        const raw = inputFile('-');
        const original = compactBridgeCommand(cwd, o.id);
        try {
          observeCompactBridge(cwd, o.id, JSON.parse(raw));
        } catch {
          /* Partial cache data never changes the user's status line. */
        }
        if (original) {
          const result = await run(process.env.SHELL || '/bin/sh', ['-c', original], {
            cwd,
            env: process.env,
            input: raw,
            timeoutMs: 5000,
            maxOutputBytes: 262144,
            onOutput: (kind, chunk) => process[kind].write(chunk),
          });
          process.exitCode = result.code ?? 1;
        }
        return;
      }
      throw new OmhaError('configuration', 'Unknown compact command');
    }
    if (command === 'status') {
      if (!o.watch) return json(projectStatus(cwd));
      for await (const snapshot of watchStatus(cwd, {
        signal: controller.signal,
        intervalMs: o.interval_ms === undefined ? undefined : Number(o.interval_ms),
        durationMs: o.wait_ms === undefined ? undefined : Number(o.wait_ms),
      }))
        process.stdout.write(
          `${JSON.stringify(redactData(snapshot, environmentSecrets(process.env)))}\n`,
        );
      return;
    }
    if (command === 'arena') {
      const sub = o._[0];
      if (sub === 'import')
        return json(
          importOpenArena(o.source, inputJson(o.input), {
            sourceCwd: cwd,
            secretPolicy: o.secret_policy,
          }),
        );
      if (sub === 'knowledge') return json(readOpenArena(o.id));
      if (sub === 'status') return json(arenaStatus(o.id));
      if (sub === 'cancel') return json(cancelArena(o.id));
      if (sub === 'resume')
        return json(await resumeArena(o.id, { spec: o.input ? inputJson(o.input) : undefined }));
      if (sub === 'review') return json(arenaReviewPacket(o.id));
      if (sub === 'review-record') return json(recordArenaReview(o.id, inputJson(o.input)));
      if (sub === 'run') {
        check(
          o.allow_write,
          'Arena execution requires --allow-write and a separate authorized specification',
        );
        const result = await runArena(cwd, inputJson(o.input), {
          config: o.config,
          signal: controller.signal,
          batchId: o.id,
        });
        json(result);
        if (result.status !== 'completed') process.exitCode = 1;
        return;
      }
      throw new OmhaError('configuration', 'Unknown arena command');
    }
    if (command === 'fork') {
      const sub = o._[0];
      if (sub === 'status') return json(forkStatus(o.id));
      if (sub === 'tree') return json(forkTree(o.id));
      if (sub === 'cancel') return json(cancelFork(o.id));
      if (sub === 'resume')
        return json(await resumeFork(o.id, { spec: o.input ? inputJson(o.input) : undefined }));
      if (sub === 'create' || sub === 'run') {
        check(
          o.allow_write,
          'Session fork execution requires --allow-write and a separate authorized specification',
        );
        const result = await runFork(cwd, inputJson(o.input), {
          config: o.config,
          signal: controller.signal,
          batchId: o.id,
          name: o.name,
        });
        json(result);
        if (result.status !== 'completed') process.exitCode = 1;
        return;
      }
      throw new OmhaError('configuration', 'Unknown fork command');
    }
    if (command === 'memory') {
      const sub = o._.shift() || 'status',
        scoped = memoryOptions(o);
      if (sub === 'init') return json(initMemory(cwd, scoped));
      if (sub === 'status') return json(memoryStatus(cwd, scoped));
      if (sub === 'list') return json(listMemory(cwd, scoped));
      if (sub === 'read') {
        const content = readMemory(cwd, o.name || o._[0] || null, scoped);
        if (o.json) return json({ content });
        process.stdout.write(content);
        return;
      }
      if (sub === 'pointer') return json(memoryPointer(cwd, scoped));
      if (sub === 'search') return json(searchMemory(cwd, o.query || o._[0] || '', scoped));
      if (sub === 'write' || sub === 'put') {
        const value = {
          name: o.name || o._[0],
          description: o.description,
          type: o.type,
          content: o.file ? inputFile(o.file) : o.content || o._.slice(1).join(' '),
          source: o.source || 'cli',
          author: o.author,
          reference: o.reference,
          ttlDays: o.ttl_days === undefined ? undefined : Number(o.ttl_days),
          status: o.status,
        };
        if (o.expected_hash !== undefined) value.expectedHash = o.expected_hash;
        if (o.create_only) value.expectedHash = null;
        return json(writeMemory(cwd, value, scoped));
      }
      if (sub === 'forget') return json(forgetMemory(cwd, o.name || o._[0], scoped));
      if (sub === 'inject')
        return json(
          injectMemory(cwd, {
            ...scoped,
            scopes: csv(o.scopes),
            topics: csv(o.topics),
            maxBytes: o.max_bytes ? Number(o.max_bytes) : undefined,
            maxLines: o.max_lines ? Number(o.max_lines) : undefined,
          }),
        );
      if (sub === 'doctor') {
        const result = doctorMemory(cwd, scoped);
        json(result);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      throw new OmhaError('configuration', `Unknown memory command: ${sub}`);
    }
    if (command === 'run') {
      const mode = o.mode || 'readonly';
      check(mode !== 'write' || o.allow_write, 'Write mode requires --allow-write');
      const runtime = createRuntime(loadConfig(cwd, o.config), { budget: options.budget });
      const result = await runtime.dispatch(
        prompt(o),
        [o.profile || 'fake', ...(csv(o.fallback) || [])],
        { ...options, mode, model: o.model },
      );
      json(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === 'leader') {
      const result = await leader(cwd, prompt(o), csv(o.providers) || [o.profile || 'claude'], {
        ...options,
        plan: o.plan ? inputJson(o.plan) : undefined,
        policy: o.policy ? inputJson(o.policy) : undefined,
        resume: Boolean(o.resume),
        runId: o.resume || o.id,
        retryFailed: o.retry_failed,
        retryInterruptedWrites: o.retry_interrupted_writes,
        plannerProfile: o.profile,
        publicContext: o.public_context ? inputFile(o.public_context) : '',
        onNotification: (notification) => process.stderr.write(`${JSON.stringify(notification)}\n`),
      });
      json(result);
      if (result.status !== 'completed') process.exitCode = 1;
      return;
    }
    if (command === 'runs') {
      const sub = o._[0] || 'list';
      if (sub === 'list') return json(listRuns(cwd));
      if (sub === 'status') return json(runStatus(cwd, o.id));
      if (sub === 'cancel') return json(cancelRun(cwd, o.id));
      if (sub === 'message')
        return json(sendTaskMessage(cwd, o.id, o.task_id, o.content, { sender: o.sender }));
      throw new OmhaError('configuration', 'Unknown runs command');
    }
    if (command === 'roundtable') {
      const input = o.input ? inputJson(o.input) : {};
      const result = await roundtable(cwd, o.task || input.objective, csv(o.providers), {
        ...options,
        publicContext: input.publicContext,
        evidence: o.evidence ? inputJson(o.evidence) : input.evidence,
        voters: csv(o.voters) || input.voters,
        chairProfile: o.chair || input.chairProfile,
        method: o.method || input.method,
        humanGate: o.human_gate || input.humanGate,
      });
      return json(result);
    }
    if (command === 'decision') {
      const sub = o._[0] || 'status';
      if (sub === 'status') return json(decisionStatus(cwd, o.id));
      return json(resolveDecision(cwd, o.id, sub, o.reason));
    }
    if (command === 'auto-recover') {
      const sub = o._[0] || 'run';
      if (sub === 'status') return json(tabRecoveryStatus());
      if (sub === 'list') return json({ tabs: await discoverTabs(cwd) });
      check(['run', 'check'].includes(sub), `Unknown auto-recover command: ${sub}`);
      const options = {
        allowSend: o.allow_send === true && sub !== 'check',
        message: o.message,
        intervalMs: o.interval_ms === undefined ? undefined : Number(o.interval_ms),
        cooldownMs: o.cooldown_ms === undefined ? undefined : Number(o.cooldown_ms),
        maxAttempts: o.max_attempts === undefined ? undefined : Number(o.max_attempts),
        screenLines: o.screen_lines === undefined ? undefined : Number(o.screen_lines),
        errorWindow: o.error_window === undefined ? undefined : Number(o.error_window),
        verifyMs: o.verify_ms === undefined ? undefined : Number(o.verify_ms),
        signal: controller.signal,
      };
      if (o.watch) {
        await watchTabRecovery(cwd, {
          ...options,
          lockTimeoutMs: 0,
          onReport: (report) => {
            if (o.json)
              process.stdout.write(
                `${JSON.stringify(redactData(report, environmentSecrets(process.env)))}\n`,
              );
            else process.stdout.write(`${recoveryLine(report)}\n`);
          },
        });
        return;
      }
      return json(await recoverTabs(cwd, options));
    }
    if (command === 'auto-close') {
      keys(
        o,
        ['_', 'cwd', 'json', 'completed', 'reason', 'id', 'run_id', 'delay_ms'],
        'auto-close',
      );
      check(o._.length === 0, 'Auto-close accepts no positional hook payload');
      return json(
        await autoCloseHandoff(cwd, {
          id: o.id,
          completed: o.completed === true,
          reason: o.reason,
          runId: o.run_id,
          delayMs: o.delay_ms === undefined ? undefined : Number(o.delay_ms),
          signal: controller.signal,
        }),
      );
    }
    if (command === 'handoff') {
      const sub = o._[0] || 'start';
      const terminal = {
        backend: o.backend || 'auto',
        name: o.name,
        command: o.command,
        args: o.args ? JSON.parse(o.args) : undefined,
        interactive: o.interactive ? true : undefined,
        timeoutMs: options.timeoutMs,
        envAllowlist: csv(o.env_allowlist),
        signal: controller.signal,
        enter: !o.no_enter,
        waitMs: o.wait_ms === undefined ? undefined : Number(o.wait_ms),
        intervalMs: o.interval_ms ? Number(o.interval_ms) : undefined,
        allowWrite: options.allowWrite,
      };
      if (sub === 'adopt') return json(await adoptHandoff(cwd, terminal));
      if (sub === 'checkpoints') return json(await handoffCheckpoints(o.id, terminal));
      if (sub === 'accept') return json(await acceptHandoff(o.id, terminal));
      if (sub === 'message')
        return json(
          await messageHandoff(
            o.id,
            o.prompt_file ? inputFile(o.prompt_file) : o.prompt || o._.slice(1).join(' '),
            terminal,
          ),
        );
      if (sub === 'fork') {
        const result = await forkHandoff(
          cwd,
          o.prompt_file ? inputFile(o.prompt_file) : o.prompt,
          {
            sourceHandoffId: o.id,
            ...(o.checkpoint !== undefined ? { checkpoint: o.checkpoint } : {}),
            ...(o.turn !== undefined ? { turn: Number(o.turn) } : {}),
            closeSource: Boolean(o.close_source),
          },
          terminal,
        );
        json(result);
        if (result.state !== 'running') process.exitCode = 1;
        return;
      }
      if (sub === 'start' || o.prompt || o.prompt_file) {
        if (sub === 'send') return json(await sendHandoff(o.id, prompt(o), terminal));
        if (sub === 'resume')
          return json(
            await resumeHandoff(
              o.id,
              o.prompt_file ? inputFile(o.prompt_file) : o.prompt,
              terminal,
            ),
          );
        return json(
          await handoff(
            cwd,
            o.prompt_file
              ? inputFile(o.prompt_file)
              : o.prompt || o._.slice(sub === 'start' ? 1 : 0).join(' '),
            terminal,
          ),
        );
      }
      if (sub === 'list') return json(listHandoffs());
      if (sub === 'status') return json(handoffStatus(o.id));
      if (sub === 'read' || sub === 'capture') return json(await readHandoff(o.id, terminal));
      if (sub === 'poll') return json(await pollHandoff(o.id, terminal));
      if (sub === 'resume')
        return json(await resumeHandoff(o.id, undefined, { ...terminal, backend: o.backend }));
      if (sub === 'send') return json(await sendHandoff(o.id, o._.slice(1).join(' '), terminal));
      if (sub === 'cancel') return json(await cancelHandoff(o.id, terminal));
      if (sub === 'close') return json(await closeHandoff(o.id, terminal));
      if (sub === 'complete') return json(completeHandoff(o.id, Number(o.exit_code || 0)));
      throw new OmhaError('configuration', 'Unknown handoff command');
    }
    if (command === 'auto-butterfly') {
      check(
        o.input || o.transcript || o.artifact,
        'Use --input history.json or --artifact with explicit history',
      );
      const input =
        o.input || o.transcript
          ? inputJson(o.input || o.transcript)
          : { version: 1, artifacts: [{ id: 'artifact', path: o.artifact }], transcript: [] };
      const result = await autoButterfly(cwd, input, {
        ...options,
        analyze: o.analyze,
        handoff: o.handoff,
        backend: o.backend,
        providers: csv(o.providers) || [o.profile || 'claude'],
        fork: o.fork ? inputJson(o.fork) : undefined,
      });
      if (o.artifact) result.currentHash = hash(inputFile(resolve(cwd, o.artifact)));
      if (o.fork && result.handoffs?.some((record) => record.state !== 'running'))
        process.exitCode = 1;
      return json(result);
    }
    if (command === 'doctor') {
      let configuration;
      try {
        const config = loadConfig(cwd, o.config);
        configuration = { ok: true, profiles: Object.keys(config.profiles) };
      } catch (error) {
        configuration = { ok: false, error: error.message };
      }
      const checks = {
        node: process.versions.node,
        nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
        platform: process.platform,
        processGroups: process.platform !== 'win32',
        project: projectIdentity(cwd),
        stateHome: stateHome(),
        configuration,
        capabilities: Object.fromEntries(
          ['claude', 'codex', 'kimi', 'tmux', 'cmux'].map((name) => [name, commandExists(name)]),
        ),
        plugin:
          JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url)))
            .name === 'omha',
      };
      const ok = checks.nodeSupported && configuration.ok && checks.plugin;
      json({ ok, checks });
      if (!ok) process.exitCode = 1;
      return;
    }
    throw new OmhaError('configuration', `Unknown command: ${command}`);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify(redactData({ ok: false, error: { code: error.code || 'error', message: error.message } }, environmentSecrets(process.env)))}\n`,
  );
  process.exitCode = 1;
});
