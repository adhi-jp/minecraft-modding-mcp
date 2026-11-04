import { z } from "zod";

import { buildSuggestedCall } from "../../build-suggested-call.js";
import { createError, ERROR_CODES, isAppError } from "../../errors.js";
import {
  hasPartialVanillaCoverage,
  resolveBinaryBackedClass,
  type InspectMinecraftDeps
} from "../../entry-tools/inspect-minecraft/internal.js";
import {
  describeResolvedArtifact,
  resolveCatalogTarget,
  toResolveArtifactRequest,
  withCatalogFieldPaths,
  withMappingApplied,
  type CatalogTarget
} from "../artifact-target.js";
import { defined } from "../items.js";
import { detailSchema, mappingSchema, nonEmptyString, numericInput, targetSchema } from "../schemas.js";
import type {
  CatalogNextAction,
  CatalogServices,
  CatalogStatus,
  CatalogToolSpec,
  CatalogTruncation,
  CatalogWarning,
  ServiceSuggestedCall
} from "../types.js";

/**
 * Resolution family: listing versions, resolving and indexing artifacts,
 * listing and reading the files inside an artifact, and finding classes by
 * name. Every target-taking tool returns `result.artifact` so the caller can
 * reuse `{ kind: "artifact", artifactId }`.
 */

const ALL_TARGET_KINDS = ["artifact", "version", "jar", "coordinate", "workspace", "dependency"] as const;
const RESOLVABLE_TARGET_KINDS = ["version", "jar", "coordinate", "workspace", "dependency"] as const;

// ---------------------------------------------------------------------------
// version-list
// ---------------------------------------------------------------------------

const versionListInput = z.strictObject({
  includeSnapshots: z.boolean().default(false),
  limit: numericInput(z.number().int().min(1).max(200)).default(20).describe("Default 20, per release type.")
});

export const versionListSpec: CatalogToolSpec<z.output<typeof versionListInput>> = {
  name: "version-list",
  description:
    "List Minecraft versions from Mojang's version manifest: releases, then snapshots, each newest first, " +
    "with the latest release and snapshot and the versions already cached locally.",
  annotations: { readOnlyHint: true },
  inputSchema: versionListInput,
  examples: [{}, { includeSnapshots: true, limit: 5 }],
  statuses: ["ok"],
  primaryKey: "versions",
  handler: async (input, call) => {
    const output = await call.services.listVersions({
      includeSnapshots: input.includeSnapshots,
      limit: input.limit
    });
    const cached = new Set(output.cached);
    const entry = (type: "release" | "snapshot") => (version: { id: string; unobfuscated: boolean }) => ({
      version: version.id,
      type,
      unobfuscated: version.unobfuscated,
      cached: cached.has(version.id)
    });
    return {
      result: {
        versions: [...output.releases.map(entry("release")), ...(output.snapshots ?? []).map(entry("snapshot"))],
        latest: output.latest,
        cached: output.cached,
        totalAvailable: output.totalAvailable
      },
      warnings: output.warnings ?? []
    };
  }
};

// ---------------------------------------------------------------------------
// artifact-resolve
// ---------------------------------------------------------------------------

const artifactResolveInput = z.strictObject({
  target: targetSchema(RESOLVABLE_TARGET_KINDS),
  mapping: mappingSchema.optional(),
  sourcePriority: z.enum(["loom-first", "maven-first"]).optional(),
  allowDecompile: z.boolean().default(true),
  gradleUserHome: nonEmptyString.optional(),
  preferProjectVersion: z
    .boolean()
    .optional()
    .describe("Use the Minecraft version of target.projectPath instead of target.version."),
  strictVersion: z.boolean().optional().describe("Fail instead of serving another version's source."),
  detail: detailSchema("summary")
});

type ArtifactResolveInput = z.output<typeof artifactResolveInput>;

/**
 * The resolver's strict-version failure with its recovery call rebuilt from
 * the request: the resolver suggests only the version with
 * `strictVersion: false`, which drops the `mapping` (an approximated version
 * comes only from the Mojang-named Loom discovery, so without it the retry
 * resolves another artifact), `target.projectPath`, `target.scope` and the
 * other tuning. Any other error is returned as it is.
 */
