# Security Model and Limitations

Open Arena imports run without providers and store frozen dependencies outside
the input repository. Implementation batches distinguish cooperative same-user
trust from strict external enforcement. Strict writes require a pinned external
executor, a host policy and successful local negative probes; refusal never
falls back to cooperative execution. No OS sandbox is bundled. See
[Open Arena execution and verification boundaries](open-arena.md).

Omha treats provider output, plan text, transcripts and terminal output as
untrusted data. It redacts common credential forms before durable records and
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
kill the owned group. Windows lacks equivalent process-group guarantees in this
release; its documented degradation is fake providers, file handoff and memory.
Kimi's installed CLI has no verified read-only or tool-free flag, so Omha
requires `sandbox: external` for read-only Kimi use and rejects it for blind
planning/voting. Claude and Codex flags are passed explicitly, but users must
review their CLI configuration and permissions.

cmux and tmux resources carry a unique owner token. Omha stores full cmux
UUIDs and uses a private tmux socket. It verifies ownership before capture/send/
close and never discovers or reuses an existing user session. The local probe
script compares cmux workspace IDs before and after. Interactive handoff uses a
raw pipe for line-oriented programs; full-screen terminal protocols can require a
host-native integration.

Prompt injection is not solved by stable prefixes. Stable public context prevents
accidental cache churn and private worker suffixes isolate roles, but users must
review untrusted plans, external content, provider permissions and write tasks.
