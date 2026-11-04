import { z } from "zod";

import { createCacheRegistry, PUBLIC_CACHE_KINDS, type CacheRegistry } from "../../cache-registry.js";
import type { Config } from "../../types.js";
import { normalizeOptionalPathForHost } from "../../path-converter.js";
import { defined } from "../items.js";
import { ARTIFACT_SCOPES, mappingSchema, nonEmptyString, numericInput } from "../schemas.js";
import type { CatalogNextAction, CatalogStatus, CatalogToolSpec } from "../types.js";

/**
 * Operations family: the server's own caches and counters. `cache-manage`
 * reports, lists, verifies and deletes cache entries (deleting only with
 * `apply: true`); `server-metrics` returns the runtime counters.
 */

// ---------------------------------------------------------------------------
// cache-manage
// ---------------------------------------------------------------------------

const CACHE_ACTIONS = ["summary", "list", "verify", "delete"] as const;
const CACHE_HEALTH_STATES = ["healthy", "partial", "stale", "orphaned", "corrupt", "in_use"] as const;
const DEFAULT_LIST_LIMIT = 50;

/**
 * Whether a selector path is the file system root in any spelling (`/`,
 * `\`, `///`, `\\wsl$\<distro>`). The registry normalizes such a path
 * to an empty key, the same way as here, and then filters on nothing, so it
 * would select every entry of every kind. A path the host conversion rejects
 * is left to the registry, which rejects it the same way.
 */
function namesOnlyTheRoot(path: string): boolean {
  let normalized: string | undefined;
  try {
    normalized = normalizeOptionalPathForHost(path, undefined, "jarPath");
  } catch {
    return false;
  }
  return normalized !== undefined && normalized.replace(/\\/g, "/").replace(/\/+$/, "") === "";
}

const cacheSelector = z
  .strictObject({
    artifactId: nonEmptyString.optional(),
    version: nonEmptyString.optional(),
    jarPath: nonEmptyString.optional(),
    entryId: nonEmptyString.optional(),
    status: z.enum(CACHE_HEALTH_STATES).optional(),
    olderThan: nonEmptyString.optional(),
    mapping: mappingSchema.optional(),
    scope: z.enum(ARTIFACT_SCOPES).optional(),
    projectPath: nonEmptyString.optional()
  })
  .describe('Entries matching every field given. olderThan: ISO-8601 duration ("P30D", "PT12H").');

const cacheManageInput = z
  .strictObject({
    action: z
      .enum(CACHE_ACTIONS)
      .describe("summary: per-kind totals; list: entries; verify: health check; delete: remove entries."),
    cacheKinds: z.array(z.enum(PUBLIC_CACHE_KINDS)).min(1).optional().describe("Default: every kind."),
    selector: cacheSelector.optional(),
    limit: numericInput(z.number().int().min(1)).optional().describe("list only: entries per page, default 50."),
    cursor: nonEmptyString.optional().describe("list only: meta.pagination.nextCursor of the previous page."),
    apply: z.boolean().optional().describe("delete only: true deletes; default false previews.")
  })
  .superRefine((value, ctx) => {
    for (const key of ["limit", "cursor"] as const) {
      if (value[key] !== undefined && value.action !== "list") {
        ctx.addIssue({ code: "custom", path: [key], message: `"${key}" is accepted only with action "list".` });
      }
    }
    for (const key of ["jarPath", "projectPath"] as const) {
      const path = value.selector?.[key];
      if (path !== undefined && namesOnlyTheRoot(path)) {
        ctx.addIssue({
          code: "custom",
          path: ["selector", key],
          message: `"${key}" names the file system root, which would select every cache entry; name a path below it.`
        });
      }
    }
    if (value.apply !== undefined && value.action !== "delete") {
      ctx.addIssue({ code: "custom", path: ["apply"], message: '"apply" is accepted only with action "delete".' });
    }
    if (value.action === "delete" && !hasSelectorField(value.selector)) {
      ctx.addIssue({
        code: "custom",
        path: ["selector"],
        message: 'Action "delete" requires a selector with at least one field, in preview and apply alike.'
      });
    }
  });

type CacheManageInput = z.output<typeof cacheManageInput>;
type CacheSelector = NonNullable<CacheManageInput["selector"]>;

function hasSelectorField(selector: CacheSelector | undefined): boolean {
  return selector !== undefined && Object.values(selector).some((value) => value !== undefined);
}

/** The cache registry over the server's cache directory and database, as the 8.x tool builds it. */
function cacheRegistryOf(config: Config): CacheRegistry {
  return createCacheRegistry({
    cacheDir: config.cacheDir,
    sqlitePath: config.sqlitePath,
    sqliteCacheKb: config.sqliteCacheKb,
    sqliteMmapSize: config.sqliteMmapSize
  });
}

/** The registry's warning for a cached download an apply could not delete. */
const UNDELETED_DOWNLOAD = /^Could not delete cached download \(it may be locked or read-only\): /;

