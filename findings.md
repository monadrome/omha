# Research findings

## Authorized optimization evidence (2026-10-13)

- Recovery on 2026-10-16 found only an uncommitted supervision plan/schema stub.
  The runtime already supplies live JSONL summaries; supervision will reuse that
  callback and existing fallback routing with a separate controller per attempt.
- Scheduler cleanup currently releases the worktree and task deadline before
  acceptance/review. Extend their lifetime through the complete task lifecycle
  so verification cannot overlap another run's writer or escape cancellation.
- Final audit must check planner authority over acceptance/review/decision policy
  and restart recovery of reviews that were pending at host interruption.
- DAG acceptance reuses the bounded local process path but does not copy the
  Arena Git artifact collector. It persists only command, exit/signal, hashes,
  byte counts and bounded outcome metadata; provider output is not passed to the
  acceptance command.
- Plan-level decision gates are evaluated after immutable run creation and before
  the scheduler starts. Resume inspects the durable decision record and avoids
  rerunning voters or charging a second decision after host approval.

## Authorized optimization audit (2026-10-13)

- Current clean baseline: main at 1a615ae. Previous analysis passed 99 offline
  tests and reproduced three defects using only fake/local providers.
- `.execution.lock` and scheduler `active` state are per run; distinct runs can
  overlap writes in the same worktree. Worktree admission needs a durable shared
  lease with asynchronous waits, because holding a synchronous storage lock
  across provider execution would deadlock in-process runs.
- `reviewTask()` compares requested reviewer and planned author names, allowing
  both author-fallback and reviewer-fallback self-review. Actual attempt lineage
  and served profiles must remain authoritative at routing and acceptance.
- `streamFramer.finish()` errors are ignored when `parseOutput()` succeeds;
  a complete JSON object without a terminating JSONL newline is accepted with
  `ok:true` and `stream.complete:false`.
- Existing review, roundtable, event, memory and Arena artifact/harness modules
  are the implementation boundaries for the remaining lifecycle improvements.
- The new post-routing authority test exposed another review boundary defect:
  runStatus replayed `review.recorded.status` as task execution state. Filtering
  task execution events preserves completed tasks after failed/invalid reviews.

## Concurrency and security hardening (2026-10-12)

- Baseline cce12eb: clean main synchronized with origin/main. Read AGENTS.md,
  README.md and docs/contracts.md; previous protocol work is excluded.
- Timing candidates: runtime semaphore assertions use elapsed wall time;
  process timeout/cancellation fixtures assume startup within 120ms. Handoff
  real-worker tests already allow 10s and await actual child completion.
- Test modules are runtime, handoff and integration (no runner/process modules).
- Reproduced the disclosed false/true assertion by delaying eval worker startup
  300ms: 3/3 failures at runtime.test.mjs:430 (pidFile absent). A ready-signal plus
  MockTimers prototype passes with that delay and on Node 20.20.2.
- Full-suite round 1 exposed a separate real lock race: transient nlink=0 is
  mistaken for a hardlink by assertSafePath. A real 200,000-lstat / 80,000-unlink
  experiment observed 1,737 zero-link stats. Four concurrent atomic writers also
  reproduced the rejection; baseline CAS experiment admitted 1/8 and rejected 7/8.
- Runtime 30/30 and handoff 30/30 pass independently. Focused memory concurrency,
  hash and live-lock tests pass 40/40. Integration 20/20 is blocked by ps EPERM;
  full sandbox suites also have strict-executor localhost EPERM.
- Concrete queue defect: hold a lease at injected time 0, start a waiter with
  timeout=10, advance time to 11 and release; waiter still acquires a lease.
- Credentials accepted unchanged: auth_token assignment, a quoted password whose
  first word has <4 characters, and a [REDACTED]-prefixed actual key. Command args
  accept --auth-token=value and password values beginning with dollar/brace.
- A real command echoing an allowlisted multiline AUTH_TOKEN as JSON leaks its
  escaped value through stdout/attempt records. Original-only literal replacement
  misses the JSON-escaped representation.
- Repairs validated: queue checks its deadline before gate mutation; storage accepts
  transient zero-link files but still rejects nlink>1; redaction scans auth-token,
  quoted/bracketed assignments and JSON-escaped allowlisted values, while argv
  credentials only permit exact environment placeholders.
- New regression fixtures: tests/storage.test.mjs (cross-process atomic writes,
  hardlinks, compare-and-swap memory writes) and tests/security.test.mjs.
- The existing adapter layer already runs Claude JSON, Codex JSONL and Kimi
  stream-JSON headlessly; the missing group-decision layer was the host trigger,
  not another provider implementation. The trigger now uses only bounded host
  signals and reuses the existing blind roundtable, so it cannot delegate the
  decision boundary to a prompt.
- Capability inference is limited to flags Omha can enforce: known structured
  adapters imply `headless`, Claude/Codex/fake imply `tool-free`, and only the
  `read-only` sandbox implies `read-only`. External wrappers remain explicit and
  are not promoted to read-only automatically.
- Structured event summaries are intentionally post-parse, bounded and payload-free:
  they provide audit and input-wait evidence without treating event type or CLI
  exit status as task correctness. Real-time escalation still needs a streaming
  provider callback or ACP channel.
- Generic task review now has a separate host API and packet. Reviewer output
  cannot set approval, must cover exactly the frozen criteria, and is rejected
  when the run profile hash changes; review records never mutate task status.

## Residual automation boundaries (2026-10-12)

- Escalation/takeover supervision remains pending. Default and non-JSONL summaries
  are emitted after a provider response is parsed; the new opt-in Codex/Kimi JSONL
  stream provides live evidence but does not yet define a watchdog policy. Existing
  task/handoff timeouts remain the bounded failure path until that host decision
  loop is specified.
