/**
 * Registry-driven schema discovery + Zod v3 introspection helpers shared by
 * the pre-migration capture harnesses.
 *
 * Discovery parses src/index.ts for `registerToolSchema("<name>", <ident>)`
 * pairs and resolves each ident through index.ts's own import statements, then
 * imports the schema from its defining module (src/tool-schemas.ts and
 * src/entry-tools/*-service.ts are import-pure — no server bootstrap).
 *
 * Must run under `node --import tsx` (imports .ts modules).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./lib.mjs";

export async function loadRegistry() {
  const indexSource = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");

  const registrations = [];
  for (const match of indexSource.matchAll(/registerToolSchema\(\s*"([^"]+)"\s*,\s*([A-Za-z0-9_$]+)\s*\)/g)) {
    registrations.push({ tool: match[1], schemaIdent: match[2] });
  }
  if (registrations.length === 0) {
    throw new Error("No registerToolSchema pairs found in src/index.ts");
  }

  const identToModule = new Map();
  for (const match of indexSource.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(\.[^"]+)"/gs)) {
    const names = match[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (!identToModule.has(name)) identToModule.set(name, match[2]);
    }
  }

  const moduleCache = new Map();
  async function importSchemaModule(relativeJsPath) {
    if (!moduleCache.has(relativeJsPath)) {
      const tsPath = join(
        REPO_ROOT,
        "src",
        relativeJsPath.replace(/^\.\//, "").replace(/\.js$/, ".ts")
      );
      moduleCache.set(relativeJsPath, await import(pathToFileURL(tsPath).href));
    }
    return moduleCache.get(relativeJsPath);
  }

  const tools = [];
  for (const { tool, schemaIdent } of registrations) {
    const modulePath = identToModule.get(schemaIdent);
    if (!modulePath) throw new Error(`No import found for schema ident ${schemaIdent} (tool ${tool})`);
    const module = await importSchemaModule(modulePath);
    const schema = module[schemaIdent];
    if (!schema || typeof schema.safeParse !== "function") {
      throw new Error(`Import ${schemaIdent} from ${modulePath} is not a Zod schema (tool ${tool})`);
    }
    tools.push({ tool, schemaIdent, modulePath, schema });
  }
  tools.sort((a, b) => a.tool.localeCompare(b.tool));

  /**
   * Whether the server.tool()/expertTool() registration passes a params-shape
   * argument to the SDK. Anchored on the registration call itself, NOT on
   * runTool(...) — `runTool` also ends in "Tool(".
   */
  function registrationHasShape(toolName) {
    const starts = [`.tool("${toolName}"`, `expertTool("${toolName}"`]
      .map((marker) => indexSource.indexOf(marker))
      .filter((index) => index >= 0);
    if (starts.length === 0) return false;
    const start = Math.min(...starts);
    const end = indexSource.indexOf(`runTool("${toolName}"`, start);
    if (end < 0) return false;
    const snippet = indexSource.slice(start, end);
    return /\b[A-Za-z0-9_]+Shape\b/.test(snippet);
  }

  return { indexSource, tools, registrationHasShape };
}

// ---------------------------------------------------------------------------
// Zod (v3) introspection
// ---------------------------------------------------------------------------

export function typeName(schema) {
  return schema?._def?.typeName;
}

/** Unwrap Optional/Default/Nullable wrappers (NOT effects). */
export function unwrapField(schema) {
  let current = schema;
  for (;;) {
    const name = typeName(current);
    if (name === "ZodOptional" || name === "ZodNullable") current = current._def.innerType;
    else if (name === "ZodDefault") current = current._def.innerType;
    else return current;
  }
}

export function isOptionalLike(schema) {
  const name = typeName(schema);
  return (
    name === "ZodOptional" ||
    name === "ZodDefault" ||
    (name === "ZodEffects" && isOptionalLike(schema._def.schema))
  );
}

/** Unwrap ZodEffects chains to the base schema. */
export function unwrapEffects(schema) {
  let current = schema;
  while (typeName(current) === "ZodEffects") current = current._def.schema;
  return current;
}

/** The top-level ZodObject of a registered tool schema, or undefined. */
export function baseObject(schema) {
  const base = unwrapEffects(schema);
  return typeName(base) === "ZodObject" ? base : undefined;
}

