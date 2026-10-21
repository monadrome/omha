# Auto Compact

Omha can compact an explicitly activated Claude Code terminal session while its
one-hour prompt cache is still warm. The default is **57 minutes after the latest
observed cache refresh**, with at least **20%** of the context window used. Both
values are configurable. A working session keeps refreshing its cache deadline.

## Enable

Requires POSIX, Node 20+, an installed `omha` on PATH and Claude Code 2.1.290+ with Mods
enabled. Old Claude versions and sessions without activation keep ordinary prompt
skills; they do not run this maintenance. No component installs or upgrades tools.

Add this root-level block to your version 1 provider configuration:

```json
{
  "maintenance": {
    "autoCompact": {
      "enabled": true,
      "profile": "claude",
      "afterMinutes": 57,
      "minContextPercent": 20,
      "minIntervalMinutes": 10,
      "minRemainingSeconds": 30,
      "maxCompactionsPerSession": 8,
      "bridgeStatusLine": true
    }
  }
}
```

The profile must be an existing Claude profile whose command is the bare
`claude` command. It supplies maintenance admission budgets and concurrency;
its headless sandbox and model options are not silently imposed on the native
session. The native CLI keeps its normal permissions, authentication and billing.
Set its model or other ordinary CLI options explicitly in `--args` when needed.

```bash
omha compact start --config .omha/providers.json
omha compact start --config .omha/providers.json --args '["--model","sonnet"]'
omha compact status
omha status
```

`start` checks the installed version without a model request, creates a bounded
activation record and settings file, then starts a normal interactive `claude`
process in the calling terminal. It injects this same `omha` plugin and a single
session settings overlay with `idleCompaction:false` and the cache bridge.
It never disables normal context-threshold compaction or its safety hooks.

The existing user, project and project-local status-line command is preserved;
`--input settings.json` can supply an additional Claude settings overlay. No
global settings are rewritten. Managed overrides still take precedence; the Mod
checks the effective idle setting and refuses activation if it remains enabled.
The overlay is stored in Omha state and rejects known credentials, so credentials
belong in the native CLI's existing credential store, not this input.

For a launcher you control, `omha compact setup --config providers.json` returns
`command`, argv, activation ID and settings path without launching a provider.
Use the returned settings and plugin argv together. `setup --input settings.json`
preserves the statusLine from that input; unlike `start`, it does not discover
the existing user's status-line settings. An already-running session cannot be
activated by simply registering it: start a session with this explicit overlay.

## Configuration

| Field                      | Default  | Bounds                                                 |
| -------------------------- | -------- | ------------------------------------------------------ |
| `enabled`                  | `false`  | Boolean                                                |
| `profile`                  | `claude` | Existing Claude budget profile                         |
| `afterMinutes`             | `57`     | Integer 1-59                                           |
| `minContextPercent`        | `20`     | Number 0-100, inclusive threshold                      |
| `minIntervalMinutes`       | `10`     | Integer 0-1440; since any confirmed applied compaction |
| `minRemainingSeconds`      | `30`     | Integer 1-3599                                         |
| `maxCompactionsPerSession` | `8`      | Integer 1-32                                           |
| `bridgeStatusLine`         | `false`  | Explicit opt-in required for execution                 |

`afterMinutes * 60 + minRemainingSeconds` must be below 3600. Unknown fields,
invalid higher-priority configuration, incompatible profiles and timing windows
fail closed. Changing or disabling the frozen policy blocks the old activation;
create a new activation to apply a new policy. It does not clear the old account.

The bridge uses Claude's structured `prompt_cache` and `context_window` data;
it does not scrape the screen. It chains the original status-line command with
the same JSON input, stdout/stderr and exit code, bounded to five seconds and
256 KiB output. An empty status line renders no extra text. Custom status lines
can replace Claude footer hints even if their output is empty, so bridge opt-in
also opts into that UI behavior. Missing cache data never starts a model request.

## Timing And New Input

Only an observed one-hour cache is eligible. Five-minute TTL, missing usage,
expired cache, unknown context, busy sessions, active background agents and
pending input all prevent execution. Context uses input + cache read + cache
creation tokens divided by window size, without percentage rounding or a paid
token-count request.

