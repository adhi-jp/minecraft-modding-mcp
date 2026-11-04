import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";

import { z } from "zod";

import { mapWithConcurrencyLimit } from "../../concurrency.js";
import { problemClassification } from "../../error-mapping.js";
import { createError, ERROR_CODES, isAppError } from "../../errors.js";
import { normalizePathForHost } from "../../path-converter.js";
import type { GetClassMembersOutput, GetClassSourceOutput } from "../../source-service.js";
import { writeSourceToOutputFile } from "../../text-truncate.js";
import type { SourceMapping } from "../../types.js";
import { resolveCatalogTarget, withMappingApplied, type CatalogTarget, type ResolvedCatalogTarget } from "../artifact-target.js";
import { defined, failedItem as failedWorkItem, FollowUps, itemCounts, type FailedItem as FailedWorkItem } from "../items.js";
import { detailSchema, mappingSchema, nonEmptyString, numericInput, targetSchema } from "../schemas.js";
import type {
  CatalogCall,
  CatalogStatus,
  CatalogToolSpec,
  CatalogTruncation,
  CatalogWarning
} from "../types.js";

/**
 * Source family: reading class source, writing it to files, and listing the
 * bytecode members of classes. Each call resolves its target once and reads
 * 1 to 50 classes from that artifact; every class gets its own item with a
 * status, and a class that fails carries its error inside its item. Only
 * invalid input or a target that cannot be resolved fails the whole call.
 */

const ALL_TARGET_KINDS = ["artifact", "version", "jar", "coordinate", "workspace", "dependency"] as const;

/** Classes read at the same time within one call. */
const ITEM_CONCURRENCY = 4;

/** The line window the source service reads in snippet mode when no range or `maxLines` is given. */
const DEFAULT_SNIPPET_LINES = 200;

const classesSchema = z
  .array(nonEmptyString)
  .min(1)
  .max(50)
  .describe('1-50 fully qualified class names, e.g. ["net.minecraft.world.item.Item"].');

const sourceModeSchema = z.enum(["metadata", "snippet", "full"]);

/**
 * Fields that address a position inside one class (a line range or a page
 * cursor) and so are accepted only when `classes` holds exactly one class.
 */
function singleClassFields<T extends { classes: string[] }>(fields: ReadonlyArray<keyof T & string>) {
  return (value: T, ctx: z.RefinementCtx) => {
    if (value.classes.length === 1) return;
    for (const field of fields) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `"${field}" is accepted only with exactly one class in "classes".`
        });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Items, statuses and errors
// ---------------------------------------------------------------------------

type FailedItem = FailedWorkItem<{ className: string }>;

/** The status of a class whose read failed with `code`. */
function failureStatus(code: string): CatalogStatus {
  switch (code) {
    case ERROR_CODES.CLASS_NOT_FOUND:
      return "not_found";
    case ERROR_CODES.NESTED_JAR_AMBIGUOUS:
      return "ambiguous";
    case ERROR_CODES.MAPPING_NOT_APPLIED:
    case ERROR_CODES.MAPPING_UNAVAILABLE:
      return "unavailable";
    default:
      return "error";
  }
}

/** The item for a class whose read failed; see `failedItem` in `items.ts`. */
function failedItem(className: string, caught: unknown, call: CatalogCall, followUps: FollowUps): FailedItem {
  return failedWorkItem({ className }, caught, call, followUps, failureStatus);
}

function writeFailure(className: string, outputDir: string, path: string, errno: string | undefined): FailedItem {
  return {
    className,
    status: "error",
    error: {
      code: ERROR_CODES.INVALID_INPUT,
      detail: `outputDir "${outputDir}": "${path}" could not be written (${errno ?? "unknown error"}).`,
      ...problemClassification(ERROR_CODES.INVALID_INPUT, undefined)
    }
  };
}

/** Fields of an item read from another artifact or namespace than the call's artifact. */
function itemContext(
  shared: ResolvedCatalogTarget,
  artifactMapping: SourceMapping | undefined,
  output: { artifactId: string },
  namespace: SourceMapping
): Record<string, unknown> {
  return {
    ...(output.artifactId !== shared.artifactId ? { artifactId: output.artifactId } : {}),
    ...(artifactMapping !== undefined && namespace !== artifactMapping ? { mappingApplied: namespace } : {})
  };
}