export function numberChecks(schema) {
  const checks = schema?._def?.checks ?? [];
  const result = {};
  for (const check of checks) {
    if (check.kind === "min") result.min = check.value + (check.inclusive === false ? 1 : 0);
    if (check.kind === "max") result.max = check.value - (check.inclusive === false ? 1 : 0);
    if (check.kind === "int") result.int = true;
  }
  return result;
}

export function stringHasMin(schema) {
  return (schema?._def?.checks ?? []).some((check) => check.kind === "min" && check.value >= 1);
}

/** Build a minimally valid value for a schema; returns undefined when unsupported. */
export function minimalValue(schema, depth = 0) {
  if (depth > 8) return undefined;
  const name = typeName(schema);
  switch (name) {
    case "ZodEffects":
      return minimalValue(schema._def.schema, depth + 1);
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return minimalValue(unwrapField(schema), depth + 1);
    case "ZodString":
      return "premigration";
    case "ZodNumber": {
      const { min } = numberChecks(schema);
      return min !== undefined && min > 1 ? min : 1;
    }
    case "ZodBoolean":
      return true;
    case "ZodEnum":
      return schema._def.values[0];
    case "ZodLiteral":
      return schema._def.value;
    case "ZodArray": {
      const minLength = schema._def.minLength?.value ?? 0;
      if (minLength === 0) return [];
      const element = minimalValue(schema._def.type, depth + 1);
      if (element === undefined) return undefined;
      return Array.from({ length: minLength }, () => element);
    }
    case "ZodObject": {
      const result = {};
      for (const [key, field] of Object.entries(schema.shape)) {
        if (isOptionalLike(field)) continue;
        const value = minimalValue(field, depth + 1);
        if (value === undefined) return undefined;
        result[key] = value;
      }
      return result;
    }
    case "ZodDiscriminatedUnion": {
      const [first] = schema._def.options instanceof Map
        ? [...schema._def.options.values()]
        : schema._def.options;
      return minimalValue(first, depth + 1);
    }
    case "ZodUnion": {
      for (const option of schema._def.options) {
        const value = minimalValue(option, depth + 1);
        if (value !== undefined) return value;
      }
      return undefined;
    }
    case "ZodRecord":
      return {};
    default:
      return undefined;
  }
}

/** Minimal object of required top-level keys that validates against the FULL schema. */
export function minimalValidObject(toolEntry) {
  const object = baseObject(toolEntry.schema);
  if (!object) return undefined;
  const minimal = minimalValue(object);
  if (minimal === undefined) return undefined;
  return toolEntry.schema.safeParse(minimal).success ? minimal : undefined;
}

// ---------------------------------------------------------------------------
// Failure-kind classification (offline safeParse)
// ---------------------------------------------------------------------------

export const WRONG_PRIMITIVE = {
  ZodString: 12345,
  ZodNumber: "not-a-number",
  ZodBoolean: "not-a-boolean"
};

export function classifyIssue(issue) {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? "invalid_type.missing-required"
        : "invalid_type.wrong-type";
    case "too_small":
      return `too_small.${issue.type}`;
    case "too_big":
      return `too_big.${issue.type}`;
    default:
      return issue.code;
  }
}

/** All issue kinds for a candidate, or undefined when the candidate parses. */
export function offlineKinds(schema, candidate) {
  const result = schema.safeParse(candidate);
  if (result.success) return undefined;
  return {
    kinds: [...new Set(result.error.issues.map(classifyIssue))],
    issues: result.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.join("."),
      message: issue.message
    }))
  };
}

/**
 * A guaranteed-offline-failing invalid input for a tool schema, used to sample
 * error envelopes without triggering real work. Preference order: {} when the
 * schema rejects it; otherwise one wrong-typed / bogus-enum top-level key.
 */
export function guaranteedInvalidInput(toolEntry) {
  const { schema } = toolEntry;
  if (!schema.safeParse({}).success) return {};
  const object = baseObject(schema);
  if (object) {
    for (const key of Object.keys(object.shape).sort()) {
      const base = unwrapField(object.shape[key]);
      const wrong =
        WRONG_PRIMITIVE[typeName(base)] ??
        (typeName(base) === "ZodEnum" ? "__premigration_bogus_enum__" : undefined) ??
        (typeName(base) === "ZodObject" || typeName(base) === "ZodDiscriminatedUnion"
          ? "not-an-object"
          : undefined) ??
        (typeName(base) === "ZodArray" ? "not-an-array" : undefined);
      if (wrong === undefined) continue;
      const candidate = { [key]: wrong };
      if (!schema.safeParse(candidate).success) return candidate;
    }
  }
  return undefined;
}
