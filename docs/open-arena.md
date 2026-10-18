# Open Arena Content and Independent Implementations

Open Arena is a knowledge boundary. Its import does not grant execution
permission. Omha maintains three separate records: a frozen knowledge
package, an independently authorized execution specification, and artifacts with
host verification and review evidence. Business invariants and non-goals belong
in `OPEN_ARENA.md`; commands, scheduling and acceptance criteria belong in the
execution specification.

## Import a Knowledge Package

```sh
omha arena import --source /absolute/knowledge-package \
  --input knowledge-metadata.json --cwd /absolute/source-repository
omha arena knowledge --id KNOWLEDGE_DIGEST
```

The directory contains `OPEN_ARENA.md` and `references/`. Every imported file
requires source provenance. Local Markdown links must resolve within that
inventory. HTTP citations remain citations and are never fetched. Links,
hardlinks, non-text input, missing dependencies and oversized packages are
rejected. The importer writes only under `OMHA_HOME/arena/knowledge/`, which
must be outside the source repository. It starts no planner, provider or terminal.

Metadata is supplied separately so existing Open Arena documents need no rigid
heading or frontmatter migration:

```json
{
  "version": 1,
  "authority": {
    "requirementId": "issue-123",
    "generatedAt": "2026-10-10T12:00:00.000Z",
    "worktree": "logical-source",
    "branch": "main",
    "baseline": "recorded-baseline",
    "revision": "recorded-authoritative-revision",
    "sourcePrecedence": ["current user instructions", "current source", "history"]
  },
  "sources": [
    {
      "path": "OPEN_ARENA.md",
      "origin": "reviewed-domain-document",
      "snapshotAt": "2026-10-10T12:00:00.000Z",
      "revision": "recorded-authoritative-revision",
      "status": "current"
    },
    {
      "path": "references/domain.md",
      "origin": "prior-domain-document",
      "snapshotAt": "2026-10-10T12:00:00.000Z",
      "revision": "prior-revision",
      "status": "historical"
    }
  ],
  "evidence": [
    {
      "id": "deployment-gap",
      "label": "Unresolved",
      "path": "references/domain.md",
      "quote": "Deployment has not been verified."
    }
  ],
  "semanticReview": {
    "status": "approved",
    "by": "human-reviewer",
    "source": "recorded-review-reference",
    "at": "2026-10-10T12:00:00.000Z",
    "knowledgeOnly": true,
    "noEvidencePromotion": true
  }
}
```

`sources[].status` is `current`, `historical` or `unresolved`; `revision` can be
`null` when unknown. Optional `rawHash` pins the submitted source bytes.
Evidence labels are `Current authoritative fact`, `Historical evidence`,
`Supported conclusion`, `Hypothesis`, `Unresolved` and `Non-goal`. Quotes must
exist in frozen content. Unresolved sources cannot become supported conclusions;
current facts require current sources. All labels are retained without forcing a
document to make a claim in every category.

The semantic review is a recorded human/host attestation, not a regex proof.
Use `status: "unresolved"` when that review is absent; import remains available
and implementation execution is refused. A review must separately establish that
the text contains no next operation, role, execution order or completion gate and
does not promote hypotheses. Metadata hashes establish integrity, not truth.

The manifest pins the external Open Arena 0.1.0 contract revision and SHA-256,
portable file paths, raw and sanitized hashes, source status, review source and
public context hash. No external skill installation or network fetch is needed.
Credentials matching the shared scanner or known secret environment values are
rejected. Explicit `--secret-policy redact` freezes sanitized copies while
preserving original hashes; original documents remain unchanged. Secret scanning
requires review of opaque credentials beyond the scanner's known forms.

Import limits: 128 files, 256 KiB per file, 1 MiB document bytes and 1 MiB metadata.
Reuse verifies both frozen files and original source hashes/inventory. Changed or
missing originals require a new import; there is no live-memory substitution.
`readOpenArena(id).context` can be supplied to the existing string `publicContext`
API. Existing leader and roundtable contracts remain compatible.