/** The request options the class services take from the target beside the artifact. */
function targetContext(target: CatalogTarget) {
  return defined({ projectPath: target.projectPath, scope: target.scope });
}

/** Recovery must not turn a source call that declined decompilation into one that permits it. */
function sourceRecoveryError(caught: unknown, allowDecompile: boolean | undefined): unknown {
  if (allowDecompile !== false || !isAppError(caught) || caught.details === undefined) return caught;
  const preserve = (suggestion: unknown) => {
    if (typeof suggestion !== "object" || suggestion === null) return suggestion;
    const action = suggestion as { tool?: unknown; params?: unknown };
    if (!["resolve-artifact", "get-class-source", "artifact-resolve", "source-read", "source-export"].includes(String(action.tool))) {
      return suggestion;
    }
    if (typeof action.params !== "object" || action.params === null || Array.isArray(action.params)) return suggestion;
    return { ...suggestion, params: { ...action.params, allowDecompile: false } };
  };
  return createError({
    code: caught.code,
    message: caught.message,
    details: {
      ...caught.details,
      ...(caught.details.suggestedCall !== undefined ? { suggestedCall: preserve(caught.details.suggestedCall) } : {}),
      ...(Array.isArray(caught.details.exampleCalls) ? { exampleCalls: caught.details.exampleCalls.map(preserve) } : {})
    }
  });
}

async function resolveSourceTarget(
  call: CatalogCall,
  target: CatalogTarget,
  input: { mapping?: SourceMapping; allowDecompile?: boolean }
): Promise<ResolvedCatalogTarget> {
  try {
    return await resolveCatalogTarget(
      call.services, target, defined({ mapping: input.mapping, allowDecompile: input.allowDecompile })
    );
  } catch (caught) {
    throw sourceRecoveryError(caught, input.allowDecompile);
  }
}

type ReadOutcome<T> = { className: string; output: T };

function firstOutput<T>(outcomes: ReadonlyArray<ReadOutcome<T> | FailedItem>): T | undefined {
  return outcomes.find((outcome): outcome is ReadOutcome<T> => "output" in outcome)?.output;
}

// ---------------------------------------------------------------------------
// source-read
// ---------------------------------------------------------------------------

const sourceReadInput = z
  .strictObject({
    target: targetSchema(ALL_TARGET_KINDS),
    classes: classesSchema,
    mapping: mappingSchema.optional().describe("Namespace of the class names; default the artifact's."),
    allowDecompile: z.boolean().optional().describe("Allow source decompilation on this call; default true."),
    mode: sourceModeSchema
      .default("metadata")
      .describe("metadata: member outline; snippet: source, 200 lines unless a range or maxLines is set; full: whole source."),
    startLine: numericInput(z.number().int().min(1)).optional().describe("One class only."),
    endLine: numericInput(z.number().int().min(1)).optional().describe("One class only."),
    maxLines: numericInput(z.number().int().min(1)).optional(),
    maxChars: numericInput(z.number().int().min(1)).optional(),
    withProvenance: z.boolean().default(false).describe("Add provenance, qualityFlags and artifactContents per class.")
  })
  .superRefine(singleClassFields(["startLine", "endLine"]))
  .superRefine((value, ctx) => {
    if (value.startLine !== undefined && value.endLine !== undefined && value.startLine > value.endLine) {
      ctx.addIssue({ code: "custom", path: ["startLine"], message: "startLine must be less than or equal to endLine." });
    }
  });

type SourceReadInput = z.output<typeof sourceReadInput>;

function sourceTruncation(output: GetClassSourceOutput): string | undefined {
  if (output.charsTruncated === true) return "maxChars";
  if (output.nextStartLine !== undefined) return "maxLines";
  return undefined;
}

/**
 * The line window the service applied: the requested `maxLines`, or the
 * default snippet window when snippet mode came without a range or limit.
 * A continuation carries it, since its `startLine` turns the default off.
 */
function appliedMaxLines(input: SourceReadInput): number | undefined {
  if (input.maxLines !== undefined) return input.maxLines;
  const unbounded = input.startLine === undefined && input.endLine === undefined;
  return input.mode === "snippet" && unbounded ? DEFAULT_SNIPPET_LINES : undefined;
}

