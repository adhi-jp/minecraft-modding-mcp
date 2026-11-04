import type {
  CallToolResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations
} from "@modelcontextprotocol/server";

import {
  aliasDeprecation,
  aliasInventoryEntry,
  ALIAS_REMOVAL_VERSION,
  type AliasToolInventoryEntry
} from "./tools/inventory.js";

/**
 * Validation-bypassing Standard Schema adapter for MCP SDK v2 tool
 * registration.
 *
 * The v2 SDK validates tool arguments through `schema["~standard"].validate`
 * before invoking the handler and returns generic InvalidParams text on
 * failure. This adapter's identity `validate` passes ALL object args through
 * raw so runTool() stays the single source of truth for validation and the
 * error envelope, and `jsonSchema.input()` advertises the permissive alias
 * schema `{ "type": "object" }` in tools/list.
 */
const aliasInputSchema = {
  "~standard": {
    version: 1,
    vendor: "app",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({ type: "object" })
    }
  }
} as unknown as StandardSchemaWithJSON<unknown, unknown>;

/**
 * Tool handler shape of the 8.x registrations: raw (unvalidated) args plus
 * the v2 ServerContext. Handlers delegate validation to runTool().
 */
type AppToolHandler = (
  args: unknown,
  ctx: ServerContext
) => Promise<CallToolResult>;

/** `a`, `a or b`, `a, b or c`. */
function joinAlternatives(names: readonly string[]): string {
  return names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * The listed description of an alias: deprecated, the release that removes
 * it, and the catalog tools that replace it.
 */
function aliasDescription(entry: AliasToolInventoryEntry): string {
  const perTask = entry.tasks !== undefined ? " (one per task)" : "";
  return `Deprecated 8.x tool, removed in ${ALIAS_REMOVAL_VERSION}; use ${joinAlternatives(entry.replacedBy)}${perTask}.`;
}

/**
 * Registers an 8.x tool as a deprecated alias. Its listing is a minimal
 * entry: the deprecation description, the permissive input schema, the
 * tool's annotations, and `_meta.deprecated` naming the catalog tools that
 * replace it. The handler validates the input itself and adds
 * `meta.deprecated` before serializing the reply.
 */
export function registerAliasTool(
  server: McpServer,
  name: string,
  annotations: ToolAnnotations,
  handler: AppToolHandler
): void {
  const entry = aliasInventoryEntry(name);
  if (entry === undefined) {
    throw new Error(`${name} is not an alias in the tool inventory`);
  }
  server.registerTool(
    name,
    {
      description: aliasDescription(entry),
      inputSchema: aliasInputSchema,
      annotations,
      _meta: { deprecated: aliasDeprecation(name) }
    },
    handler
  );
}