function withStrictVersionRetry(caught: unknown, input: ArtifactResolveInput): unknown {
  if (
    input.strictVersion !== true ||
    !isAppError(caught) ||
    caught.code !== ERROR_CODES.VERSION_NOT_FOUND ||
    caught.details?.requestedVersion === undefined ||
    caught.details?.selectedSourceJar === undefined
  ) {
    return caught;
  }
  const { suggestedCall: _lossyRetry, ...details } = caught.details;
  return createError({
    code: caught.code,
    message: caught.message,
    details: {
      ...details,
      ...buildSuggestedCall({
        tool: "artifact-resolve",
        params: {
          target: input.target,
          ...defined({
            mapping: input.mapping,
            sourcePriority: input.sourcePriority,
            allowDecompile: input.allowDecompile === false ? false : undefined,
            gradleUserHome: input.gradleUserHome,
            preferProjectVersion: input.preferProjectVersion,
            detail: input.detail === "summary" ? undefined : input.detail
          }),
          strictVersion: false
        }
      })
    }
  });
}

export const artifactResolveSpec: CatalogToolSpec<ArtifactResolveInput> = {
  name: "artifact-resolve",
  description:
    "Resolve a version, jar, coordinate, workspace or dependency target to a source artifact. Reuse " +
    'result.artifact.artifactId in other tools as target {"kind":"artifact","artifactId":"..."}. ' +
    "The resolution options live only on this tool. " +
    'Example: {"target":{"kind":"version","version":"1.21.10"}}',
  annotations: { readOnlyHint: true },
  inputSchema: artifactResolveInput,
  examples: [
    { target: { kind: "version", version: "1.21.10" } },
    { target: { kind: "workspace", projectPath: "/path/to/mod" }, detail: "standard" }
  ],
  statuses: ["ok"],
  primaryKey: "artifact",
  detailProjection: {
    default: "summary",
    minimumLevel: {
      artifactContents: "standard",
      adjacentSourceCandidates: "standard",
      binaryJarPath: "standard",
      coordinate: "standard",
      repoUrl: "standard",
      resolvedSourceJarPath: "standard",
      provenance: "full",
      sampleEntries: "full"
    }
  },
  handler: async (input, call) => {
    const target = input.target as CatalogTarget;
    const resolved = await withCatalogFieldPaths(target, () => call.services.resolveArtifact({
      ...toResolveArtifactRequest(target),
      ...defined({
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        allowDecompile: input.allowDecompile,
        gradleUserHome: input.gradleUserHome,
        preferProjectVersion: input.preferProjectVersion,
        strictVersion: input.strictVersion
      }),
      includeSampleEntries: input.detail === "full"
    })).catch((caught: unknown) => {
      throw withStrictVersionRetry(caught, input);
    });
    const described = describeResolvedArtifact(resolved);
    return {
      result: {
        artifact: {
          ...described.artifact,
          ...defined({
            artifactAlias: resolved.artifactAlias,
            requestedMapping: resolved.requestedMapping,
            origin: resolved.origin,
            isDecompiled: resolved.isDecompiled,
            qualityFlags: resolved.qualityFlags,
            artifactContents: resolved.artifactContents,
            adjacentSourceCandidates: resolved.adjacentSourceCandidates,
            binaryJarPath: resolved.binaryJarPath,
            coordinate: resolved.coordinate,
            repoUrl: resolved.repoUrl,
            resolvedSourceJarPath: resolved.resolvedSourceJarPath,
            provenance: resolved.provenance,
            sampleEntries: resolved.sampleEntries
          })
        }
      },
      warnings: described.warnings
    };
  }
};

// ---------------------------------------------------------------------------
// artifact-index
// ---------------------------------------------------------------------------

const artifactIndexInput = z.strictObject({
  target: targetSchema(ALL_TARGET_KINDS),
  force: z.boolean().default(false).describe("Rebuild even when the index is current.")
});

export const artifactIndexSpec: CatalogToolSpec<z.output<typeof artifactIndexInput>> = {
  name: "artifact-index",
  description:
    "Rebuild the cached file and symbol index of an artifact. A target that is not cached yet is resolved and " +
    "indexed first; force: true rebuilds an index that is already current.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: artifactIndexInput,
  examples: [{ target: { kind: "artifact", artifactId: "artifact-id" }, force: true }],
  statuses: ["ok"],
  primaryKey: "artifact",
  handler: async (input, call) => {
    const target = await resolveCatalogTarget(call.services, input.target as CatalogTarget);
    const output = await call.services.indexArtifact({ artifactId: target.artifactId, force: input.force });
    return {
      result: {
        artifact: {
          ...withMappingApplied(target.artifact, output.mappingApplied),
          reindexed: output.reindexed,
          reason: output.reason,
          counts: output.counts,
          indexedAt: output.indexedAt
        }
      },
      warnings: target.warnings
    };
  }
};

