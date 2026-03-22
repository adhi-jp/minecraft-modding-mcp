import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TOOL_SURFACE_SECTION_IDS,
  renderToolSurfaceSection
} from "../src/tool-contract-manifest.ts";

function extractGeneratedTable(readme: string, sectionId: string): string {
  const startMarker = `<!-- BEGIN GENERATED TOOL TABLE: ${sectionId} -->`;
  const endMarker = `<!-- END GENERATED TOOL TABLE: ${sectionId} -->`;
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  assert.notEqual(start, -1, `Missing start marker for ${sectionId}`);
  assert.notEqual(end, -1, `Missing end marker for ${sectionId}`);
  assert.ok(end > start, `Invalid marker order for ${sectionId}`);
  return readme
    .slice(start + startMarker.length, end)
    .trim();
}

test("README tool surface tables are generated from the contract manifest", async () => {
  const readme = await readFile("README.md", "utf8");

  for (const sectionId of TOOL_SURFACE_SECTION_IDS) {
    assert.equal(extractGeneratedTable(readme, sectionId), renderToolSurfaceSection("en", sectionId));
  }
});

test("Japanese README tool surface tables are generated from the contract manifest", async () => {
  const readme = await readFile("docs/README-ja.md", "utf8");

  for (const sectionId of TOOL_SURFACE_SECTION_IDS) {
    assert.equal(extractGeneratedTable(readme, sectionId), renderToolSurfaceSection("ja", sectionId));
  }
});

test("tool contract manifest renders compact two-column tables", () => {
  const entryTable = renderToolSurfaceSection("en", "v3-entry-tools");
  const japaneseEntryTable = renderToolSurfaceSection("ja", "v3-entry-tools");

  assert.match(entryTable, /^\| Tool \| Purpose \|\n\| --- \| --- \|/);
  assert.match(japaneseEntryTable, /^\| ツール \| 役割 \|\n\| --- \| --- \|/);
  assert.doesNotMatch(entryTable, /Key Inputs|Key Outputs/);
  assert.doesNotMatch(japaneseEntryTable, /主な入力|主な出力/);
});

test("tool contract manifest reflects current entry-tool purpose summaries", () => {
  const entryTable = renderToolSurfaceSection("en", "v3-entry-tools");

  assert.match(
    entryTable,
    /\| `inspect-minecraft` \| Inspect versions, artifacts, classes, files, source text, and workspace-aware lookup flows \|/
  );
  assert.match(
    entryTable,
    /\| `compare-minecraft` \| Compare version pairs, class diffs, registry diffs, and migration-oriented summaries \|/
  );
  assert.match(
    entryTable,
    /\| `validate-project` \| Summarize workspaces and run direct Mixin or Access Widener validation \|/
  );
});

test("tool contract manifest keeps Japanese purpose rows localized", () => {
  const diagnosticsTable = renderToolSurfaceSection("ja", "registry-diagnostics");

  assert.match(
    diagnosticsTable,
    /\| `get-runtime-metrics` \| ランタイムメトリクスとレイテンシスナップショットを確認する \|/
  );
  assert.doesNotMatch(diagnosticsTable, /runtime metrics|meta envelope/);
});