export const sourceReadSpec: CatalogToolSpec<SourceReadInput> = {
  name: "source-read",
  description:
    "Read the Java source of 1-50 classes from one artifact (Minecraft, dependency or mod jar): a member outline " +
    "(mode metadata, default), a line window (snippet) or the whole file (full). Read-only; source-export writes files. " +
    'Example: {"target":{"kind":"artifact","artifactId":"..."},"classes":["net.minecraft.world.item.Item"],"mode":"snippet"}',
  annotations: { readOnlyHint: true },
  inputSchema: sourceReadInput,
  examples: [
    { target: { kind: "artifact", artifactId: "artifact-id" }, classes: ["net.minecraft.world.item.Item"], mode: "snippet" },
    { target: { kind: "jar", jarPath: "/path/to/mod.jar" }, classes: ["com.example.mod.ExampleMod"], mode: "full" }
  ],
  statuses: ["ok", "not_found", "ambiguous", "unavailable", "error"],
  primaryKey: "items",
  handler: async (input, call) => {
    const target = input.target as CatalogTarget;
    const shared = await resolveSourceTarget(call, target, input);
    const mapping = input.mapping ?? shared.artifact.mappingApplied;
    const warnings: Array<string | CatalogWarning> = [...shared.warnings];
    const followUps = new FollowUps(call.tool);
    const truncation: CatalogTruncation[] = [];

    const outcomes = await mapWithConcurrencyLimit(
      input.classes,
      ITEM_CONCURRENCY,
      async (className): Promise<ReadOutcome<GetClassSourceOutput> | FailedItem> => {
        try {
          return {
            className,
            output: await call.services.getClassSource({
              artifactId: shared.artifactId,
              className,
              mode: input.mode,
              ...defined({
                mapping,
                allowDecompile: input.allowDecompile,
                startLine: input.startLine,
                endLine: input.endLine,
                maxLines: input.maxLines,
                maxChars: input.maxChars
              }),
              ...targetContext(target)
            })
          };
        } catch (caught) {
          return failedItem(className, sourceRecoveryError(caught, input.allowDecompile), call, followUps);
        }
      }
    );

    const artifact = withMappingApplied(shared.artifact, firstOutput(outcomes)?.mappingApplied);
    const items = outcomes.map((outcome, index) => {
      if (!("output" in outcome)) return outcome;
      const output = outcome.output;
      warnings.push(...output.warnings);
      const limitedBy = sourceTruncation(output);
      if (limitedBy !== undefined) truncation.push({ field: `items[${index}].sourceText`, limitedBy });
      if (output.nextStartLine !== undefined) {
        followUps.add({
          tool: "source-read",
          params: {
            target: { kind: "artifact", artifactId: output.artifactId },
            classes: [outcome.className],
            mode: output.mode,
            startLine: output.nextStartLine,
            ...defined({
              mapping,
              allowDecompile: input.allowDecompile,
              endLine: input.endLine,
              maxLines: appliedMaxLines(input),
              maxChars: input.maxChars
            })
          },
          reason: `Read the next lines of ${outcome.className}.`
        });
      }
      return {
        className: outcome.className,
        status: "ok" as const,
        sourceText: output.sourceText,
        totalLines: output.totalLines,
        ...(output.returnedRange !== undefined ? { returnedRange: output.returnedRange } : {}),
        ...(output.outOfRange === true ? { outOfRange: true } : {}),
        ...itemContext(shared, artifact.mappingApplied, output, output.mappingApplied),
        ...(input.withProvenance
          ? {
              provenance: output.provenance,
              qualityFlags: output.qualityFlags,
              artifactContents: output.artifactContents
            }
          : {})
      };
    });

    return {
      result: { items, counts: itemCounts(items), artifact },
      warnings,
      nextActions: followUps.list(),
      truncation
    };
  }
};

// ---------------------------------------------------------------------------
// source-export
// ---------------------------------------------------------------------------

const sourceExportInput = z.strictObject({
  target: targetSchema(ALL_TARGET_KINDS),
  classes: classesSchema,
  outputDir: nonEmptyString.describe(
    "Directory to write into; relative paths resolve against the server's working directory."
  ),
  mapping: mappingSchema.optional().describe("Namespace of the class names; default the artifact's."),
  allowDecompile: z.boolean().optional().describe("Allow source decompilation on this call; default true."),
  mode: sourceModeSchema.default("full").describe("What to write: full source (default), snippet or metadata outline.")
});

type SourceExportInput = z.output<typeof sourceExportInput>;