// ---------------------------------------------------------------------------
// file-list
// ---------------------------------------------------------------------------

const fileListInput = z.strictObject({
  target: targetSchema(ALL_TARGET_KINDS),
  prefix: nonEmptyString.optional().describe('Path prefix, e.g. "net/minecraft/world/item/".'),
  limit: numericInput(z.number().int().min(1).max(2000)).default(200).describe("Default 200."),
  cursor: nonEmptyString.optional().describe("meta.pagination.nextCursor of the previous page.")
});

export const fileListSpec: CatalogToolSpec<z.output<typeof fileListInput>> = {
  name: "file-list",
  description:
    "List the file paths inside an artifact, optionally under a path prefix. Pages with limit; pass " +
    "meta.pagination.nextCursor as cursor for the next page.",
  annotations: { readOnlyHint: true },
  inputSchema: fileListInput,
  examples: [{ target: { kind: "artifact", artifactId: "artifact-id" }, prefix: "net/minecraft/world/item/" }],
  statuses: ["ok"],
  primaryKey: "files",
  handler: async (input, call) => {
    const target = await resolveCatalogTarget(call.services, input.target as CatalogTarget);
    const output = await call.services.listArtifactFiles({
      artifactId: target.artifactId,
      ...defined({ prefix: input.prefix, cursor: input.cursor }),
      limit: input.limit
    });
    const nextActions: CatalogNextAction[] =
      output.nextCursor !== undefined
        ? [
            {
              tool: "file-list",
              params: {
                target: { kind: "artifact", artifactId: target.artifactId },
                ...defined({ prefix: input.prefix }),
                limit: input.limit,
                cursor: output.nextCursor
              },
              reason: "Read the next page."
            }
          ]
        : [];
    return {
      result: {
        files: output.items,
        artifact: withMappingApplied(target.artifact, output.mappingApplied)
      },
      warnings: [...target.warnings, ...output.warnings],
      pagination: {
        hasMore: output.nextCursor !== undefined,
        ...(output.nextCursor !== undefined ? { nextCursor: output.nextCursor } : {})
      },
      nextActions
    };
  }
};

// ---------------------------------------------------------------------------
// file-read
// ---------------------------------------------------------------------------

const fileReadInput = z.strictObject({
  target: targetSchema(ALL_TARGET_KINDS),
  filePath: nonEmptyString.describe('Path inside the artifact, e.g. "net/minecraft/world/item/Item.java".'),
  maxBytes: numericInput(z.number().int().min(1)).optional()
});

export const fileReadSpec: CatalogToolSpec<z.output<typeof fileReadInput>> = {
  name: "file-read",
  description:
    "Read one file inside an artifact by its path: a source file, or a resource or data file of the backing jar. " +
    "maxBytes caps the returned content; a cut is reported in meta.truncation. " +
    'Example: {"target":{"kind":"artifact","artifactId":"..."},"filePath":"net/minecraft/world/item/Item.java"}',
  annotations: { readOnlyHint: true },
  inputSchema: fileReadInput,
  examples: [
    {
      target: { kind: "artifact", artifactId: "artifact-id" },
      filePath: "net/minecraft/world/item/Item.java",
      maxBytes: 65536
    }
  ],
  statuses: ["ok"],
  primaryKey: "content",
  handler: async (input, call) => {
    const target = await resolveCatalogTarget(call.services, input.target as CatalogTarget);
    const output = await call.services.getArtifactFile({
      artifactId: target.artifactId,
      filePath: input.filePath,
      ...defined({ maxBytes: input.maxBytes })
    });
    const truncation: CatalogTruncation[] = output.truncated ? [{ field: "content", limitedBy: "maxBytes" }] : [];
    return {
      result: {
        content: output.content,
        filePath: output.filePath,
        contentBytes: output.contentBytes,
        ...defined({ deliveryMode: output.deliveryMode, contentOmittedReason: output.contentOmittedReason }),
        artifact: withMappingApplied(target.artifact, output.mappingApplied)
      },
      warnings: target.warnings,
      truncation
    };
  }
};

// ---------------------------------------------------------------------------
// class-find
// ---------------------------------------------------------------------------

