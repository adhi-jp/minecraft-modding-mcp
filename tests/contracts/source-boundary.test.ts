import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import fastGlob from "fast-glob";

/**
 * One-way module boundary between the catalog (`src/tools/**`) and the 8.x
 * surface: the catalog may use entry-tool modules, but the entry-tool modules
 * and the 8.x registration code never depend on catalog code. The only shared
 * module is the dependency-free tool inventory.
 */

const INVENTORY = "src/tools/inventory.ts";

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]!);
}

/** Repository-relative `.ts` path of a relative import, or undefined for packages. */
function resolveImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return normalize(join(dirname(fromFile), specifier)).replace(/\\/g, "/").replace(/\.js$/, ".ts");
}

function isCatalogModule(path: string | undefined): boolean {
  return path !== undefined && path.startsWith("src/tools/") && path !== INVENTORY;
}

test("entry-tool modules import nothing from the catalog except the tool inventory", async () => {
  const files = await fastGlob("src/entry-tools/**/*.ts", { onlyFiles: true });
  assert.ok(files.length > 0, "the scan must see the entry-tool modules");
  const offenders: string[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(await readFile(file, "utf8"))) {
      if (isCatalogModule(resolveImport(file, specifier))) offenders.push(`${file} imports ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the entry-tool import matcher catches every import form of a catalog module", () => {
  const file = "src/entry-tools/sample.ts";
  const offending = (source: string) =>
    importSpecifiers(source).filter((specifier) => isCatalogModule(resolveImport(file, specifier)));
  for (const form of [
    'import { runCatalogTool } from "../tools/runner.js";',
    'import type { CatalogToolSpec } from "../tools/types.js";',
    'import * as catalog from "../tools/catalog.js";',
    'import catalogDefault from "../tools/catalog.js";',
    'export { runCatalogTool } from "../tools/runner.js";',
    'import "../tools/registration.js";',
    'const runner = await import("../tools/runner.js");'
  ]) {
    assert.equal(offending(form).length, 1, form);
  }
  assert.deepEqual(offending('import * as inventory from "../tools/inventory.js"; await import("../tools/inventory.js");'), []);
});

test("the tool inventory is dependency-free data", async () => {
  assert.deepEqual(importSpecifiers(await readFile(INVENTORY, "utf8")), []);
});

/**
 * Local names a source binds from catalog modules other than the inventory:
 * named (`{ a, b as c }`, `type { T }`), namespace (`* as ns`) and default
 * (`def`, also combined as `def, { a }` or `def, * as ns`) imports.
 */
function catalogBindings(source: string, fromFile: string): string[] {
  const bindings: string[] = [];
  const importStatement = /import\s+(?:type\s+)?([^"';]*?)\s+from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(importStatement)) {
    if (!isCatalogModule(resolveImport(fromFile, match[2]!))) continue;
    let clause = match[1]!.trim();
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1]!.split(",")) {
        const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
        if (local) bindings.push(local);
      }
      clause = clause.replace(named[0], "");
    }
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace) {
      bindings.push(namespace[1]!);
      clause = clause.replace(namespace[0], "");
    }
    const defaultName = /^\s*([A-Za-z_$][\w$]*)/.exec(clause);
    if (defaultName) bindings.push(defaultName[1]!);
  }
  return bindings;
}

/** Catalog modules other than the inventory loaded with a dynamic `import(...)` in `text`. */
function dynamicCatalogImports(text: string, fromFile: string): string[] {
  return [...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)]
    .map((match) => match[1]!)
    .filter((specifier) => isCatalogModule(resolveImport(fromFile, specifier)));
}

/** Uses of catalog code inside `region`: a bound catalog name or a dynamic catalog import. */
function catalogUses(region: string, bindings: readonly string[], fromFile: string): string[] {
  return [
    ...bindings.filter((binding) => new RegExp(`\\b${binding.replace(/\$/g, "\\$")}\\b`).test(region)),
    ...dynamicCatalogImports(region, fromFile).map((specifier) => `import(${specifier})`)
  ];
}

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `markers "${startMarker}" .. "${endMarker}" must be found`);
  return source.slice(start, end);
}

const RUNNER_START = "async function runTool<";
const REGISTRATIONS_START = 'registerAliasTool(server, "list-versions"';
const REGISTRATIONS_END = "// Deferred-registration executor";

function eightXRegions(source: string): Record<string, string> {
  return {
    "8.x runner": between(source, RUNNER_START, "\n}\n"),
    "8.x registrations": between(source, REGISTRATIONS_START, REGISTRATIONS_END)
  };
}

function eightXViolations(source: string): string[] {
  const bindings = catalogBindings(source, "src/index.ts");
  return Object.entries(eightXRegions(source)).flatMap(([label, region]) =>
    catalogUses(region, bindings, "src/index.ts").map((use) => `${label} uses ${use}`)
  );
}

test("the matcher catches named, type, namespace, default and dynamic catalog imports used by 8.x code", () => {
  const sample = (imports: string, use: string): string =>
    `${imports}\nasync function runTool<T>() {\n  ${use};\n}\n${REGISTRATIONS_START});\n${REGISTRATIONS_END}\n`;
  const cases: Array<[string, string, string]> = [
    ['import { runCatalogTool } from "./tools/runner.js";', "runCatalogTool()", "runCatalogTool"],
    ['import { runCatalogTool as run } from "./tools/runner.js";', "run()", "run"],
    ['import type { CatalogToolSpec } from "./tools/types.js";', "let spec: CatalogToolSpec", "CatalogToolSpec"],
    ['import * as catalog from "./tools/catalog.js";', "catalog.CATALOG_TOOL_SPECS", "catalog"],
    ['import catalogDefault from "./tools/catalog.js";', "catalogDefault()", "catalogDefault"],
    ['import first, { second } from "./tools/catalog.js";', "first()", "first"],
    ['import first, * as rest from "./tools/catalog.js";', "rest.x", "rest"],
    ["", 'await import("./tools/runner.js")', "import(./tools/runner.js)"]
  ];
  for (const [imports, use, expected] of cases) {
    assert.deepEqual(eightXViolations(sample(imports, use)), [`8.x runner uses ${expected}`], `${imports || use}`);
  }
  // The inventory stays allowed in every form.
  assert.deepEqual(
    eightXViolations(sample('import * as inventory from "./tools/inventory.js";', 'inventory.x; await import("./tools/inventory.js")')),
    []
  );
});

test("the 8.x registration code and runner in src/index.ts use no catalog module except the tool inventory", async () => {
  const source = await readFile("src/index.ts", "utf8");
  const bindings = catalogBindings(source, "src/index.ts");
  assert.ok(bindings.length > 0, "positive control: src/index.ts wires catalog registration");
  assert.deepEqual(eightXViolations(source), []);

  const regions = eightXRegions(source);
  const outside = Object.values(regions).reduce((text, region) => text.replace(region, ""), source);
  for (const binding of bindings) {
    assert.match(outside, new RegExp(`\\b${binding}\\b`), `positive control: ${binding} is used by the catalog wiring`);
  }
});
