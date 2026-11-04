import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ALIAS_TOOL_INVENTORY, ALIAS_TOOL_NAMES, CATALOG_TOOL_NAMES } from "../../src/tools/inventory.ts";

/**
 * docs/tool-reference.md indexes the deprecated 8.x tools in "Migration from
 * 8.x" at the end of its tool catalog: one row per 8.x tool, in inventory
 * order, naming the catalog tools that replace it (one per task for the
 * multiplexed tools), each linked to its catalog entry. The disposition of
 * every 8.x input lives in the "From 8.x `<tool>`" notes of those entries.
 *
 * The input oracle is the frozen 8.x listing entry of each tool in
 * tests/fixtures/premigration/tool-contracts/<tool>.json: the property names
 * at the top level of its input schema and one level into each object-valued
 * property (union branches and array items included). Every such name must
 * appear as an identifier inside a backtick span of the notes for that tool.
 * A note's lead (`From 8.x \`<tool>\` \`task: "…"\`:`) and spans that are
 * exactly a tool name are not read, so a property cannot be found only
 * because its name is a word of a tool or task name.
 */

const REFERENCE = readFileSync("docs/tool-reference.md", "utf8");
const CONTRACTS_DIR = fileURLToPath(new URL("../fixtures/premigration/tool-contracts/", import.meta.url));

type SchemaNode = {
  $ref?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode | SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
};

/** The lines of one `## ` section, without its heading. */
function topSection(document: string, heading: string): string[] {
  const lines = document.split("\n");
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `docs/tool-reference.md has the heading ${heading}`);
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("## ")) end += 1;
  return lines.slice(start + 1, end);
}

/** The lines of one `### ` entry inside the given lines, without its heading. */
function entry(lines: readonly string[], heading: string): string[] | undefined {
  const start = lines.indexOf(heading);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^#{1,3} /.test(lines[end]!)) end += 1;
  return lines.slice(start + 1, end);
}

const CATALOG_SECTION = topSection(REFERENCE, "## Tool catalog");

// --- the migration table ------------------------------------------------------

type MigrationRow = { name: string; replacedBy: string[]; tasks?: Record<string, string> };

const LINK = /^\[`([a-z0-9-]+)`\]\(#([a-z0-9-]+)\)$/;

function parseLink(text: string, row: string): string {
  const match = LINK.exec(text.trim());
  assert.ok(match, `"${text.trim()}" in row ${row} is a link to a catalog entry`);
  assert.equal(match[2], match[1], `the link of ${match[1]} in row ${row} points to its catalog entry`);
  return match[1]!;
}

function migrationRows(): MigrationRow[] {
  const section = entry(CATALOG_SECTION, "### Migration from 8.x");
  assert.ok(section !== undefined, "the tool catalog ends with the Migration from 8.x section");
  const tableLines = section.filter((line) => line.startsWith("|"));
  assert.equal(tableLines[0], "| 8.x tool | Replaced by |");
  assert.equal(tableLines[1], "| --- | --- |");
  return tableLines.slice(2).map((line) => {
    const cells = line.split(" | ").map((cell) => cell.replace(/^\| ?/, "").replace(/ ?\|$/, ""));
    assert.equal(cells.length, 2, `row ${line} has two cells`);
    const name = /^`([a-z0-9-]+)`$/.exec(cells[0]!)?.[1];
    assert.ok(name, `row ${line} names an 8.x tool`);
    const parts = cells[1]!.split(", ");
    if (parts[0]!.includes(" → ")) {
      const tasks: Record<string, string> = {};
      for (const part of parts) {
        const [task, tool] = part.split(" → ");
        const taskName = /^`([a-z-]+)`$/.exec(task ?? "")?.[1];
        assert.ok(taskName && tool, `"${part}" in row ${name} is a task and its catalog tool`);
        tasks[taskName] = parseLink(tool, name);
      }
      return { name, replacedBy: [...new Set(Object.values(tasks))], tasks };
    }
    return { name, replacedBy: parts.map((part) => parseLink(part, name)) };
  });
}

test("the migration table has one row per 8.x tool naming the inventory's replacements", () => {
  const expected: MigrationRow[] = ALIAS_TOOL_INVENTORY.map((alias) =>
    alias.tasks === undefined
      ? { name: alias.name, replacedBy: [...alias.replacedBy] }
      : { name: alias.name, replacedBy: [...new Set(Object.values(alias.tasks))], tasks: { ...alias.tasks } }
  );
  assert.deepEqual(migrationRows(), expected);
  for (const alias of ALIAS_TOOL_INVENTORY.filter((entry) => entry.tasks !== undefined)) {
    // A task row shows the replacements in task order; together they are the inventory's list.
    assert.deepEqual(
      new Set(Object.values(alias.tasks!)),
      new Set(alias.replacedBy),
      `${alias.name}: the tasks cover every replacement`
    );
  }
});

test("every catalog tool the migration table names has an entry in the tool catalog", () => {
  const named = new Set(migrationRows().flatMap((row) => row.replacedBy));
  assert.ok(named.size > 0, "the table names catalog tools");
  for (const tool of named) {
    assert.ok(CATALOG_TOOL_NAMES.has(tool), `${tool} is a catalog tool`);
    assert.ok(entry(CATALOG_SECTION, `### \`${tool}\``) !== undefined, `${tool} has a catalog entry`);
  }
});

// --- the "From 8.x" notes -----------------------------------------------------

/** The text of a note line up to its first colon outside a backtick span. */
function noteLead(line: string): string {
  let inSpan = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "`") inSpan = !inSpan;
    else if (line[index] === ":" && !inSpan) return line.slice(0, index);
  }
  return line;
}