const classFindInput = z.strictObject({
  target: targetSchema(ALL_TARGET_KINDS),
  className: nonEmptyString.describe('Simple ("Blocks") or fully qualified class name.'),
  limit: numericInput(z.number().int().min(1).max(200)).default(20).describe("Default 20.")
});

/** The binary-backed lookup a workspace with partial vanilla source coverage falls back to. */
function binaryLookupDeps(services: CatalogServices): InspectMinecraftDeps {
  return {
    checkSymbolExists: (input: Parameters<NonNullable<InspectMinecraftDeps["checkSymbolExists"]>>[0]) =>
      services.checkSymbolExists(input)
  } as Pick<InspectMinecraftDeps, "checkSymbolExists"> as InspectMinecraftDeps;
}

/** The most matches one class lookup returns. */
const FIND_CLASS_SERVICE_CAP = 200;

/** `count` counts every candidate seen, including those beyond `limit`. */
function classStatus(count: number): CatalogStatus {
  if (count === 0) return "not_found";
  return count === 1 ? "ok" : "ambiguous";
}

export const classFindSpec: CatalogToolSpec<z.output<typeof classFindInput>> = {
  name: "class-find",
  description:
    "Find fully qualified class names by simple or qualified name in an artifact, including classes in nested " +
    "jars. status: ok (one class), ambiguous (several) or not_found. " +
    'Example: {"target":{"kind":"version","version":"1.21.10"},"className":"Blocks"}',
  annotations: { readOnlyHint: true },
  inputSchema: classFindInput,
  examples: [{ target: { kind: "version", version: "1.21.10" }, className: "Blocks" }],
  statuses: ["ok", "ambiguous", "not_found"],
  primaryKey: "classes",
  handler: async (input, call) => {
    const target = await resolveCatalogTarget(call.services, input.target as CatalogTarget);
    // One match beyond `limit` tells a cut list and an ambiguous name apart.
    // At the service's cap a full page may already be cut.
    const lookahead = Math.min(input.limit + 1, FIND_CLASS_SERVICE_CAP);
    const output = await call.services.findClassIncludingNested({
      className: input.className,
      artifactId: target.artifactId,
      limit: lookahead
    });
    const cut =
      output.matches.length > input.limit ||
      output.total > output.matches.length ||
      (input.limit >= FIND_CLASS_SERVICE_CAP && output.matches.length >= FIND_CLASS_SERVICE_CAP);
    const candidateCount = output.matches.length;
    let classes: Array<Record<string, unknown>> = output.matches.slice(0, input.limit).map((match) => ({
      className: match.qualifiedName,
      filePath: match.filePath,
      line: match.line,
      symbolKind: match.symbolKind,
      ...defined({ nested: match.nested, enclosingClass: match.enclosingClass })
    }));
    const warnings: Array<string | CatalogWarning> = [...target.warnings, ...output.warnings];
    let serviceSuggestedCalls: ServiceSuggestedCall[] = output.suggestedCall !== undefined ? [output.suggestedCall] : [];

    // A workspace whose sources omit net.minecraft cannot answer a vanilla
    // class from its index; the class is then confirmed in the binary jar.
    if (output.total === 0 && input.target.kind === "workspace" && hasPartialVanillaCoverage(target.resolved)) {
      const fallback = await resolveBinaryBackedClass(binaryLookupDeps(call.services), input.className, {
        ...defined({ version: target.resolved?.version, mapping: target.resolved?.mappingApplied })
      });
      if (fallback !== undefined) {
        classes = [{ className: fallback.className, binaryOnly: true }];
        warnings.push(...fallback.warnings, {
          code: "binary-fallback",
          severity: "info",
          message:
            "The workspace sources omit net.minecraft, so the class was confirmed in the binary jar; it has no source file in this artifact."
        });
        serviceSuggestedCalls = [];
      }
    }

    const truncation: CatalogTruncation[] = cut ? [{ field: "classes", limitedBy: "limit" }] : [];
    return {
      result: {
        status: classStatus(Math.max(classes.length, candidateCount)),
        classes,
        artifact: target.artifact
      },
      warnings,
      serviceSuggestedCalls,
      truncation
    };
  }
};

export const RESOLUTION_TOOL_SPECS: readonly CatalogToolSpec[] = [
  versionListSpec,
  artifactResolveSpec,
  artifactIndexSpec,
  fileListSpec,
  fileReadSpec,
  classFindSpec
];
