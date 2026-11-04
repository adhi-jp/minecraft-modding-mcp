import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { z } from "zod";

import { buildSuggestedCall } from "../../src/build-suggested-call.ts";
import { createError, ERROR_CODES } from "../../src/errors.ts";
import { heavyToolExecutionGate } from "../../src/tool-execution-gate.ts";
import { ALIAS_TOOL_INVENTORY, isAliasToolName } from "../../src/tools/inventory.ts";
import { runCatalogTool } from "../../src/tools/runner.ts";
import { numericInput, TARGET_KINDS, targetSchema } from "../../src/tools/schemas.ts";
import { SERVICE_HINT_TRANSLATIONS, translateToolNamesInText } from "../../src/tools/translation.ts";
import { buildCatalogWarnings } from "../../src/tools/warnings.ts";
import type {
  CatalogHandlerOutput,
  CatalogRuntime,
  CatalogServices,
  CatalogToolSpec
} from "../../src/tools/types.ts";
import { startCatalogSession, type CatalogSession, type SessionFrame } from "./catalog-session.ts";

const root = mkdtempSync(join(tmpdir(), "catalog-runner-"));
process.env.MCP_CACHE_DIR = join(root, "cache");
process.env.MCP_SQLITE_PATH = join(root, "cache", "source-cache.db");

const PROBE = "probe-run";

/** Verbatim service notices: the two routine ones and an actionable one. */
const DECOMPILED_NOTICE =
  "Source is decompiled: method/accessor names may differ from the jar the workspace "
  + "compiles against. Confirm signatures with get-class-members (bytecode-derived) "
  + "before copying names from this source.";
const VERSION_RESOLUTION_NOTICE = "Resolved Minecraft 1.21.10 from https://example.invalid/client.jar.";
const SPACED_VERSION_RESOLUTION_NOTICE =
  "Resolved Minecraft 1.14 Pre-Release 5 from https://example.invalid/1.14-pre5/client.jar.";
const PARTIAL_COVERAGE_WARNING =
  "Artifact source coverage is partial and excludes net.minecraft; use get-class-source/get-class-members "
  + "for binary fallback or get-class-api-matrix for mappings.";
const FALLBACK_SENTENCE = "suggested call payload failed schema validation; using fallback examples";

