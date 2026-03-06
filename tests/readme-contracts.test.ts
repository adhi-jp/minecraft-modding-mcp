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
    /\| `validate-mixin` \|.*`input`.*`sourceRoots\?`.*`projectPath\?`.*`scope\?`.*`preferProjectVersion\?`.*`explain\?`/
  );
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePath\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePaths\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`mixinConfigPath\?`/);
  assert.match(readme, /\| `find-class` \|/);
  assert.match(readme, /\| `get-class-source` \|.*`target`.*`mode\?`.*`projectPath\?`.*`maxChars\?`.*`outputFile\?`/);
  assert.match(readme, /\| `get-class-members` \|.*`target`.*`mapping\?`.*`access\?`/);
  assert.match(readme, /\| `search-class-source` \|.*`artifactId`.*`query`.*`intent\?`.*`symbolKind\?`.*`queryMode\?`.*`limit\?`.*`cursor\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`snippetLines\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeDefinition\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeOneHop\?`/);
  assert.match(
    readme,
    /\| `resolve-method-mapping-exact` \|.*`version`.*`name`.*`owner`.*`descriptor`.*`sourceMapping`.*`targetMapping`/
  );
  assert.doesNotMatch(readme, /\| `resolve-method-mapping-exact` \|.*`kind`/);
  assert.match(readme, /`get-class-source` mode defaults to `metadata`/);
  assert.match(readme, /`validate-mixin` requires `input\.mode` to be exactly one of `inline`, `path`, `paths`, or `config`/);
  assert.match(readme, /`validate-mixin` always returns `mode`, `results\[\]`, and `summary`/);
  assert.match(readme, /`search-class-source` now returns compact file hits without snippets, line windows, relation expansion, or `totalApprox`/);
  assert.match(readme, /Use `get-artifact-file` or `get-class-source` to inspect returned files after search/);
  assert.match(readme, /Replace `resolve-artifact` `targetKind` \+ `targetValue` with `target: \{ kind, value \}`/);
  assert.match(readme, /Replace `get-class-source` \/ `get-class-members` top-level `artifactId` \/ `targetKind` \/ `targetValue`/);
  assert.match(readme, /`resolve-method-mapping-exact` is method-only and no longer accepts `kind`/);
  assert.match(readme, /Use `summary\.processingErrors` instead of `summary\.errors`/);
  assert.match(readme, /\| `check-symbol-exists` \|.*`nameMode\?`/);
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
    /\| `validate-mixin` \|.*`input`.*`sourceRoots\?`.*`projectPath\?`.*`scope\?`.*`preferProjectVersion\?`.*`explain\?`/
  );
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePath\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`sourcePaths\?`/);
  assert.doesNotMatch(readme, /\| `validate-mixin` \|.*`mixinConfigPath\?`/);
  assert.match(readme, /\| `get-class-source` \|.*`target`.*`mode\?`.*`projectPath\?`.*`maxChars\?`.*`outputFile\?`/);
  assert.match(readme, /\| `get-class-members` \|.*`target`.*`mapping\?`.*`access\?`/);
  assert.match(readme, /\| `search-class-source` \|.*`artifactId`.*`query`.*`intent\?`.*`symbolKind\?`.*`queryMode\?`.*`limit\?`.*`cursor\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`snippetLines\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeDefinition\?`/);
  assert.doesNotMatch(readme, /\| `search-class-source` \|.*`includeOneHop\?`/);
  assert.match(
    readme,
    /\| `resolve-method-mapping-exact` \|.*`version`.*`name`.*`owner`.*`descriptor`.*`sourceMapping`.*`targetMapping`/
  );
  assert.doesNotMatch(readme, /\| `resolve-method-mapping-exact` \|.*`kind`/);
  assert.match(readme, /`resolve-artifact` は `target: \{ kind, value \}` を受け取ります。/);
  assert.match(readme, /`validate-mixin` は `input\.mode` が `inline` \/ `path` \/ `paths` \/ `config` のいずれか/);
  assert.match(readme, /`validate-mixin` は常に `mode`、`results\[\]`、`summary` を返し/);
  assert.match(readme, /`summary\.errors` は削除されました/);
  assert.match(readme, /`search-class-source` は snippets、行ウィンドウ、relation expansion、`totalApprox` を含まない/);
  assert.match(readme, /`structuredContent`/);
  assert.match(readme, /`isError=true`/);
  assert.match(readme, /旧来の公開名前空間名 `official` は削除されました/);
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
