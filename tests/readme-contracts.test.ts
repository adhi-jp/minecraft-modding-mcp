import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("README documents analyze-mod-jar inputs that match implementation", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /\| `analyze-mod-jar` \|.*`jarPath`, `includeClasses\?` \|/);
  assert.doesNotMatch(readme, /includeAllClasses\?/);
  assert.doesNotMatch(readme, /includeRawMetadata\?/);
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
