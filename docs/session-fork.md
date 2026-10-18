# Session Fork v1

Session Fork creates two to eight isolated provider requests from one sealed,
byte-identical host prefix. It is a bounded projection of the Open Arena engine,
not provider-session cloning and not a second executor.

```bash
omha fork run --cwd /repo --input execution.json \
  --config providers.json --allow-write [--name readable-id]
omha fork status --id TREE_ID
omha fork tree --id TREE_ID
omha fork cancel --id TREE_ID
omha fork resume --id TREE_ID
```

`create` is an alias for the atomic create-and-run operation. There is no durable
unstarted tree: this avoids reserving workspace ownership without budget and
execution evidence. The JavaScript API exports `runFork`, `forkStatus`,
`forkTree`, `cancelFork` and `resumeFork`.

## Capability boundary

| Claim                                                                                    | Owner          | v1 status                                           |
| ---------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------- |
| `context.md` bytes and SHA-256 are identical for every child                             | Omha host      | verified before every dispatch                      |
| role, name, workspace and branch instructions occur after the prefix                     | Omha host      | verified and hashed                                 |
| workspace, owner token, HOME, TMPDIR, XDG cache, OMHA_HOME and memory state are separate | Omha host      | verified by Arena state/tests                       |
| provider saw the CLI string unchanged                                                    | adapter/CLI    | assumption unless provider exposes request evidence |
| hidden provider system prompt and tool schema are identical                              | provider CLI   | unknown                                             |
| provider KV/prompt cache was read or written                                             | provider usage | verified only when explicit usage fields exist      |
| a successful process produced a correct change                                           | nobody         | false; host checks and review remain separate       |

`prefixHash` proves host input equality only. It never proves a cache hit. Cache
status is `hit` only for a positive reported cache-read count, `miss` only for an
explicit zero read, and `unknown` when the field is absent or execution is
interrupted. A cache read still consumes token/rate-limit budget.

## DAG and persistence

The state uses schema version 1 under `OMHA_HOME/arena/batches/<treeId>`:

```json
{
  "tree": {
    "version": 1,
    "treeId": "uuid",
    "name": "kv-fork-2c91aa",
    "label": "KV fork",
    "root": {
      "nodeId": "uuid-root",
      "parentId": null,
      "kind": "root",
      "sealed": true,
      "forkPoint": { "type": "message-boundary", "bytes": 1234 },
      "prefixHash": "sha256",
      "prefixBytes": 1234,
      "model": "requested-model",
      "systemHash": "sha256",
      "toolsHash": "sha256",
      "workspaceSnapshot": {},
      "cache": { "epoch": null, "ttlMs": null, "expiresAt": null, "status": "unknown" },
      "pendingToolCalls": 0,
      "pendingApproval": false,
      "backgroundProcesses": false
    }
  }
}
```

Each child records `nodeId`, `parentId`, `name`, `label`, `role`, ordinal,
requested/served profile and model, isolated workspace/session/owner, prefix,
suffix and full-prompt hashes, status, per-attempt raw and normalized usage,
cache evidence and artifact digest. The exact prefix is `context.md`; each exact
suffix is `suffixes/<candidate>.txt`.

`fork.tree.created`, `fork.node.created`, `fork.node.prompt_sealed` and
`fork.root.cache` are append-only events. Status and resume compare immutable
event digests, files and state. A missing/unsealed parent, pending tool call/approval/background process,
changed prefix, changed suffix, changed prompt, owner drift or changed bundle is
an integrity failure. A changed prefix means a new tree; no node is edited into a
different parent. Resume reports sealed results and terminalizes uncertain
writes without replay, matching Arena recovery.

## Naming

Names are generated locally without a model call. A branch defaults to:

```text
<objective-slug>-<role>-<ordinal>-<identity-hash>
```

Examples: `kv-fork-implement-1-7c2a` and
`kv-fork-implement-2-91be`. Names match
`[a-z0-9][a-z0-9-]{0,47}`. Unicode-only objectives fall back to `fork`;
slashes, traversal, punctuation and repeated separators normalize to `-`.
`--name` changes the tree base. Per-branch `name` and `label` are accepted in
`contenders[]`; duplicate normalized names fail before provider launch. Labels
retain readable Unicode and are bounded to 256 characters.

The hash derives from the frozen tree id, prefix and branch identity. Persisted
nodes keep the same name on resume. Names appear in events, state/status/tree,
session ids, completion evidence and review packets. Native headless execution
does not create a cmux/tmux handoff; a future terminal projection must use this
same safe name and owner token rather than generate another identity. Names are
metadata/suffix data and never enter the shared prefix.

## Scheduling, cache lifetime and cost

