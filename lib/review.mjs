// Multi-reviewer code review over owned handoffs.
//
// Each reviewer CLI (Claude, Codex, Kimi, Kiro, Open Code Review, or a configured
// command) runs as its own handoff in the reviewed worktree, so the existing
// backend order (cmux -> tmux -> file), ownership tokens, final markers and
// cancellation rules apply unchanged. The host only prepares frozen inputs,
// observes the handoffs, normalizes their JSON and tallies votes. It never
// cancels a running reviewer because a wait budget expired.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hash, now, stateHome } from './core.mjs';
import { appendEvent, atomicWrite, ensureDir, jsonRead, lockDir, safeRead } from './storage.mjs';
import { run } from './process.mjs';
import {
  AGENT_ENV,
  DEFAULT_REVIEWERS,
  detectReviewers,
  fill,
  launchCommand,
  reviewAgents,
  stringArray,
  validateReviewer,
} from './agents.mjs';
import { closeHandoff, handoff, handoffStatus, readHandoff } from './terminal.mjs';
import { assertNoSecrets, environmentSecrets, redact } from './security.mjs';
import { check, choice, id, keys, number, object, text, OmhaError } from './validation.mjs';
import { shellQuote } from './backends.mjs';

export const REVIEW_WAIT_MS = 51 * 60 * 1000;
export const REVIEW_STALL_MS = 10 * 60 * 1000;
export const REVIEW_HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const CONTEXT_MARKER = 'TODO(omha-review)';
const KINDS = ['review', 'vote'];
const DONE = ['completed', 'failed', 'cancelled', 'timed_out', 'closed', 'interrupted'];
const REVIEW_PROMPT = `You are the independent code reviewer "{name}" in an Omha multi-review. Other reviewers examine the same change in parallel and you cannot see their conclusions; judge independently.

Inputs:
1. Read {context} completely: goal, requirements, constraints, settled decisions, non-goals and focus areas.
2. Read {diff}, then inspect the changed files, their callers and tests in {worktree}, which is checked out at the reviewed commit. Read every project rule file the context lists.
3. You may run read-only commands (git log/show/blame, grep, builds or tests) to gather evidence.

Keep {worktree} unchanged: do not edit, format, commit or stash. The only file you may write is {out}.

Report only problems the change introduces or directly exposes: correctness, concurrency, error handling and edge cases, resource leaks, security, contracts and compatibility, violations of the context constraints or project rules, unmet intent, and missing critical tests. Do not report suggestions that conflict with settled decisions or non-goals. Every finding needs checkable evidence (file:line plus reasoning); without it, lower the confidence or omit the finding. Write titles and details in the language of the context file.

Severity: P0 must fix (wrong results, crashes, data corruption, races, leaks, security, broken contracts or hard constraints); P1 should fix (edge or error handling gaps, clear performance regressions, missing tests on a critical path); P2 improvement; P3 nit.

Write UTF-8 JSON without comments to {out} when you can:
{"reviewer":"{name}","summary":"one sentence","findings":[{"file":"repository-relative path","line":123,"severity":"P0|P1|P2|P3","category":"correctness|concurrency|error-handling|security|performance|contract|test|maintainability|style","title":"one sentence","detail":"why, trigger and impact","evidence":"file:line excerpt or command output","suggested_fix":"concrete fix","confidence":0.0}]}
Use "findings": [] when there is no problem. Then print the same JSON once more in a \`\`\`json block as your final message and stop.
`;

const VOTE_PROMPT = `You are the independent voter "{name}" in an Omha multi-review. Several review findings are disputed; verify each one yourself. Other voters vote in parallel and you cannot see their ballots.

Inputs: {context} (goal, requirements, constraints, settled decisions), {items} (disputed items with id, file, line, title, claim, counter and proposed_fix), {diff} and the reviewed checkout {worktree}.

Return to the code for every item and run read-only commands or tests when needed; do not judge from the wording of the claim. Keep {worktree} unchanged; the only file you may write is {out}.

Verdicts: "fix" means the problem is real and the proposed fix (or yours) belongs in this change without violating the context; "no_fix" means real but not worth fixing now; "false_positive" means the claim does not hold.

Write JSON to {out} when you can, with exactly one vote per item, in the language of the context file:
{"voter":"{name}","votes":[{"id":"D1","verdict":"fix|no_fix|false_positive","severity":"P0|P1|P2|P3","reason":"evidence with file:line"}]}
Then print the same JSON once more in a \`\`\`json block as your final message and stop.
`;

const CONTEXT_TEMPLATE = `# Review Context

Every reviewer and voter reads this file. Complete sections 1-5 before \`omha review start\`; write "None" where nothing applies.

## 1. Goal

${CONTEXT_MARKER}: The problem this change solves or the capability it delivers, in one to three sentences.

## 2. Requirements And Acceptance

${CONTEXT_MARKER}: Required behaviors, preferably as "input -> expected output or state".

## 3. Constraints And Settled Decisions

${CONTEXT_MARKER}: Hard project constraints and decisions reviewers must not reopen, with source paths.

## 4. Non-goals

${CONTEXT_MARKER}: Work this change does not need to do.

## 5. Review Focus

${CONTEXT_MARKER}: The two to five riskiest points after reading the diff.

## 6. Reviewed Change (generated)

- Repository: \`{repo}\`
- Mode: \`{mode}\`
- Base: \`{base}\`
- Head: \`{head}\`
- Read-only worktree at head: \`{worktree}\`
- Full diff: \`{diff}\`

### Diff stat

\`\`\`
{diffstat}
\`\`\`

### Files

\`\`\`
{names}
\`\`\`

### Commits

{commits}

## 7. Project Rule Files

{rules}
`;