/**
 * The file a class is written to under `outputDir`. With the path of the
 * source file read for the class (`a/b/Outer.java`), the file keeps that
 * path. Without it, the path follows the class name: the package becomes
 * directories, and the last name segment is cut at its first `$` after the
 * first character, so `a.b.Outer$Inner` writes `a/b/Outer.java`. A source
 * path that would leave `outputDir` is not used.
 */
export function exportPathFor(outputDir: string, className: string, sourceFilePath?: string): string {
  if (sourceFilePath !== undefined) {
    const fromSource = join(outputDir, ...sourceFilePath.split("/"));
    const inside = relative(outputDir, fromSource);
    if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) return fromSource;
  }
  const segments = className.split(".");
  const last = segments.pop() ?? className;
  const cut = last.indexOf("$", 1);
  return join(outputDir, ...segments, `${cut > 0 ? last.slice(0, cut) : last}.java`);
}

export const sourceExportSpec: CatalogToolSpec<SourceExportInput> = {
  name: "source-export",
  description:
    "Write the Java source of 1-50 classes from one artifact to <outputDir>/<package path>/<Class>.java, creating " +
    "directories and overwriting existing files; a nested class writes its top-level class's file. " +
    'Example: {"target":{"kind":"artifact","artifactId":"..."},"classes":["net.minecraft.world.item.Item"],"outputDir":"/tmp/src"}',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: sourceExportInput,
  examples: [
    {
      target: { kind: "artifact", artifactId: "artifact-id" },
      classes: ["net.minecraft.world.item.Item"],
      outputDir: "/tmp/exported-sources"
    }
  ],
  statuses: ["ok", "not_found", "ambiguous", "unavailable", "error"],
  primaryKey: "items",
  handler: async (input, call) => {
    const target = input.target as CatalogTarget;
    // A Windows drive or \\wsl$ / \\wsl.localhost spelling becomes this host's path first.
    const outputDir = resolvePath(normalizePathForHost(input.outputDir, undefined, "outputDir"));
    const shared = await resolveSourceTarget(call, target, input);
    const mapping = input.mapping ?? shared.artifact.mappingApplied;
    const warnings: Array<string | CatalogWarning> = [...shared.warnings];
    const followUps = new FollowUps(call.tool);
    const truncation: CatalogTruncation[] = [];

    // One class at a time: two classes can share a file (a class and its nested class).
    const outcomes = await mapWithConcurrencyLimit(
      input.classes,
      1,
      async (className): Promise<(ReadOutcome<GetClassSourceOutput> & { path: string }) | FailedItem> => {
        let output: GetClassSourceOutput;
        let path: string;
        try {
          output = await call.services.getClassSource(
            {
              artifactId: shared.artifactId,
              className,
              mode: input.mode,
              ...defined({ mapping, allowDecompile: input.allowDecompile }),
              ...targetContext(target)
            },
            { includeSourceFilePath: true }
          );
          path = exportPathFor(outputDir, className, output.sourceFilePath);
        } catch (caught) {
          return failedItem(className, sourceRecoveryError(caught, input.allowDecompile), call, followUps);
        }
        warnings.push(...output.warnings);
        try {
          await mkdir(dirname(path), { recursive: true });
          await writeSourceToOutputFile(path, output.sourceText);
        } catch (caught) {
          const errno = isAppError(caught) ? caught.details?.osErrorCode : (caught as NodeJS.ErrnoException).code;
          return writeFailure(className, outputDir, path, typeof errno === "string" ? errno : undefined);
        }
        return { className, output, path };
      }
    );

    const artifact = withMappingApplied(shared.artifact, firstOutput(outcomes)?.mappingApplied);
    const items = outcomes.map((outcome, index) => {
      if (!("output" in outcome)) return outcome;
      // The snippet window cuts the text written to the file, as it cuts source-read's sourceText.
      const limitedBy = sourceTruncation(outcome.output);
      if (limitedBy !== undefined) truncation.push({ field: `items[${index}].path`, limitedBy });
      return {
        className: outcome.className,
        status: "ok" as const,
        path: outcome.path,
        totalLines: outcome.output.totalLines,
        ...itemContext(shared, artifact.mappingApplied, outcome.output, outcome.output.mappingApplied)
      };
    });

    return {
      result: { items, counts: itemCounts(items), outputDir, artifact },
      warnings,
      nextActions: followUps.list(),
      truncation
    };
  }
};