/**
 * The "From 8.x" notes for one 8.x tool inside one catalog entry: each note
 * line whose lead names the tool, without that lead, with its indented
 * continuation lines.
 */
function notesFor(alias: string, entryLines: readonly string[]): string[] {
  const notes: string[] = [];
  for (let index = 0; index < entryLines.length; index += 1) {
    const line = entryLines[index]!;
    if (!line.startsWith("- From 8.x ")) continue;
    const lead = noteLead(line);
    if (!lead.includes(`\`${alias}\``)) continue;
    const note = [line.slice(lead.length + 1)];
    while (index + 1 < entryLines.length && /^\s+\S/.test(entryLines[index + 1]!)) {
      index += 1;
      note.push(entryLines[index]!);
    }
    notes.push(note.join("\n"));
  }
  return notes;
}

const TOOL_NAMES: ReadonlySet<string> = new Set([...CATALOG_TOOL_NAMES, ...ALIAS_TOOL_NAMES]);

/** Every identifier inside a backtick span of the text, except spans that are exactly a tool name. */
function backtickIdentifiers(text: string): Set<string> {
  const identifiers = new Set<string>();
  for (const span of text.matchAll(/`([^`]+)`/g)) {
    if (TOOL_NAMES.has(span[1]!)) continue;
    for (const identifier of span[1]!.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) identifiers.add(identifier[0]);
  }
  return identifiers;
}

function resolveLocalRef(root: SchemaNode, ref: string): SchemaNode | undefined {
  if (!ref.startsWith("#")) return undefined;
  let current: unknown = root;
  for (const segment of ref.slice(1).split("/").filter((part) => part !== "")) {
    if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as SchemaNode;
}

/** The object schemas a node stands for: itself, its `$ref` target, its union branches and array items. */
function objectSchemas(root: SchemaNode, node: SchemaNode | undefined, seen: ReadonlySet<string> = new Set()): SchemaNode[] {
  if (node === undefined || node === null || typeof node !== "object") return [];
  const found: SchemaNode[] = [];
  if (typeof node.$ref === "string" && !seen.has(node.$ref)) {
    const target = resolveLocalRef(root, node.$ref);
    assert.ok(target !== undefined, `unresolvable local $ref ${node.$ref}`);
    found.push(...objectSchemas(root, target, new Set([...seen, node.$ref])));
  }
  if (node.properties !== undefined) found.push(node);
  for (const item of Array.isArray(node.items) ? node.items : [node.items]) found.push(...objectSchemas(root, item, seen));
  for (const branches of [node.anyOf, node.oneOf, node.allOf]) {
    for (const branch of branches ?? []) found.push(...objectSchemas(root, branch, seen));
  }
  return found;
}

/** Property names at the top level of an input schema and one level into its object-valued properties. */
function inputPropertyNames(schema: SchemaNode): Set<string> {
  const names = new Set<string>();
  for (const top of objectSchemas(schema, schema)) {
    for (const [name, child] of Object.entries(top.properties ?? {})) {
      names.add(name);
      for (const inner of objectSchemas(schema, child)) {
        for (const innerName of Object.keys(inner.properties ?? {})) names.add(innerName);
      }
    }
  }
  return names;
}

function frozenInputSchema(alias: string): SchemaNode {
  const contract = JSON.parse(readFileSync(`${CONTRACTS_DIR}${alias}.json`, "utf8")) as {
    advertised: { inputSchema: SchemaNode };
  };
  return contract.advertised.inputSchema;
}

test("every replacement entry has a From 8.x note for each 8.x tool it replaces", () => {
  const missing: string[] = [];
  for (const alias of ALIAS_TOOL_INVENTORY) {
    for (const tool of alias.replacedBy) {
      const lines = entry(CATALOG_SECTION, `### \`${tool}\``);
      assert.ok(lines !== undefined, `${tool} has a catalog entry`);
      if (notesFor(alias.name, lines).length === 0) missing.push(`${tool} has no "From 8.x \`${alias.name}\`" note`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the From 8.x notes name every input property of each 8.x tool", (t) => {
  const uncovered: string[] = [];
  let checked = 0;
  let nested = 0;
  for (const alias of ALIAS_TOOL_INVENTORY) {
    const schema = frozenInputSchema(alias.name);
    const topLevel = new Set(Object.keys(schema.properties ?? {}));
    const names = inputPropertyNames(schema);
    const notes = alias.replacedBy.flatMap((tool) => notesFor(alias.name, entry(CATALOG_SECTION, `### \`${tool}\``) ?? []));
    const identifiers = backtickIdentifiers(notes.join("\n"));
    for (const name of names) {
      checked += 1;
      if (!topLevel.has(name)) nested += 1;
      if (!identifiers.has(name)) uncovered.push(`${alias.name}: \`${name}\``);
    }
  }
  t.diagnostic(`checked ${checked} input property names (${nested} below the top level)`);
  // Guard against a vacuous pass: the oracle must see top-level and nested names.
  assert.ok(checked > 0 && nested > 0, "the oracle reads top-level and nested property names");
  assert.deepEqual(uncovered, [], `inputs without a disposition in their From 8.x notes:\n${uncovered.join("\n")}`);
});