- ACP integration remains pending. Current Claude/Codex/Kimi adapters preserve
  their native billing channels and expose a common summary envelope, but no
  JSON-RPC stdio capability contract is present to standardize without inventing
  a second adapter implementation.

## Competitor research and realtime stream (2026-10-12)

- The four most relevant active projects selected by public stars and overlap
  were OpenHands (90,711), Cline (70,213), Goose (55,197) and LangGraph
  (43,138). Sources and the selection rationale are recorded in
  `docs/research.md`; AutoGen was excluded because its repository says it is in
  maintenance mode.
- Cline's headless NDJSON/events and Goose's `stream-json` are the closest safe
  borrowing point. OpenHands' backend boundary and LangGraph's durable
  interrupt/resume model remain design references, not copied implementations.
- `createEventFramer()` now consumes complete JSONL lines with 512 KiB line,
  1 MiB incomplete-buffer and 4,096-event limits. It emits only the existing
  redacted summaries, so raw provider payloads do not enter callbacks or durable
  records.
- `streamEvents: true` is intentionally opt-in and supports real Codex/Kimi
  JSONL processes only. Claude keeps its native JSON invocation; fake fixtures
  keep completion-time behavior. Callback promises are drained after process
  exit, and callback rejection is classified as a host task failure.
- Completion parsing, host acceptance, budget settlement, retry/fallback,
  process-group cleanup and billing channels remain authoritative. A stream is
  observation evidence and cannot establish task correctness.

## Hardening audit (2026-10-12)

- Starting worktree is clean on main tracking origin/main.
- The worker writes both final.json and FINAL_MARKER stdout. Reader prefers the
  file, so stdout integration coverage must remove final.json before parsing.
- Existing handoff tests only synthesize markers; a real child-process backend
  can capture actual worker stdout while keeping terminal dependencies optional.

## Production implementation audit (2026-10-09)

- GitHub delivery (2026-10-10): local gh cache retains the old login HuaTalk,
  but authenticated API login is monadrome. Repository metadata uses the verified
  namespace while the npm name remains @huatalk/omha.

- Clean worktree at start. Five tests cover only an index, one conflict, fallback,
  file creation, and hash changes. There is no durable lifecycle or DAG validation.
- Runner ignores malformed configuration, inherits the full environment, accepts
  arbitrary nonempty output, and merges rate-limit/capacity failures.
- Process timeout kills only the direct child. Logs contain task strings and no
  cancellation, circuit, concurrency or budget semantics exist.
- Terminal code uses a cmux command not advertised by the installed CLI
  (`workspace create` versus `new-workspace`), stores no ownership record, and
  cannot capture, resume or cancel.
- Memory rebuild contains a timestamp and slices arbitrary bytes; scopes,
  stale-lock ownership, symlink/hardlink defenses and credential checks are absent.
- Existing upstream skill contracts are retained. NOTICE currently refers to
  upstream license files outside the package; copies must ship with the package.
- CLI help probes only are permitted. Installed help exposes Claude JSON output,
  Codex JSONL, Kimi stream-json and cmux full UUID output plus send/send-key.
- Full-suite concurrent writer injection exposed an EEXIST-to-lstat race when a
  lock was released between those operations. Lock acquisition now retries ENOENT
  and serializes stale-lock recovery with a separate exclusive recovery claim.
- Butterfly redaction tests exposed non-idempotent credential placeholder
  replacement. Redaction now preserves existing [REDACTED] placeholders.
- First real tmux probe found that set-option/show-option target syntax does not
  accept the same exact-match session prefix as kill-session/display-message.
  Corrected option targets and added rollback after partial backend creation.
  The diagnostic sessions were created on the probe's private socket and removed.
- A long-input tmux probe exposed macOS canonical terminal input truncation and
  CR-versus-LF handling in the pipe-supervised worker. Owned line-mode terminals
  now use raw input and normalize Enter; full-screen TUIs are outside this mode.
- cmux legacy create output can contain non-JSON migration text, and its RPC
  workspace.create ignores the CLI's command flag. Creation now uses structured
  RPC, records the full UUID and surface, sets ownership, then sends the launch
  command and a separate Enter to the owned terminal. Prompt precedes creation.
- Final verification: Node 20.20.2 and Node 26.8.2 each pass all 50 tests;
  package validation, direct installed-bin execution, strict plugin validation,
  and owned tmux/cmux probes pass. Remaining limits are documented rather than
  hidden: Windows process-group degradation, external Kimi read-only sandbox,
  line-oriented handoff input, and advisory butterfly recommendations.
- Follow-up compatibility probe with a temporary failing cmux executable produced
  bounded `status: degraded` diagnostics and a completed file fallback while the
  real tmux probes passed. The temporary executable and state were removed.

- `butterfly-effect-skill` and `hiding-skill` are mature MIT Claude plugins;
  their skill text and references are retained under `skills/` with notices.
- The existing `skills` repository is a useful plugin layout reference, while
  `loop-engine` and `all-local-skills` have no redistribution license and were
  treated as design input rather than copied code.
- Local CLIs are available: Claude 2.1.220, Codex CLI 0.160.0, Kimi 2.1.1;
  tmux 3.6a and cmux 0.64.22. All are optional adapters.
- Claude exposes a print-mode fallback model, but provider-neutral fallback is
  implemented in Omha so Codex and Kimi also participate.
- Canonical Git common roots make worktrees share project memory. `MEMORY.md`
  is an index; topic Markdown is the source of truth. Atomic writes, locks, and
  expected hashes make concurrent updates explicit.
- Omha was selected over occupied npm names; the scoped package is
  `@huatalk/omha`.
