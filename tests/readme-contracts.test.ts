import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function assertMatchesAll(content: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(content, pattern);
  }
}

const ENGLISH_NARRATIVE_PATTERNS = [
  /always return `result\.summary`/,
  /`summary\.subject` plus `summary\.nextActions`/,
  /share `detail: "summary" \| "standard" \| "full"` plus opt-in `include\[\]` groups/,
  /`executionMode: "preview" \| "apply"`/,
  /Start with `inspect-minecraft`/,
  /Start with `manage-cache`/,
  /`registry-diff` can only load one side of detailed registry data, it returns `summary.status="partial"`/,
  /`selector\.olderThan` accepts ISO-8601 durations such as `P30D`/,
  /`get-class-source` mode defaults to `metadata`/,
  /Error `suggestedCall` payloads now use the same `target` object schema/,
  /include `artifactContents`/,
  /include `returnedNamespace`/,
  /resources are indexed \(`resourcesIncluded=false` today\)/,
  /Heavy analysis tools .* are serialized inside the server/,
  /CLI stdio entrypoint now runs a supervised worker process/,
  /replays MCP initialization for the current session/,
  /Registry deltas are returned under `result\.registry` \(not `registryDiff`\)\./,
  /`scope="loader"` currently resolves the same artifact class as `scope="merged"`/,
  /`validate-mixin` requires `input\.mode` to be exactly one of `inline`, `path`, `paths`, `config`, or `project`/,
  /`validate-mixin` always returns `mode`, `results\[\]`, and `summary`/,
  /`validate-mixin` supports `includeIssues=false`/,
  /`validate-mixin` per-result responses now include `validationStatus`/,
  /`validate-mixin` batch `summary` now includes `partial`/,
  /`validate-mixin` now reports `validation-incomplete` when target metadata cannot be loaded reliably/,
  /`validate-mixin` responses now include `confidenceBreakdown`/,
  /`reportMode=summary-first` hoists shared provenance, warnings, and incomplete-reason summaries/,
  /`validate-mixin` provenance now exposes `requestedScope` \/ `appliedScope` and `requestedSourcePriority` \/ `appliedSourcePriority`/,
  /`validate-mixin` automatically retries with `sourcePriority="maven-first"`/,
  /Schema validation failures now also return the standard `ERR_INVALID_INPUT` envelope/,
  /Bare string `target` values now return `ERR_INVALID_INPUT` with a schema-correct `suggestedCall` wrapper/,
  /generated `check-symbol-exists` recovery payloads now stay within that tool's public schema/,
  /`check-symbol-exists` suppresses raw `No Loom tiny mapping files matched version .*` noise/,
  /`reportMode=compact` and `warningMode=aggregated`/,
  /`search-class-source` now returns compact file hits without snippets, line windows, relation expansion, or `totalApprox`/,
  /Use `get-artifact-file` or `get-class-source` to inspect returned files after search/,
  /Replace `resolve-artifact` `targetKind` \+ `targetValue` with `target: \{ kind, value \}`/,
  /Replace `get-class-source` \/ `get-class-members` top-level `artifactId` \/ `targetKind` \/ `targetValue`/,
  /`resolve-method-mapping-exact` is method-only and no longer accepts `kind`/,
  /Use `summary\.processingErrors` instead of `summary\.errors`/,
  /`maxCandidates` to cap `candidates\[\]`/,
  /`get-class-api-matrix` accepts `maxRows`/,
  /`decompile-mod-jar` supports `includeFiles=false`/,
  /`get-registry-data` supports `includeData=false`/,
  /`diff-class-signatures` supports `includeFullDiff=false`/,
  /nameMode=auto/,
  /numeric-string coercion only applies to documented top-level tool arguments/,
  /mirrored in MCP `structuredContent`/,
  /failures also set `isError=true`/,
  /#### Validate all Mixins in a project/,
  /"mode": "project"/
] as const;