`contenders` is bounded to 2-8 and `parallelism` to 1-N. The host preflights a
reservation for every child against shared and per-profile budgets before it
creates the tree. Batches are admitted in `parallelism`-sized groups, while the
existing `ProviderRuntime` also enforces provider concurrency, circuit, timeout
and reservation settlement. Fork disables retry/fallback exactly as Arena does,
so every child has one attributable attempt.

`warmFirst` executes the first already-budgeted child before the remaining
fan-out. It never sends an extra metered warming request. This can reduce an
implicit-cache stampede, but it cannot guarantee a cache write or hit. It
defaults to `true` for three or more branches and `false` for two; an explicit
`warmFirst:false` restores immediate fan-out within the bounded groups. The
effective mode is recorded as `scheduling: 'warm-first' | 'parallel'` on the
`fork.tree.created` event.

When the warm child reports a positive cache-creation count in its usage, the
root cache evidence upgrades to `status: 'write-reported'` with `epoch` set to
the observed write time, persisted through a `fork.root.cache` event. TTL and
expiry stay `null` because usage carries no verifiable lifetime. A failed warm
child, missing usage or a zero count keeps `unknown`. Status and resume require
any non-baseline root cache record to match its event digest. Provider TTL,
cache epoch and expiry otherwise remain `null` unless the provider reports a
verifiable value. An expired/evicted cache remains an ordinary charged request.
Unknown or estimated usage retains the original reservation; cache evidence
never refunds admission budget.

## Isolation, roles and review

Every implementation branch receives a fresh clone at the same base commit and
separate runtime directories and owner token. Cooperative mode documents its
same-OS-user limitation. Strict mode gives the external executor every sibling
workspace in `deniedRead` and runs existing negative probes. Missing enforcement
fails closed.

Fork v1 accepts only the `implement` role because its lanes are write attempts.
A read-only profile requested for a write lane is rejected before reservation.
Independent automated review remains the Leader lifecycle: it excludes all
actual author profiles, requires headless/tool-free/read-only capability and
reads only frozen diff/test/acceptance evidence. Arena review packets now carry
fork node names and sealed artifacts. Treating a simultaneous write lane as a
reviewer would violate author independence, so v1 rejects that shortcut.

## Provider usage matrix

| Provider shape                                                                      | Normalized evidence                                   | Confidence                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| Anthropic/Claude `cache_creation_input_tokens`, `cache_read_input_tokens`           | creation/read                                         | verified parser contract                            |
| OpenAI-compatible `prompt_tokens_details.cached_tokens` and available write aliases | read/write                                            | verified parser contract; vendor semantics may vary |
| DeepSeek `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`                      | read/miss                                             | verified parser contract                            |
| Kimi stream JSON                                                                    | known aliases when present; all other fields in `raw` | open question for installed CLI version             |
| missing/partial/interrupted usage                                                   | null counts and `unknown`                             | fail-closed                                         |

All original usage fields are retained in `usage.raw`. Normalized evidence is
stored per attempt/node; the tree sums known counts but reports overall
`unknown` if any child lacks cache status. Requested and served model/profile
remain separate.

## Failure behavior

| Failure                                               | Behavior                                                  |
| ----------------------------------------------------- | --------------------------------------------------------- |
| prefix bytes/hash differ                              | reject dispatch with integrity error                      |
| parent unsealed or pending work exists                | reject fork                                               |
| provider route/model differs between children         | reject before tree creation                               |
| read-only profile requested for write                 | reject before reservation                                 |
| branch count outside 2-8, bad role or duplicate name  | reject                                                    |
| shared/per-profile budget cannot reserve all children | reject all; launch zero                                   |
| concurrency unavailable                               | bounded queue/timeout through `ProviderRuntime`           |
| cache field absent or process interrupted             | `unknown`; reservation retained                           |
| root cache record without a matching event digest     | integrity failure on status/resume                        |
| one child fails                                       | retain its evidence and continue unaffected siblings      |
| host crashes                                          | no automatic write replay; sealed artifacts survive       |
| cancellation                                          | kill only fingerprint-owned processes and retain evidence |

## Reuse map

- `lib/fork.mjs` is only an API/CLI facade.
- `lib/arena.mjs` remains the sole lane executor, ledger, artifact and recovery
  implementation.
- `lib/runner.mjs` remains the sole provider admission/concurrency/budget path.
- `lib/adapters.mjs` owns provider-specific usage normalization.
- `lib/orchestrator.mjs` remains the task DAG and independent automated-review
  lifecycle; Session Fork does not duplicate it.
- `lib/terminal.mjs` and `lib/backends.mjs` remain owned handoff transports and
  do not claim provider session or KV cloning.
- `lib/roundtable.mjs` remains the blind-vote protocol.

The specialized `omha arena` surface remains compatible. `omha fork` tightens
that same engine with a common provider route/model and full fan-out reservation;
it does not introduce overlapping execution semantics.
