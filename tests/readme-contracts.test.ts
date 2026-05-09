import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("README keeps Start Here section with summary-first guidance before the tool table", async () => {
  const readme = await readFile("README.md", "utf8");
  const startHereSummaryIndex = readme.indexOf("result.summary");
  const startHereTableIndex = readme.indexOf("| Tool | Start here for |");

  assert.match(readme, /MCP server for AI-assisted Minecraft modding workflows/);
  assert.match(readme, /Use it when an agent needs to inspect Minecraft source/);
  assert.match(readme, /## Start Here/);
  assert.match(readme, /`summary\.nextActions`/);
  assert.ok(
    startHereSummaryIndex !== -1 && startHereTableIndex !== -1 && startHereSummaryIndex < startHereTableIndex,
    "summary guidance must appear before the tool table"
  );
  // Guard against reintroducing removed sections
  assert.doesNotMatch(readme, /Choosing a Starting Tool/);
  assert.doesNotMatch(readme, /- Start with `inspect-minecraft`/);
  // Quick reference to deeper docs must exist
  assert.match(readme, /docs\/examples\.md/);
  assert.match(readme, /docs\/tool-reference\.md/);
  // Common workflow tools must be referenced
  assert.match(readme, /"tool": "inspect-minecraft"/);
  assert.match(readme, /"tool": "validate-project"/);
});

test("Tool reference owns exact contract, migration, and environment details", async () => {
  const toolReference = await readFile("docs/tool-reference.md", "utf8");

  assert.match(toolReference, /Use \[README\.md\]\(\.\.\/README\.md\) for quick start/);
  assert.match(toolReference, /Use \[docs\/examples\.md\]\(examples\.md\) for concrete request payloads/);
  assert.match(toolReference, /`resolve-artifact` uses `target: \{ kind, value \}`/);
  assert.match(
    toolReference,
    /`get-class-source` and `get-class-members` use `target: \{ type: "artifact", artifactId \}`/
  );
  assert.match(
    toolReference,
    /`validate-mixin` and `validate-project task="mixin"` use `input\.mode="inline" \| "path" \| "paths" \| "config" \| "project"`/
  );
  assert.match(toolReference, /`mapping="mojang"` requires source-backed artifacts/);
  assert.match(toolReference, /`search-class-source` defaults to `queryMode="auto"`/);
  assert.match(toolReference, /`search-class-source` returns compact hits only/);
  assert.match(toolReference, /`scope="loader"` now means runtime artifact discovery/);
  assert.match(toolReference, /`remap-mod-jar` requires Java and supports Fabric\/Quilt inputs/);
  assert.match(
    toolReference,
    /`suggestedCall` payloads omit parameters when the supplied value already matches the tool default/
  );
  assert.match(toolReference, /`artifactContents`/);
  assert.match(toolReference, /`returnedNamespace`/);
  assert.match(toolReference, /`mc:\/\/versions\/list`/);
  assert.match(toolReference, /`mc:\/\/artifact\/\{artifactId\}\/members\/\{className\}`/);
  assert.match(toolReference, /standard `\{ result\?, error\?, meta \}` envelope/);
  assert.match(toolReference, /`MCP_VINEFLOWER_JAR_PATH`/);
  assert.match(toolReference, /`MCP_TINY_REMAPPER_JAR_PATH`/);
});

test("Japanese README stays overview-first with summary-first guidance and natural Japanese", async () => {
  const readme = await readFile("docs/README-ja.md", "utf8");
  const startHereSummaryIndex = readme.indexOf("result.summary");
  const startHereTableIndex = readme.indexOf("| ツール | 主な用途 |");

  assert.match(readme, /AI 支援の Minecraft Modding ワークフロー向け MCP サーバー/);
  assert.match(readme, /エージェントが Minecraft ソースを調査/);
  assert.match(readme, /## まずここから/);
  assert.match(readme, /`summary\.nextActions`/);
  assert.ok(
    startHereSummaryIndex !== -1 && startHereTableIndex !== -1 && startHereSummaryIndex < startHereTableIndex,
    "summary guidance must appear before the tool table"
  );
  // Guard against reintroducing removed sections and unnatural Japanese
  assert.doesNotMatch(readme, /開始ツールの選び方/);
  assert.doesNotMatch(readme, /plain な/);
  assert.doesNotMatch(readme, /retry 用/);
  assert.doesNotMatch(readme, /partial 結果/);
  assert.doesNotMatch(readme, /structured な/);
  assert.doesNotMatch(readme, /canonical な/);
  assert.doesNotMatch(readme, /stage budget/);
  assert.doesNotMatch(readme, /runtime artifact/);
  assert.doesNotMatch(readme, /runtime-aware/);
  assert.doesNotMatch(readme, /vanilla bytecode/);
  assert.doesNotMatch(readme, /1 call/);
  assert.doesNotMatch(readme, /1\.\.50 entries/);
  assert.doesNotMatch(readme, /workspace \/ version target/);
  assert.doesNotMatch(readme, /shared envelope/);
  // Links to English detailed docs must exist
  assert.match(readme, /examples\.md/);
  assert.match(readme, /tool-reference\.md/);
  // Common workflow tools must be referenced
  assert.match(readme, /"tool": "inspect-minecraft"/);
  assert.match(readme, /"tool": "validate-project"/);
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
