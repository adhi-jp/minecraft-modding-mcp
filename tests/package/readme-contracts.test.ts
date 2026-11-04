import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import { ALIAS_TOOL_INVENTORY, CATALOG_TOOL_NAMES } from "../../src/tools/inventory.ts";

/** The lines of a `## ` section of a Markdown document, heading included. */
function section(document: string, heading: string): string {
  const start = document.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `the document has the section ${heading}`);
  const end = document.indexOf("\n## ", start + 1);
  return document.slice(start + 1, end < 0 ? undefined : end);
}

/** The tool names in the first column of the table that starts with the given header row. */
function tableTools(text: string, header: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(header);
  assert.ok(start >= 0, `the table ${header} exists`);
  const tools: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const name = /^\| `([a-z0-9-]+)` \|/.exec(line)?.[1];
    assert.ok(name, `row ${line} names one tool`);
    tools.push(name);
  }
  return tools;
}

/** Every fenced JSON request `{ "tool", "arguments" }` in the text. */
function jsonRequests(text: string): Array<{ tool: string; arguments: Record<string, unknown> }> {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1]!) as { tool?: unknown; arguments?: unknown })
    .filter((request): request is { tool: string; arguments: Record<string, unknown> } => typeof request.tool === "string");
}

function assertCatalogStartHere(path: string, startHere: string, tableHeader: string): void {
  const nextActionsIndex = startHere.indexOf("`meta.nextActions`");
  const tableIndex = startHere.indexOf(tableHeader);
  assert.ok(
    nextActionsIndex !== -1 && tableIndex !== -1 && nextActionsIndex < tableIndex,
    `${path}: the next-action guidance must appear before the tool table`
  );
  const tools = tableTools(startHere, tableHeader);
  assert.ok(tools.length > 0, `${path}: the Start Here table names tools`);
  for (const tool of tools) {
    assert.ok(CATALOG_TOOL_NAMES.has(tool), `${path}: the Start Here table names the catalog tool ${tool}`);
  }
  const requests = jsonRequests(startHere);
  // The common workflows keep an example: reading source and validating a workspace.
  for (const tool of ["source-read", "project-validate"]) {
    assert.ok(requests.some((request) => request.tool === tool), `${path}: Start Here shows a ${tool} request`);
  }
  for (const request of requests) {
    const spec = CATALOG_TOOL_SPECS.find((entry) => entry.name === request.tool);
    assert.ok(spec, `${path}: the example request calls the catalog tool ${request.tool}`);
    const parsed = spec.inputSchema.safeParse(request.arguments);
    assert.ok(parsed.success, `${path}: the ${request.tool} example validates: ${JSON.stringify(parsed.error?.issues)}`);
  }
}

test("README Start Here leads with the catalog tools, next-action guidance and valid catalog requests", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /MCP server for AI-assisted Minecraft modding workflows/);
  assert.match(readme, /Use it when an agent needs to inspect Minecraft source/);
  assertCatalogStartHere("README.md", section(readme, "## Start Here"), "| Tool | Start here for |");
  // Guard against reintroducing removed sections
  assert.doesNotMatch(readme, /Choosing a Starting Tool/);
  assert.doesNotMatch(readme, /- Start with `inspect-minecraft`/);
  // Quick reference to deeper docs must exist
  assert.match(readme, /docs\/examples\.md/);
  assert.match(readme, /docs\/tool-reference\.md/);
});

test("Tool reference owns exact contract, migration, and environment details", async () => {
  const toolReference = await readFile("docs/tool-reference.md", "utf8");

  assert.match(toolReference, /Use \[README\.md\]\(\.\.\/README\.md\) for quick start/);
  assert.match(toolReference, /Use \[docs\/examples\.md\]\(examples\.md\) for concrete request payloads/);
  assert.match(toolReference, /`resolve-artifact` uses `target: \{ kind, value \}`/);
  assert.match(
    toolReference,
    /`get-class-source` and `get-class-members` use `target: \{ kind, value \}`/
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

test("Japanese README stays overview-first, leads with the catalog tools and uses natural Japanese", async () => {
  const readme = await readFile("docs/README-ja.md", "utf8");

  assert.match(readme, /AI 支援の Minecraft Modding ワークフロー向け MCP サーバー/);
  assert.match(readme, /エージェントが Minecraft ソースを調査/);
  assertCatalogStartHere("docs/README-ja.md", section(readme, "## まずここから"), "| ツール | 主な用途 |");
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
    /"tool": "get-class-members"[\s\S]*"arguments": \{[\s\S]*"target": \{[\s\S]*"kind": "artifact"[\s\S]*"artifactId": "<artifact-id>"/
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

test("CHANGELOG names every deprecated 8.x tool somewhere in its release history", async () => {
  // README and docs/tool-reference.md coverage of the same tools is checked
  // against the generated tables in tests/contracts/tool-docs.test.ts.
  const changelog = await readFile("CHANGELOG.md", "utf8");
  for (const { name } of ALIAS_TOOL_INVENTORY) {
    assert.ok(changelog.includes(`\`${name}\``), `CHANGELOG.md must mention "${name}"`);
  }
});

test("README and tool-reference both document the removed-mapping migration token", async () => {
  const [readme, toolRef] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("docs/tool-reference.md", "utf8")
  ]);
  // tool-reference owns the canonical migration note. We anchor the assertion
  // on a removal/rejection phrase next to the literal `official` so the test
  // would still fail if `official` were ever reintroduced as an *active*
  // mapping value (e.g. as a legal `mapping: "official"` example in a sample).
  assert.match(
    toolRef,
    /(removed|rejects?|fail|deprecated|legacy)[^\n]{0,80}`?official`?|`?official`?[^\n]{0,80}(removed|rejected?|fail|deprecat|legacy)/i,
    "tool-reference.md must keep the `official` token tied to a removal / rejection note"
  );
  // README must at least point at tool-reference.
  assert.ok(/tool-reference/.test(readme), "README.md must link to docs/tool-reference.md");
});