// ---------------------------------------------------------------- configuration
// Registry agents with a review role join the built-ins; project entries still
// override or disable them by name.
export function validateReviewConfig(input = {}, agents = {}) {
  keys(
    input,
    ['version', 'backend', 'waitMs', 'stallMs', 'hardTimeoutMs', 'reviewers', 'voters'],
    'review config',
  );
  check(input.version === undefined || input.version === 1, 'Review config version must be 1');
  const config = {
    version: 1,
    backend: input.backend || 'auto',
    waitMs: input.waitMs ?? REVIEW_WAIT_MS,
    stallMs: input.stallMs ?? REVIEW_STALL_MS,
    hardTimeoutMs: input.hardTimeoutMs ?? REVIEW_HARD_TIMEOUT_MS,
  };
  choice(config.backend, ['auto', 'cmux', 'tmux', 'file'], 'review backend');
  number(config.waitMs, 'review waitMs', 1000, 86400000);
  number(config.stallMs, 'review stallMs', 1000, 86400000);
  number(config.hardTimeoutMs, 'review hardTimeoutMs', config.waitMs, 86400000);
  const overrides = object(input.reviewers || {}, 'review reviewers');
  const names = [
    ...new Set([
      ...Object.keys(DEFAULT_REVIEWERS),
      ...Object.keys(agents),
      ...Object.keys(overrides),
    ]),
  ];
  config.reviewers = Object.fromEntries(
    names.map((name) => [
      name,
      validateReviewer(name, overrides[name] || {}, DEFAULT_REVIEWERS[name] || agents[name] || {}),
    ]),
  );
  if (input.voters !== undefined) {
    stringArray(input.voters, 'review voters');
    check(new Set(input.voters).size === input.voters.length, 'Duplicate review voter');
    input.voters.forEach((name) =>
      check(config.reviewers[name]?.enabled, `Unknown or disabled voter: ${name}`),
    );
    config.voters = [...input.voters];
  }
  return config;
}

export function loadReviewConfig(cwd = process.cwd(), file) {
  const agents = reviewAgents();
  const candidates = file
    ? [resolve(cwd, file)]
    : [join(cwd, '.omha', 'review.json'), join(stateHome(), 'review.json')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(safeRead(path));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new OmhaError('configuration', `Malformed review JSON: ${path}`);
      throw error;
    }
    return { ...validateReviewConfig(parsed, agents), source: path };
  }
  if (file) throw new OmhaError('configuration', 'Review configuration file does not exist');
  return { ...validateReviewConfig({}, agents), source: null };
}

// ---------------------------------------------------------------- state
function reviewDir(reviewId) {
  id(reviewId, 'review id');
  return join(stateHome(), 'reviews', reviewId);
}
const recordFile = (dir) => join(dir, 'review.json');

export function reviewRecord(reviewId) {
  const dir = reviewDir(reviewId);
  const record = jsonRead(recordFile(dir), null, stateHome());
  check(record, 'Unknown review id', 'not_found');
  return record;
}
function save(record) {
  atomicWrite(recordFile(record.dir), JSON.stringify(record, null, 2), stateHome());
}
// Short read-modify-write of review.json; never held across a provider launch.
function mutate(reviewId, change) {
  const release = lockDir(join(reviewDir(reviewId), '.record.lock'), { root: stateHome() });
  try {
    const record = reviewRecord(reviewId);
    const result = change(record);
    save(record);
    return result === undefined ? record : result;
  } finally {
    release();
  }
}
// Serializes start, vote and close so two launches cannot claim one reviewer slot.
function exclusive(reviewId) {
  try {
    return lockDir(join(reviewDir(reviewId), '.operation.lock'), {
      root: stateHome(),
      timeoutMs: 1000,
    });
  } catch (error) {
    if (error.code === 'lock_timeout')
      throw new OmhaError('busy', 'Another review start, vote or close is in progress');
    throw error;
  }
}
function event(record, kind, data = {}) {
  appendEvent(join(record.dir, 'events.jsonl'), { kind, at: now(), ...data }, stateHome());
}
function readJson(file) {
  if (!existsSync(file)) return { exists: false, value: null };
  try {
    return { exists: true, value: JSON.parse(safeRead(file, stateHome())) };
  } catch {
    return { exists: true, value: null };
  }
}
const secrets = () => environmentSecrets(process.env);
function assertReviewInputs(record) {
  for (const file of [record.context, record.diff])
    assertNoSecrets(safeRead(file, stateHome()), secrets());
}

async function git(cwd, args, extra = {}) {
  const result = await run('git', args, {
    cwd,
    timeoutMs: 60000,
    maxOutputBytes: 64 * 1024 * 1024,
    ...extra,
  });
  if (result.code !== 0 || result.spawnError || result.timedOut || result.outputLimited)
    throw new OmhaError('git', `git ${args[0]} failed: ${result.stderr.trim().slice(0, 500)}`);
  return result.stdout.replace(/\n$/, '');
}

