import { z } from "zod";
import type {
  CallToolResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations
} from "@modelcontextprotocol/server";

import { V1_PARITY_SCHEMAS } from "./v1-parity-schemas.js";

/**
 * Validation-bypassing Standard Schema adapter for MCP SDK v2 tool
 * registration.
 *
 * The v2 SDK validates tool arguments through `schema["~standard"].validate`
 * before invoking the handler and returns generic InvalidParams text on
 * failure. This adapter's identity `validate` passes ALL object args through
 * raw so runTool() remains the single source of truth for validation and
 * error envelopes (matching pre-migration behavior, where the equivalent v1
 * layer was bypassed).
 *
 * `jsonSchema` is a Converter object whose `input()` serves the pinned
 * pre-migration wire schema for the tool (V1_PARITY_SCHEMAS), advertised
 * VERBATIM in tools/list. The zod fallback only applies to tools without a
 * frozen fixture (none today).
 */
export function appValidated<S extends z.ZodObject>(
  name: string,
  schema: S
): StandardSchemaWithJSON<unknown, z.output<S>> {
  return {
    "~standard": {
      version: 1,
      vendor: "app",
      validate: (value: unknown) => ({ value: value as z.output<S> }),
      jsonSchema: {
        input: () => V1_PARITY_SCHEMAS[name] ?? z.toJSONSchema(schema, { io: "input" })
      }
    }
  } as never;
}

/**
 * Tool handler shape used by all app registrations: raw (unvalidated) args
 * plus the v2 ServerContext. Handlers delegate validation to runTool().
 */
export type AppToolHandler = (
  args: unknown,
  ctx: ServerContext
) => Promise<CallToolResult>;

/**
 * Registers a tool through the v2 `registerTool` API with the
 * validation-bypassing adapter, preserving the v1 registration surface
 * (name, description, zod raw shape, annotations, handler).
 */
export function registerAppTool(
  server: McpServer,
  name: string,
  description: string,
  shape: z.ZodRawShape,
  annotations: ToolAnnotations,
  handler: AppToolHandler
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: appValidated(name, z.object(shape)),
      annotations
    },
    handler
  );
}

// Low-level/expert tools duplicate capability that the six entry tools expose
// in a single resolve+fetch call. registerExpertTool() registers them exactly
// like registerAppTool() but appends a note steering agents to the entry tools
// first. Entry tools, batch tools, and the NBT/runtime utilities (which have no
// entry equivalent) keep their plain descriptions via registerAppTool().
export const EXPERT_TOOL_NOTE =
  " Expert tool: prefer the entry tools (inspect-minecraft, analyze-symbol, compare-minecraft, analyze-mod, validate-project) first.";

export function registerExpertTool(
  server: McpServer,
  name: string,
  description: string,
  shape: z.ZodRawShape,
  annotations: ToolAnnotations,
  handler: AppToolHandler
): void {
  registerAppTool(server, name, description + EXPERT_TOOL_NOTE, shape, annotations, handler);
}
