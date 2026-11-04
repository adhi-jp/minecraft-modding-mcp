import type {
  CallToolResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON
} from "@modelcontextprotocol/server";

import { toAdvertisedInputSchema } from "./json-schema.js";
import { runCatalogTool } from "./runner.js";
import type { CatalogRuntime, CatalogToolSpec } from "./types.js";

/**
 * Standard Schema wrapper that advertises the generated JSON Schema and passes
 * the raw arguments through, so `runCatalogTool` owns validation and the error
 * envelope (the SDK would otherwise answer invalid input with plain text).
 */
function passThroughInput(advertised: Record<string, unknown>): StandardSchemaWithJSON<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "app",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => advertised,
        output: () => advertised
      }
    }
  } as never;
}

/** Registers one catalog tool on `server`; calls run through `runCatalogTool`. */
export function registerCatalogTool(
  server: McpServer,
  spec: CatalogToolSpec,
  runtime: CatalogRuntime
): void {
  server.registerTool(
    spec.name,
    {
      ...(spec.title !== undefined ? { title: spec.title } : {}),
      description: spec.description,
      inputSchema: passThroughInput(toAdvertisedInputSchema(spec.inputSchema)),
      annotations: spec.annotations
    },
    (args: unknown, ctx: ServerContext): Promise<CallToolResult> => runCatalogTool(spec, args, runtime, ctx)
  );
}