// ---------------------------------------------------------------------------
// member-list
// ---------------------------------------------------------------------------

const memberListInput = z
  .strictObject({
    target: targetSchema(ALL_TARGET_KINDS),
    classes: classesSchema,
    mapping: mappingSchema.optional().describe("Namespace of the class and member names; default the artifact's."),
    access: z.enum(["public", "all"]).default("public"),
    includeSynthetic: z.boolean().default(false),
    includeInherited: z.boolean().default(false),
    memberPattern: nonEmptyString
      .optional()
      .describe('Case-insensitive substring of member names; "|" separates alternatives.'),
    withDescriptors: z.boolean().default(false).describe("Add JVM descriptors of fields, at every detail level."),
    withAnnotations: z.boolean().default(false).describe("Add runtime-visible member annotations, at every detail level."),
    limit: numericInput(z.number().int().min(1).max(5000)).default(150).describe("Members per class; default 150."),
    cursor: nonEmptyString.optional().describe("meta.pagination.nextCursor; one class only."),
    detail: detailSchema("standard").describe(
      "summary: name and Java signature per member; standard: adds descriptors and context; full: adds provenance."
    )
  })
  .superRefine(singleClassFields(["cursor"]));

type MemberListInput = z.output<typeof memberListInput>;

function memberStatus(output: GetClassMembersOutput): CatalogStatus {
  switch (output.status) {
    case "partial":
      return "partial";
    case "members_unavailable":
      return "unavailable";
    default:
      return "ok";
  }
}

type ListedMember = Record<string, unknown>;
type MembersBlock = { ownerFqn?: string; constructors: ListedMember[]; fields: ListedMember[]; methods: ListedMember[] };

/**
 * The summary form of a member listing: name, Java signature, owner and the
 * synthetic flag per member, plus the descriptor and annotations a `with…`
 * flag asked for. Decompiled-source fallback members keep their name only.
 */
function summaryMembers(block: MembersBlock, input: MemberListInput): MembersBlock {
  const kept = new Set(["name", "javaSignature", "ownerFqn", "isSynthetic"]);
  if (input.withDescriptors) kept.add("jvmDescriptor");
  if (input.withAnnotations) kept.add("annotations");
  const reduce = (member: ListedMember): ListedMember =>
    Object.fromEntries(Object.entries(member).filter(([key]) => kept.has(key)));
  return {
    ...(block.ownerFqn !== undefined ? { ownerFqn: block.ownerFqn } : {}),
    constructors: block.constructors.map(reduce),
    fields: block.fields.map(reduce),
    methods: block.methods.map(reduce)
  };
}

function summaryFallback(fallback: NonNullable<GetClassMembersOutput["decompiledFallback"]>) {
  const reduce = (member: { name: string }) => ({ name: member.name });
  return {
    constructors: fallback.constructors.map(reduce),
    fields: fallback.fields.map(reduce),
    methods: fallback.methods.map(reduce),
    origin: fallback.origin
  };
}

/** True when the decompiled-source fallback returned fewer members than it found. */
function fallbackCapped(output: GetClassMembersOutput): boolean {
  const fallback = output.decompiledFallback;
  const found = output.decompiledMemberCounts?.total;
  if (fallback === undefined || found === undefined) return false;
  return fallback.constructors.length + fallback.fields.length + fallback.methods.length < found;
}

