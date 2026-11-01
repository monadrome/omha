# Claude Mods Support

Claude Code Mods are the in-process plugin hook layer introduced with Claude
Code 2.1.287: a plugin lists a hooks module in `hooks/hooks.json`, and Claude
Code calls its functions on lifecycle events inside the CLI process. Omha
ships exactly one Mod — the auto-compact controller — and this document is the
single place that records which parts of the Mods API Omha depends on, how
each part is verified, and what is deliberately left to the host CLI.

The runtime contract of the Mod itself (activation, policy, budgets, claims)
lives in [auto compact](auto-compact.md); the decision records are
[ADR 0001](adr/0001-native-auto-compact.md) and
[ADR 0002](adr/0002-compact-evidence-and-recovery.md).

## Version gates

| Gate                      | Requirement | Verified                                     |
| ------------------------- | ----------- | -------------------------------------------- |
| Mods in terminal sessions | 2.1.287+    | Official docs, re-checked 2026-11-01         |
| `idleCompaction` settings | 2.1.290+    | Official settings reference                  |
| Omha activation floor     | 2.1.290+    | `compactCapabilities()` in `lib/compact.mjs` |
| Local live verification   | 2.1.316     | See verification matrix below                |

Mods also run in `claude -p` and Agent SDK sessions (hooks, no drawing).
Omha's Mod registers only for `e.isInteractive && e.surface === 'terminal'`,
so print runs and other surfaces stay prompt-skill only by design.

## The surface Omha uses

`hooks/hooks.json` declares one module, `hooks/register.mjs`, which wires
`hooks/controller.mjs` to the native session. Everything the Mod does outside
its own code goes through the Mods API; the module has no Node built-ins, no
timer globals and no direct file or network access, which is what makes the
surface below enumerable by `claude plugin validate`.

| Mods surface                                  | Omha use                                                             |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `session.start` (`isInteractive`, `surface`)  | Register once per interactive terminal session with the activation   |
| `prompt.submit` (`text`, `attachments`)       | Invalidate timers on new business input; slash commands are excluded |
| `turn.start` / `turn.complete` (`agentId`)    | Main-thread busy/idle tracking; subagent turns are ignored           |
| `turn.step` (`agentId`, result `usage`)       | Correlate each main request; cache-read/creation fields gate arming  |
| `session.compact` (event, `trigger`)          | Deduplicate manual/native/precompute compactions                     |
| `session.end`                                 | Close the durable session account on exit, `/clear`, `/resume`       |
| `$.session.id/cwd/version/model/compact`      | Bind the native session, pass the version gate, invoke compaction    |
| `$.settings.read()`                           | Refuse activation unless effective `idleCompaction` is `false`       |
| `$.agent.list()`                              | Block compaction while subagents or teammates are active             |
| `$.env.get('OMHA_COMPACT_ACTIVATION')`        | Find the activation injected by the settings overlay                 |
| `$.clock.now/after/every`                     | Deadline projection and the 15-second metadata refresh               |
| `$.process.run(['omha','compact','rpc',...])` | The only host channel; stdin JSON in, version 1 envelope out         |
| `$.ui.status`                                 | Bounded user notices                                                 |

Engine-enforced shapes the Mod relies on: `turn.step` results carry the four
API usage counters (`input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`) plus the answering
`model`; `$.session.compact()` resolves to `{ messages }` or `{ skip }` where
each message row is `{ role, text, toolUses }`; `$.agent.list()` statuses
include `idle` and `waiting` on 2.1.289+, which Omha conservatively treats as
unsafe like any non-terminal status.

## What is deliberately not used

- `$.model.complete` (and its new prompt-caching breakpoints): the Mod never
  spends usage. Compaction model work belongs to the native CLI.
- `$.prompt.submit`-as-input or `$.turn.abort`: the Mod never injects text or
  interrupts a turn. It only invalidates its own timers and reports.
- `$.fs`, `$.http`, `$.store`, `$.session.send/append/authorize`: state lives
  in the Omha host ledger, not in plugin storage, so evidence stays append-only
  and auditable outside the CLI process.
- Screen scraping: everything above is structured events or typed calls.

## Verification matrix

| Layer                                              | What it proves                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm test` fake-Mod cycle (Node)                   | Controller state machine, timing, recovery, budgets                                                      |
| `claude plugin test` (`tests/compact-mod.test.ts`) | Real engine loads the module; full register→arm→claim→consume→apply lifecycle against a stubbed host RPC |
| `claude plugin validate --strict`                  | Manifest plus enumerated `hooks:`/`calls:`/env reads                                                     |
| Live 2.1.316 interactive session                   | Real registration in the ledger with zero model requests                                                 |

Run the plugin suite with `claude plugin test` from the repository root. It is
part of the claude-gated checks (like the manifest validations), not the
default offline `npm run check`, because it needs the `claude` binary. The
suite stubs every mods API call, so it never starts a session, signs in, or
reaches a provider.

Live evidence (2026-11-01, Claude Code 2.1.316, scratch activation): a real
interactive session with `--plugin-dir` and the generated settings overlay
produced a `compact.register` ledger event binding the native session ID,
the observed model, the version gate result, effective `idleCompaction:false`
and the owner fingerprint, with no prompt submitted. The session stayed busy,
so refresh RPCs were correctly suppressed, and the status-line bridge caused
no model request. Killing the session left the account open with no replay,
matching the uncertainty contract.

Still not verified live (needs a real working session): a native compaction
through `$.session.compact()`, warm-cache arming from the bridge with real
usage, and cross-session shared budget exhaustion. Until then those paths
carry only offline and real-engine-stubbed evidence, and no cache savings are
claimed.

## Documentation drift notes (2026-11-01)

Re-checked against the official Mods pages (overview, API, reference, events,
test): every API and event Omha uses is still documented and current.
Notable official additions since the original design snapshot:

- The docs split into per-topic pages and Mods now also load in `claude -p`,
  Agent SDK, Desktop and VS Code sessions with surface-specific limits.
- `claude plugin test` ships a stub/mock test kit that runs mods without a
  session or network; Omha adopted it for the suite above.
- `$.model.complete` gained prompt-caching breakpoints (2.1.292+) and its
  result exposes the same cache counters `turn.step` does.
- `session.end` reports a `reason` (`clear`, `resume`, `logout`,
  `prompt_input_exit`, `other`) and also fires on `/clear`, `/resume` and
  `/branch`; Omha's close path treats all of them as session close.
- `$.session.usage()` still returns `{startedAt, context, rateLimits, cost}`
  with no cache fields, so the status-line bridge remains required for cache
  evidence; no change was needed.

## Future opportunities (not implemented)

Adding any of these must go through the same host-boundary rules; a Mod may
observe and propose but the host decides.

- **Input-wait detection for Claude terminals**: the structured
  `prompt.submit`/turn lifecycle already distinguishes pending input from
  busy work, which could replace timeout-based observation for activated
  Claude sessions only.
- **Live execution-channel summaries for Claude**: `turn.step` streaming
  would give Claude the same kind of live event evidence Codex/Kimi get from
  JSONL streams, without touching the native billing channel.
- **Native cross-session messaging**: `$.session.send`/`session.receive`
  overlap with the Omha agent-team mailboxes; a bridge would need the same
  queued/delivered/read evidence rules the cmux message path already enforces.
- **`claude plugin test` in CI**: once a claude binary is available in CI,
  the suite can gate plugin-affecting changes the way `pack:check` does.
