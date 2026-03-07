import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("README documents analyze-mod-jar inputs that match implementation", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /\| `analyze-mod-jar` \|.*`jarPath`, `includeClasses\?` \|/);
  assert.doesNotMatch(readme, /includeAllClasses\?/);
  assert.doesNotMatch(readme, /includeRawMetadata\?/);
});

test("README documents source resolution options and source-mode behavior", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /\| `resolve-artifact` \|.*`target`.*`projectPath\?`.*`scope\?`.*`preferProjectVersion\?`/);
  assert.match(
    readme,
    /\| `validate-mixin` \|.*`input`.*`sourceRoots\?`.*`projectPath\?`.*`scope\?`.*`preferProjectVersion\?`.*`explain\?`.*`includeIssues\?`/
  );
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePath\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePaths\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`mixinConfigPath\?`/);
  assert.match(readme, /\| `find-class` \|/);
  assert.match(readme, /\| `resolve-artifact` \|.*`artifactContents`/);
  assert.match(readme, /\| `get-class-source` \|.*`target`.*`mode\?`.*`projectPath\?`.*`maxChars\?`.*`outputFile\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `get-class-members` \|.*`target`.*`mapping\?`.*`access\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `search-class-source` \|.*`artifactId`.*`query`.*`intent\?`.*`symbolKind\?`.*`queryMode\?`.*`limit\?`.*`cursor\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `get-artifact-file` \|.*`artifactId`.*`filePath`.*`maxBytes\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `list-artifact-files` \|.*`artifactId`.*`prefix\?`.*`cursor\?`.*`artifactContents`.*`warnings\[\]`/);
  assert.match(readme, /\| `diff-class-signatures` \|.*`includeFullDiff\?`.*`modified`/);
  assert.match(readme, /\| `compare-versions` \|.*`classes`, `registry`, `summary`, `warnings\[\]` \|/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`snippetLines\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeDefinition\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeOneHop\?`/);
  assert.match(
    readme,
    /\| `resolve-method-mapping-exact` \|.*`version`.*`name`.*`owner`.*`descriptor`.*`sourceMapping`.*`targetMapping`/
  );
  assert.doesNotMatch(readme, /\| `resolve-method-mapping-exact` \|.*`kind`/);
  assert.match(readme, /\| `find-mapping` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `resolve-method-mapping-exact` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `get-class-api-matrix` \|.*`maxRows\?`.*`rowCount`.*`rowsTruncated\?`/);
  assert.match(readme, /\| `resolve-workspace-symbol` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `check-symbol-exists` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `decompile-mod-jar` \|.*`includeFiles\?`.*`maxFiles\?`.*`returnedFileCount\?`.*`filesTruncated\?`.*`filesOmitted\?`/);
  assert.match(readme, /\| `get-registry-data` \|.*`includeData\?`.*`maxEntriesPerRegistry\?`.*`returnedEntryCount\?`.*`registryEntryCounts\?`.*`dataTruncated\?`/);
  assert.match(readme, /`get-class-source` mode defaults to `metadata`/);
  assert.match(readme, /Error `suggestedCall` payloads now use the same `target` object schema/);
  assert.match(readme, /include `artifactContents`/);
  assert.match(readme, /include `returnedNamespace`/);
  assert.match(readme, /resources are indexed \(`resourcesIncluded=false` today\)/);
  assert.match(readme, /Heavy analysis tools .* are serialized inside the server/);
  assert.match(readme, /CLI stdio entrypoint now runs a supervised worker process/);
  assert.match(readme, /replays MCP initialization for the current session/);
  assert.match(readme, /Registry deltas are returned under `result\.registry` \(not `registryDiff`\)\./);
  assert.match(readme, /`validate-mixin` requires `input\.mode` to be exactly one of `inline`, `path`, `paths`, or `config`/);
  assert.match(readme, /`validate-mixin` always returns `mode`, `results\[\]`, and `summary`/);
  assert.match(readme, /`validate-mixin` supports `includeIssues=false`/);
  assert.match(readme, /`reportMode=compact` and `warningMode=aggregated`/);
  assert.match(readme, /`search-class-source` now returns compact file hits without snippets, line windows, relation expansion, or `totalApprox`/);
  assert.match(readme, /Use `get-artifact-file` or `get-class-source` to inspect returned files after search/);
  assert.match(readme, /Replace `resolve-artifact` `targetKind` \+ `targetValue` with `target: \{ kind, value \}`/);
  assert.match(readme, /Replace `get-class-source` \/ `get-class-members` top-level `artifactId` \/ `targetKind` \/ `targetValue`/);
  assert.match(readme, /`resolve-method-mapping-exact` is method-only and no longer accepts `kind`/);
  assert.match(readme, /Use `summary\.processingErrors` instead of `summary\.errors`/);
  assert.match(readme, /\| `check-symbol-exists` \|.*`nameMode\?`/);
  assert.match(readme, /`maxCandidates` to cap `candidates\[\]`/);
  assert.match(readme, /`get-class-api-matrix` accepts `maxRows`/);
  assert.match(readme, /`decompile-mod-jar` supports `includeFiles=false`/);
  assert.match(readme, /`get-registry-data` supports `includeData=false`/);
  assert.match(readme, /`diff-class-signatures` supports `includeFullDiff=false`/);
  assert.match(readme, /nameMode=auto/);
  assert.match(readme, /numeric-string coercion only applies to documented top-level tool arguments/);
  assert.match(readme, /mirrored in MCP `structuredContent`/);
  assert.match(readme, /failures also set `isError=true`/);
});