## Run Two Independent Implementations

```sh
omha arena run --cwd /absolute/source-repository \
  --input execution.json --config providers.json --allow-write
omha arena status --id BATCH_ID
omha arena cancel --id BATCH_ID
omha arena resume --id BATCH_ID
omha arena review --id BATCH_ID
omha arena review-record --id BATCH_ID --input human-review.json
```

`runArena(cwd, specification, { config })` is the API equivalent. A specification
has these version 1 fields; `validateArenaSpec()` is the executable contract:

| Field              | Required Value                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `authorization`    | Independent `{by, source, at}` execution authority                                                        |
| `objective`        | Authorized implementation objective                                                                       |
| `knowledgeId`      | Imported knowledge digest                                                                                 |
| `bundle`           | Absolute path, SHA-256, base commit/tree, approved refs, complete sorted object IDs, forbidden object IDs |
| `contenders`       | 2-8 write profiles; optional suffix-only `role`, `name`, `label` and `suffix`                             |
| `allowedPaths`     | Relative files/directories; `"."` authorizes the entire clone                                             |
| `securityMode`     | Explicit `cooperative` or `strict`                                                                        |
| `deadlineMs`       | Overall preparation, implementation and verification deadline                                             |
| `attemptTimeoutMs` | Each lane's admission/execution deadline, at most the overall deadline                                    |
| `parallelism`      | 1-N, bounding implementations and verification together; optional `warmFirst` orders the first lane       |
| `budget`           | Explicit shared runtime admission budget                                                                  |
| `verification`     | Independent authority plus an array of fixed host criteria                                                |

The bundle is limited to 16 MiB, self-contained and verified in an empty host
repository. `allowedRefs` is a sorted array of `{ref, commit}`. `objectIds` lists
every packed object, including unreachable extras; incomplete or unapproved
inventories and any `forbiddenObjectIds` are rejected. This establishes the
approved Git input set. Its semantic exclusion of reference answers requires the
input reviewer. The original source may contain additional history; each lane
clones only this frozen bundle, retains no source remote or Git alternates, and
starts at the same base commit. Git SHA-1 repositories and POSIX are supported.

Every lane calls `ProviderRuntime.attempt()` once. Profile retry/fallback policies
are never invoked. The shared host runtime persists reservations before launch,
settlements, process fingerprints, events, workspace ownership, physical IDs and
logical source identity. Each attempt gets a separate HOME, TMPDIR, cache,
`OMHA_HOME` and memory session; credentials require explicit environment
allowlisting. Provider CLI configuration under the original HOME is not inherited.
The final UTF-8 prefix is identical across lanes. Workspace paths, objective and
execution instructions appear in the suffix; live memory is never injected.

The budget counts CLI attempts rather than internal model turns. The host ledger
distinguishes admitted reservations, reported usage, estimates/unknown usage and
active commitments. Unknown usage retains its reservation; recovery launches no
model requests and never refunds uncertain cost. A breach blocks further
admission and aborts active lanes. Actual provider bills remain outside this
admission model. Cache is `unknown`; no cache saving is assumed.

`resume` validates knowledge, spec, configuration, bundle, ownership, artifact and
harness hashes. It preserves sealed outputs, marks unsealed writes `interrupted`,
records missing verification as `unknown`, attempts fingerprint-checked cleanup
and retains workspaces and reservations. It starts no new attempts or harnesses.
A separately authorized new batch can use the same frozen inputs. Cancellation
is durable and preserves partial evidence. Host fsync/Git collection is bounded
but synchronous; absolute deadline checks prevent late provider admission, while
process deadlines and signals govern active native processes.

## Artifacts and Host Verification

A criterion contains `id`, absolute `command`, `args` including the exact
`"{harness}"` placeholder, absolute `harnessPath`, `harnessHash`, and `timeoutMs`.
The approved harness is frozen outside the provider workspace and runs against a
fresh materialization of the sealed candidate. It must use audited local
dependencies and commands. Omha performs no dependency installation.
An empty criteria array produces explicit missing verification evidence.