const ALIAS_NAME_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(${ALIAS_TOOL_INVENTORY.map((entry) => entry.name).join("|")})(?![A-Za-z0-9_-])`
);

const SCENARIOS = [
  "ok",
  "app-error",
  "catalog-suggestion",
  "fallback-hint",
  "sqlite-corruption",
  "stage-budget",
  "nested-jars",
  "internal",
  "eight-x-suggestion"
] as const;

/** A suggestion's parameters carrying every locator an 8.x lookup tool takes. */
const EIGHT_X_SUGGESTION_PARAMS = {
  artifactId: "artifact-1",
  className: "net.minecraft.world.item.Item",
  target: { kind: "version", value: "1.21.10" },
  version: "1.21.10",
  jarPath: "/mods/example.jar",
  query: "Item"
};

/** The 8.x tool the "eight-x-suggestion" scenario suggests; chosen by its test. */
let suggestedEightXTool = "";

function okOutput(limit: number | undefined): CatalogHandlerOutput {
  return {
    result: { echoedLimit: limit ?? null, items: [{ status: "ok" }] },
    warnings: [
      DECOMPILED_NOTICE,
      VERSION_RESOLUTION_NOTICE,
      SPACED_VERSION_RESOLUTION_NOTICE,
      { code: "general", severity: "info", message: VERSION_RESOLUTION_NOTICE },
      { code: "general", severity: "info", message: DECOMPILED_NOTICE },
      PARTIAL_COVERAGE_WARNING,
      PARTIAL_COVERAGE_WARNING,
      "Mapping data was served from the local cache.",
      "The index was rebuilt before reading.",
      { code: "version-mismatch", severity: "warning", message: "Requested 1.21.10 but served 1.21.9." },
      { code: "version-mismatch", severity: "warning", message: "Requested 1.21.10 but served 1.21.9." }
    ],
    pagination: { hasMore: true, nextCursor: "cursor-1" },
    truncation: [{ field: "items", limitedBy: "limit" }],
    nextActions: [
      { tool: PROBE, params: { scenario: "ok", limit: 2 }, reason: "Read the next page, as search-class-source pages." },
      { tool: PROBE, params: { scenario: "ok", limit: 500 } },
      { tool: PROBE, params: { scenario: "ok", target: { kind: "version", version: "<version>" } }, template: true },
      { tool: PROBE, params: { scenario: "ok", target: { kind: "version", version: "<version>" } } },
      { tool: "list-versions", params: {} },
      { tool: "no-such-tool", params: {} }
    ],
    serviceSuggestedCalls: [
      {
        tool: "lookup-without-catalog-form",
        params: { className: "net.minecraft.world.item.Item", target: { kind: "version", value: "1.21.10" } }
      },
      { tool: PROBE, params: { scenario: "ok" }, reason: "Retry, or read it with get-class-source." },
      { tool: "not-a-known-tool", params: {} }
    ]
  };
}

const probeSpec: CatalogToolSpec = {
  name: PROBE,
  description: "Test-only catalog tool driving the runner.",
  annotations: { readOnlyHint: true },
  inputSchema: z.strictObject({
    scenario: z.enum(SCENARIOS),
    limit: numericInput(z.number().int().min(1).max(50)).optional(),
    target: targetSchema(["version", "artifact"]).optional()
  }),
  examples: [{ scenario: "ok" }],
  statuses: ["ok"],
  handler: async (input: { scenario: (typeof SCENARIOS)[number]; limit?: number }) => {
    switch (input.scenario) {
      case "ok":
        return okOutput(input.limit);
      case "app-error":
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: "Class not found; find-class resolves simple names.",
          details: {
            nextAction: "Use find-class to resolve the fully-qualified name, then get-class-source.",
            ...buildSuggestedCall({ tool: "lookup-without-catalog-form", params: { version: "1.21.10" } })
          }
        });
      case "catalog-suggestion":
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: "Class not found.",
          details: {
            ...buildSuggestedCall({ tool: PROBE, params: { scenario: "ok" } }),
            exampleCalls: [
              {
                tool: PROBE,
                params: { scenario: "ok", target: { kind: "version", version: "<version>" } },
                reason: "Pick a version, as list-versions shows them."
              }
            ]
          }
        });
      case "fallback-hint":
        throw fallbackHintError();
      case "sqlite-corruption":
        throw Object.assign(new Error("database disk image is malformed"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 11
        });
      case "stage-budget":
        throw createError({
          code: ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
          message: "Stage budget exhausted before parsing.",
          details: { stageBudgetExhausted: true, budgetMs: 50, elapsedMs: 75 }
        });
      case "nested-jars":
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: "Class not found in the shell jar; find-class searches its bundled jars.",
          details: {
            nestedJars: ["META-INF/jars/find-mapping.jar"],
            artifactId: "find-class-artifact",
            fieldErrors: [{ path: "get-class-source", message: "Not resolvable with get-class-source." }],
            nextAction: "Run find-class against one of nestedJars."
          }
        });
      case "internal":
        throw new Error("boom");
      case "eight-x-suggestion":
        return {
          result: { items: [] },
          serviceSuggestedCalls: [{ tool: suggestedEightXTool, params: EIGHT_X_SUGGESTION_PARAMS }]
        };
    }
  }
};

function fallbackHintError() {
  return createError({
    code: ERROR_CODES.CLASS_NOT_FOUND,
    message: "Class not found.",
    details: {
      nextAction: "Check the class name.",
      ...buildSuggestedCall({ tool: "list-versions", params: { limit: "not-a-number" } })
    }
  });
}

let session: CatalogSession;

before(async () => {
  session = await startCatalogSession([probeSpec]);
});

after(async () => {
  await session?.close();
});

type Envelope = {
  result?: Record<string, unknown>;
  error?: Record<string, unknown> & { fieldErrors?: Array<Record<string, unknown>>; hints?: string[] };
  meta: Record<string, unknown> & { nextActions?: unknown[]; warnings?: unknown[] };
};

function envelopeOf(frame: SessionFrame): { envelope: Envelope; isError: boolean; text: string } {
  assert.equal(frame.error, undefined, "a tool reply is a result, not a JSON-RPC error");
  const result = frame.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: Envelope;
    isError?: boolean;
  };
  assert.equal(result.content.length, 1);
  assert.deepEqual(
    JSON.parse(result.content[0]!.text),
    JSON.parse(JSON.stringify(result.structuredContent)),
    "text and structured content agree"
  );
  return { envelope: result.structuredContent, isError: result.isError === true, text: result.content[0]!.text };
}

async function call(args: unknown) {
  return envelopeOf(await session.callTool(PROBE, args));
}

test("a success returns { result, meta } with the request id, tool and duration", async () => {
  const { envelope, isError } = await call({ scenario: "ok" });
  assert.equal(isError, false);
  assert.deepEqual(Object.keys(envelope), ["result", "meta"]);
  assert.deepEqual(envelope.result, { echoedLimit: null, items: [{ status: "ok" }] });
  assert.equal(typeof envelope.meta.requestId, "string");
  assert.equal(envelope.meta.tool, PROBE);
  assert.equal(typeof envelope.meta.durationMs, "number");
});

test("warnings are structured and deduplicated by code and message, routine notices are dropped and 8.x names translated", async () => {
  const { envelope, text } = await call({ scenario: "ok" });
  assert.deepEqual(envelope.meta.warnings, [
    {
      code: "partial_coverage",
      severity: "warning",
      message:
        "Artifact source coverage is partial and excludes net.minecraft; use source-read/member-list "
        + "for binary fallback or class-mappings for mappings."
    },
    { code: "general", severity: "info", message: "Mapping data was served from the local cache." },
    { code: "general", severity: "info", message: "The index was rebuilt before reading." },
    { code: "version-mismatch", severity: "warning", message: "Requested 1.21.10 but served 1.21.9." }
  ]);
  assert.equal(text.includes("Source is decompiled"), false, "the decompiled-source notice is routine, string or structured");
  assert.equal(text.includes("Resolved Minecraft"), false, "version resolution notices are routine, including spaced ids");
  assert.doesNotMatch(text, ALIAS_NAME_PATTERN, "no 8.x tool name in the reply");
  assert.match(text, /source-read/, "the translated catalog name is present");
});

test("8.x tool names inside paths are kept while the same names in prose are translated", () => {
  const paths = [
    "/home/me/validate-mixin/gradle.properties",
    "C:\\mods\\find-class\\build.gradle",
    "/work/find-class",
    "config.validate-project",
    "find-class/src/main/java"
  ];
  for (const path of paths) {
    const text = `Read ${path}; use find-class.`;
    assert.equal(
      translateToolNamesInText(text, "project-validate"),
      `Read ${path}; use class-find.`,
      `${path} stays byte-identical while the prose name is translated`
    );
  }
  assert.deepEqual(
    buildCatalogWarnings(["No mixin config under /tmp/validate-mixin; try validate-mixin."], "mixin-validate").map(
      (warning) => warning.message
    ),
    ["No mixin config under /tmp/validate-mixin; try mixin-validate."]
  );
});

test("pagination and truncation are reported in meta", async () => {
  const { envelope } = await call({ scenario: "ok" });
  assert.deepEqual(envelope.meta.pagination, { hasMore: true, nextCursor: "cursor-1" });
  assert.deepEqual(envelope.meta.truncation, [{ field: "items", limitedBy: "limit" }]);
});

test("next actions keep valid catalog calls and flagged templates and drop everything else", async () => {
  const { envelope } = await call({ scenario: "ok" });
  assert.deepEqual(envelope.meta.nextActions, [
    { tool: PROBE, params: { scenario: "ok", limit: 2 }, reason: "Read the next page, as source-search pages." },
    { tool: PROBE, params: { scenario: "ok", target: { kind: "version", version: "<version>" } }, template: true },
    { tool: PROBE, params: { scenario: "ok" }, reason: "Retry, or read it with source-read." }
  ]);
});

test("an unknown key fails with ERR_INVALID_INPUT naming its path, with did-you-mean suggestions", async () => {
  const topLevel = await call({ scenario: "ok", limt: 3 });
  assert.equal(topLevel.isError, true);
  assert.equal(topLevel.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(topLevel.envelope.error?.fieldErrors, [
    {
      path: "limt",
      code: "unrecognized_keys",
      message: 'Unknown key "limt"; did you mean "limit"?',
      suggestions: ["limit"]
    }
  ]);

  const far = await call({ scenario: "ok", zzzzzzzzzz: 1 });
  assert.deepEqual(far.envelope.error?.fieldErrors, [
    { path: "zzzzzzzzzz", code: "unrecognized_keys", message: 'Unknown key "zzzzzzzzzz".' }
  ]);
});

test("an unknown target key fails with ERR_INVALID_INPUT naming target.<key>", async () => {
  const { envelope, isError } = await call({
    scenario: "ok",
    target: { kind: "version", version: "1.21.10", verison: "1.21.9" }
  });
  assert.equal(isError, true);
  assert.equal(envelope.error?.code, "ERR_INVALID_INPUT");
  const fieldError = envelope.error?.fieldErrors?.find((entry) => entry.path === "target.verison");
  assert.ok(fieldError, `fieldErrors must name target.verison: ${JSON.stringify(envelope.error?.fieldErrors)}`);
  assert.deepEqual(fieldError.suggestions, ["version"]);
});

test("an unknown target key is matched against the fields of the target's kind, and value names that kind's locator", async () => {
  const targetSpec: CatalogToolSpec = {
    ...probeSpec,
    name: "probe-target",
    inputSchema: z.strictObject({ target: targetSchema(TARGET_KINDS) }),
    examples: [{ target: { kind: "version", version: "1.21.10" } }],
    handler: async () => ({ result: {} })
  };
  const runtime: CatalogRuntime = {
    heavyGate: heavyToolExecutionGate,
    isHeavy: () => false,
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services: {} as CatalogServices
  };
  const fieldErrorsOf = async (target: Record<string, unknown>) => {
    const envelope = (await runCatalogTool(targetSpec, { target }, runtime)).structuredContent as Envelope;
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT", JSON.stringify(target));
    return envelope.error?.fieldErrors ?? [];
  };
  const suggestionsFor = async (target: Record<string, unknown>, key: string) =>
    (await fieldErrorsOf(target)).find((entry) => entry.path === `target.${key}`)?.suggestions;

  const locators: Record<string, string[]> = {
    artifact: ["artifactId"],
    version: ["version"],
    jar: ["jarPath"],
    coordinate: ["coordinate"],
    workspace: ["projectPath"],
    dependency: ["group", "name"]
  };
  for (const kind of TARGET_KINDS) {
    const fieldError = (await fieldErrorsOf({ kind, value: "x" })).find((entry) => entry.path === "target.value");
    assert.deepEqual(fieldError?.suggestions, locators[kind], `value with kind ${kind}`);
    assert.match(String(fieldError?.message), new RegExp(`^Unknown key "value"; target kind "${kind}" takes "`));
  }

  assert.equal(
    await suggestionsFor({ kind: "version", version: "1.21.10", jarPth: "/a.jar" }, "jarPth"),
    undefined,
    "a jar field is not offered with kind version"
  );
  assert.deepEqual(
    await suggestionsFor({ kind: "jar", jarPath: "/a.jar", jarPth: "/a.jar" }, "jarPth"),
    ["jarPath"],
    "positive control: the jar field is offered with kind jar"
  );
  assert.equal(
    await suggestionsFor({ kind: "workspace", projectPath: "/p", nmae: "x" }, "nmae"),
    undefined,
    "a dependency field is not offered with kind workspace"
  );
  assert.deepEqual(await suggestionsFor({ kind: "dependency", group: "g", dependencyVersion: "1", nmae: "x" }, "nmae"), ["name"]);

  const kindless = await fieldErrorsOf({ verison: "1.21.10" });
  assert.ok(kindless.some((entry) => entry.path === "target.kind"), "the missing kind is named");
  assert.ok(
    kindless.find((entry) => entry.path === "target.verison")?.suggestions?.includes("version"),
    "without a kind, every declared field is compared"
  );
  assert.ok(
    (await suggestionsFor({ kind: "bogus", jarPth: "/a.jar" }, "jarPth"))?.includes("jarPath"),
    "with a kind the target does not take, every declared field is compared"
  );
});

