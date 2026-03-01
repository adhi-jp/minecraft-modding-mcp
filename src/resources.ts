import { text, object, error } from "mcp-use/server";
import type { MCPServer } from "mcp-use/server";

import { createError, ERROR_CODES, isAppError } from "./errors.js";
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
  server: InstanceType<typeof MCPServer>,
  sourceService: SourceService
): void {
  // ── Fixed resources ──────────────────────────────────────────────

  server.resource(
    {
      name: "versions-list",
      uri: "mc://versions/list",
      description: "List all available Minecraft versions with their metadata.",
      mimeType: "application/json"
    },
    async () => {
      try {
        const result = await sourceService.listVersions();
        return object(result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return error(e.message);
        throw e;
      }
    }
  );

  server.resource(
    {
      name: "runtime-metrics",
      uri: "mc://metrics",
      description: "Runtime metrics and performance counters for the MCP server.",
      mimeType: "application/json"
    },
    async () => {
      try {
        const result = sourceService.getRuntimeMetrics();
        return object(result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return error(e.message);
        throw e;
      }
    }
  );

  // ── Template resources ───────────────────────────────────────────

  server.resourceTemplate(
    {
      name: "class-source",
      uriTemplate: "mc://source/{artifactId}/{className}",
      description:
        "Java source code for a class within a resolved artifact. className may use dot or slash separators.",
      mimeType: "text/x-java"
    },
    async (_uri: URL, params: Record<string, string>) => {
      try {
        const result = await sourceService.getClassSource({
          artifactId: params.artifactId,
          className: decodeTemplateParam(params, "className")
        });
        return text(result.sourceText);
      } catch (e: unknown) {
        if (isAppError(e)) return error(e.message);
        throw e;
      }
    }
  );

  server.resourceTemplate(
    {
      name: "artifact-file",
      uriTemplate: "mc://artifact/{artifactId}/files/{filePath}",
      description:
        "Raw content of a file within a resolved artifact. filePath is the archive-relative path.",
      mimeType: "text/plain"
    },
    async (_uri: URL, params: Record<string, string>) => {
      try {
        const result = await sourceService.getArtifactFile({
          artifactId: params.artifactId,
          filePath: decodeTemplateParam(params, "filePath")
        });
        return text(result.content);
      } catch (e: unknown) {
        if (isAppError(e)) return error(e.message);
        throw e;
      }
    }
  );

  server.resourceTemplate(
    {
      name: "find-mapping",
      uriTemplate:
        "mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}",
      description:
        "Look up a mapping for a class, field, or method between two naming namespaces.",
      mimeType: "application/json"
    },
    async (_uri: URL, params: Record<string, string>) => {
      try {
        const result = await sourceService.findMapping({
          version: params.version,
          kind: params.kind as "class" | "field" | "method",
          name: decodeTemplateParam(params, "name"),
          sourceMapping: params.sourceMapping as "official" | "mojang" | "intermediary" | "yarn",
          targetMapping: params.targetMapping as "official" | "mojang" | "intermediary" | "yarn"
        });
        return object(result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return error(e.message);
        throw e;
      }
    }
  );

  server.resourceTemplate(
    {
      name: "class-members",
      uriTemplate: "mc://artifact/{artifactId}/members/{className}",
      description:
        "List constructors, methods, and fields for a class within a resolved artifact.",
      mimeType: "application/json"
    },
    async (_uri: URL, params: Record<string, string>) => {
      try {
        const result = await sourceService.getClassMembers({
          artifactId: params.artifactId,
          className: decodeTemplateParam(params, "className")
        });
        return object(result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return error(e.message);
        throw e;
      }
    }
  );

  server.resourceTemplate(
    {
      name: "artifact-metadata",
      uriTemplate: "mc://artifact/{artifactId}",
      description:
        "Metadata for a previously resolved artifact (origin, coordinate, mapping, provenance).",
      mimeType: "application/json"
    },
    async (_uri: URL, params: Record<string, string>) => {
      try {
        const artifact = sourceService.getArtifact(params.artifactId);
        return object(artifact as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return error(e.message);
        throw e;
      }
    }
  );
}
