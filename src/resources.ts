import { ResourceTemplate } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";

import {
  METRICS_READ_CACHE_HINT,
  RESOURCE_READ_CACHE_HINT,
  VERSIONS_LIST_READ_CACHE_HINT
} from "./cache-policy.js";
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

// Cache-hint rows (adopted policy, src/cache-policy.ts): per-registration
// hints ride the SDK's never-serialized carrier and only surface on
// 2026-07-28 results. The errorResource(...) calls also receive the request
// ctx so the ProblemDetails-read override (ttlMs 0, unconditional precedence
// over these class rows) can be applied structurally on the error path.

export function registerResources(
  server: McpServer,
  sourceService: SourceService
): void {
  // ── Fixed resources ──────────────────────────────────────────────

  server.registerResource("versions-list", "mc://versions/list",
    { description: "List all available Minecraft versions with their metadata.", mimeType: "application/json", cacheHint: VERSIONS_LIST_READ_CACHE_HINT },
    async (uri, ctx) => {
      try {
        const result = await sourceService.listVersions();
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  server.registerResource("runtime-metrics", "mc://metrics",
    { description: "Runtime metrics and performance counters for the MCP server.", mimeType: "application/json", cacheHint: METRICS_READ_CACHE_HINT },
    async (uri, ctx) => {
      try {
        const result = sourceService.getRuntimeMetrics();
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  // ── Template resources ───────────────────────────────────────────

  server.registerResource("class-source",
    new ResourceTemplate("mc://source/{artifactId}/{className}", { list: undefined }),
    { description: "Java source code for a class within a resolved artifact. className may use dot or slash separators.", mimeType: "text/x-java", cacheHint: RESOURCE_READ_CACHE_HINT },
    async (uri, params, ctx) => {
      try {
        const result = await sourceService.getClassSource({
          artifactId: params.artifactId as string,
          className: decodeTemplateParam(params as Record<string, string>, "className"),
          // A "text/x-java" source resource must return real Java, not the default
          // metadata outline; match the sibling class-source-json resource.
          mode: "full"
        });
        return textResource(uri.href, result.sourceText);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  server.registerResource("class-source-json",
    new ResourceTemplate("mc://source-json/{artifactId}/{className}", { list: undefined }),
    { description: "JSON envelope of a class's full source plus metadata (artifactId, mappingApplied, totalLines, returnedRange, provenance, warnings) — the structured alternative to the raw-text class-source resource, easier to cite and continue.", mimeType: "application/json", cacheHint: RESOURCE_READ_CACHE_HINT },
    async (uri, params, ctx) => {
      try {
        const result = await sourceService.getClassSource({
          artifactId: params.artifactId as string,
          className: decodeTemplateParam(params as Record<string, string>, "className"),
          mode: "full"
        });
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  server.registerResource("artifact-file",
    new ResourceTemplate("mc://artifact/{artifactId}/files/{filePath}", { list: undefined }),
    { description: "Raw content of a file within a resolved artifact. filePath is the archive-relative path.", mimeType: "text/plain", cacheHint: RESOURCE_READ_CACHE_HINT },
    async (uri, params, ctx) => {
      try {
        const result = await sourceService.getArtifactFile({
          artifactId: params.artifactId as string,
          filePath: decodeTemplateParam(params as Record<string, string>, "filePath")
        });
        return textResource(uri.href, result.content);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  server.registerResource("find-mapping",
    new ResourceTemplate("mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{name}", { list: undefined }),
    { description: "Look up a CLASS mapping between two naming namespaces. This URI carries no owner, so field/method lookups (which need an owner) must use the find-member-mapping resource or the find-mapping tool.", mimeType: "application/json", cacheHint: RESOURCE_READ_CACHE_HINT },
    async (uri, params, ctx) => {
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
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  server.registerResource("find-member-mapping",
    new ResourceTemplate("mc://mappings/{version}/{sourceMapping}/{targetMapping}/{kind}/{owner}/{name}", { list: undefined }),
    { description: "Look up a FIELD or METHOD mapping between two naming namespaces, including the owner class the member belongs to (required for member lookups). For exact method overload resolution, use the find-mapping tool with a descriptor.", mimeType: "application/json", cacheHint: RESOURCE_READ_CACHE_HINT },
    async (uri, params, ctx) => {
      try {
        const result = await sourceService.findMapping({
          version: params.version as string,
          kind: params.kind as "class" | "field" | "method",
          owner: decodeTemplateParam(params as Record<string, string>, "owner"),
          name: decodeTemplateParam(params as Record<string, string>, "name"),
          sourceMapping: params.sourceMapping as "obfuscated" | "mojang" | "intermediary" | "yarn",
          targetMapping: params.targetMapping as "obfuscated" | "mojang" | "intermediary" | "yarn"
        });
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  server.registerResource("class-members",
    new ResourceTemplate("mc://artifact/{artifactId}/members/{className}", { list: undefined }),
    { description: "List constructors, methods, and fields for a class within a resolved artifact.", mimeType: "application/json", cacheHint: RESOURCE_READ_CACHE_HINT },
    async (uri, params, ctx) => {
      try {
        const result = await sourceService.getClassMembers({
          artifactId: params.artifactId as string,
          className: decodeTemplateParam(params as Record<string, string>, "className")
        });
        return objectResource(uri.href, result as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );

  server.registerResource("artifact-metadata",
    new ResourceTemplate("mc://artifact/{artifactId}", { list: undefined }),
    { description: "Metadata for a previously resolved artifact (origin, coordinate, mapping, provenance).", mimeType: "application/json", cacheHint: RESOURCE_READ_CACHE_HINT },
    async (uri, params, ctx) => {
      try {
        const artifact = sourceService.getArtifact(params.artifactId as string);
        return objectResource(uri.href, artifact as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        if (isAppError(e)) return errorResource(uri.href, { message: e.message, code: e.code, details: e.details }, ctx);
        throw e;
      }
    }
  );
}
