# Research findings

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
