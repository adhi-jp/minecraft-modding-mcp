/**
 * Contract lint for catalog tool specs and their advertised tools/list
 * entries. Each check returns human-readable findings; an empty list passes.
 * Shared by the catalog contract test (real specs and test-only fixtures).
 */
import assert from "node:assert/strict";

import { z } from "zod";

import { isNumericInputSchema, isSharedTargetSchema, DETAIL_LEVELS } from "../../src/tools/schemas.ts";
import { CATALOG_STATUSES, type CatalogToolSpec } from "../../src/tools/types.ts";
import {
  CATALOG_PROPERTY_VOCABULARY,
  DATA_DOCUMENT_PROPERTIES,
  RETIRED_PROPERTY_NAMES
} from "../../src/tools/vocabulary.ts";
import { ALIAS_TOOL_NAMES } from "../../src/tools/inventory.ts";

export type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** Domains a catalog name may start with (`<domain>-<verb>`). */
export const CATALOG_DOMAINS = [
  "version",
  "artifact",
  "file",
  "class",
  "source",
  "member",
  "symbol",
  "registry",
  "mod",
  "project",
  "mixin",
  "access",
  "nbt",
  "cache",
  "server"
] as const;

export const SIZE_LIMIT_PER_TOOL = 3_000;
export const DESCRIPTION_LIMIT = 400;
/** Half of the 8.0.0-rc.1 advertisement (97,412 characters, same formula). */
export const CATALOG_SIZE_BUDGET = 48_706;
export const MAX_NESTING_DEPTH = 2;

const FORBIDDEN_SCHEMA_KEYWORDS = ["$ref", "$defs", "anyOf", "oneOf", "allOf", "$schema"];

export function lintName(name: string): string[] {
  const findings: string[] = [];
  const domainPattern = new RegExp(`^(${CATALOG_DOMAINS.join("|")})-[a-z]+(?:-[a-z]+)*$`);
  if (!domainPattern.test(name)) {
    findings.push(`${name}: not a lowercase kebab-case <domain>-<verb> name with a catalog domain`);
  }
  if (name.length > 32) {
    findings.push(`${name}: longer than 32 characters`);
  }
  if (ALIAS_TOOL_NAMES.has(name)) {
    findings.push(`${name}: reuses an 8.x tool name`);
  }
  return findings;
}

/** The exact size formula: undefined fields are omitted by JSON.stringify. */
export function listingSize(tool: ListedTool): number {
  return JSON.stringify({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: tool.inputSchema,
    _meta: tool._meta
  }).length;
}

export function lintSize(tool: ListedTool): string[] {
  const findings: string[] = [];
  const size = listingSize(tool);
  if (size > SIZE_LIMIT_PER_TOOL) {
    findings.push(`${tool.name}: advertisement is ${size} characters (limit ${SIZE_LIMIT_PER_TOOL})`);
  }
  const descriptionLength = (tool.description ?? "").length;
  if (descriptionLength > DESCRIPTION_LIMIT) {
    findings.push(`${tool.name}: description is ${descriptionLength} characters (limit ${DESCRIPTION_LIMIT})`);
  }
  return findings;
}

type JsonNode = Record<string, unknown>;

function asNode(value: unknown): JsonNode | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonNode) : undefined;
}

