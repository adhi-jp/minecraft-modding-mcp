import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { z } from "zod";

import {
  ALIAS_TOOL_INVENTORY,
  ALIAS_BATCH_TOOL_NAMES,
  ALIAS_ENTRY_TOOL_NAMES,
  ALIAS_HEAVY_TOOL_NAMES,
  CATALOG_HEAVY_TOOL_NAMES,
  CATALOG_TOOL_INVENTORY,
  CATALOG_TOOL_NAMES,
  LONG_RUNNING_TOOL_NAMES
} from "../../src/tools/inventory.ts";
import { CATALOG_TOOL_SPECS } from "../../src/tools/catalog.ts";
import {
  detailSchema,
  mappingSchema,
  numericInput,
  symbolSchema,
  targetSchema
} from "../../src/tools/schemas.ts";
import type { CatalogToolSpec } from "../../src/tools/types.ts";
import {
  CATALOG_SIZE_BUDGET,
  lintAnnotations,
  lintCatalogTool,
  lintExamplesAndStatuses,
  lintListedAnnotations,
  lintName,
  lintNumbers,
  lintSchemaShape,
  lintSize,
  lintVocabulary,
  listingSize,
  type ListedTool,
  type WriterOracle
} from "./catalog-lint.ts";
import { startCatalogSession } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-contract-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

/**
 * Independent oracle: the catalog tools that write files or mutate the cache,
 * with the effect hints the catalog table assigns them. Every other catalog
 * tool is read-only.
 */
const CATALOG_WRITERS: WriterOracle = new Map([
  ["artifact-index", { destructiveHint: false, idempotentHint: true }],
  ["source-export", { destructiveHint: true, idempotentHint: true }],
  ["mod-remap", { destructiveHint: true }],
  ["cache-manage", { destructiveHint: true }]
]);

const handler = async () => ({ result: { items: [] } });

/** A spec that satisfies every rule; the lint must report nothing for it. */
const conformingSpec: CatalogToolSpec = {
  name: "class-probe",
  title: "Class probe",
  description: "Test-only conforming spec.",
  annotations: { readOnlyHint: true },
  inputSchema: z.strictObject({
    target: targetSchema(["version", "artifact"]),
    symbols: z.array(symbolSchema).min(1).max(50),
    mapping: mappingSchema.optional(),
    limit: numericInput(z.number().int().min(1).max(50)).optional(),
    maxVersions: numericInput(z.number().int()).optional(),
    detail: detailSchema("summary"),
    typedJson: z.record(z.string(), z.unknown()).optional()
  }),
  examples: [
    {
      target: { kind: "version", version: "1.21.10" },
      symbols: [{ kind: "class", className: "net.minecraft.world.entity.Entity" }]
    }
  ],
  statuses: ["ok", "not_found"],
  handler
};

const conformingWriter: CatalogToolSpec = {
  name: "source-probe-export",
  description: "Test-only conforming writer.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: z.strictObject({ classes: z.array(z.string().min(1)).min(1).max(50) }),
  examples: [{ classes: ["a.B"] }],
  statuses: ["ok"],
  handler
};

const FIXTURE_WRITERS: WriterOracle = new Map([
  ["source-probe-export", { destructiveHint: true, idempotentHint: true }],
  ["class-probe-wrong-writer", { destructiveHint: true }]
]);

