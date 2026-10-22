# Agent Tab Connection Recovery

`omha auto-recover` detects local cmux agent tabs or registered owned tmux workers that stopped after a provider
connection failure and submits one bounded `go on` message to the affected
surface. It is a terminal observer, not a provider retry layer: it does not
change profiles, models, billing channels or provider configuration.

```bash
# One read-only pass across every local terminal tab
omha auto-recover check

# Recover once, then inspect persisted state
omha auto-recover --allow-send
omha auto-recover status

# Run in its own cmux workspace, every 25 minutes
omha auto-recover --watch --allow-send --interval-ms 1500000
```

`--allow-send` is required for any input. Without it the command only reports
what it found, which makes `check` safe on a live workspace. `--message` changes
the submitted text (one line, at most 1 KiB); the default is `go on`.

## Discovery

The default `--backend auto` prefers cmux. If cmux discovery is unavailable,
it falls back to Omha-owned tmux workers in the current worktree. Explicit
`--backend cmux` or `--backend tmux` disables fallback. A healthy empty cmux
catalog does not imply failure. Ownership errors never trigger fallback, and
input failure never moves the action to another backend. Reports retain
`requestedBackend`, `backend` and `backendAttempts`.

tmux discovery uses existing handoff records, a private socket, fixed pane ID
and owner token. Recovery input requires a worker-bound idle activity signal
from `handoff activity`, at most one minute older than the larger of the watch
interval and 25 minutes; a signal authorizes at most one submission.
Unknown, stale or consumed signals remain report-only. A busy process cannot
be inferred to be idle from a quiet pane or an error string. No arbitrary user
session is adopted. See [terminal backends](terminal-backends.md) for integration.

Every pass merges two structured cmux projections: `current` for registered
agent sessions and `surface ls` for the surface/workspace catalog. Only local
terminal resources are inspected. Markdown, browser, simulator and remote
surfaces are out of scope in this iteration.

Tabs are never selected by title alone:

- A tab with a live (`idle`) Claude/Codex agent is eligible for recovery.
- A tab with a `working` agent is reported as `busy` and is never injected into.
- A tab with no registered agent or only `ended` sessions is still inspected and
  reported (`detected`) but receives no input. Missing hook metadata is not proof
  that a tab is a plain shell.
- Duplicate projections of one surface are collapsed.

## Failure Classification

The current screen viewport is read with `read-screen`; no scrollback is used.
Only the last 12 non-empty lines are classified by default, so an error above
newer successful output is ignored. Stored evidence contains the matched reason,
category and a bounded line excerpt, never the full screen, transcript or
environment.

| Category     | Examples                                                              | Action                 |
| ------------ | --------------------------------------------------------------------- | ---------------------- |
| `connection` | stream disconnected, provider overloaded, 5xx upstream, network reset | submit `go on`         |
| `rate_limit` | 429, too many requests, rate limited                                  | submit `go on`         |
| `retrying`   | reconnecting, retrying in Ns                                          | none; wait for the CLI |
| `auth`       | 401/403, invalid API key, permission denied                           | none; report `blocked` |
| `quota`      | insufficient quota, credit balance, payment required                  | none; report `blocked` |

Sending `go on` to an auth or quota failure cannot succeed and is deliberately
refused. A tab whose client is already retrying is also left alone. The
classifier prefers the bottom-most matching line, so a retry notice below an
error wins.

## Bounds

- **Cooldown:** the default is 10 minutes per surface. A pass that starts before
  the cooldown reports `cooldown` and sends nothing.
- **Attempts:** at most 6 consecutive submissions per surface and failure reason.
  After that the surface reports `stalled` until the error clears or a different
  failure category appears. Reaching `idle`/`ok` resets the counter.
- **Submission:** persist a pending claim before `send`, wait 250 ms, then `send-key Enter`.
  A crash or uncertain send leaves the claim stalled rather than retyping. If `Enter` fails, the text
  may remain in the input box; the surface is reported as `enter_failed` and is
  never retyped.
- **Verification:** after 1.5 seconds the screen is read again. Recovery is
  `verified` only when the screen changed and the submitted text appears near
  the tail. Otherwise the result is `sent_unverified` and the same cooldown and
  attempt bounds apply.
- **Single writer:** a lock under the Omha state directory prevents concurrent
  passes or watchers from submitting duplicate input.

## State and Events

State lives under `$OMHA_HOME` (or the platform XDG state path) in
`auto-recover/`:

- `state.json` records per-surface status, reason, attempt count, cooldowns and
  the last pass summary.
- `events.jsonl` is append-only and records `auto_recover.pass`, `detected`,
  `detected_unregistered`, `sent`, `uncertain`, `cooldown`, `blocked`, `stalled`
  and `recovered` transitions.
- `auto-recover.lock` is held by the active pass or watcher.

`omha auto-recover status` returns the persisted state plus the last 50 events.
`omha auto-recover list` returns the discovered tabs without reading screens.

## Watch Mode

`--watch` runs the first pass immediately, then waits `--interval-ms` (minimum
one minute, default 25 minutes). The default stays inside the common 30-minute
provider KV-cache lifetime, so a recovered turn can still reuse the cached prompt.
Backend and timeout failures are reported and retried on the next interval; invalid
options, corrupt state and unsafe paths stop the watcher. JSONL output is available
with `--json`.

The watcher is CLI-only. A prompt skill cannot hold a durable timer, deduplicate
sends across passes or prove that a surface is an idle agent tab, so
[the plugin guide](plugin.md) points here instead of installing an unconditional
hook.

## Security and Limits

This is the screen-scraping fallback permitted by the project invariants: cmux
does not expose provider stream errors structurally, so the current screen is the
only signal. The command never launches a provider, never changes provider
configuration and never sends credentials. It types only into local cmux agent
surfaces with `idle` state and a classified recoverable failure. It cannot prove
that a submitted continuation is semantically correct, restore files or certify
task completion.

Offline verification: `tests/auto-recover.test.mjs` covers detection, busy and
unregistered tabs, auth/quota blocking, client-owned retries, stale errors,
cooldown, attempt exhaustion, raw-screen exclusion and an installed-fixture CLI
pass. No test calls a metered provider.