/** Schema shape: no references or combinators, closed control objects, bounded depth. */
export function lintSchemaShape(toolName: string, inputSchema: unknown): string[] {
  const findings: string[] = [];
  const visit = (node: JsonNode, path: string, depth: number, dataDocument: boolean): void => {
    for (const keyword of FORBIDDEN_SCHEMA_KEYWORDS) {
      if (keyword in node) findings.push(`${toolName}: ${path} uses ${keyword}`);
    }
    for (const branchKey of ["anyOf", "oneOf", "allOf"]) {
      const branches = node[branchKey];
      if (Array.isArray(branches)) {
        for (const branch of branches) {
          const child = asNode(branch);
          if (child) visit(child, `${path}|${branchKey}`, depth, dataDocument);
        }
      }
    }
    const properties = asNode(node.properties);
    const isObject = node.type === "object" || properties !== undefined;
    if (isObject && !dataDocument && node.additionalProperties !== false) {
      findings.push(`${toolName}: ${path} is an open object (additionalProperties is not false)`);
    }
    if (depth > MAX_NESTING_DEPTH) {
      findings.push(`${toolName}: ${path} nests ${depth} levels below the root (limit ${MAX_NESTING_DEPTH})`);
    }
    for (const [key, value] of Object.entries(properties ?? {})) {
      const child = asNode(value);
      if (!child) continue;
      const nested = child.type === "object" || child.type === "array" || "properties" in child || "items" in child;
      visit(
        child,
        `${path}.${key}`,
        nested ? depth + 1 : depth,
        dataDocument || (depth === 0 && DATA_DOCUMENT_PROPERTIES.has(key))
      );
    }
    const items = asNode(node.items);
    if (items) {
      const nested = items.type === "object" || "properties" in items;
      visit(items, `${path}[]`, nested ? depth + 1 : depth, dataDocument);
    }
  };
  const root = asNode(inputSchema);
  if (!root) return [`${toolName}: input schema is not an object`];
  visit(root, "$", 0, false);
  return findings;
}

/** Peels wrappers that do not change what is validated (optional, default, numeric strings). */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = (current as unknown as { def?: Record<string, unknown> }).def;
    if (def?.innerType instanceof z.ZodType) {
      current = def.innerType;
      continue;
    }
    return current;
  }
}

function objectShape(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const inner = unwrap(schema);
  return inner instanceof z.ZodObject ? (inner.shape as Record<string, z.ZodType>) : undefined;
}

/** Vocabulary: allowed names only, no retired spellings, the shared target, advertised detail default. */
export function lintVocabulary(spec: CatalogToolSpec, inputSchema: unknown): string[] {
  const findings: string[] = [];
  const visitNames = (node: JsonNode, path: string, topLevel: boolean): void => {
    const properties = asNode(node.properties) ?? {};
    for (const [key, value] of Object.entries(properties)) {
      if (RETIRED_PROPERTY_NAMES.has(key)) {
        findings.push(`${spec.name}: ${path}.${key} is a retired 8.x spelling`);
      } else if (!CATALOG_PROPERTY_VOCABULARY.has(key)) {
        findings.push(`${spec.name}: ${path}.${key} is not in the catalog vocabulary`);
      }
      if (topLevel && key === "artifactId") {
        findings.push(`${spec.name}: top-level artifactId (use target kind "artifact")`);
      }
      if (topLevel && key === "jarPath" && !spec.name.startsWith("mod-")) {
        findings.push(`${spec.name}: top-level jarPath outside the mod tools (use target kind "jar")`);
      }
      if (topLevel && DATA_DOCUMENT_PROPERTIES.has(key)) continue;
      const child = asNode(value);
      if (!child) continue;
      visitNames(child, `${path}.${key}`, false);
      const items = asNode(child.items);
      if (items) visitNames(items, `${path}.${key}[]`, false);
    }
  };
  const root = asNode(inputSchema);
  if (!root) return [`${spec.name}: input schema is not an object`];
  visitNames(root, "$", true);

  const detail = asNode(asNode(root.properties)?.detail);
  if (detail !== undefined && !(DETAIL_LEVELS as readonly unknown[]).includes(detail.default)) {
    findings.push(`${spec.name}: detail does not advertise its default`);
  }
  const shape = objectShape(spec.inputSchema);
  if (shape?.target !== undefined && !isSharedTargetSchema(unwrap(shape.target))) {
    findings.push(`${spec.name}: target is not the shared target schema`);
  }
  return findings;
}

