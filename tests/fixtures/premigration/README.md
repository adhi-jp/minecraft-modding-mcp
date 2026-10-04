# Pre-migration baselines

Golden fixtures captured against the **untouched SDK v1 build** (before any
MCP 2026-07-28 migration edit). The one-off capture harnesses that produced
them were removed from the tree after the migration; the procedure is the one
recorded at commit `7964871` (`git show 7964871`), and the fixtures can no
longer be re-captured against a current build. The fixtures are regenerated
only in the derived sense: `src/v1-parity-schemas.ts` is rebuilt from the
`tool-contracts/*.json` files with
`node scripts/premigration/generate-v1-parity-schemas.mjs`.

- Capture date: **2026-08-08**
- Commit: **2a17b66d2975e37835061dd87ea34f9a449ba61f** (branch `feature/mcp-spec-2026-07-28`, clean tracked tree)
- Server under test: production entry `node --import tsx src/cli.ts` (stdio
  supervisor + worker), newline-delimited JSON-RPC, legacy handshake
  (`initialize` `protocolVersion: "2025-11-25"` + `notifications/initialized`)
  unless a fixture says otherwise
- Node v24.13.0, Linux (WSL2); `@modelcontextprotocol/sdk` 1.27.1, zod 3.x per lockfile
- Harnesses: each fixture names the harness that produced it in its `harness`
  field; those scripts exist only in git history (commit `7964871`)

## Normalization rules

Applied by `scripts/premigration/lib.mjs` (`normalizeCaptured`), which the
comparison tests import; its header comment is the authoritative copy. Summary:

- **N1** — JSON object keys sorted recursively, EXCEPT subtrees marked
  verbatim: the `advertised.inputSchema` subtree of `tool-contracts/*.json`
  keeps wire property order and raw strings (legacy byte-comparison baseline).
- **N2** — machine-specific path prefixes replaced in all strings: repo root →
  `<REPO>`, harness scratch dir → `<SCRATCH>`, home dir → `<HOME>`.
- **N3** — non-deterministic values replaced by key: `requestId` →
  `<REQUEST_ID>`; `durationMs`/`lastStageElapsedMs`/`elapsedMs` and the
  runtime-metrics latency aggregates (`avgMs`, `lastMs`, `minMs`, `maxMs`,
  `p95Ms`, `p99Ms`, `totalMs`) → `<DURATION_MS>`; `startedAt`/
  `lastStageStartedAt` → `<TIMESTAMP>`; `pid` → `<PID>`; `instance` values
  matching the server's random request-id pattern → `<REQUEST_ID>`.
  `urn:mcp:request:<n>` instances are kept: the harness uses fixed sequential
  JSON-RPC ids, so they are deterministic.
- **N4** — `content[*].text` strings that parse as JSON are replaced by
  `{"__normalizedJson": <parsed-and-normalized value>}` (the live server emits
  `text === JSON.stringify(structuredContent)`, so both views normalize
  identically).
- **N5** — every fixture records the behavior-selecting environment in its
  `env` field (paths normalized per N2). All captures redirect
  `MCP_CACHE_DIR`/`MCP_SQLITE_PATH` into the scratch dir so the user cache is
  untouched. Fixtures carry no timestamps; date/commit live only in this file.

Comparing live output: the capture procedure is the one recorded at commit
`7964871` and cannot be re-run against the current tree. The comparison tests
(`tests/stdio/stdio-problemdetails-envelope-goldens.test.ts`,
`tests/stdio/stdio-tool-contract-snapshots.test.ts`) instead normalize live
output with `normalizeCaptured` and compare it with the frozen fixtures — the
normalization is deterministic, so byte equality of normalized output is the
comparison contract (for `inputSchema`, byte equality of the verbatim subtree).

## Post-capture edits