const nonConformingSpecs: CatalogToolSpec[] = [
  {
    name: "class-probe-shape",
    description: "Test-only spec with a combinator, an open object and deep nesting.",
    annotations: { readOnlyHint: true },
    inputSchema: z.strictObject({
      query: z.union([z.string(), z.array(z.string())]),
      selector: z.object({ status: z.string().optional() }).optional(),
      symbols: z.array(z.strictObject({ kind: z.strictObject({ name: z.string() }) })).optional()
    }),
    examples: [{ query: "a" }],
    statuses: ["ok"],
    handler
  },
  {
    name: "class-probe-vocabulary",
    description: "Test-only spec with drifted names.",
    annotations: { readOnlyHint: true },
    inputSchema: z.strictObject({
      sourceMapping: z.string().optional(),
      artifactId: z.string().optional(),
      jarPath: z.string().optional(),
      fancyKnob: z.boolean().optional(),
      target: z.strictObject({ kind: z.enum(["version"]), version: z.string() }).optional(),
      detail: z.enum(["summary", "standard", "full"]).optional()
    }),
    examples: [{}],
    statuses: ["ok"],
    handler
  },
  {
    name: "class-probe-number",
    description: "Test-only spec with a plain number.",
    annotations: { readOnlyHint: true },
    inputSchema: z.strictObject({ limit: z.number().int().optional() }),
    examples: [{}],
    statuses: ["ok"],
    handler
  },
  {
    name: "class-probe-size",
    description: "x".repeat(401),
    annotations: { readOnlyHint: true },
    inputSchema: z.strictObject({ query: z.string().describe("y".repeat(3_000)).optional() }),
    examples: [{}],
    statuses: ["ok"],
    handler
  },
  {
    name: "class-probe-wrong-writer",
    description: "Test-only writer that claims to be read-only.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.strictObject({}),
    examples: [{}],
    statuses: ["ok"],
    handler
  },
  {
    name: "class-probe-examples",
    description: "Test-only spec with an invalid example and an unknown status.",
    annotations: { readOnlyHint: true },
    inputSchema: z.strictObject({ query: z.string() }),
    examples: [{ query: "a", extra: 1 }],
    statuses: ["ok", "weird" as "ok"],
    handler
  }
];

const FIXTURE_SPECS = [conformingSpec, conformingWriter, ...nonConformingSpecs];

async function listWith(specs: readonly CatalogToolSpec[]): Promise<ListedTool[]> {
  const session = await startCatalogSession(specs);
  try {
    return (await session.listTools()) as ListedTool[];
  } finally {
    await session.close();
  }
}

let productionList: ListedTool[];
let fixtureList: Map<string, ListedTool>;

before(async () => {
  productionList = await listWith(CATALOG_TOOL_SPECS);
  fixtureList = new Map((await listWith(FIXTURE_SPECS)).map((tool) => [tool.name, tool]));
});

function listedFixture(name: string): ListedTool {
  const listed = fixtureList.get(name);
  assert.ok(listed, `fixture ${name} must be listed`);
  return listed;
}

test("the catalog spec names equal the inventory's catalog names", () => {
  assert.deepEqual(
    CATALOG_TOOL_SPECS.map((spec) => spec.name),
    CATALOG_TOOL_INVENTORY.map((entry) => entry.name)
  );
  assert.equal(new Set(CATALOG_TOOL_SPECS.map((spec) => spec.name)).size, CATALOG_TOOL_SPECS.length);
});

test("catalog and replacement names follow the <domain>-<verb> naming rule", () => {
  const planned = new Set([...CATALOG_TOOL_NAMES, ...ALIAS_TOOL_INVENTORY.flatMap((entry) => entry.replacedBy)]);
  assert.ok(planned.size > 0, "the naming rule must see at least one name");
  assert.deepEqual([...planned].flatMap(lintName), []);
});

test("every catalog tool passes the contract lint and the catalog fits its size budget", () => {
  const specByName = new Map(CATALOG_TOOL_SPECS.map((spec) => [spec.name, spec]));
  const listed = productionList.filter((tool) => CATALOG_TOOL_NAMES.has(tool.name));
  assert.deepEqual(
    listed.map((tool) => tool.name).sort(),
    [...CATALOG_TOOL_NAMES].sort(),
    "every catalog tool is listed"
  );
  const findings = listed.flatMap((tool) => lintCatalogTool(specByName.get(tool.name)!, tool, CATALOG_WRITERS));
  assert.deepEqual(findings, []);
  const total = listed.reduce((sum, tool) => sum + listingSize(tool), 0);
  assert.ok(total <= CATALOG_SIZE_BUDGET, `catalog advertisement is ${total} characters (budget ${CATALOG_SIZE_BUDGET})`);
});

