import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function assertMatchesAll(content: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(content, pattern);
  }
}

const ENGLISH_NARRATIVE_PATTERNS = [
  /These six top-level workflow tools cover the common workflows/,
  /Start with `inspect-minecraft`/,
  /Start with `manage-cache`/,
  /`resolve-artifact` uses `target: \{ kind, value \}`/,
  /`get-class-source` and `get-class-members` use `target: \{ type: "artifact", artifactId \}`/,
  /`validate-mixin` and `validate-project task="mixin"` use `input\.mode="inline" \| "path" \| "paths" \| "config" \| "project"`/,
  /`mapping="mojang"` requires source-backed artifacts/,
  /`search-class-source` defaults to `queryMode="auto"`/,
  /include `summary\.nextActions` when there is a clear follow-up step/,
  /keeps separator queries such as `foo\.bar`, `foo_bar`, and `foo\$bar` on the indexed path/,
  /`tools\/list` exposes it through the JSON Schema `default` field/,
  /`suggestedCall` payloads omit parameters when the supplied value already matches the tool default/,
  /`search-class-source` returns compact hits only/,
  /`scope="loader"` currently resolves through the same lookup path as `scope="merged"`/,
  /`remap-mod-jar` requires Java and supports Fabric\/Quilt inputs/,
  /`artifactContents`/,
  /`returnedNamespace`/,
  /`mc:\/\/versions\/list`/,
  /`mc:\/\/artifact\/\{artifactId\}\/members\/\{className\}`/,
  /Tools and JSON resources return the standard `\{ result\?, error\?, meta \}` envelope/,
  /`MCP_VINEFLOWER_JAR_PATH`/,
  /`MCP_TINY_REMAPPER_JAR_PATH`/,
  /"tool": "inspect-minecraft"/,
  /"tool": "validate-project"/
] as const;

const JAPANESE_NARRATIVE_PATTERNS = [
  /Claude Desktop、Claude Code、VS Code、Codex CLI、Gemini CLI/,
  /以下の 6 つのトップレベルワークフローツールは、一般的な作業をカバー/,
  /明確に狙っている専用操作がない限り、まずは以下のトップレベルワークフローツールから始めてください/,
  /次の一手が明確な場合は `summary\.nextActions` も含めます/,
  /`search-class-source` は既定で `queryMode="auto"`/,
  /`foo\.bar`、`foo_bar`、`foo\$bar` のような区切り文字付きクエリ/,
  /`tools\/list` は JSON Schema の `default` フィールドにその値を出します/,
  /`suggestedCall` は、指定値がすでにツール既定動作と同じパラメータを省略/,
  /`artifactContents`/,
  /`returnedNamespace`/,
  /`mc:\/\/versions\/list`/,
  /`mc:\/\/artifact\/\{artifactId\}\/members\/\{className\}`/,
  /標準の `\{ result\?, error\?, meta \}` エンベロープ/,
  /`MCP_VINEFLOWER_JAR_PATH`/,
  /`MCP_TINY_REMAPPER_JAR_PATH`/,
  /詳細なリクエスト例（英語）/,
  /ツール \/ 設定リファレンス（英語）/,
  /"tool": "inspect-minecraft"/,
  /"tool": "validate-project"/
] as const;

test("README documents narrative contract outside generated tables", async () => {
  const [readme, toolReference, examples] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("docs/tool-reference.md", "utf8"),
    readFile("docs/examples.md", "utf8")
  ]);
  const englishDocs = [readme, toolReference, examples].join("\n");

  assertMatchesAll(englishDocs, ENGLISH_NARRATIVE_PATTERNS);
});

test("Japanese README documents narrative contract outside generated tables", async () => {
  const readme = await readFile("docs/README-ja.md", "utf8");

  assertMatchesAll(readme, JAPANESE_NARRATIVE_PATTERNS);
});

test("README documents MCP client quick start commands", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /## Quick Start/);
  assert.match(readme, /### Client Setup/);
  assert.match(readme, /Claude Code/);
  assert.match(readme, /claude mcp add minecraft-modding -- npx -y @adhisang\/minecraft-modding-mcp/);
  assert.match(readme, /claude mcp list/);

  assert.match(readme, /OpenAI Codex CLI/);
  assert.match(readme, /codex mcp add minecraft-modding -- npx -y @adhisang\/minecraft-modding-mcp/);
  assert.match(readme, /codex mcp list/);

  assert.match(readme, /#### Gemini CLI/);
  assert.match(readme, /~\/\.gemini\/settings\.json/);
  assert.match(readme, /\/mcp list/);
});

test("Example docs use the current get-class-members target schema", async () => {
  const examples = await readFile("docs/examples.md", "utf8");
  const memberListExample = examples.match(
    /### Get class member list[\s\S]*?```json\n([\s\S]*?)\n```/
  );

  assert.ok(memberListExample, "Expected a dedicated get-class-members example block.");
  const block = memberListExample[1];

  assert.match(
    block,
    /"tool": "get-class-members"[\s\S]*"arguments": \{[\s\S]*"target": \{[\s\S]*"type": "artifact"[\s\S]*"artifactId": "<artifact-id>"/
  );
  assert.doesNotMatch(
    block,
    /"arguments": \{\s*"artifactId": "<artifact-id>"/
  );
});

test("ArtifactContentsSummary sourceCoverage contract only allows full or partial", async () => {
  const sourceService = await readFile("src/source-service.ts", "utf8");

  assert.match(
    sourceService,
    /export type ArtifactContentsSummary = \{[\s\S]*sourceCoverage: "full" \| "partial";/
  );
  assert.doesNotMatch(sourceService, /sourceCoverage: "full" \| "partial" \| "unknown";/);
});
