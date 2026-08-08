/**
 * Pre-migration baseline capture — registry-driven invalid-input ProblemDetails capture.
 *
 * Run with: node --import tsx scripts/premigration/capture-problemdetails.mjs [--validate-only]
 *
 * Registry-driven (see schema-registry.mjs): parses src/index.ts for
 * `registerToolSchema("<name>", <ident>)` pairs and imports each schema from
 * its defining module (import-pure; no server bootstrap).
 *
 * For each DISTINCT Zod failure KIND observed across the registered schemas it
 * generates ONE invalid-inputs case (kind templates below; a case is selected
 * only when an OFFLINE schema.safeParse proves the candidate fails with
 * exactly that kind, so no live call can accidentally trigger real work),
 * plus the MANDATORY `arguments`-omitted-entirely cases (the approved decision's
 * golden: one all-optional/defaulted shape-registered tool — today an error,
 * post-migration a success — one required-field tool for the error-text-class
 * shift, and one schema-less registration which already succeeds today; the
 * all-optional fixture also enumerates every registration whose schema
 * accepts {}).
 *
 * Every selected case is then sent over the wire as tools/call to the live
 * production server (default flag config, legacy handshake) and the full
 * JSON-RPC reply envelope is captured and normalized (lib.mjs rules N1-N5)
 * into tests/fixtures/premigration/problemdetails/<kind>.json.
 */

import {
  ServerSession,
  normalizeCaptured,
  writeFixture,
  scratchPath
} from "./lib.mjs";
import {
  loadRegistry,
  typeName,
  unwrapField,
  unwrapEffects,
  baseObject,
  isOptionalLike,
  numberChecks,
  stringHasMin,
  minimalValue,
  minimalValidObject,
  offlineKinds,
  WRONG_PRIMITIVE
} from "./schema-registry.mjs";

const validateOnly = process.argv.includes("--validate-only");

const { tools, registrationHasShape } = await loadRegistry();
console.log(`registry: ${tools.length} registered tool schemas discovered`);

// ---------------------------------------------------------------------------
// Kind templates — one clean candidate per distinct failure kind
// ---------------------------------------------------------------------------

/**
 * Each template yields candidate params for a tool, or undefined.
 * Candidates are accepted only when offline safeParse fails with EXACTLY the
 * template's kind (clean case), guaranteeing single-kind fixtures.
 */