Full file inventories capture already committed changes, untracked/ignored files,
binary bytes, modes and deletions. The host constructs the candidate Git tree and
binary-capable patch against the fixed base, independently of the provider's
index/configuration. Limits are 4,096 files, 1 MiB per file and 8 MiB total.
Symlinks, hardlinks, special files, submodules, LFS pointers and oversized payloads
remain uncertified. Snapshots retain original bytes in base64; patches retain raw
bytes with an explicit UTF-8/base64 transport encoding. Truncation or omission
cannot silently certify an artifact.

Verification records bind a criterion, candidate tree, harness digest, command,
environment/toolchain summary, exit/signal/timeout and log digest. Provider prose
is an agent self-report. Only a fixed host observation can yield a criterion
`pass` or `fail`; interruption, output limits or a harness that changes candidate
files yield `unknown`. Test success has its stated scope and does not establish
deployment or root-cause correctness.

Batch reports retain every terminal state and default to `selected: null`, no
merge, multiple retained outputs and zero model reviews. `arenaReviewPacket()`
creates an anonymous packet only after all lanes are terminal. Private profile,
model, process, author and usage data stay in host state. Known explicit identity
leaks are rejected; code style may still imply an author. Packet/file/line hashes
and bounds are checked by `validateArenaReview(packet, review)`; unknown
candidates and stale anchors are rejected. Review records require their own
`authorization: {by, source, at}` and `assessments`; an assessment binds
`candidateId`, `criterionId`, `artifactDigest`, `result` and `anchors`, with optional
confidence, reason, risks and tradeoffs. File anchors use `{path, hash}` and log
anchors use `{criterionId, hash}`; optional `line`/`quote` pins an exact text line.
Binary evidence uses a whole-file hash anchor. Review remains advisory and never
applies code or promotes an opinion into a host test result.
`recordArenaReview(batchId, review)` persists a validated, independently authorized
review with packet/digest provenance and launches no model calls.

## Strict Execution

Cooperative execution is trusted host collaboration and does not prevent reads
by the same OS user. Strict mode requires an independently approved external
write executor; there is no automatic downgrade or bundled container dependency.

A strict profile uses `sandbox: "external"`, `sandboxWrite: true`, an absolute
`sandboxCommand`, and `sandboxArgs` containing exact `{policy}`, `{command}` and
`{args}` entries. The wrapper receives a host policy JSON and must enforce the
read/write allowlists, source/sibling/state/original-HOME/reference denials,
network denial, isolated provider configuration and background-process
containment. Its executable SHA-256 is pinned in specification `isolation`,
alongside separate `{by, source, at}` authority, approved absolute
`readOnlyPaths` and `excludedPaths`.

Before any provider reservation, actual local, credential-free Node probes test
an allowed write, forbidden directory/file reads, an outside write and connection
to a local host TCP listener. Missing capabilities, unknown probe results or any
violation refuse strict execution. The same wrapper covers host verification.
These probes validate specific observations; executor containment still requires
an audited implementation and platform validation, especially for escaped
processes and wrapper dependencies. The offline suite validates refusal with an
unenforced local wrapper. It does not claim a working OS sandbox or a real
provider/cache/billing experiment.

## API Surface

Exports from `index.mjs`: `importOpenArena`, `readOpenArena`, `ARENA_LABELS`,
`ARENA_CONTRACT`, `validateArenaSpec`, `runArena`, `arenaStatus`, `cancelArena`,
`resumeArena`, `arenaReviewPacket`, `validateArenaReview` and `recordArenaReview`.

`runArena` accepts `profiles` as a map of existing provider profiles. Offline
tests can capture `onPrompt`/`onEvent` and explicitly inject an
`offlineCollector({candidateId, workspace, result, signal})` with fake adapters.
Fake adapters produce only text; the collector supplies fixture artifacts.
Injection with native providers is rejected. This is not a claim of fake code
generation. Existing leader shared-worktree write exclusion is unchanged.