/** Every number input accepts numeric strings through the shared helper. */
export function lintNumbers(spec: CatalogToolSpec): string[] {
  const findings: string[] = [];
  const visit = (schema: z.ZodType, path: string): void => {
    if (isNumericInputSchema(schema)) return;
    if (schema instanceof z.ZodNumber) {
      findings.push(`${spec.name}: ${path} is a number that rejects numeric strings`);
      return;
    }
    const def = (schema as unknown as { def?: Record<string, unknown> }).def ?? {};
    if (def.innerType instanceof z.ZodType) visit(def.innerType, path);
    if (schema instanceof z.ZodPipe) {
      visit(schema.def.in as z.ZodType, path);
      visit(schema.def.out as z.ZodType, path);
    }
    if (schema instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
        if (path === "$" && DATA_DOCUMENT_PROPERTIES.has(key)) continue;
        visit(child, `${path}.${key}`);
      }
    }
    if (schema instanceof z.ZodArray) visit(schema.element as z.ZodType, `${path}[]`);
    if (schema instanceof z.ZodUnion) {
      for (const option of schema.options as z.ZodType[]) visit(option, path);
    }
  };
  visit(spec.inputSchema, "$");
  return findings;
}

export type WriterOracle = ReadonlyMap<string, { destructiveHint?: boolean; idempotentHint?: boolean }>;

/** Read-only hint is false exactly for the writers; writers declare their effect hints. */
export function lintAnnotations(spec: CatalogToolSpec, writers: WriterOracle): string[] {
  const findings: string[] = [];
  const writer = writers.get(spec.name);
  const readOnly = spec.annotations.readOnlyHint;
  if (writer === undefined && readOnly !== true) {
    findings.push(`${spec.name}: reading tool must declare readOnlyHint: true`);
  }
  if (writer !== undefined) {
    if (readOnly !== false) findings.push(`${spec.name}: writer must declare readOnlyHint: false`);
    for (const hint of ["destructiveHint", "idempotentHint"] as const) {
      if (writer[hint] !== undefined && spec.annotations[hint] !== writer[hint]) {
        findings.push(`${spec.name}: ${hint} must be ${String(writer[hint])}`);
      }
    }
  }
  return findings;
}

/** The listed entry advertises exactly the spec's annotations. */
export function lintListedAnnotations(spec: CatalogToolSpec, listed: ListedTool): string[] {
  try {
    assert.deepStrictEqual(listed.annotations, JSON.parse(JSON.stringify(spec.annotations)));
    return [];
  } catch {
    return [`${spec.name}: listed annotations ${JSON.stringify(listed.annotations)} differ from the spec's`];
  }
}

export function lintExamplesAndStatuses(spec: CatalogToolSpec): string[] {
  const findings: string[] = [];
  if (spec.examples.length === 0) {
    findings.push(`${spec.name}: declares no example`);
  }
  spec.examples.forEach((example, index) => {
    const parsed = spec.inputSchema.safeParse(example);
    if (!parsed.success) {
      findings.push(`${spec.name}: example ${index} does not validate: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
  });
  if (spec.statuses.length === 0) {
    findings.push(`${spec.name}: declares no status`);
  }
  for (const status of spec.statuses) {
    if (!(CATALOG_STATUSES as readonly string[]).includes(status)) {
      findings.push(`${spec.name}: status "${status}" is outside the catalog status enum`);
    }
  }
  return findings;
}

/** All per-tool checks for one spec and its listed entry. */
export function lintCatalogTool(spec: CatalogToolSpec, listed: ListedTool, writers: WriterOracle): string[] {
  return [
    ...lintName(spec.name),
    ...lintSize(listed),
    ...lintSchemaShape(spec.name, listed.inputSchema),
    ...lintVocabulary(spec, listed.inputSchema),
    ...lintNumbers(spec),
    ...lintAnnotations(spec, writers),
    ...lintListedAnnotations(spec, listed),
    ...lintExamplesAndStatuses(spec)
  ];
}