const KIND_TEMPLATES = [
  {
    kind: "invalid_type.missing-required",
    build(entry) {
      const object = baseObject(entry.schema);
      if (!object) return undefined;
      const hasRequired = Object.values(object.shape).some((field) => !isOptionalLike(field));
      return hasRequired ? [{}] : undefined;
    }
  },
  {
    kind: "invalid_type.wrong-type",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        const base = unwrapField(object.shape[key]);
        const wrong = WRONG_PRIMITIVE[typeName(base)];
        if (wrong !== undefined) candidates.push({ ...minimal, [key]: wrong });
      }
      return candidates;
    }
  },
  {
    kind: "invalid_enum_value",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        if (typeName(unwrapField(object.shape[key])) === "ZodEnum") {
          candidates.push({ ...minimal, [key]: "__premigration_bogus_enum__" });
        }
      }
      return candidates;
    }
  },
  {
    kind: "unrecognized_keys",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        const base = unwrapField(object.shape[key]);
        // strict object directly …
        if (typeName(base) === "ZodObject" && base._def.unknownKeys === "strict") {
          const inner = minimalValue(base);
          if (inner !== undefined) {
            candidates.push({ ...minimal, [key]: { ...inner, __premigrationUnknownKey: true } });
          }
        }
        // … or an array of strict objects (e.g. batch entries).
        if (typeName(base) === "ZodArray") {
          const element = unwrapEffects(unwrapField(base._def.type));
          if (typeName(element) === "ZodObject" && element._def.unknownKeys === "strict") {
            const inner = minimalValue(element);
            if (inner !== undefined) {
              candidates.push({ ...minimal, [key]: [{ ...inner, __premigrationUnknownKey: true }] });
            }
          }
        }
      }
      return candidates;
    }
  },
  {
    kind: "too_small.array",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        const base = unwrapField(object.shape[key]);
        if (typeName(base) === "ZodArray" && (base._def.minLength?.value ?? 0) >= 1) {
          candidates.push({ ...minimal, [key]: [] });
        }
      }
      return candidates;
    }
  },
  {
    kind: "too_small.number",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        const base = unwrapField(object.shape[key]);
        if (typeName(base) === "ZodNumber") {
          const { min } = numberChecks(base);
          if (min !== undefined && min >= 1) candidates.push({ ...minimal, [key]: 0 });
        }
      }
      return candidates;
    }
  },
  {
    kind: "too_small.string",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        const base = unwrapField(object.shape[key]);
        if (typeName(base) === "ZodString" && stringHasMin(base)) {
          candidates.push({ ...minimal, [key]: "" });
        }
      }
      return candidates;
    }
  },
  {
    kind: "too_big.number",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        const base = unwrapField(object.shape[key]);
        if (typeName(base) === "ZodNumber") {
          const { max } = numberChecks(base);
          if (max !== undefined) candidates.push({ ...minimal, [key]: max + 91 });
        }
      }
      return candidates;
    }
  },
  {
    kind: "invalid_union_discriminator",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        const base = unwrapField(object.shape[key]);
        if (typeName(base) === "ZodDiscriminatedUnion") {
          candidates.push({ ...minimal, [key]: { [base._def.discriminator]: "__premigration_bogus__" } });
        }
      }
      return candidates;
    }
  },
  {
    kind: "invalid_union",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        if (typeName(unwrapField(object.shape[key])) === "ZodUnion") {
          candidates.push({ ...minimal, [key]: { __premigrationNoMatch: true } });
        }
      }
      return candidates;
    }
  },
  {
    kind: "invalid_type.record-value",
    build(entry, minimal) {
      const object = baseObject(entry.schema);
      if (!object || minimal === undefined) return undefined;
      const candidates = [];
      for (const key of Object.keys(object.shape).sort()) {
        if (typeName(unwrapField(object.shape[key])) === "ZodRecord") {
          candidates.push({ ...minimal, [key]: { premigrationKey: { wrong: "shape" } } });
        }
      }
      return candidates;
    }
  },
  {
    kind: "custom",
    build(entry) {
      // superRefine violations: the minimal BASE object parses at object level
      // but the effects chain rejects it (e.g. exactly-one-of constraints).
      const object = baseObject(entry.schema);
      if (!object || unwrapEffects(entry.schema) === entry.schema) return undefined;
      const minimalBase = minimalValue(object);
      return minimalBase === undefined ? undefined : [minimalBase];
    }
  }
];

const selectedCases = [];
const unachievableKinds = [];
for (const template of KIND_TEMPLATES) {
  let selected;
  for (const entry of tools) {
    const minimal = minimalValidObject(entry);
    const candidates = template.build(entry, minimal) ?? [];
    for (const candidate of candidates) {
      const observed = offlineKinds(entry.schema, candidate);
      if (!observed) continue;
      const expectedKind =
        template.kind === "invalid_type.record-value" ? "invalid_type.wrong-type" : template.kind;
      if (observed.kinds.length === 1 && observed.kinds[0] === expectedKind) {
        selected = { kind: template.kind, tool: entry.tool, params: candidate, offline: observed };
        break;
      }
    }
    if (selected) break;
  }
  if (selected) selectedCases.push(selected);
  else unachievableKinds.push(template.kind);
}

// ---------------------------------------------------------------------------
// Omitted-arguments goldens: `arguments` omitted entirely
// ---------------------------------------------------------------------------

const acceptsEmptyObject = tools
  .filter((entry) => entry.schema.safeParse({}).success)
  .map((entry) => ({ tool: entry.tool, registeredWithShape: registrationHasShape(entry.tool) }));