test("Japanese README documents the current public contract", async () => {
  const readme = await readFile("docs/README-ja.md", "utf8");

  assert.match(readme, /4つの命名空間（`obfuscated`、`mojang`、`intermediary`、`yarn`）/);
  assert.match(readme, /\| `resolve-artifact` \|.*`target`.*`projectPath\?`.*`scope\?`.*`preferProjectVersion\?`/);
  assert.match(
    readme,
    /\| `validate-mixin` \|.*`input`.*`sourceRoots\?`.*`projectPath\?`.*`scope\?`.*`preferProjectVersion\?`.*`explain\?`.*`includeIssues\?`/
  );
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePath\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePaths\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`mixinConfigPath\?`/);
  assert.match(readme, /\| `resolve-artifact` \|.*`artifactContents`/);
  assert.match(readme, /\| `get-class-source` \|.*`target`.*`mode\?`.*`projectPath\?`.*`maxChars\?`.*`outputFile\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `get-class-members` \|.*`target`.*`mapping\?`.*`access\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `search-class-source` \|.*`artifactId`.*`query`.*`intent\?`.*`symbolKind\?`.*`queryMode\?`.*`limit\?`.*`cursor\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `get-artifact-file` \|.*`artifactId`.*`filePath`.*`maxBytes\?`.*`returnedNamespace`.*`artifactContents`/);
  assert.match(readme, /\| `list-artifact-files` \|.*`artifactId`.*`prefix\?`.*`cursor\?`.*`artifactContents`.*`warnings\[\]`/);
  assert.match(readme, /\| `diff-class-signatures` \|.*`includeFullDiff\?`.*`modified`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`snippetLines\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeDefinition\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeOneHop\?`/);
  assert.match(
    readme,
    /\| `resolve-method-mapping-exact` \|.*`version`.*`name`.*`owner`.*`descriptor`.*`sourceMapping`.*`targetMapping`/
  );
  assert.doesNotMatch(readme, /\| `resolve-method-mapping-exact` \|.*`kind`/);
  assert.match(readme, /\| `find-mapping` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `resolve-method-mapping-exact` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `get-class-api-matrix` \|.*`maxRows\?`.*`rowCount`.*`rowsTruncated\?`/);
  assert.match(readme, /\| `resolve-workspace-symbol` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `check-symbol-exists` \|.*`maxCandidates\?`.*`candidateCount`.*`candidatesTruncated\?`/);
  assert.match(readme, /\| `decompile-mod-jar` \|.*`includeFiles\?`.*`maxFiles\?`.*`returnedFileCount\?`.*`filesTruncated\?`.*`filesOmitted\?`/);
  assert.match(readme, /\| `get-registry-data` \|.*`includeData\?`.*`maxEntriesPerRegistry\?`.*`returnedEntryCount\?`.*`registryEntryCounts\?`.*`dataTruncated\?`/);
  assert.match(readme, /`resolve-artifact` は `target: \{ kind, value \}` を受け取ります。/);
  assert.match(readme, /エラーの `suggestedCall` も、旧 `targetKind` \/ `targetValue` ではなく同じ `target` オブジェクト形状/);
  assert.match(readme, /`artifactContents` を返し/);
  assert.match(readme, /`returnedNamespace` を返します/);
  assert.match(readme, /`resourcesIncluded=false`/);
  assert.match(readme, /重い解析系ツール.*直列化されます/);
  assert.match(readme, /CLI の stdio entrypoint は supervised worker process として動作します/);
  assert.match(readme, /MCP initialize を replay して同じ stdio 接続を継続します/);
  assert.match(readme, /`validate-mixin` は `input\.mode` が `inline` \/ `path` \/ `paths` \/ `config` のいずれか/);
  assert.match(readme, /`validate-mixin` は常に `mode`、`results\[\]`、`summary` を返し/);
  assert.match(readme, /`validate-mixin` は `includeIssues=false` をサポートし/);
  assert.match(readme, /`reportMode=compact` と `warningMode=aggregated`/);
  assert.match(readme, /`summary\.errors` は削除されました/);
  assert.match(readme, /`search-class-source` は snippets、行ウィンドウ、relation expansion、`totalApprox` を含まない/);
  assert.match(readme, /`structuredContent`/);
  assert.match(readme, /`isError=true`/);
  assert.match(readme, /旧来の公開名前空間名 `official` は削除されました/);
  assert.match(readme, /`maxCandidates` で `candidates\[\]` を上限付きにできます/);
  assert.match(readme, /`get-class-api-matrix` は `maxRows` を受け付けます/);
  assert.match(readme, /`decompile-mod-jar` は `includeFiles=false`/);
  assert.match(readme, /`get-registry-data` は `includeData=false`/);
  assert.match(readme, /`diff-class-signatures` は `includeFullDiff=false`/);
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