```text
10:00:00  Cached request, original evaluation at 10:57:00
10:53:00  New business input accepted; old timer/unused claim immediately invalidated
10:53:20  Its request refreshes the cache; new evaluation at 11:50:20
10:58:00  Answer finishes; this does not extend the cache deadline
```

The same rule applies after minute 53 until the native invocation is submitted.
Input alone does not prove a cache refresh. Failed/cancelled requests without
fresh evidence never restore the old schedule. Each main request is correlated
with input revision, a request-start timestamp and the bridge request counter;
older snapshots cannot replace new evidence. Provider timestamps have seconds
precision, so request matching allows at most one second of rounding, while the
execution guard leaves at least the configured remaining time.

The Mod cancels old callbacks locally before waiting for CLI communication.
Every claim is checked again under the host lock and binds the current cache,
input, work and compaction versions. A 15-second local metadata refresh lets an
asynchronous bridge update re-arm a timer; it never sends a model prompt.
At the deadline it checks again and calls the native API, not text `/compact`.
Busy/unknown states and misses of the execution window do not cause cold replay.

## Deduplication And Recovery

Applied manual, native and Omha compactions share a business boundary. Without
new normal main-thread requests after that boundary, no further automatic compact
is allowed, even if the summary still occupies more than 20%. Status commands,
timer callbacks and compaction's own model work do not count as new business.
Precomputed summaries are tracked separately and do not masquerade as applied.

RPCs use stdin JSON (`omha compact rpc --input -`) and a version 1 JSON response.
Registration binds native session, real cwd, activation, OS user, caller PID and
process-start fingerprint to a fresh owner token. Reload preserves revisions and
accounts, invalidates cached evidence and unconsumed claims, and requires new
business evidence. A live different process cannot steal the session.

`claim` is a two-second PREPARED proposal with no spend. `consume` atomically
revalidates it, reserves shared/profile and session budgets, checks concurrency,
and persists invocation intent before a native call is permitted. A token is
one-use. A lost consume response or process crash leaves uncertainty, never an
automatic second invocation. `finish` requires the matching intent and records
applied, skipped, failed or unknown. Skip/failure also consume one submitted attempt.

Execution uncertainty and unknown usage are separate. Confirmed native completion
can release the execution gate while retaining the unknown-cost reservation.
Unresolved execution keeps the gate closed; automatic replay is not supported.
RPC failure stops the local controller and shows one unavailable notice rather
than retrying a potentially spent request. Session shutdown cancels local timers.

The stable native-session account persists across registration, reload and resume.
Profile budgets aggregate all compact sessions in the same Omha state directory.
These are maintenance admission limits, not a proxy for provider billing or a
hard cap on internal model turns. Native model identity is recorded as observed;
actual served model and unknown usage remain unknown. There is no zero-budget
fallback and no switch from subscription to an API channel.

The ledger is hash-chained, append-only and serialized with existing storage
locks. It holds only metadata, bounded counters and version/hash evidence, not
prompts, tool outputs or summaries. There are at most 32 retained activations,
32 retained sessions, 10,000 events and 32 MiB of audit data per state directory;
exhaustion refuses new mutations instead of truncating audit history. There is
no automatic deletion/reset of charged accounts. The same OS user is trusted,
as with existing Omha storage and terminal ownership.

## Verification And Context

Offline tests exercise policy refusal, exact timing/context boundaries, minute-53
rescheduling, stale callback rejection, manual/precomputed compaction, native
failure, reload, uncertainty, budgets, settings changes and a complete fake Mod
event cycle. Packaging checks include the installed CLI/API, hook files, plugin
discovery and prompt-skill availability without running a model.

The local Claude 2.1.220 parser can validate the hooks envelope with `hooks:{}`
and `modules`, but cannot verify the supported runtime. Real Mod loading,
effective provider cache behavior and native compaction on 2.1.290+ remain a
live verification prerequisite; no cache savings or real model correctness is
claimed from offline fixtures. Unsupported or absent APIs stop maintenance.

- [ADR index](adr/README.md): short accepted/rejected decisions.
- [Original design](auto-compact-design.md) and [review](auto-compact-review.md):
  historical design context; this document describes the implemented contract.