These fixtures are otherwise verbatim captures; there is one deliberate
exception. Four `tool-contracts/*.json` files — `search-class-source.json`,
`get-artifact-file.json`, `list-artifact-files.json` and
`index-artifact.json` — carry a top-level `projectPath` property added AFTER
capture, by commit `6e45c3b` ("fix(tools): accept projectPath on the
flat-artifactId tools"), mirroring the shape `find-class` already had at
capture time. For that one property those four files are no longer a record
of what the SDK v1 build advertised.

`src/v1-parity-schemas.ts` was regenerated from the edited files (see its
header), so the advertised `inputSchema` bytes and the parity baseline still
agree with each other — but a byte comparison of those four against a fresh
capture from the untouched v1 build would not match on `projectPath`.

Two more `tool-contracts/*.json` files — `batch-class-source.json` and
`batch-class-members.json` — carry a `{"kind":"artifact","artifactId":...}`
variant added to their `target` property's `anyOf`, added AFTER capture by the
change that let the batch tools reuse an already-resolved `artifactId`,
mirroring the shape `get-class-source.json` /
`get-class-members.json` already had at capture time for the same reuse-an-
already-resolved-artifact case. `src/v1-parity-schemas.ts` was regenerated
from the edited files afterward, so the advertised `inputSchema` bytes and the
parity baseline still agree — but a byte comparison of those two against a
fresh capture from the untouched v1 build would not match on that variant.

`tool-contracts/manage-cache.json` had the `rebuild` value removed from its
advertised `action` enum for this major release, which removed that action;
`src/v1-parity-schemas.ts` was regenerated from the edited file, and a byte
comparison against a fresh capture from the untouched v1 build would not match
on that enum.

## Fixture families

### `tools-list-order.<flag-config>.json`

RAW legacy `tools/list` name order (registration order — legacy golden),
one file per flag configuration. Only the `default` configuration (no flags)
remains; the other captured configurations existed only for toggles that have
since been removed, and their files were deleted with them.

| config | env |
| --- | --- |
| `default` | (none) |

Harness validation at capture time (raw report not committed): two consecutive
fresh-process runs produced identical raw order per config, and the sorted
form equals the sorted `EXPECTED_TOOLS` pinned by
`tests/helpers/expected-tools.ts` /
`tests/integration/mcp-tools/contracts.test.ts`.

### `synthetic-shapes/*.json`

The seven synthetic terminal paths (client-visible replies), untouched-v1 shapes.
Injection methods (external only — no `src/` changes):

| fixture | path | injection | reply shape |
| --- | --- | --- | --- |
| `restart-toolscall-structured.json` | restart × tools/call, toggle on | SIGSTOP worker (pid via `MCP_SUPERVISOR_CHILD_PID_FILE`), send tools/call, SIGKILL worker | structured `isError` CallToolResult, `ERR_WORKER_RESTART` |
| `restart-other-raw.json` | restart × other | same, `resources/list` in flight | raw JSON-RPC `-32603` |
| `restart-toolscall-toggle-off.json` | restart × toggle-off | same as first + `SUPERVISOR_STRUCTURED_RESTART_OFF=1` | raw `-32603` for tools/call too |
| `overflow-toolscall.json` | overflow × tools/call | SIGSTOP worker; 1 pending tools/call + queued validate-project (dispatch barrier) + 1 more queued request fill `MAX_SUPERVISOR_QUEUE=2`; next tools/call overflows | structured `isError` CallToolResult, `ERR_LIMIT_EXCEEDED` |
| `overflow-other.json` | overflow × other | same session, queue still full, `resources/list` probe | raw `-32000` |
| `timeout-validate-project.json` | timeout × validate-project | `MCP_VALIDATE_PROJECT_TIMEOUT_MS=10000` (the minimum); SIGSTOP worker; validate-project cannot finish | structured `isError` CallToolResult, `ERR_TOOL_TIMEOUT`, phase `running`, `workerRestartInitiated: true` |
| `startup-failure-terminalization.json` | replay-failure/startup-failure terminalization | `MCP_SUPERVISOR_CHILD_PID_FILE` points into a nonexistent directory → the worker-mode process throws in `writeFileSync` **before** `startServer` and exits 1 on every generation; `initialize` + tools/call + `resources/list` pipelined pre-readiness | queued tools/call → structured `ERR_WORKER_RESTART` reply; queued other → raw `-32603`; retained initialize → raw `-32603` (failed, not hung) |

Shape-relevant injection notes: the SIGKILL injection makes structured restart
replies carry `exit.signal: "SIGKILL"` and `retryRecommendation:
"clear-cache"`; the startup-failure injection carries `exit.code: 1` and
`retryRecommendation: "same-request"`. These values are part of the captured
shape, not incidental.

**Documented limitation** — a genuine gen-2 **replay rejection** (restarted
worker answering the replayed `initialize` with an error,
`src/stdio-supervisor.ts:1249-1263`) is not externally injectable against the
real worker: the real worker always accepts `initialize`, and the baseline
capture may not modify `src/`. A pre-migration real-supervisor-copy spike
proved that replay failure terminalizes through the **same startup-failure
path** captured here (queued requests failed, not hung). The migration's
injection-seam work (`workerSpawner`) owns constructing the replay-rejection
variant.

### `problemdetails/*.json`

One golden per distinct Zod failure kind observed across ALL 41 registered
tool schemas, selected registry-driven (by the `capture-problemdetails.mjs` harness at
commit `7964871`; offline `safeParse` proved
each case failed with exactly its kind before it was sent, so validation always
fails before real work). Kinds captured: `invalid_type.missing-required`,
`invalid_type.wrong-type`, `invalid_enum_value`, `unrecognized_keys`
(`.strict()` batch entry), `too_small.array`, `too_small.number` (positive
int), `too_small.string`, `too_big.number`, `invalid_union_discriminator`,
`custom` (superRefine). Kinds with **no occurrence** in the registered
schemas (nothing to capture): plain `z.union` no-match, `z.record`
wrong-value-type.

Plus the mandatory omitted-arguments goldens (`arguments` omitted entirely on the wire):

- `omitted-arguments-all-optional.json` — `json-to-nbt` (first shape-registered
  tool whose schema accepts `{}`): **error today**, becomes a success under the
  approved class merge. Also enumerates every registration whose schema
  accepts `{}` (`omittedArguments.acceptsEmptyObjectRegistrations`): `get-runtime-metrics`
  (schema-less registration — see below), `json-to-nbt`, `list-versions`.
- `omitted-arguments-required-fields.json` — `analyze-mod`: stays an error;
  the approved decision predicts the error-text class shift.
- `omitted-arguments-no-input-shape.json` — `get-runtime-metrics`: registered
  with NO params schema, so the omitted-arguments call **already succeeds
  today** (not part of the approved error→success class; captured as context).

Env: default flag config, scratch cache redirect (N5).

### `tool-contracts/*.json`

Per registered tool (41 files, default flag config): the
advertised `tools/list` entry with **verbatim** `inputSchema` bytes (N1
exception), plus one envelope sample — a **successful** call envelope for
`get-runtime-metrics` (cheap, local, no arguments; captured first in the
session so runtime-metrics counters are in the deterministic fresh state), an
offline-proven **invalid-input** ProblemDetails envelope for every other tool.

### `test-list.txt`

Named-test inventory (regression set-difference baseline): the same test-file
selection as `npm test` run with node's TAP reporter; one line per test point
`<subtest-depth>\t<ok|not ok>\t<name>`; indices and timings stripped; lines
sorted (set semantics — file interleaving is not deterministic).

**Rename normalization** — eleven captured names carry a legacy `F-nn: ` ID
prefix (four `listFiles`/`searchFiles` cursor tests, five `getModClassSource`
truncation tests, one `resolveArtifact` strictVersion test, one
`search-class-source` queryMode test). The live suite has since dropped these
prefixes with the name bodies unchanged; before set-differencing this
inventory against a current run, strip `/^F-[0-9]{2}: /` from captured names.

### `error-code-inventory.json`

Observed wire error codes per exercised error path:
tool-input validation (per captured kind), unmatched `resources/read` URI
(live probe, raw `-32602`), disabled tool under `BATCH_TOOLS_OFF=1` (live
probe, successful `isError` result embedding `-32602`), queue overflow
(`-32000` raw / structured), worker restart (`-32603` raw / structured,
toggle variants), validate-project timeout (structured), startup-failure
terminalization (`-32603` + structured). Each entry: path, method, wire code
(or `null` for successful `isError` tool results), ProblemDetails code,
`raw-jsonrpc-error` vs `isError-tool-result` classification. Observed raw
wire codes: `-32000`, `-32602`, `-32603` — none in the MCP-reserved
`-32020..-32099` range.

## No-SDK-private-patching check

`scripts/premigration/no-sdk-private-patching.mjs` — generic source scan
over `src/` (type-cast member assignment, SDK-private member writes, deep SDK
internal imports). Verified to FAIL against this baseline by detecting the
`validateToolInput` monkey-patch at `src/index.ts:227-231` (exit 1). It must
pass after the migration removes the patch.