const allOptionalTool = tools.find(
  (entry) =>
    entry.schema.safeParse({}).success &&
    registrationHasShape(entry.tool) &&
    !entry.schema.safeParse(undefined).success
);
const requiredFieldTool = tools.find(
  (entry) => !entry.schema.safeParse({}).success && registrationHasShape(entry.tool)
);
const noShapeTool = tools.find((entry) => !registrationHasShape(entry.tool));
const omittedArgumentsCases = [
  {
    kind: "omitted-arguments.all-optional",
    tool: allOptionalTool.tool,
    params: undefined,
    expectError: true,
    omittedArguments: {
      note: "Omitted-arguments golden: shape-registered schema accepts {}. Today this call is a ProblemDetails validation error (schema.parse(undefined) fails); under the approved class merge it becomes a success post-migration.",
      acceptsEmptyObjectRegistrations: acceptsEmptyObject
    }
  },
  {
    kind: "omitted-arguments.required-fields",
    tool: requiredFieldTool.tool,
    params: undefined,
    expectError: true,
    omittedArguments: {
      note: "Omitted-arguments golden: schema has required fields. The call stays an error post-migration; the error-text class shifts from top-level 'expected object, received undefined' to per-field messages."
    }
  },
  ...(noShapeTool
    ? [
        {
          kind: "omitted-arguments.no-input-shape",
          tool: noShapeTool.tool,
          params: undefined,
          expectError: false,
          omittedArguments: {
            note: "Context golden: this registration passes no params schema to the SDK, so an omitted-arguments call already SUCCEEDS today (the SDK invokes the handler without a validated args value and the passthrough schema accepts it). Not part of the approved error->success class."
          }
        }
      ]
    : [])
];

console.log(`kinds selected: ${selectedCases.map((c) => `${c.kind}(${c.tool})`).join(", ")}`);
console.log(`kinds with no occurrence in registered schemas: ${unachievableKinds.join(", ") || "(none)"}`);
console.log(
  `omitted-arguments goldens: all-optional=${allOptionalTool.tool}, required-fields=${requiredFieldTool.tool}, no-input-shape=${noShapeTool?.tool ?? "(none)"}`
);
console.log(`registrations whose schema accepts {}: ${JSON.stringify(acceptsEmptyObject)}`);

// ---------------------------------------------------------------------------
// Wire capture against the live server (default flag config)
// ---------------------------------------------------------------------------

const session = new ServerSession({
  label: "problemdetails",
  env: {},
  pidFile: scratchPath("run", "problemdetails.pid")
}).start();

let failures = 0;
try {
  await session.handshake();
  const allCases = [...selectedCases, ...omittedArgumentsCases];
  for (const testCase of allCases) {
    const params = {
      name: testCase.tool,
      ...(testCase.params !== undefined ? { arguments: testCase.params } : {})
    };
    const { request, reply } = session.request("tools/call", params, { timeoutMs: 60_000 });
    const message = await reply;
    const isErrorResult = message.result?.isError === true;
    const problemCode = message.result?.structuredContent?.error?.code;
    const expectError = testCase.expectError ?? true;
    console.log(`[${testCase.kind}] tool=${testCase.tool} isError=${isErrorResult} problemCode=${problemCode}`);
    if (isErrorResult !== expectError) {
      failures += 1;
      console.error(
        `[${testCase.kind}] expected isError=${expectError}, got: ${JSON.stringify(message).slice(0, 400)}`
      );
      continue;
    }
    if (!validateOnly) {
      const fileName = `problemdetails/${testCase.kind.replaceAll(".", "-")}.json`;
      writeFixture(fileName, {
        description:
          "Pre-migration ProblemDetails envelope golden for one Zod failure kind. Captured over the wire against the untouched SDK v1 build; legacy handshake; default flag config.",
        harness: "scripts/premigration/capture-problemdetails.mjs",
        env: session.recordedEnv(),
        zodFailureKind: testCase.kind,
        tool: testCase.tool,
        sentParams: testCase.params === undefined ? { __argumentsOmitted: true } : testCase.params,
        offlineZodIssues: testCase.offline?.issues,
        ...(testCase.omittedArguments ? { omittedArguments: testCase.omittedArguments } : {}),
        request: normalizeCaptured(request),
        reply: normalizeCaptured(message)
      });
      console.log(`[${testCase.kind}] fixture written: ${fileName}`);
    }
  }
} finally {
  await session.stop();
}

if (failures > 0) {
  console.error(`FAILED: ${failures} case(s) did not match the expected envelope class`);
  process.exit(1);
}
console.log("problemdetails capture: OK");
