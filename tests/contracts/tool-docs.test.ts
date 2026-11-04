import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ALIAS_TOOL_INVENTORY, CATALOG_TOOL_INVENTORY } from "../../src/tools/inventory.ts";
import {
  CATALOG_TOOL_PURPOSES,
  generatedAliasSection,
  generatedCatalogSection,
  renderAliasTable,
  renderCatalogTable,
  type DocLocale
} from "../helpers/catalog-docs.ts";

const DOCUMENTS: ReadonlyArray<[string, DocLocale]> = [
  ["README.md", "en"],
  ["docs/README-ja.md", "ja"]
];

test("the catalog purposes cover exactly the inventory's catalog tools", () => {
  assert.deepEqual(
    Object.keys(CATALOG_TOOL_PURPOSES).sort(),
    CATALOG_TOOL_INVENTORY.map((entry) => entry.name).sort()
  );
  for (const [name, purposes] of Object.entries(CATALOG_TOOL_PURPOSES)) {
    assert.ok(purposes.en.length > 0 && purposes.ja.length > 0, `${name} has an English and a Japanese purpose`);
  }
});

for (const [path, locale] of DOCUMENTS) {
  test(`${path} carries the generated catalog table`, async () => {
    const section = generatedCatalogSection(await readFile(path, "utf8"));
    assert.ok(section !== undefined, `${path} has the catalog table markers`);
    assert.equal(section, renderCatalogTable(locale));
  });

  test(`${path} carries the generated table of deprecated 8.x tools`, async () => {
    const section = generatedAliasSection(await readFile(path, "utf8"));
    assert.ok(section !== undefined, `${path} has the alias table markers`);
    assert.equal(section, renderAliasTable(locale));
  });
}

test("README and README-ja state the catalog and deprecated 8.x tool counts from the inventory", async () => {
  const catalogCount = CATALOG_TOOL_INVENTORY.length;
  const aliasCount = ALIAS_TOOL_INVENTORY.length;
  const headlines: Array<[string, string]> = [
    ["README.md", `**${catalogCount} catalog tools** + **${aliasCount} deprecated 8.x tools**`],
    ["docs/README-ja.md", `**${catalogCount} カタログツール** + **${aliasCount} 非推奨の 8.x ツール**`]
  ];
  for (const [path, headline] of headlines) {
    const document = await readFile(path, "utf8");
    assert.ok(document.includes(headline), `${path} must state "${headline}"`);
  }
});

test("the rendered catalog table lists every catalog tool once", () => {
  const table = renderCatalogTable("en");
  for (const { name } of CATALOG_TOOL_INVENTORY) {
    assert.equal(table.split(`| \`${name}\` |`).length - 1, 1, `${name} has one row`);
  }
});

test("the rendered alias table lists every deprecated 8.x tool once, with its replacements", () => {
  const rows = renderAliasTable("en").split("\n").slice(2);
  assert.deepEqual(
    rows.map((row) => /^\| `([a-z0-9-]+)` \|/.exec(row)?.[1]),
    ALIAS_TOOL_INVENTORY.map((entry) => entry.name)
  );
  for (const [index, entry] of ALIAS_TOOL_INVENTORY.entries()) {
    for (const tool of entry.replacedBy) {
      assert.ok(rows[index]!.includes(`\`${tool}\``), `${entry.name} names ${tool}`);
    }
    for (const task of Object.keys(entry.tasks ?? {})) {
      assert.ok(rows[index]!.includes(`\`${task}\` → `), `${entry.name} names its task ${task}`);
    }
  }
});

test("docs/tool-reference.md documents every catalog tool in its tool catalog section", async () => {
  const reference = await readFile("docs/tool-reference.md", "utf8");
  const start = reference.indexOf("\n## Tool catalog\n");
  assert.ok(start >= 0, "the tool catalog section exists");
  const end = reference.indexOf("\n## ", start + 1);
  const section = reference.slice(start, end < 0 ? undefined : end);
  for (const { name } of CATALOG_TOOL_INVENTORY) {
    assert.ok(section.includes(`### \`${name}\``), `${name} has an entry in the tool catalog section`);
  }
});

test("docs/tool-reference.md names every deprecated 8.x tool", async () => {
  const reference = await readFile("docs/tool-reference.md", "utf8");
  for (const { name } of ALIAS_TOOL_INVENTORY) {
    assert.ok(reference.includes(`\`${name}\``), `${name} appears in docs/tool-reference.md`);
  }
});
