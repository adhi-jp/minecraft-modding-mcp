import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createError, ERROR_CODES, isAppError } from "./errors.js";
import { textResource, objectResource, errorResource } from "./mcp-helpers.js";
import type { SourceService } from "./source-service.js";

function decodeTemplateParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Missing template parameter: ${key}.`,
      details: { key }
    });
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `${key} contains invalid URL encoding.`,
      details: { key, value }
    });
  }
}

export function registerResources(
  server: McpServer,
  sourceService: SourceService
): void {
  // ── Fixed resources ──────────────────────────────────────────────

  server.resource("versions-list", "mc://versions/list",
    { description: "List all available Minecraft versions with their metadata.", mimeType: "application/json" },
    async (uri) => {
      try {
        const result = await sourceService.listVersions();
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, e.message);
        throw e;
      }
    }
  );

  server.resource("runtime-metrics", "mc://metrics",
    { description: "Runtime metrics and performance counters for the MCP server.", mimeType: "application/json" },
    async (uri) => {
      try {
        const result = sourceService.getRuntimeMetrics();
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, e.message);
        throw e;
      }
    }
  );

  // ── Template resources ───────────────────────────────────────────

  server.resource("class-source",
    new ResourceTemplate("mc://source/{artifactId}/{className}", { list: undefined }),
    { description: "Java source code for a class within a resolved artifact. className may use dot or slash separators.", mimeType: "text/x-java" },
    async (uri, params) => {
      try {
        const result = await sourceService.getClassSource({
          artifactId: params.artifactId as string,
          className: decodeTemplateParam(params as Record<string, string>, "className")
        });
        return textResource(uri.href, result.sourceText);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, e.message);
        throw e;
      }
    }
  );

  server.resource("artifact-file",
    new ResourceTemplate("mc://artifact/{artifactId}/files/{filePath}", { list: undefined }),
    { description: "Raw content of a file within a resolved artifact. filePath is the archive-relative path.", mimeType: "text/plain" },
    async (uri, params) => {
      try {
        const result = await sourceService.getArtifactFile({
          artifactId: params.artifactId as string,
          filePath: decodeTemplateParam(params as Record<string, string>, "filePath")
        });
        return textResource(uri.href, result.content);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, e.message);
        throw e;
      }
    }
  );

  server.resource("find-mapping",
    new ResourceTemplate("mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}", { list: undefined }),
    { description: "Look up a mapping for a class, field, or method between two naming namespaces.", mimeType: "application/json" },
    async (uri, params) => {
      try {
        const result = await sourceService.findMapping({
          version: params.version as string,
          kind: params.kind as "class" | "field" | "method",
          name: decodeTemplateParam(params as Record<string, string>, "name"),
          sourceMapping: params.sourceMapping as "obfuscated" | "mojang" | "intermediary" | "yarn",
          targetMapping: params.targetMapping as "obfuscated" | "mojang" | "intermediary" | "yarn"
        });
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, e.message);
        throw e;
      }
    }
  );

  server.resource("class-members",
    new ResourceTemplate("mc://artifact/{artifactId}/members/{className}", { list: undefined }),
    { description: "List constructors, methods, and fields for a class within a resolved artifact.", mimeType: "application/json" },
    async (uri, params) => {
      try {
        const result = await sourceService.getClassMembers({
          artifactId: params.artifactId as string,
          className: decodeTemplateParam(params as Record<string, string>, "className")
        });
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, e.message);
        throw e;
      }
    }
  );

  server.resource("artifact-metadata",
    new ResourceTemplate("mc://artifact/{artifactId}", { list: undefined }),
    { description: "Metadata for a previously resolved artifact (origin, coordinate, mapping, provenance).", mimeType: "application/json" },
    async (uri, params) => {
      try {
        const artifact = sourceService.getArtifact(params.artifactId as string);
        return objectResource(uri.href, artifact as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, e.message);
        throw e;
      }
    }
  );
}