test("self-check: a note is read without its lead, with its continuation lines, and only for the tool its lead names", () => {
  const lines = [
    "- Replaces (8.x): `old-tool`.",
    "- From 8.x `old-tool` `task: \"x\"`: `omega` → `omega`; see `version-list` and `trace-symbol-lifecycle`.",
    "  - `alpha` → `beta`.",
    "- From 8.x `other-tool`: `gamma` → `delta`, as for `old-tool`.",
    "- Example: `{ \"zeta\": 1 }`"
  ];
  const notes = notesFor("old-tool", lines);
  assert.equal(notes.length, 1);
  const identifiers = backtickIdentifiers(notes[0]!);
  assert.ok(identifiers.has("alpha") && identifiers.has("omega"), "the note body and the continuation line are read");
  assert.ok(!identifiers.has("task") && !identifiers.has("old"), "the lead is not read");
  assert.ok(!identifiers.has("version") && !identifiers.has("symbol"), "spans that are a tool name are not read");
  assert.ok(!identifiers.has("gamma") && !identifiers.has("zeta"), "another tool's note and other bullets are not");
  assert.deepEqual(
    [...inputPropertyNames({
      properties: { subject: { anyOf: [{ properties: { kind: {}, focus: { properties: { deep: {} } } } }] }, entries: { items: { $ref: "#/$defs/e" } } },
      $defs: { e: { properties: { className: {} } } }
    } as SchemaNode)].sort(),
    ["className", "entries", "focus", "kind", "subject"]
  );
});
