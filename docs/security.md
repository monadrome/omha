# Security Model and Limitations

Open Arena imports run without providers and store frozen dependencies outside
the input repository. Implementation batches distinguish cooperative same-user
trust from strict external enforcement. Strict writes require a pinned external
executor, a host policy and successful local negative probes; refusal never
falls back to cooperative execution. No OS sandbox is bundled. See
[Open Arena execution and verification boundaries](open-arena.md).

Omha treats provider output, plan text, transcripts and terminal output as
untrusted data. It redacts common credential forms before durable records,
including allowlisted secret values in literal and JSON-escaped output, and
rejects credentials and raw transcripts in shared memory. It does not inspect or
rotate credentials already stored in provider CLIs.

State files are private (`0700` directories and `0600` files), use no-follow
opens, reject null bytes/path escapes/symlinks/hardlinks, write through fsync plus
rename, and use ownership-bearing locks. Stale recovery only removes a lock when
the recorded process is dead on the same host. A process with the same OS user
and write access to `OMHA_HOME` can still alter state; this is not a hostile
multi-user service.

Provider environment variables are allowlisted by name. The allowlist can expose
a secret to a child process by design; the secret value is never included in the
provider prompt or persisted metadata. Provider CLI configuration and model
billing remain outside Omha's control. Budget reservations prevent admitted
work from exceeding configured local limits, but they cannot predict provider
pricing when usage is unavailable.

POSIX native workers run in a detached process group and cancellation/timeout
kill the owned group. Windows is not supported.
Upstream Kimi has no qualified read-only or tool-free flag, so Omha requires
`sandbox: external` for its read-only use and rejects it for blind planning/voting.
A trusted personal Kimi executable can opt in with `kimiProtocol: "kimi-personal/1"`.
Its native read-only tool set omits Bash, Write, Edit and other mutating tools;
tool-free omits every model tool and autonomous Goal continuation. Omha passes
the mode explicitly and rejects missing or mismatched protocol evidence. These
are model-tool restrictions, not an OS sandbox: Kimi still writes its own
configuration/session logs, and a substituted or malicious executable can lie.
Personal Codex tool-free routing requires the explicit `codex-personal/1`
profile contract and a fork-only CLI flag. The host passes an empty startup tool
ceiling plus single-turn mode and verifies matching runtime evidence. Unknown
upstream config keys such as `tools.shell=false` are not an enforcement boundary.
The configured executable remains trusted; it can still write its own logs and
session metadata. Personal Codex read-only workers also receive an allowlist of
sandboxed local reads and native control tools, excluding MCP, connectors,
subagents, patching and escalation. Code Mode composes only the same permitted
tools. Startup evidence is checked against that ceiling; the read-only filesystem
sandbox still constrains terminal commands. Goal completion never replaces host acceptance or review.
Kiro read-only passes an empty `--trust-tools=` list: the non-interactive CLI
denies writes, shell and other untrusted tools, but auto-approves its built-in
reads, so Kiro is never tool-free. The host rejects a read-only result whose
stream shows a completed non-read tool call; that detects rather than undoes a
change made by a substituted or misconfigured executable. Kiro write profiles use
`--trust-all-tools` with no workspace confinement. Global Kiro hooks, steering and
agent settings still apply.
Use an external sandbox when OS enforcement is required. Claude and Codex flags
are also passed explicitly; review executable provenance, CLI configuration and
permissions for every adapter.

cmux and tmux resources carry a unique owner token. Omha stores full cmux
UUIDs and uses a private tmux socket. It verifies ownership before capture/send/
close and never discovers or reuses an existing user session. The local probe
script compares cmux workspace IDs before and after. Interactive handoff uses a
raw pipe for line-oriented programs; full-screen terminal protocols can require a
host-native integration. tmux activity reports bind to a live worker and child,
but the reported provider state remains caller-reported and stale/unknown states
are not eligible for recovery input.

Prompt injection is not solved by stable prefixes. Stable public context prevents
accidental cache churn and private worker suffixes isolate roles, but users must
review untrusted plans, external content, provider permissions and write tasks.