test("a misplaced key and a locator the target kind does not take fail with ERR_INVALID_INPUT", async () => {
  const misplaced = await call({ scenario: "ok", version: "1.21.10" });
  assert.equal(misplaced.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.equal(misplaced.envelope.error?.fieldErrors?.[0]?.path, "version");

  const wrongLocator = await call({ scenario: "ok", target: { kind: "artifact", version: "1.21.10" } });
  assert.equal(wrongLocator.envelope.error?.code, "ERR_INVALID_INPUT");
  assert.deepEqual(
    wrongLocator.envelope.error?.fieldErrors?.map((entry) => entry.path).sort(),
    ["target.artifactId", "target.version"]
  );
});

test("numbers accept numeric strings and nothing else is coerced", async () => {
  assert.equal((await call({ scenario: "ok", limit: "7" })).envelope.result?.echoedLimit, 7);
  assert.equal((await call({ scenario: "ok", limit: 7 })).envelope.result?.echoedLimit, 7);
  for (const limit of ["seven", true, ""]) {
    const { envelope } = await call({ scenario: "ok", limit });
    assert.equal(envelope.error?.code, "ERR_INVALID_INPUT", `limit ${JSON.stringify(limit)} is rejected`);
    assert.equal(envelope.error?.fieldErrors?.[0]?.path, "limit");
  }
});

test("a validation failure maps to the catalog invalid-input problem, an AppError through mapErrorToProblem", async () => {
  const invalid = await call({ scenario: "unknown-scenario" });
  assert.equal(invalid.envelope.error?.title, "Invalid input");
  assert.equal(invalid.envelope.error?.status, 400);
  assert.equal(invalid.envelope.error?.retryClass, "input");
  assert.deepEqual(Object.keys(invalid.envelope.meta).sort(), ["durationMs", "requestId", "tool"]);

  const appError = await call({ scenario: "app-error" });
  assert.equal(appError.isError, true);
  assert.equal(appError.envelope.error?.title, "Tool execution error");
  assert.equal(appError.envelope.error?.code, "ERR_CLASS_NOT_FOUND");
  assert.equal(appError.envelope.error?.detail, "Class not found; class-find resolves simple names.");
  assert.deepEqual(appError.envelope.error?.hints, [
    "Use class-find to resolve the fully-qualified name, then source-read."
  ]);
  assert.equal("suggestedCall" in (appError.envelope.error ?? {}), false, "suggestions never stay in error");
  assert.equal(appError.envelope.meta.nextActions, undefined, "a suggestion without a catalog counterpart is dropped");
  assert.doesNotMatch(appError.text, ALIAS_NAME_PATTERN);
  assert.match(appError.text, /class-find/);
});

test("a service suggestion naming an 8.x tool whose translator has no catalog form is dropped", async (t) => {
  const dropped = Object.keys(SERVICE_HINT_TRANSLATIONS).find(
    (name) =>
      isAliasToolName(name) &&
      SERVICE_HINT_TRANSLATIONS[name]!({ tool: name, params: EIGHT_X_SUGGESTION_PARAMS }) === undefined
  );
  if (dropped === undefined) {
    t.skip("every translated 8.x tool has a catalog form for this suggestion");
    return;
  }
  suggestedEightXTool = dropped;
  const { envelope, text } = await call({ scenario: "eight-x-suggestion" });
  assert.equal(envelope.error, undefined);
  assert.equal(envelope.meta.nextActions, undefined, `the ${dropped} suggestion is dropped`);
  assert.equal(text.includes(`"${dropped}"`), false);
});

test("an error's suggested and example calls move into validated meta.nextActions", async () => {
  const { envelope, text } = await call({ scenario: "catalog-suggestion" });
  assert.equal("suggestedCall" in (envelope.error ?? {}), false);
  assert.equal("exampleCalls" in (envelope.error ?? {}), false);
  assert.deepEqual(envelope.meta.nextActions, [
    { tool: PROBE, params: { scenario: "ok" } },
    {
      tool: PROBE,
      params: { scenario: "ok", target: { kind: "version", version: "<version>" } },
      reason: "Pick a version, as version-list shows them.",
      template: true
    }
  ]);
  assert.doesNotMatch(text, ALIAS_NAME_PATTERN);
});

test("the internal suggestion-fallback sentence never reaches a catalog reply", async () => {
  const { mapErrorToProblem } = await import("../../src/tool-guidance.ts");
  const eightXProblem = mapErrorToProblem(fallbackHintError(), "positive-control", { tool: "list-versions" });
  assert.ok(eightXProblem.hints?.includes(FALLBACK_SENTENCE), "positive control: the 8.x mapping appends it");

  const { envelope, text } = await call({ scenario: "fallback-hint" });
  assert.equal(text.includes(FALLBACK_SENTENCE), false);
  assert.deepEqual(envelope.error?.hints, ["Check the class name."]);
});

test("error translation rewrites prose only and keeps data fields such as nestedJars unchanged", async () => {
  const { envelope, text } = await call({ scenario: "nested-jars" });
  assert.equal(envelope.error?.code, "ERR_CLASS_NOT_FOUND");
  assert.equal(envelope.error?.detail, "Class not found in the shell jar; class-find searches its bundled jars.");
  assert.deepEqual(envelope.error?.hints, ["Run class-find against one of nestedJars."]);
  assert.deepEqual(envelope.error?.nestedJars, ["META-INF/jars/find-mapping.jar"], "data keeps the 8.x-looking name");
  assert.deepEqual(envelope.error?.context, { artifactId: "find-class-artifact" });
  assert.deepEqual(envelope.error?.fieldErrors, [
    { path: "get-class-source", message: "Not resolvable with source-read." }
  ]);
  assert.equal(text.includes("Run find-class"), false);
});

test("a raw SQLite corruption error becomes ERR_DB_FAILURE and a non-AppError becomes ERR_INTERNAL", async () => {
  const corruption = await call({ scenario: "sqlite-corruption" });
  assert.equal(corruption.envelope.error?.code, "ERR_DB_FAILURE");
  assert.match(String(corruption.envelope.error?.hints?.[0]), /restart/i);

  const internal = await call({ scenario: "internal" });
  assert.equal(internal.envelope.error?.code, "ERR_INTERNAL");
  assert.equal(internal.envelope.error?.detail, "Unexpected server error.");
});

test("a stage-budget failure publishes the budget fields in meta", async () => {
  const { envelope } = await call({ scenario: "stage-budget" });
  assert.equal(envelope.error?.code, "ERR_STAGE_BUDGET_PRE_PARSE");
  assert.equal(envelope.meta.stageBudgetExhausted, true);
  assert.equal(envelope.meta.budgetMs, 50);
  assert.equal(envelope.meta.elapsedMs, 75);
});

test("catalog calls are counted in the per-tool runtime metrics, successes and failures alike", async () => {
  const { sourceService } = await import("../../src/index.ts");
  const countOf = () => sourceService.getRuntimeMetrics().tool_call_counts[PROBE] ?? 0;
  const before = countOf();
  await call({ scenario: "ok" });
  await call({ scenario: "app-error" });
  await call({ scenario: "ok", bogus: true });
  assert.equal(countOf(), before + 3);
});

test("heavy catalog calls share the 8.x tools' heavy-tool gate and light calls bypass it", async () => {
  const runtime: CatalogRuntime = {
    heavyGate: heavyToolExecutionGate,
    isHeavy: (tool) => tool === "probe-heavy",
    recordToolCall: () => {},
    sqlitePath: process.env.MCP_SQLITE_PATH!,
    services: {} as CatalogServices
  };
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blockingSpec: CatalogToolSpec = {
    ...probeSpec,
    name: "probe-heavy",
    inputSchema: z.strictObject({}),
    examples: [{}],
    handler: async () => {
      await opened;
      return { result: { done: true } };
    }
  };
  const lightSpec: CatalogToolSpec = {
    ...blockingSpec,
    name: "probe-light",
    handler: async () => ({ result: { light: true } })
  };
  // One running and two queued fill the shared gate (1 running, queue 2).
  const held = [1, 2, 3].map(() => runCatalogTool(blockingSpec, {}, runtime));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const eightX = envelopeOf(await session.callTool("get-registry-data", { version: "1.21.10" }));
  assert.equal(eightX.envelope.error?.code, "ERR_LIMIT_EXCEEDED", "an 8.x heavy call overflows the shared queue");

  const overflow = await runCatalogTool(blockingSpec, {}, runtime);
  const overflowEnvelope = overflow.structuredContent as Envelope;
  assert.equal(overflowEnvelope.error?.code, "ERR_LIMIT_EXCEEDED", "a fourth heavy catalog call overflows too");
  assert.equal(JSON.stringify(overflowEnvelope).includes("batch-mappings"), false);

  // While the gate is still saturated, a light call runs at once instead of overflowing.
  const light = await runCatalogTool(lightSpec, {}, runtime);
  assert.deepEqual((light.structuredContent as Envelope).result, { light: true }, "a non-heavy call bypasses the gate");
  const lightThroughServer = await call({ scenario: "ok" });
  assert.equal(lightThroughServer.isError, false, "a non-heavy catalog tool on the server bypasses the gate");

  release();
  for (const reply of await Promise.all(held)) {
    assert.deepEqual((reply.structuredContent as Envelope).result, { done: true });
  }
});
