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

test("tool contract manifest fixes compare-minecraft nested sourcePriority drift", () => {
  const entryTable = renderToolSurfaceSection("en", "v3-entry-tools");

  assert.match(entryTable, /\| `compare-minecraft` \|.*`subject\.kind="class"\.sourcePriority\?`/);
  assert.doesNotMatch(entryTable, /\| `compare-minecraft` \|.*`include\?`, `sourcePriority\?`, `maxClassResults\?`/);
});

test("tool contract manifest reflects current inspect-minecraft and validate-project table contracts", () => {
  const entryTable = renderToolSurfaceSection("en", "v3-entry-tools");

  assert.match(entryTable, /\| `inspect-minecraft` \|.*`result\.summary`, `versions\?`, `subject`, `artifact\?`, `class\?`, `source\?`, `members\?`, `search\?`, `file\?`, `files\?` \|/);
  assert.match(entryTable, /\| `validate-project` \|.*`result\.summary`, `project`, `workspace\?`, `issues\?` \|/);
  assert.doesNotMatch(entryTable, /\| `validate-project` \|.*`recovery\?`/);
});
