import { z } from "zod";

import {
  type CacheRegistry,
  type CacheSelector,
  PUBLIC_CACHE_KINDS
} from "../cache-registry.js";
import { createError, ERROR_CODES } from "../errors.js";
import {
  buildIncludeSchema,
  detailSchema,
  executionModeSchema,
  positiveIntSchema
} from "./entry-tool-schema.js";
import {
  buildEntryToolResult,
  createNextAction,
  createSummarySubject
} from "./response-contract.js";
import {
  normalizeReadOnlyExecutionMode,
  requireNonEmptyObject,
  resolveDetail,
  resolveInclude
} from "./request-normalizers.js";

const nonEmptyString = z.string().trim().min(1);
const INCLUDE_GROUPS = ["warnings", "cacheEntries", "paths", "owners", "health", "preview", "timings"] as const;

export const manageCacheShape = {
  action: z.enum(["summary", "list", "inspect", "delete", "prune", "rebuild", "verify"]),
  cacheKinds: z.array(z.enum(PUBLIC_CACHE_KINDS)).optional(),
  selector: z.object({
    artifactId: nonEmptyString.optional(),
    version: nonEmptyString.optional(),
    jarPath: nonEmptyString.optional(),
    entryId: nonEmptyString.optional(),
    status: z.enum(["healthy", "partial", "stale", "orphaned", "corrupt", "in_use"]).optional(),
    olderThan: nonEmptyString.optional(),
    mapping: nonEmptyString.optional(),
    scope: nonEmptyString.optional(),
    projectPath: nonEmptyString.optional()
  }).optional(),
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS),
  limit: positiveIntSchema.optional(),
  cursor: nonEmptyString.optional(),
  executionMode: executionModeSchema.optional()
};

export const manageCacheSchema = z.object(manageCacheShape);

export type ManageCacheInput = z.infer<typeof manageCacheSchema>;

export class ManageCacheService {
  constructor(private readonly deps: { registry: CacheRegistry }) {}