/** The request fields a follow-up call repeats (defaults left out). */
function repeatedFields(input: CacheManageInput): Record<string, unknown> {
  return defined({ cacheKinds: input.cacheKinds, selector: input.selector });
}

export const cacheManageSpec: CatalogToolSpec<CacheManageInput> = {
  name: "cache-manage",
  description:
    "Summarize, list, verify or delete the server's cache entries (index, downloads, mappings, registries, " +
    "decompiled source, remapped and nested jars, workspaces); each action returns entries or counts. delete " +
    "needs a selector and previews unless apply is true: a preview deletes nothing and, if it finds entries, offers " +
    "the apply call. " +
    'Example: {"action":"delete","selector":{"version":"1.21.1"}}',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: cacheManageInput,
  examples: [
    { action: "summary" },
    { action: "list", cacheKinds: ["artifact-index"], limit: 20 },
    { action: "delete", cacheKinds: ["downloads"], selector: { version: "1.21.1" } }
  ],
  statuses: ["ok", "partial"],
  primaryKey: "cache",
  handler: async (input, call) => {
    const registry = cacheRegistryOf(call.config);
    const scope = defined({ cacheKinds: input.cacheKinds, selector: input.selector });

    switch (input.action) {
      case "summary": {
        const { kinds } = await registry.summarize(scope);
        const rows = Object.values(kinds);
        // An empty kind reports health "partial"; only a kind with entries can be unhealthy.
        const unhealthy = rows.some((row) => row !== undefined && row.entryCount > 0 && row.status !== "healthy");
        return {
          result: {
            cache: {
              action: "summary",
              status: (unhealthy ? "partial" : "ok") satisfies CatalogStatus,
              entryCount: rows.reduce((total, row) => total + (row?.entryCount ?? 0), 0),
              totalBytes: rows.reduce((total, row) => total + (row?.totalBytes ?? 0), 0),
              kinds
            }
          }
        };
      }
      case "list": {
        const limit = input.limit ?? DEFAULT_LIST_LIMIT;
        const page = await registry.listEntries({ ...scope, limit, ...defined({ cursor: input.cursor }) });
        const nextActions: CatalogNextAction[] =
          page.nextCursor !== undefined
            ? [
                {
                  tool: "cache-manage",
                  params: { action: "list", ...repeatedFields(input), ...defined({ limit: input.limit }), cursor: page.nextCursor },
                  reason: "List the next page."
                }
              ]
            : [];
        return {
          result: {
            cache: {
              action: "list",
              status: (page.entries.some((entry) => entry.status !== "healthy") ? "partial" : "ok") satisfies CatalogStatus,
              entries: page.entries
            }
          },
          pagination: {
            hasMore: page.nextCursor !== undefined,
            ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {})
          },
          nextActions
        };
      }
      case "verify": {
        const output = await registry.verifyEntries(scope);
        return {
          result: {
            cache: {
              action: "verify",
              status: (output.unhealthyEntries > 0 ? "partial" : "ok") satisfies CatalogStatus,
              checkedEntries: output.checkedEntries,
              unhealthyEntries: output.unhealthyEntries
            }
          },
          warnings: output.warnings
        };
      }
      case "delete": {
        const applied = input.apply === true;
        const output = await registry.deleteEntries({ ...scope, executionMode: applied ? "apply" : "preview" });
        const undeleted = output.warnings.filter((warning) => UNDELETED_DOWNLOAD.test(warning)).length;
        const nextActions: CatalogNextAction[] =
          !applied && output.deletedEntries > 0
            ? [
                {
                  tool: "cache-manage",
                  params: { action: "delete", ...repeatedFields(input), apply: true },
                  reason: `Delete the ${output.deletedEntries} matching entr${output.deletedEntries === 1 ? "y" : "ies"} (${output.deletedBytes} bytes).`
                }
              ]
            : [];
        return {
          result: {
            cache: {
              action: "delete",
              status: (undeleted > 0 ? "partial" : "ok") satisfies CatalogStatus,
              applied,
              deletedEntries: output.deletedEntries,
              deletedBytes: output.deletedBytes
            }
          },
          warnings: output.warnings,
          nextActions
        };
      }
    }
  }
};

// ---------------------------------------------------------------------------
// server-metrics
// ---------------------------------------------------------------------------

const serverMetricsInput = z.strictObject({});

export const serverMetricsSpec: CatalogToolSpec<z.output<typeof serverMetricsInput>> = {
  name: "server-metrics",
  description:
    "Runtime counters of this server process since it started: per-tool call counts and durations, cache, " +
    "search and index counters, and latency timings. Takes no input. Example: {}",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: serverMetricsInput,
  examples: [{}],
  statuses: ["ok"],
  primaryKey: "metrics",
  handler: async (_input, call) => ({ result: { metrics: call.services.getRuntimeMetrics() } })
};

export const OPERATIONS_TOOL_SPECS: readonly CatalogToolSpec[] = [cacheManageSpec, serverMetricsSpec];