async function snapshotWorkingTree(repo) {
  const headSha = await git(repo, ['rev-parse', 'HEAD']);
  const index = join(tmpdir(), `omha-review-index-${randomUUID()}`);
  // A fixed identity keeps the internal snapshot independent of user git config.
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'omha review',
    GIT_AUTHOR_EMAIL: 'omha-review@localhost',
    GIT_COMMITTER_NAME: 'omha review',
    GIT_COMMITTER_EMAIL: 'omha-review@localhost',
  };
  try {
    await git(repo, ['read-tree', 'HEAD'], { env });
    await git(repo, ['add', '-A'], { env });
    const tree = await git(repo, ['write-tree'], { env });
    const snapshot = await git(
      repo,
      ['commit-tree', tree, '-p', headSha, '-m', 'omha review snapshot of the working tree'],
      { env },
    );
    return { base: headSha, head: snapshot };
  } finally {
    rmSync(index, { force: true });
  }
}

export async function prepareReview(cwd, options = {}) {
  const repo = await git(cwd, ['rev-parse', '--show-toplevel']);
  const modes = [Boolean(options.commit), Boolean(options.base), Boolean(options.working)];
  check(
    modes.filter(Boolean).length === 1,
    'Choose exactly one target: --commit SHA, --base REF [--head REF] or --working',
  );
  check(!options.head || options.base, '--head requires --base');
  const secretPolicy = choice(
    options.secretPolicy || 'reject',
    ['reject', 'redact'],
    'secret policy',
  );
  // reject (default) fails closed; redact is an explicit opt-in that freezes
  // sanitized copies so secret-like fixtures do not block the review.
  let redactions = 0;
  const screen = (value) => {
    if (secretPolicy === 'reject') {
      assertNoSecrets(value, secrets());
      return value;
    }
    const clean = redact(value, secrets());
    const marks = (x) => x.split('[REDACTED]').length - 1;
    redactions += marks(clean) - marks(value);
    return clean;
  };
  let mode, base, head, rangeArgs;
  if (options.commit) {
    mode = 'commit';
    head = await git(repo, ['rev-parse', `${options.commit}^{commit}`]);
    base = await git(repo, ['rev-parse', `${head}^`]);
    rangeArgs = ['--commit', head];
  } else if (options.working) {
    mode = 'working';
    ({ base, head } = await snapshotWorkingTree(repo));
    rangeArgs = ['--commit', head];
  } else {
    mode = 'range';
    head = await git(repo, ['rev-parse', `${options.head || 'HEAD'}^{commit}`]);
    const target = await git(repo, ['rev-parse', `${options.base}^{commit}`]);
    base = await git(repo, ['merge-base', target, head]);
    rangeArgs = ['--from', base, '--to', head];
  }
  // Build and screen every provider-visible input before any state is created.
  const diffText = screen(`${await git(repo, ['diff', '--find-renames', base, head])}\n`);
  const diffstat = await git(repo, ['diff', '--stat', '--find-renames', base, head]);
  const names = await git(repo, ['diff', '--name-status', '--find-renames', base, head]);
  const commits = screen(
    mode === 'working'
      ? '(working tree snapshot; no commit messages)'
      : await git(repo, ['log', '--format=### %h %s%n%n%b', `${base}..${head}`]),
  );
  const reviewId = options.id || `review-${head.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const dir = reviewDir(reviewId);
  check(!existsSync(dir), 'Review id already exists');
  const ref = `refs/omha-review/${reviewId}`;
  const worktree = join(dir, 'wt');
  const diff = join(dir, 'diff.patch');
  const context = join(dir, 'context.md');
  let worktreeAdded = false;
  try {
    ensureDir(dir, stateHome());
    for (const sub of ['results', 'votes']) ensureDir(join(dir, sub), stateHome());
    await git(repo, ['update-ref', ref, head]);
    await git(repo, ['worktree', 'add', '--detach', worktree, head]);
    worktreeAdded = true;
    atomicWrite(diff, diffText, stateHome());
    const rules = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'].filter((file) =>
      existsSync(join(worktree, file)),
    );
    const contextText = screen(
      fill(CONTEXT_TEMPLATE, {
        repo,
        mode,
        base,
        head,
        worktree,
        diff,
        diffstat: diffstat || '(empty)',
        names: names || '(empty)',
        commits: commits.trim() || '(none)',
        rules: rules.map((file) => `- \`${join(worktree, file)}\``).join('\n') || '- (none found)',
      }),
    );
    atomicWrite(context, contextText, stateHome());
    const record = {
      version: 1,
      id: reviewId,
      repo,
      dir,
      mode,
      base,
      head,
      ref,
      rangeArgs,
      worktree,
      context,
      diff,
      secretPolicy,
      redactions,
      createdAt: now(),
      state: 'prepared',
      jobs: { review: {}, vote: {} },
      history: [],
      voteRound: null,
    };
    save(record);
    event(record, 'review.prepared', { mode, base, head, secretPolicy, redactions });
    return record;
  } catch (error) {
    // Roll back every resource this call created; the original error wins.
    if (worktreeAdded)
      await git(repo, ['worktree', 'remove', '--force', worktree]).catch(() => null);
    await git(repo, ['update-ref', '-d', ref]).catch(() => null);
    await git(repo, ['worktree', 'prune']).catch(() => null);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------- launch
async function launch(record, kind, spec, prompt, config, options, slot) {
  const values = {
    name: spec.name,
    run: record.dir,
    worktree: record.worktree,
    context: record.context,
    diff: record.diff,
    items: slot.items || join(record.dir, 'disputed.json'),
    out: join(slot.dir, `${spec.name}.json`),
    last: join(slot.dir, `${spec.name}.last.md`),
    model: spec.model || '',
    base: record.base,
    head: record.head,
    range_args: record.rangeArgs,
  };
  const body = fill(prompt, values);
  values.prompt = body;
  const { command, args } = launchCommand(spec, values);
  // Everything that can fail is computed before the handoff exists.
  const started = Date.now();
  const deadline = new Date(started + slot.waitMs).toISOString();
  ensureDir(slot.dir, stateHome());
  for (const file of [values.out, values.last]) rmSync(file, { force: true });
  const handoffRecord = await handoff(record.worktree, body, {
    backend: options.backend || config.backend,
    name: `${record.id}-${kind}-${spec.name}`.slice(0, 128),
    command,
    args,
    interactive: false,
    timeoutMs: config.hardTimeoutMs,
    envAllowlist: [...new Set([...AGENT_ENV, ...spec.envAllowlist])],
    backendAdapter: options.backendAdapter,
    backends: options.backends,
    signal: options.signal,
  });
  return {
    name: spec.name,
    kind,
    round: slot.round ?? null,
    itemsHash: slot.itemsHash ?? null,
    role: spec.role,
    handoffId: handoffRecord.id,
    backend: handoffRecord.backend,
    requestedBackend: handoffRecord.requestedBackend,
    launchAttempts: handoffRecord.launchAttempts,
    state: handoffRecord.state,
    ref: handoffRecord.ref,
    command: spec.command,
    requestedModel: spec.model ?? null,
    promptHash: hash(body),
    startedAt: new Date(started).toISOString(),
    deadline,
    stallMs: config.stallMs,
    out: values.out,
    last: values.last,
    activity: { hash: null, changedAt: new Date(started).toISOString() },
  };
}

function selectSpecs(config, detected, requested, kind) {
  const byName = new Map(detected.map((entry) => [entry.name, entry]));
  if (requested?.length) {
    check(
      new Set(requested).size === requested.length,
      `Duplicate ${kind === 'vote' ? 'voter' : 'reviewer'} name`,
    );
    requested.forEach((name) => check(config.reviewers[name], `Unknown reviewer: ${name}`));
  }
  const pool = requested?.length
    ? requested
    : kind === 'vote'
      ? config.voters || Object.keys(config.reviewers)
      : Object.keys(config.reviewers);
  const selected = [],
    skipped = [];
  for (const name of pool) {
    const spec = config.reviewers[name];
    const found = byName.get(name);
    if (!spec.enabled || !found?.available) {
      if (requested?.length || spec.enabled)
        skipped.push({ name, reason: found?.reason || 'disabled' });
      continue;
    }
    if (kind === 'vote' && (spec.role === 'static' || !spec.vote)) {
      if (requested?.length) skipped.push({ name, reason: 'reviewer cannot vote' });
      continue;
    }
    selected.push({ ...spec, model: found.model ?? undefined });
  }
  return { selected, skipped };
}

// Cheap label for reports; decisions use liveState, which re-reads the handoff.
const isLive = (job) => !DONE.includes(handoffStatus(job.handoffId).state);
async function liveState(job, options) {
  const state = handoffStatus(job.handoffId).state;
  if (DONE.includes(state)) return null;
  const current = await readHandoff(job.handoffId, options);
  return DONE.includes(current.state) ? null : current.state;
}

// Close an owned handoff that is being superseded; it stays in history for close.
async function retire(job, options) {
  if (handoffStatus(job.handoffId).state !== 'closed') await closeHandoff(job.handoffId, options);
}

function archive(job, attempt) {
  for (const file of [job.out, job.last])
    if (existsSync(file)) renameSync(file, file.replace(/(\.[a-z.]+)$/, `.attempt-${attempt}$1`));
}

async function startJobs(reviewId, kind, prompt, options, slotFor, minimum = 1) {
  const record = reviewRecord(reviewId);
  const config = options.reviewConfig || loadReviewConfig(record.repo, options.config);
  const waitMs = number(
    options.waitMs ?? config.waitMs,
    'review waitMs',
    1000,
    config.hardTimeoutMs,
  );
  const detected = detectReviewers(config, options);
  const { selected, skipped } = selectSpecs(config, detected, options.reviewers, kind);
  // Check the quorum before launching anything so a rejected request leaves no workers.
  check(
    selected.length >= minimum,
    `${kind === 'vote' ? 'Voting needs at least two voters' : 'No reviewer could be launched'}: ${JSON.stringify(skipped)}`,
    'unavailable',
  );
  const slot = { ...slotFor(record), waitMs };
  const launched = [];
  for (const spec of selected) {
    const previous = record.jobs[kind][spec.name];
    if (previous) {
      const state = await liveState(previous, options);
      if (state && !options.force) {
        skipped.push({ name: spec.name, reason: `already ${state}; pass --force to relaunch` });
        continue;
      }
      await retire(previous, options);
      archive(previous, record.history.filter((x) => x.name === spec.name).length + 1);
    }
    try {
      const job = await launch(record, kind, spec, prompt, config, options, slot);
      mutate(reviewId, (latest) => {
        if (previous) latest.history.push({ ...previous, supersededAt: now() });
        latest.jobs[kind][spec.name] = job;
        latest.state = kind === 'review' ? 'reviewing' : 'voting';
      });
      record.jobs[kind][spec.name] = job;
      launched.push({
        name: spec.name,
        backend: job.backend,
        state: job.state,
        handoffId: job.handoffId,
      });
      event(record, `${kind}.launched`, {
        reviewer: spec.name,
        handoffId: job.handoffId,
        backend: job.backend,
        requestedModel: job.requestedModel,
        promptHash: job.promptHash,
        round: job.round,
      });
    } catch (error) {
      if (previous)
        mutate(reviewId, (latest) => {
          latest.history.push({ ...previous, supersededAt: now() });
          delete latest.jobs[kind][spec.name];
        });
      skipped.push({ name: spec.name, reason: `launch failed: ${error.message}` });
      event(record, `${kind}.launch_failed`, {
        reviewer: spec.name,
        failure: error.code || 'error',
      });
    }
  }
  return {
    id: record.id,
    kind,
    round: slot.round ?? null,
    configSource: config.source,
    launched,
    skipped,
    deadline: launched.length
      ? new Date(
          Math.max(...launched.map((x) => Date.parse(record.jobs[kind][x.name].deadline))),
        ).toISOString()
      : null,
  };
}

export async function startReview(reviewId, options = {}) {
  const release = exclusive(reviewId);
  try {
    const record = reviewRecord(reviewId);
    check(!['closed', 'cleanup_failed'].includes(record.state), 'Review is closed');
    check(
      !safeRead(record.context, stateHome()).includes(CONTEXT_MARKER),
      `Complete every ${CONTEXT_MARKER} section in ${record.context} before starting`,
    );
    assertReviewInputs(record);
    return await startJobs(reviewId, 'review', REVIEW_PROMPT, options, () => ({
      dir: join(record.dir, 'results'),
    }));
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- observation
export function extractJson(value, key) {
  if (!value) return null;
  const candidates = [];
  for (const match of value.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g))
    candidates.push(match[1]);
  for (const match of value.matchAll(/\{\s*"/g)) candidates.push(value.slice(match.index));
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (!key || Object.hasOwn(parsed, key)) return parsed;
    } catch {
      // Tolerate trailing text after the final JSON object.
      try {
        let depth = 0,
          inString = false,
          escaped = false;
        for (let i = 0; i < candidate.length; i += 1) {
          const c = candidate[i];
          if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
          } else if (c === '"') inString = true;
          else if (c === '{') depth += 1;
          else if (c === '}' && --depth === 0) {
            const parsed = JSON.parse(candidate.slice(0, i + 1));
            if (!key || Object.hasOwn(parsed, key)) return parsed;
            break;
          }
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const isEntryList = (value) =>
  Array.isArray(value) && value.every((x) => x && typeof x === 'object' && !Array.isArray(x));

function findList(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['findings', 'comments', 'issues', 'results', 'review_comments'])
    if (Array.isArray(value?.[key])) return value[key];
  if (value?.result && typeof value.result === 'object') return findList(value.result);
  return null;
}

// A result is accepted only when its envelope and every entry have the expected shape;
// a malformed payload must never look like a clean zero-finding review.
function validResult(job, value) {
  if (!value || typeof value !== 'object') return false;
  if (job.kind === 'vote') return isEntryList(value.votes);
  if (job.role === 'static') return isEntryList(findList(value));
  return isEntryList(value.findings);
}

function resultOf(job, output) {
  const direct = readJson(job.out);
  if (validResult(job, direct.value)) return { value: direct.value, source: 'file' };
  const key = job.kind === 'vote' ? 'votes' : job.role === 'static' ? null : 'findings';
  if (key)
    for (const [source, value] of [
      ['last', existsSync(job.last) ? safeRead(job.last, stateHome()) : ''],
      ['output', output || ''],
    ]) {
      const parsed = extractJson(value, key);
      if (validResult(job, parsed)) {
        if (direct.exists) renameSync(job.out, `${job.out}.malformed`);
        atomicWrite(job.out, JSON.stringify(parsed, null, 2), stateHome());
        return { value: parsed, source };
      }
    }
  return direct.exists ? { value: null, source: null, malformed: true } : null;
}

async function observe(job, options) {
  const current = await readHandoff(job.handoffId, options);
  const at = Date.now();
  const digest = hash(current.output || '');
  const activity =
    digest !== job.activity.hash
      ? { hash: digest, changedAt: new Date(at).toISOString() }
      : job.activity;
  const final = DONE.includes(current.state);
  const result = resultOf(job, final ? current.output : '');
  const idleMs = at - Date.parse(activity.changedAt);
  let view;
  if (current.state === 'awaiting') view = 'awaiting_handoff';
  else if (final) view = current.state === 'completed' ? 'done' : current.state;
  else if (idleMs > job.stallMs) view = 'stalled';
  else view = 'running';
  return {
    update: { state: current.state, activity, final, output: Boolean(result?.value) },
    responseHash: current.completion?.responseHash || null,
    view: {
      name: job.name,
      view,
      state: current.state,
      output: Boolean(result?.value),
      outputSource: result?.source || null,
      malformedOutput: Boolean(result?.malformed),
      backend: current.backend,
      ref: current.ref,
      pid: current.pid,
      alive: current.alive,
      exitCode: current.completion?.exitCode ?? null,
      idleMs: final ? null : idleMs,
      startedAt: job.startedAt,
      deadline: job.deadline,
      handoffId: job.handoffId,
      round: job.round,
      promptFile: current.state === 'awaiting' ? current.promptFile : undefined,
      resumeCommand:
        current.state === 'awaiting'
          ? `cd ${shellQuote(current.cwd)} && ${[current.command, ...current.args].map(shellQuote).join(' ')} < ${shellQuote(current.promptFile)}`
          : undefined,
      failure: current.failure,
    },
  };
}

async function worktreeIntegrity(record) {
  if (!existsSync(record.worktree)) return { tampered: null, error: 'worktree is absent' };
  try {
    const head = await git(record.worktree, ['rev-parse', 'HEAD']);
    const dirty = await git(record.worktree, ['status', '--porcelain']);
    return { tampered: head !== record.head || Boolean(dirty), error: null };
  } catch (error) {
    return { tampered: null, error: error.message };
  }
}

export async function reviewStatus(reviewId, options = {}) {
  const kind = options.kind || 'review';
  choice(kind, KINDS, 'review status kind');
  const snapshot = reviewRecord(reviewId);
  const jobs = Object.values(snapshot.jobs[kind]);
  const reviewers = [],
    updates = [];
  // Observation runs without the record lock; only the observed fields are merged
  // into the latest record afterwards, so concurrent launches and closes survive.
  for (const job of jobs) {
    try {
      const observed = await observe(job, options);
      reviewers.push(observed.view);
      updates.push({ job, ...observed });
    } catch (error) {
      reviewers.push({
        name: job.name,
        view: 'unknown',
        error: error.message,
        handoffId: job.handoffId,
      });
    }
  }
  const record = mutate(reviewId, (latest) => {
    for (const { job, update, responseHash } of updates) {
      const target = latest.jobs[kind][job.name];
      if (target?.handoffId !== job.handoffId) continue;
      target.state = update.state;
      target.activity = update.activity;
      if (update.final && !target.finishedAt) {
        target.finishedAt = now();
        event(latest, `${kind}.finished`, {
          reviewer: job.name,
          state: update.state,
          output: update.output,
          responseHash,
        });
      }
    }
    return latest;
  });
  const integrity = await worktreeIntegrity(record);
  const deadline = jobs.length ? Math.max(...jobs.map((job) => Date.parse(job.deadline))) : null;
  return {
    id: record.id,
    kind,
    state: record.state,
    round: kind === 'vote' ? (record.voteRound?.n ?? null) : undefined,
    deadline: deadline ? new Date(deadline).toISOString() : null,
    remainingMs: deadline ? Math.max(0, deadline - Date.now()) : null,
    worktreeTampered: integrity.tampered,
    worktreeError: integrity.error,
    reviewers,
  };
}

const pending = (entry) => ['running', 'stalled', 'unknown'].includes(entry.view);

export async function waitReview(reviewId, options = {}) {
  const start = Date.now();
  const maxMs = options.maxMs ?? null;
  if (maxMs !== null) number(maxMs, 'review wait maxMs', 0, 86400000);
  const intervalMs = number(options.intervalMs ?? 5000, 'review wait intervalMs', 10, 600000);
  while (true) {
    const status = await reviewStatus(reviewId, options);
    const live = status.reviewers.filter(pending);
    let outcome = null;
    if (!status.reviewers.length) outcome = 'empty';
    else if (!live.length)
      outcome = status.reviewers.some((x) => x.view === 'awaiting_handoff')
        ? 'handoff_pending'
        : 'finished';
    else if (status.remainingMs === 0) outcome = 'deadline';
    else if (maxMs !== null && Date.now() - start >= maxMs) outcome = 'max_wait';
    else if (options.signal?.aborted) outcome = 'interrupted';
    if (outcome) {
      // Reaching the budget never cancels reviewers; their handoffs keep running.
      return { ...status, outcome, stillRunning: live.map((x) => x.name) };
    }
    const sleep = Math.min(
      intervalMs,
      status.remainingMs,
      maxMs === null ? Infinity : Math.max(0, maxMs - (Date.now() - start)),
    );
    await new Promise((done) => setTimeout(done, sleep));
  }
}

// ---------------------------------------------------------------- merge
function normSeverity(value) {
  const s = String(value || '')
    .trim()
    .toUpperCase();
  if (SEVERITIES.includes(s)) return s;
  const table = {
    CRITICAL: 'P0',
    BLOCKER: 'P0',
    HIGH: 'P1',
    MAJOR: 'P1',
    ERROR: 'P1',
    MEDIUM: 'P2',
    WARNING: 'P2',
    MINOR: 'P2',
    LOW: 'P3',
    INFO: 'P3',
    NIT: 'P3',
    SUGGESTION: 'P3',
  };
  return table[s] || 'P2';
}
const first = (item, ...names) =>
  names
    .map((name) => item?.[name])
    .find((value) => value !== undefined && value !== null && value !== '');

export function normalizeFindings(name, value) {
  return (findList(value) || []).map((item, index) => {
    const line = Number.parseInt(
      first(item, 'line', 'start_line', 'startLine', 'line_start', 'new_line'),
      10,
    );
    const title = String(
      first(item, 'title', 'summary', 'message', 'content', 'body', 'comment') || '',
    );
    return {
      reviewer: name,
      rid: `${name}-${index + 1}`,
      file: String(first(item, 'file', 'path', 'file_path', 'filename') || ''),
      line: Number.isFinite(line) ? line : null,
      severity: normSeverity(first(item, 'severity', 'priority', 'level')),
      category: String(first(item, 'category', 'type', 'kind') || ''),
      title: title.trim().split(/\r?\n/)[0].slice(0, 200),
      detail: String(
        first(item, 'detail', 'description', 'body', 'content', 'message', 'comment') || '',
      ),
      evidence: String(first(item, 'evidence', 'existing_code', 'code', 'snippet') || ''),
      suggestedFix: String(
        first(item, 'suggested_fix', 'suggestion', 'suggestion_code', 'fix') || '',
      ),
      confidence: first(item, 'confidence') ?? null,
    };
  });
}

export function clusterFindings(findings, window = 6) {
  const sorted = [...findings].sort(
    (a, b) => a.file.localeCompare(b.file) || (a.line ?? -1) - (b.line ?? -1),
  );
  const groups = [];
  let current = null;
  for (const finding of sorted) {
    if (
      current &&
      finding.file === current.file &&
      finding.line !== null &&
      current.last !== null &&
      Math.abs(finding.line - current.last) <= window
    ) {
      current.items.push(finding);
      current.last = finding.line;
    } else {
      current = { file: finding.file, last: finding.line, items: [finding] };
      groups.push(current);
    }
  }
  return groups
    .map((group, index) => ({
      cid: `C${String(index + 1).padStart(2, '0')}`,
      file: group.file,
      lines: [...new Set(group.items.map((x) => x.line).filter((x) => x !== null))].sort(
        (a, b) => a - b,
      ),
      reviewers: [...new Set(group.items.map((x) => x.reviewer))].sort(),
      maxSeverity: group.items
        .map((x) => x.severity)
        .sort((a, b) => SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b))[0],
      items: group.items,
    }))
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(a.maxSeverity) - SEVERITIES.indexOf(b.maxSeverity) ||
        b.reviewers.length - a.reviewers.length,
    );
}

export function mergeReview(reviewId) {
  const record = reviewRecord(reviewId);
  const sources = {},
    findings = [];
  for (const job of Object.values(record.jobs.review)) {
    const read = readJson(job.out);
    if (!validResult(job, read.value)) {
      sources[job.name] = read.exists ? 'malformed' : isLive(job) ? 'pending' : 'missing';
      continue;
    }
    const normalized = normalizeFindings(job.name, read.value);
    sources[job.name] = normalized.length;
    findings.push(...normalized);
  }
  const clusters = clusterFindings(findings);
  const lines = ['# Omha review findings', '', `sources: ${JSON.stringify(sources)}`, ''];
  const flat = (value, max) => String(value).trim().replace(/\s+/g, ' ').slice(0, max);
  for (const c of clusters) {
    lines.push(
      `## ${c.cid} [${c.maxSeverity}] ${c.file || '(no file)'}:${c.lines.join(',') || '-'} reviewers=${c.reviewers.join('+')}`,
    );
    for (const x of c.items) {
      lines.push(`- **${x.rid}** ${x.severity} ${x.category} — ${x.title}`);
      if (x.detail && x.detail !== x.title) lines.push(`  - detail: ${flat(x.detail, 800)}`);
      if (x.evidence) lines.push(`  - evidence: ${flat(x.evidence, 400)}`);
      if (x.suggestedFix) lines.push(`  - fix: ${flat(x.suggestedFix, 400)}`);
    }
    lines.push('');
  }
  const findingsFile = join(record.dir, 'findings.md');
  atomicWrite(
    join(record.dir, 'findings.json'),
    JSON.stringify({ sources, clusters }, null, 2),
    stateHome(),
  );
  atomicWrite(findingsFile, `${lines.join('\n')}\n`, stateHome());
  event(record, 'review.merged', { sources, clusters: clusters.length });
  return { id: record.id, sources, clusters: clusters.length, findings: findingsFile };
}

// ---------------------------------------------------------------- votes
export function validateDisputed(input) {
  check(
    Array.isArray(input) && input.length > 0 && input.length <= 50,
    'Disputed items must be a nonempty array (at most 50)',
  );
  const seen = new Set();
  for (const item of input) {
    keys(
      item,
      ['id', 'file', 'line', 'title', 'claim', 'counter', 'proposed_fix'],
      'disputed item',
    );
    id(item.id, 'disputed item id');
    check(!seen.has(item.id), `Duplicate disputed item: ${item.id}`);
    seen.add(item.id);
    for (const key of ['title', 'claim', 'counter', 'proposed_fix'])
      text(item[key], `disputed ${key}`, 20000);
    if (item.file !== undefined) text(item.file, 'disputed file', 4096);
    if (item.line !== undefined) number(item.line, 'disputed line', 0, 10000000);
  }
  assertNoSecrets(input, secrets());
  return input;
}

// Each vote call opens a new immutable round; ballots count only for their round.
export async function voteReview(reviewId, disputed, options = {}) {
  validateDisputed(disputed);
  const release = exclusive(reviewId);
  try {
    let record = reviewRecord(reviewId);
    check(!['closed', 'cleanup_failed'].includes(record.state), 'Review is closed');
    assertReviewInputs(record);
    const live = [];
    for (const job of Object.values(record.jobs.vote))
      if (await liveState(job, options)) live.push(job);
    check(
      !live.length || options.force,
      `Voters of round ${record.voteRound?.n} are still running: ${live.map((x) => x.name).join(', ')}; wait or pass --force`,
      'busy',
    );
    const config = options.reviewConfig || loadReviewConfig(record.repo, options.config);
    // Fail fast on quorum, unknown voters and duplicates before retiring anything.
    const { selected, skipped } = selectSpecs(
      config,
      detectReviewers(config, options),
      options.reviewers,
      'vote',
    );
    check(
      selected.length >= 2,
      `Voting needs at least two voters: ${JSON.stringify(skipped)}`,
      'unavailable',
    );
    for (const job of Object.values(record.jobs.vote)) await retire(job, options);
    const n = (record.voteRound?.n || 0) + 1;
    const dir = join(record.dir, 'votes', `round-${n}`);
    const items = join(dir, 'disputed.json');
    const body = JSON.stringify(disputed, null, 2);
    ensureDir(dir, stateHome());
    atomicWrite(items, body, stateHome());
    const round = { n, items, itemsHash: hash(body), at: now() };
    record = mutate(reviewId, (latest) => {
      latest.history.push(
        ...Object.values(latest.jobs.vote).map((job) => ({ ...job, supersededAt: now() })),
      );
      latest.jobs.vote = {};
      latest.voteRound = round;
      return latest;
    });
    event(record, 'vote.round_opened', { round: n, itemsHash: round.itemsHash });
    return await startJobs(
      reviewId,
      'vote',
      VOTE_PROMPT,
      { ...options, reviewConfig: config },
      () => ({ dir, items, round: n, itemsHash: round.itemsHash }),
      2,
    );
  } finally {
    release();
  }
}

export function tallyReview(reviewId) {
  const record = reviewRecord(reviewId);
  const round = record.voteRound;
  check(round, 'No vote round recorded for this review');
  const body = safeRead(round.items, stateHome());
  check(hash(body) === round.itemsHash, 'Disputed items changed after the round opened');
  const disputed = JSON.parse(body);
  const ballots = {},
    pendingVoters = [],
    malformed = [];
  for (const job of Object.values(record.jobs.vote)) {
    if (job.round !== round.n || job.itemsHash !== round.itemsHash) continue;
    const read = readJson(job.out);
    if (validResult(job, read.value))
      ballots[job.name] = Object.fromEntries(read.value.votes.map((x) => [String(x.id), x]));
    else if (read.exists) malformed.push(job.name);
    else if (isLive(job)) pendingVoters.push(job.name);
  }
  const items = disputed.map((item) => {
    const cast = Object.fromEntries(
      Object.entries(ballots)
        .filter(([, votes]) => votes[item.id])
        .map(([voter, votes]) => [voter, votes[item.id]]),
    );
    const valid = Object.values(cast).filter((x) =>
      ['fix', 'no_fix', 'false_positive'].includes(String(x.verdict)),
    ).length;
    const fix = Object.values(cast).filter((x) => x.verdict === 'fix').length;
    // Strict majority of at least two valid ballots; ties and missing votes do not fix.
    return {
      id: item.id,
      title: item.title,
      decision: valid >= 2 && fix * 2 > valid ? 'fix' : 'no_fix',
      fixVotes: fix,
      validVotes: valid,
      ballots: Object.fromEntries(
        Object.entries(cast).map(([voter, x]) => [
          voter,
          { verdict: x.verdict ?? null, severity: x.severity ?? null, reason: x.reason ?? null },
        ]),
      ),
    };
  });
  const result = {
    id: record.id,
    round: round.n,
    itemsHash: round.itemsHash,
    voters: Object.keys(ballots),
    pendingVoters,
    malformedVoters: malformed,
    items,
  };
  atomicWrite(join(record.dir, 'tally.json'), JSON.stringify(result, null, 2), stateHome());
  event(record, 'vote.tallied', {
    round: round.n,
    voters: result.voters,
    pendingVoters,
    decisions: items.map((x) => ({ id: x.id, decision: x.decision })),
  });
  return result;
}

// ---------------------------------------------------------------- cleanup
export async function closeReview(reviewId, options = {}) {
  const release = exclusive(reviewId);
  try {
    const record = reviewRecord(reviewId);
    if (record.state === 'closed')
      return { id: record.id, state: 'closed', closedHandoffs: [], evidence: record.dir };
    const jobs = [
      ...KINDS.flatMap((kind) => Object.values(record.jobs[kind])),
      ...(record.history || []),
    ];
    const live = [];
    for (const job of jobs) if (await liveState(job, options)) live.push(job);
    check(
      !live.length || options.force,
      `Reviewers still running: ${live.map((job) => `${job.kind}:${job.name}`).join(', ')}; wait or pass --force`,
      'busy',
    );
    const closed = [];
    for (const job of jobs) {
      if (handoffStatus(job.handoffId).state === 'closed') continue;
      await closeHandoff(job.handoffId, options);
      closed.push(job.handoffId);
    }
    const failures = [];
    if (existsSync(record.worktree))
      await git(record.repo, ['worktree', 'remove', '--force', record.worktree]).catch((error) =>
        failures.push(error.message),
      );
    const refExists = await git(record.repo, ['rev-parse', '--verify', '--quiet', record.ref])
      .then(() => true)
      .catch(() => false);
    if (refExists)
      await git(record.repo, ['update-ref', '-d', record.ref]).catch((error) =>
        failures.push(error.message),
      );
    // Prune only removes stale metadata; its failure leaves no owned resource behind.
    await git(record.repo, ['worktree', 'prune']).catch(() => null);
    const state = failures.length ? 'cleanup_failed' : 'closed';
    mutate(reviewId, (latest) => {
      latest.state = state;
      latest.closedAt = now();
      if (failures.length) latest.cleanupErrors = failures;
      else delete latest.cleanupErrors;
    });
    event(record, failures.length ? 'review.cleanup_failed' : 'review.closed', {
      handoffs: closed,
      forced: Boolean(options.force),
      failures,
    });
    if (failures.length)
      throw new OmhaError(
        'cleanup',
        `Review handoffs closed but repository cleanup failed; retry close: ${failures.join('; ')}`,
      );
    return { id: record.id, state, closedHandoffs: closed, evidence: record.dir };
  } finally {
    release();
  }
}

export function listReviews() {
  const root = join(stateHome(), 'reviews');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => existsSync(recordFile(join(root, name))))
    .map((name) => {
      const record = jsonRead(recordFile(join(root, name)), null, stateHome());
      return {
        id: record.id,
        state: record.state,
        mode: record.mode,
        head: record.head,
        createdAt: record.createdAt,
        reviewers: Object.keys(record.jobs.review),
        voteRound: record.voteRound?.n ?? null,
        updatedAt: statSync(recordFile(join(root, name))).mtime.toISOString(),
      };
    });
}