test("every catalog tool names its primary result key, and a detail input comes with its projection", () => {
  for (const spec of CATALOG_TOOL_SPECS) {
    assert.equal(typeof spec.primaryKey, "string", `${spec.name} names its primary result key`);
    const listed = productionList.find((tool) => tool.name === spec.name);
    const properties = (listed?.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const detail = properties.detail;
    if (detail === undefined) {
      assert.equal(spec.detailProjection, undefined, `${spec.name} has no detail input, so no projection`);
      continue;
    }
    assert.ok(spec.detailProjection, `${spec.name} declares what each detail level keeps`);
    assert.equal(detail.default, spec.detailProjection.default, `${spec.name} advertises its projection default`);
    for (const reserved of [spec.primaryKey!, "status"]) {
      assert.equal(
        reserved in spec.detailProjection.minimumLevel,
        false,
        `${spec.name}: ${reserved} is kept at every detail level`
      );
    }
  }
});

test("the lint reports nothing for conforming test-only specs, including an open data document", () => {
  assert.deepEqual(lintCatalogTool(conformingSpec, listedFixture(conformingSpec.name), FIXTURE_WRITERS), []);
  assert.deepEqual(lintCatalogTool(conformingWriter, listedFixture(conformingWriter.name), FIXTURE_WRITERS), []);
  const listed = listedFixture(conformingSpec.name);
  const properties = listed.inputSchema?.properties as Record<string, Record<string, unknown>>;
  assert.notEqual(properties.typedJson?.additionalProperties, false, "the data document stays open");
  assert.equal(properties.target?.additionalProperties, false, "the target stays closed");
  assert.equal(properties.detail?.default, "summary", "detail advertises its default");
  assert.deepEqual(properties.maxVersions, { type: "integer" }, "an unbounded integer advertises no bound");
  assert.equal(
    JSON.stringify(listed.inputSchema).includes("9007199254740991"),
    false,
    "neither safe-integer bound (minimum -9007199254740991, maximum 9007199254740991) is advertised"
  );
});

function assertFindings(findings: string[], expected: RegExp[]): void {
  for (const pattern of expected) {
    assert.ok(
      findings.some((finding) => pattern.test(finding)),
      `expected a finding matching ${pattern}; got:\n${findings.join("\n")}`
    );
  }
}

test("the shape lint reports combinators, open control objects and deep nesting", () => {
  const listed = listedFixture("class-probe-shape");
  assertFindings(lintSchemaShape("class-probe-shape", listed.inputSchema), [
    /\$\.query uses anyOf/,
    /\$\.selector is an open object/,
    /\$\.symbols\[\]\.kind nests 3 levels/
  ]);
  assertFindings(lintSchemaShape("raw", { $schema: "x", type: "object", additionalProperties: false, $defs: {} }), [
    /uses \$schema/,
    /uses \$defs/
  ]);
});

test("the vocabulary lint reports drifted names, misplaced locators, a private target and an unadvertised detail default", () => {
  const spec = nonConformingSpecs.find((entry) => entry.name === "class-probe-vocabulary")!;
  assertFindings(lintVocabulary(spec, listedFixture(spec.name).inputSchema), [
    /\$\.sourceMapping is a retired 8\.x spelling/,
    /top-level artifactId/,
    /top-level jarPath outside the mod tools/,
    /\$\.fancyKnob is not in the catalog vocabulary/,
    /target is not the shared target schema/,
    /detail does not advertise its default/
  ]);
});

test("the number lint reports a number input that rejects numeric strings", () => {
  const spec = nonConformingSpecs.find((entry) => entry.name === "class-probe-number")!;
  assertFindings(lintNumbers(spec), [/\$\.limit is a number that rejects numeric strings/]);
  assert.deepEqual(lintNumbers(conformingSpec), []);
});

test("the size lint reports an oversized advertisement and description", () => {
  assertFindings(lintSize(listedFixture("class-probe-size")), [
    /advertisement is \d+ characters \(limit 3000\)/,
    /description is 401 characters \(limit 400\)/
  ]);
});

test("the annotation lint holds writers to the writer oracle", () => {
  const spec = nonConformingSpecs.find((entry) => entry.name === "class-probe-wrong-writer")!;
  assertFindings(lintAnnotations(spec, FIXTURE_WRITERS), [
    /writer must declare readOnlyHint: false/,
    /destructiveHint must be true/
  ]);
  assertFindings(lintAnnotations({ ...conformingSpec, annotations: {} }, FIXTURE_WRITERS), [
    /reading tool must declare readOnlyHint: true/
  ]);
});

test("the listing lint reports annotations that registration dropped or changed", () => {
  const listed = listedFixture(conformingWriter.name);
  assert.deepEqual(listed.annotations, conformingWriter.annotations, "registration advertises the spec's annotations");
  assert.deepEqual(lintListedAnnotations(conformingWriter, listed), []);
  assertFindings(lintListedAnnotations(conformingWriter, { ...listed, annotations: undefined }), [
    /listed annotations undefined differ/
  ]);
  assertFindings(
    lintListedAnnotations(conformingWriter, { ...listed, annotations: { ...listed.annotations, destructiveHint: false } }),
    [/listed annotations .* differ from the spec's/]
  );
});

test("the example and status lint reports an invalid example and an undeclared status", () => {
  const spec = nonConformingSpecs.find((entry) => entry.name === "class-probe-examples")!;
  assertFindings(lintExamplesAndStatuses(spec), [/example 0 does not validate/, /status "weird" is outside/]);
});

test("the naming lint reports names outside the rule", () => {
  assertFindings(lintName("Probe.Read"), [/not a lowercase kebab-case/]);
  assertFindings(lintName("find-class"), [/reuses an 8\.x tool name/, /not a lowercase kebab-case/]);
  assertFindings(lintName(`class-${"a".repeat(40)}`), [/longer than 32 characters/]);
});

test("the alias inventory covers each 8.x tool once with catalog replacements and the 8.x runner flags", () => {
  const names = ALIAS_TOOL_INVENTORY.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "no 8.x name appears twice");
  for (const entry of ALIAS_TOOL_INVENTORY) {
    assert.ok(entry.replacedBy.length > 0, `${entry.name} names a replacement`);
    assert.equal(new Set(entry.replacedBy).size, entry.replacedBy.length, `${entry.name} lists each replacement once`);
    for (const replacement of Object.values(entry.tasks ?? {})) {
      assert.ok(entry.replacedBy.includes(replacement), `${entry.name}: task tool ${replacement} is a replacement`);
    }
  }
  assert.deepEqual(
    ALIAS_TOOL_INVENTORY.filter((entry) => entry.tasks !== undefined).map((entry) => entry.name).sort(),
    ["analyze-mod", "analyze-symbol", "compare-minecraft", "inspect-minecraft", "validate-project"]
  );
  // Oracles: the heavy, entry and batch name sets the 8.x runner keys on, listed
  // independently of the inventory.
  assert.deepEqual([...ALIAS_HEAVY_TOOL_NAMES].sort(), [
    "compare-versions",
    "diff-class-signatures",
    "find-mapping",
    "get-class-api-matrix",
    "get-registry-data",
    "resolve-method-mapping-exact",
    "trace-symbol-lifecycle"
  ]);
  assert.deepEqual([...ALIAS_ENTRY_TOOL_NAMES].sort(), [
    "analyze-mod",
    "analyze-symbol",
    "compare-minecraft",
    "inspect-minecraft",
    "manage-cache",
    "validate-project"
  ]);
  assert.deepEqual([...ALIAS_BATCH_TOOL_NAMES].sort(), [
    "batch-class-members",
    "batch-class-source",
    "batch-mappings",
    "batch-symbol-exists"
  ]);
  assert.ok(LONG_RUNNING_TOOL_NAMES.has("validate-project"), "validate-project keeps its deadline");
  for (const name of LONG_RUNNING_TOOL_NAMES) {
    assert.ok(
      name === "validate-project" || CATALOG_TOOL_NAMES.has(name),
      `${name}: only validate-project and catalog tools are long-running`
    );
  }
});

test("the catalog tools behind the shared heavy-tool gate match an independent oracle", () => {
  // Oracle: the catalog tools that run behind the shared heavy-tool gate,
  // listed independently of the inventory.
  assert.deepEqual([...CATALOG_HEAVY_TOOL_NAMES].sort(), [
    "class-diff",
    "class-mappings",
    "registry-read",
    "symbol-map",
    "symbol-trace",
    "version-compare"
  ]);
});

test("the long-running tools match an independent oracle", () => {
  // Oracle: the tools that get the supervisor's deadline and run alone,
  // listed independently of the inventory.
  assert.deepEqual([...LONG_RUNNING_TOOL_NAMES].sort(), ["mixin-validate", "project-validate", "validate-project"]);
});