  async execute(input: ManageCacheInput): Promise<Record<string, unknown> & { warnings?: string[] }> {
    const detail = resolveDetail(input.detail);
    const include = resolveInclude(input.include);
    const executionMode = normalizeReadOnlyExecutionMode(input.action, input.executionMode);
    const cacheKinds = input.cacheKinds?.length ? input.cacheKinds : [...PUBLIC_CACHE_KINDS];
    const summarySubject = createSummarySubject({
      action: input.action,
      cacheKinds,
      executionMode,
      selector: input.selector
    });

    if (
      executionMode === "apply" &&
      (input.action === "delete" || input.action === "prune" || input.action === "rebuild")
    ) {
      requireNonEmptyObject(
        input.selector as Record<string, unknown> | undefined,
        `${input.action} apply requires a non-empty selector.`
      );
    }

    switch (input.action) {
      case "summary": {
        const summary = await this.deps.registry.summarize({
          cacheKinds,
          selector: input.selector
        });
        const hasUnhealthyKinds = Object.values(summary.kinds).some((item) => item && item.status !== "healthy");
        const entryCount = Object.values(summary.kinds).reduce(
          (total, item) => total + (item?.entryCount ?? 0),
          0
        );
        const totalBytes = Object.values(summary.kinds).reduce(
          (total, item) => total + (item?.totalBytes ?? 0),
          0
        );
        return {
          ...buildEntryToolResult({
            task: "summary",
            detail,
            include,
            summary: {
              status: hasUnhealthyKinds ? "partial" : "ok",
              headline: `Summarized ${cacheKinds.length} cache kind(s).`,
              subject: summarySubject,
              counts: {
                entries: entryCount,
                bytes: totalBytes
              }
            },
            blocks: {
              stats: summary.kinds,
              operation: {
                executionMode
              }
            },
            alwaysBlocks: ["operation"]
          }),
          warnings: []
        };
      }
      case "list":
      case "inspect": {
        const page = input.action === "list"
          ? await this.deps.registry.listEntries({
              cacheKinds,
              selector: input.selector,
              limit: input.limit,
              cursor: input.cursor
            })
          : {
              entries: await this.deps.registry.inspectEntries({
                cacheKinds,
                selector: input.selector,
                limit: input.limit
              }),
              nextCursor: undefined
            };
        const hasUnhealthyEntries = page.entries.some((entry) => entry.status !== "healthy");
        return {
          ...buildEntryToolResult({
            task: input.action,
            detail,
            include,
            summary: {
              status: hasUnhealthyEntries ? "partial" : "ok",
              headline: `${input.action === "list" ? "Listed" : "Inspected"} ${page.entries.length} cache entr${page.entries.length === 1 ? "y" : "ies"}.`,
              subject: summarySubject,
              counts: {
                entries: page.entries.length
              }
            },
            blocks: {
              cacheEntries: page.entries,
              operation: {
                executionMode
              }
            },
            alwaysBlocks: ["operation"]
          }),
          warnings: [],
          ...(input.action === "list" && page.nextCursor
            ? {
                meta: {
                  pagination: {
                    nextCursor: page.nextCursor
                  }
                }
              }
            : {})
        };
      }
      case "verify": {
        const output = await this.deps.registry.verifyEntries({
          cacheKinds,
          selector: input.selector
        });
        return {
          ...buildEntryToolResult({
            task: "verify",
            detail,
            include,
            summary: {
              status: output.unhealthyEntries > 0 ? "partial" : "ok",
              headline: `Verified ${output.checkedEntries} cache entr${output.checkedEntries === 1 ? "y" : "ies"}.`,
              subject: summarySubject,
              counts: {
                checkedEntries: output.checkedEntries,
                unhealthyEntries: output.unhealthyEntries
              }
            },
            blocks: {
              operation: {
                executionMode
              }
            },
            alwaysBlocks: ["operation"]
          }),
          warnings: output.warnings
        };
      }
      case "delete":
      case "prune": {
        const output = input.action === "delete"
          ? await this.deps.registry.deleteEntries({
              cacheKinds,
              selector: input.selector,
              executionMode
            })
          : await this.deps.registry.pruneEntries({
              cacheKinds,
              selector: input.selector,
              executionMode
            });
        return {
          ...buildEntryToolResult({
            task: input.action,
            detail,
            include,
            summary: {
              status: output.deletedEntries > 0 && executionMode === "apply" ? "changed" : "unchanged",
              headline: `${executionMode === "apply" ? "Applied" : "Previewed"} ${input.action} across ${cacheKinds.length} cache kind(s).`,
              subject: summarySubject,
              counts: {
                deletedEntries: output.deletedEntries,
                deletedBytes: output.deletedBytes
              },
              ...(executionMode === "preview"
                ? {
                    nextActions: [
                      createNextAction("manage-cache", {
                        action: input.action,
                        cacheKinds,
                        executionMode: "apply",
                        selector: input.selector
                      })
                    ]
                  }
                : {})
            },
            blocks: {
              operation: {
                executionMode,
                deletedEntries: output.deletedEntries,
                deletedBytes: output.deletedBytes
              }
            },
            alwaysBlocks: ["operation"]
          }),
          warnings: output.warnings
        };
      }
      case "rebuild": {
        const output = await this.deps.registry.rebuildEntries({
          cacheKinds,
          selector: input.selector,
          executionMode
        });
        return {
          ...buildEntryToolResult({
            task: "rebuild",
            detail,
            include,
            summary: {
              status: output.rebuiltEntries > 0 && executionMode === "apply" ? "changed" : "unchanged",
              headline: `${executionMode === "apply" ? "Applied" : "Previewed"} rebuild for ${cacheKinds.length} cache kind(s).`,
              subject: summarySubject,
              counts: {
                rebuiltEntries: output.rebuiltEntries
              },
              ...(executionMode === "preview"
                ? {
                    nextActions: [
                      createNextAction("manage-cache", {
                        action: "rebuild",
                        cacheKinds,
                        executionMode: "apply",
                        selector: input.selector
                      })
                    ]
                  }
                : {})
            },
            blocks: {
              operation: {
                executionMode,
                rebuiltEntries: output.rebuiltEntries
              }
            },
            alwaysBlocks: ["operation"]
          }),
          warnings: output.warnings
        };
      }
    }

    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Unsupported manage-cache action "${input.action}".`
    });
  }
}