export const memberListSpec: CatalogToolSpec<MemberListInput> = {
  name: "member-list",
  description:
    "List the constructors, fields and methods of 1-50 classes from an artifact's bytecode (Minecraft, dependency " +
    "or mod jar). status: ok, partial (names from decompiled source only) or unavailable. " +
    'Example: {"target":{"kind":"artifact","artifactId":"..."},"classes":["net.minecraft.world.item.Item"]}',
  annotations: { readOnlyHint: true },
  inputSchema: memberListInput,
  examples: [
    { target: { kind: "artifact", artifactId: "artifact-id" }, classes: ["net.minecraft.world.item.Item"] },
    {
      target: { kind: "jar", jarPath: "/path/to/mod.jar" },
      classes: ["com.example.mod.ExampleMod"],
      access: "all",
      detail: "summary"
    }
  ],
  statuses: ["ok", "partial", "unavailable", "not_found", "ambiguous", "error"],
  primaryKey: "items",
  detailProjection: {
    default: "standard",
    minimumLevel: {
      context: "standard",
      provenance: "full",
      qualityFlags: "full",
      artifactContents: "full"
    }
  },
  handler: async (input, call) => {
    const target = input.target as CatalogTarget;
    const shared = await resolveCatalogTarget(call.services, target, defined({ mapping: input.mapping }));
    const mapping = input.mapping ?? shared.artifact.mappingApplied;
    const warnings: Array<string | CatalogWarning> = [...shared.warnings];
    const followUps = new FollowUps(call.tool);
    const truncation: CatalogTruncation[] = [];

    const outcomes = await mapWithConcurrencyLimit(
      input.classes,
      ITEM_CONCURRENCY,
      async (className): Promise<ReadOutcome<GetClassMembersOutput> | FailedItem> => {
        try {
          return {
            className,
            output: await call.services.getClassMembers({
              artifactId: shared.artifactId,
              // A jar the caller named is their choice; any other target leaves
              // the choice of artifact to the server.
              artifactSelectedBy: target.kind === "jar" ? "caller" : "tool",
              className,
              access: input.access,
              includeSynthetic: input.includeSynthetic,
              includeInherited: input.includeInherited,
              includeAnnotations: input.withAnnotations,
              includeDescriptors: input.withDescriptors,
              maxMembers: input.limit,
              projection: "full",
              ...defined({ mapping, memberPattern: input.memberPattern, cursor: input.cursor }),
              ...targetContext(target)
            })
          };
        } catch (caught) {
          return failedItem(className, caught, call, followUps);
        }
      }
    );

    const artifact = withMappingApplied(shared.artifact, firstOutput(outcomes)?.mappingApplied);
    const summary = input.detail === "summary";
    let pagination: { hasMore: boolean; nextCursor?: string } | undefined;
    const items = outcomes.map((outcome, index) => {
      if (!("output" in outcome)) return outcome;
      const output = outcome.output;
      warnings.push(...output.warnings);
      if (output.cursorIgnored === true) {
        warnings.push({
          code: "cursor-ignored",
          severity: "warning",
          message: `The cursor does not belong to this listing of ${outcome.className}; the list starts from the first member.`
        });
      }
      followUps.addServiceCall(output.suggestedCall);
      if (fallbackCapped(output)) {
        truncation.push({ field: `items[${index}].decompiledFallback`, limitedBy: "limit" });
      }
      if (output.nextCursor !== undefined) {
        truncation.push({ field: `items[${index}].members`, limitedBy: "limit" });
        followUps.add({
          tool: "member-list",
          params: {
            target: { kind: "artifact", artifactId: output.artifactId },
            classes: [outcome.className],
            ...defined({ mapping, memberPattern: input.memberPattern }),
            access: input.access,
            includeSynthetic: input.includeSynthetic,
            includeInherited: input.includeInherited,
            withDescriptors: input.withDescriptors,
            withAnnotations: input.withAnnotations,
            limit: input.limit,
            detail: input.detail,
            cursor: output.nextCursor
          },
          reason: `Read the next page of ${outcome.className} members.`
        });
      }
      if (input.classes.length === 1) {
        pagination = {
          hasMore: output.nextCursor !== undefined,
          ...(output.nextCursor !== undefined ? { nextCursor: output.nextCursor } : {})
        };
      }
      const members = output.members as MembersBlock;
      return {
        className: outcome.className,
        status: memberStatus(output),
        members: summary ? summaryMembers(members, input) : members,
        counts: output.counts,
        ...defined({
          decompiledFallback:
            summary && output.decompiledFallback !== undefined
              ? summaryFallback(output.decompiledFallback)
              : output.decompiledFallback,
          decompiledMemberCounts: output.decompiledMemberCounts,
          unavailableReason: output.unavailableReason
        }),
        context: output.context,
        ...itemContext(shared, artifact.mappingApplied, output, output.returnedNamespace),
        provenance: output.provenance,
        qualityFlags: output.qualityFlags,
        artifactContents: output.artifactContents
      };
    });

    return {
      result: { items, counts: itemCounts(items), artifact },
      warnings,
      nextActions: followUps.list(),
      truncation,
      ...(pagination !== undefined ? { pagination } : {})
    };
  }
};

export const SOURCE_TOOL_SPECS: readonly CatalogToolSpec[] = [sourceReadSpec, sourceExportSpec, memberListSpec];