const JAPANESE_NARRATIVE_PATTERNS = [
  /常に `result\.summary` を返します/,
  /`summary\.subject` と `summary\.nextActions`/,
  /`detail: "summary" \| "standard" \| "full"` と opt-in の `include\[\]` を共有/,
  /`executionMode: "preview" \| "apply"`/,
  /まず `inspect-minecraft` を使い/,
  /まず `manage-cache` を使い/,
  /`registry-diff` で detailed registry data を片側しか読めない場合でも、ツール全体を失敗させず `summary.status="partial"`/,
  /`selector\.olderThan` は `P30D` のような ISO-8601 duration を受け付け/,
  /`resolve-artifact` は `target: \{ kind, value \}` を受け取ります。/,
  /エラーの `suggestedCall` も、旧 `targetKind` \/ `targetValue` ではなく同じ `target` オブジェクト形状/,
  /4つの命名空間（`obfuscated`、`mojang`、`intermediary`、`yarn`）/,
  /`artifactContents` を返し/,
  /`resourcesIncluded=false`/,
  /`returnedNamespace` を返します/,
  /重い解析系ツール.*直列化されます/,
  /CLI の stdio entrypoint は supervised worker process として動作します/,
  /MCP initialize を replay して同じ stdio 接続を継続します/,
  /`validate-mixin` は `input\.mode` が `inline` \/ `path` \/ `paths` \/ `config` \/ `project` のいずれか/,
  /`validate-mixin` は常に `mode`、`results\[\]`、`summary` を返し/,
  /`validate-mixin` は `includeIssues=false` をサポートし/,
  /`validate-mixin` の各結果は `validationStatus`/,
  /`validate-mixin` のバッチ `summary` には `partial` が追加され/,
  /`validate-mixin` は、target metadata を十分に取得できない場合に `validation-incomplete` を返します/,
  /`validate-mixin` のレスポンスには `confidenceBreakdown` が追加され/,
  /`reportMode=summary-first` は共有 provenance、warnings、incomplete reason をトップレベルへ集約/,
  /`validate-mixin` の provenance には `requestedScope` \/ `appliedScope` と `requestedSourcePriority` \/ `appliedSourcePriority`/,
  /`validate-mixin` は、マッピング\/署名解決の制約で `loom-first` の結果が partial になった場合、自動で `sourcePriority="maven-first"` に再試行/,
  /Schema validation failure でも標準の `ERR_INVALID_INPUT` エンベロープ/,
  /bare string の `target` を渡した場合も `ERR_INVALID_INPUT` と schema-valid な `suggestedCall` を返します/,
  /`scope="loader"` は現時点では `scope="merged"` と同じ解決クラスを使います/,
  /`check-symbol-exists` 向け recovery payload は、そのツールの公開 schema に収まる引数だけ/,
  /`check-symbol-exists` は、Maven tiny mapping fallback が成功した場合に raw な `No Loom tiny mapping files matched version .*` warning を繰り返さず/,
  /`reportMode=compact` と `warningMode=aggregated`/,
  /`summary\.errors` は削除されました/,
  /`search-class-source` は snippets、行ウィンドウ、relation expansion、`totalApprox` を含まない/,
  /`structuredContent`/,
  /`isError=true`/,
  /旧来の公開名前空間名 `official` は削除されました/,
  /レジストリ差分は `result\.registry` に返ります（`registryDiff` ではありません）。/,
  /`maxCandidates` で `candidates\[\]` を上限付きにできます/,
  /`get-class-api-matrix` は `maxRows` を受け付けます/,
  /`decompile-mod-jar` は `includeFiles=false`/,
  /`get-registry-data` は `includeData=false`/,
  /`diff-class-signatures` は `includeFullDiff=false`/,
  /#### プロジェクト内の Mixin を一括バリデーション/,
  /"mode": "project"/
] as const;

test("README documents narrative contract outside generated tables", async () => {
  const readme = await readFile("README.md", "utf8");

  assertMatchesAll(readme, ENGLISH_NARRATIVE_PATTERNS);
});

test("Japanese README documents narrative contract outside generated tables", async () => {
  const readme = await readFile("docs/README-ja.md", "utf8");

  assertMatchesAll(readme, JAPANESE_NARRATIVE_PATTERNS);
});

test("README documents CLI agent MCP quick start commands", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /### CLI Agent Tools/);
  assert.match(readme, /#### Claude Code/);
  assert.match(readme, /claude mcp add minecraft-modding -- npx -y @adhisang\/minecraft-modding-mcp/);
  assert.match(readme, /claude mcp list/);

  assert.match(readme, /#### OpenAI Codex CLI/);
  assert.match(readme, /codex mcp add minecraft-modding -- npx -y @adhisang\/minecraft-modding-mcp/);
  assert.match(readme, /codex mcp list/);

  assert.match(readme, /#### Gemini CLI/);
  assert.match(readme, /~\/\.gemini\/settings\.json/);
  assert.match(readme, /\/mcp list/);
});

test("ArtifactContentsSummary sourceCoverage contract only allows full or partial", async () => {
  const sourceService = await readFile("src/source-service.ts", "utf8");

  assert.match(
    sourceService,
    /export type ArtifactContentsSummary = \{[\s\S]*sourceCoverage: "full" \| "partial";/
  );
  assert.doesNotMatch(sourceService, /sourceCoverage: "full" \| "partial" \| "unknown";/);
});
