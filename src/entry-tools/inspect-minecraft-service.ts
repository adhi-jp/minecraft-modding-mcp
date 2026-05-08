import { z } from "zod";

import type {
  CheckSymbolExistsOutput,
  FindClassOutput,
  GetArtifactFileOutput,
  GetClassMembersOutput,
  GetClassSourceOutput,
  ListArtifactFilesOutput,
  ResolveArtifactOutput,
  SearchClassSourceOutput
} from "../source-service.js";
import type { ListVersionsOutput } from "../version-service.js";
import { buildSuggestedCall } from "../build-suggested-call.js";
import { createError, ERROR_CODES, isAppError } from "../errors.js";
import { buildIncludeSchema, detailSchema, positiveIntSchema } from "./entry-tool-schema.js";
import {
  buildEntryToolResult,
  buildEntryToolMeta,
  createNextAction,
  createSummarySubject,
  createTruncationMeta,
  type DetailLevel,
  type NextAction,
  type Summary
} from "./response-contract.js";
import { resolveDetail, resolveInclude } from "./request-normalizers.js";
import { handleVersions } from "./inspect-minecraft/handlers/versions.js";
import { handleArtifact } from "./inspect-minecraft/handlers/artifact.js";
import { handleClassOverview } from "./inspect-minecraft/handlers/class-overview.js";
import { handleClassSource } from "./inspect-minecraft/handlers/class-source.js";
import { handleClassMembers } from "./inspect-minecraft/handlers/class-members.js";
import { handleSearch } from "./inspect-minecraft/handlers/search.js";
import { handleFile } from "./inspect-minecraft/handlers/file.js";
import { handleListFiles } from "./inspect-minecraft/handlers/list-files.js";

const INCLUDE_GROUPS = ["warnings", "provenance", "candidates", "members", "source", "files", "samples", "artifact", "timings"] as const;
const TASKS = ["auto", "versions", "artifact", "class-overview", "class-source", "class-members", "search", "file", "list-files"] as const;
const SUBJECT_KINDS = ["version", "artifact", "class", "file", "search", "workspace"] as const;

const nonEmptyString = z.string().trim().min(1);

const resolveTargetSchema = z.object({
  kind: z.enum(["version", "jar", "coordinate"]),
  value: nonEmptyString
});

const artifactRefSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resolved-id"),
    artifactId: nonEmptyString
  }),
  z.object({
    type: z.literal("resolve-target"),
    target: resolveTargetSchema
  })
]);

const workspaceFocusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("class"),
    className: nonEmptyString,
    artifact: artifactRefSchema.optional()
  }),
  z.object({
    kind: z.literal("file"),
    filePath: nonEmptyString,
    artifact: artifactRefSchema.optional()
  }),
  z.object({
    kind: z.literal("search"),
    query: nonEmptyString,
    artifact: artifactRefSchema.optional(),
    intent: z.enum(["symbol", "text", "path"]).optional(),
    match: z.enum(["exact", "prefix", "contains", "regex"]).optional(),
    symbolKind: z.enum(["class", "interface", "enum", "record", "method", "field"]).optional(),
    packagePrefix: nonEmptyString.optional(),
    fileGlob: nonEmptyString.optional(),
    queryMode: z.enum(["auto", "token", "literal"]).default("auto")
  })
]);

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("version"),
    version: nonEmptyString,
    mapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
    scope: z.enum(["vanilla", "merged", "loader"]).optional(),
    projectPath: nonEmptyString.optional(),
    preferProjectVersion: z.boolean().optional(),
    strictVersion: z.boolean().optional()
  }),
  z.object({
    kind: z.literal("artifact"),
    artifact: artifactRefSchema,
    mapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
    scope: z.enum(["vanilla", "merged", "loader"]).optional(),
    projectPath: nonEmptyString.optional(),
    preferProjectVersion: z.boolean().optional(),
    strictVersion: z.boolean().optional()
  }),
  z.object({
    kind: z.literal("class"),
    className: nonEmptyString,
    artifact: artifactRefSchema.optional(),
    mapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
    scope: z.enum(["vanilla", "merged", "loader"]).optional(),
    projectPath: nonEmptyString.optional(),
    preferProjectVersion: z.boolean().optional(),
    strictVersion: z.boolean().optional()
  }),
  z.object({
    kind: z.literal("file"),
    filePath: nonEmptyString,
    artifact: artifactRefSchema.optional()
  }),
  z.object({
    kind: z.literal("search"),
    query: nonEmptyString,
    artifact: artifactRefSchema.optional(),
    intent: z.enum(["symbol", "text", "path"]).optional(),
    match: z.enum(["exact", "prefix", "contains", "regex"]).optional(),
    symbolKind: z.enum(["class", "interface", "enum", "record", "method", "field"]).optional(),
    packagePrefix: nonEmptyString.optional(),
    fileGlob: nonEmptyString.optional(),
    queryMode: z.enum(["auto", "token", "literal"]).default("auto")
  }),
  z.object({
    kind: z.literal("workspace"),
    projectPath: nonEmptyString,
    mapping: z.enum(["obfuscated", "mojang", "intermediary", "yarn"]).optional(),
    scope: z.enum(["vanilla", "merged", "loader"]).optional(),
    preferProjectVersion: z.boolean().optional(),
    strictVersion: z.boolean().optional(),
    focus: workspaceFocusSchema.optional()
  })
]);

export const inspectMinecraftShape = {
  task: z.enum(TASKS).optional(),
  subject: subjectSchema.optional(),
  includeSnapshots: z.boolean().default(false),
  detail: detailSchema.optional(),
  include: buildIncludeSchema(INCLUDE_GROUPS),
  limit: positiveIntSchema.optional(),
  cursor: nonEmptyString.optional()
};

export const inspectMinecraftSchema = z.object(inspectMinecraftShape).superRefine((value, ctx) => {
  if (!value.subject && value.task !== "versions") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject"],
      message: "subject is required unless task=versions."
    });
  }
  if (value.includeSnapshots && value.task && value.task !== "versions") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["includeSnapshots"],
      message: "includeSnapshots is only supported for task=versions."
    });
  }
});

export type InspectMinecraftInput = z.infer<typeof inspectMinecraftSchema>;

export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type Subject = z.infer<typeof subjectSchema>;
export type WorkspaceSubject = Extract<Subject, { kind: "workspace" }>;
export type WorkspaceClassFocus = Extract<z.infer<typeof workspaceFocusSchema>, { kind: "class" }>;
export type WorkspaceSearchFocus = Extract<z.infer<typeof workspaceFocusSchema>, { kind: "search" }>;
export type WorkspaceFileFocus = Extract<z.infer<typeof workspaceFocusSchema>, { kind: "file" }>;
type InspectMinecraftTask = typeof TASKS[number];
export type ConcreteInspectMinecraftTask = Exclude<InspectMinecraftTask, "auto">;
export type ArtifactContextTask = "class-overview" | "class-source" | "class-members" | "search" | "file" | "list-files";

export function hasPartialVanillaCoverage(artifact: ResolveArtifactOutput | undefined): boolean {
  return artifact?.qualityFlags.includes("partial-source-no-net-minecraft") === true
    || artifact?.artifactContents.sourceCoverage === "partial";
}

export function looksLikeClassQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(trimmed)) {
    return false;
  }
  const simpleName = trimmed.split(".").at(-1) ?? trimmed;
  return /^[A-Z_$]/.test(simpleName) || /^class_\d+(?:\$class_\d+)*$/.test(simpleName);
}

export function classNameToFilePath(className: string): string {
  const topLevelClassName = className.split("$")[0] ?? className;
  return `${topLevelClassName.replace(/\./g, "/")}.java`;
}

function isVanillaNamespacePath(filePath: string): boolean {
  return filePath.startsWith("net/minecraft/") || filePath.startsWith("com/mojang/");
}

export function hitTargetsVanillaNamespace(hit: SearchClassSourceOutput["hits"][number]): boolean {
  if (isVanillaNamespacePath(hit.filePath)) {
    return true;
  }
  const qualifiedName = hit.symbol?.qualifiedName;
  return qualifiedName?.startsWith("net.minecraft.") === true || qualifiedName?.startsWith("com.mojang.") === true;
}

export type InspectMinecraftDeps = {
  listVersions: (input: { includeSnapshots?: boolean; limit?: number }) => Promise<ListVersionsOutput>;
  resolveArtifact: (input: {
    target: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }) => Promise<ResolveArtifactOutput>;
  findClass: (input: { className: string; artifactId: string; limit?: number }) => Promise<FindClassOutput>;
  checkSymbolExists?: (input: {
    version: string;
    kind: "class" | "field" | "method";
    name: string;
    owner?: string;
    descriptor?: string;
    sourceMapping: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    nameMode?: "fqcn" | "auto";
    signatureMode?: "exact" | "name-only";
    maxCandidates?: number;
  }) => Promise<CheckSymbolExistsOutput>;
  getClassSource: (input: {
    className: string;
    artifactId?: string;
    target?: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
    mode?: "metadata" | "snippet" | "full";
    maxLines?: number;
    maxChars?: number;
  }) => Promise<GetClassSourceOutput>;
  getClassMembers: (input: {
    className: string;
    artifactId?: string;
    target?: { kind: "version" | "jar" | "coordinate"; value: string };
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    scope?: "vanilla" | "merged" | "loader";
    projectPath?: string;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
    maxMembers?: number;
  }) => Promise<GetClassMembersOutput>;
  searchClassSource: (input: {
    artifactId: string;
    query: string;
    intent?: "symbol" | "text" | "path";
    match?: "exact" | "prefix" | "contains" | "regex";
    scope?: {
      packagePrefix?: string;
      fileGlob?: string;
      symbolKind?: "class" | "interface" | "enum" | "record" | "method" | "field";
    };
    queryMode?: "auto" | "token" | "literal";
    limit?: number;
    cursor?: string;
  }) => Promise<SearchClassSourceOutput>;
  getArtifactFile: (input: {
    artifactId: string;
    filePath: string;
    maxBytes?: number;
  }) => Promise<GetArtifactFileOutput>;
  listArtifactFiles: (input: {
    artifactId: string;
    prefix?: string;
    limit?: number;
    cursor?: string;
  }) => Promise<ListArtifactFilesOutput>;
  detectProjectMinecraftVersion: (projectPath: string) => Promise<string | undefined>;
};

export class InspectMinecraftService {
  readonly deps: InspectMinecraftDeps;

  constructor(deps: InspectMinecraftDeps) {
    this.deps = deps;
  }

  async execute(input: InspectMinecraftInput): Promise<Record<string, unknown> & { warnings?: string[] }> {
    const detail = resolveDetail(input.detail);
    const include = resolveInclude(input.include);
    const task = this.resolveTask(input.task, input.subject);

    switch (task) {
      case "versions":
        return this.handleVersions(input, detail, include);
      case "artifact":
        return this.handleArtifact(input.subject!, detail, include);
      case "class-overview":
        return this.handleClassOverview(input.subject!, detail, include);
      case "class-source":
        return this.handleClassSource(input.subject!, detail, include);
      case "class-members":
        return this.handleClassMembers(input.subject!, detail, include, input.limit);
      case "search":
        return this.handleSearch(input.subject!, detail, include, input.limit, input.cursor);
      case "file":
        return this.handleFile(input.subject!, detail, include);
      case "list-files":
        return this.handleListFiles(input.subject!, detail, include, input.limit, input.cursor);
      default:
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Unsupported inspect-minecraft task "${task}".`
        });
    }
  }

  requireWorkspaceClassFocus(subject: Subject): WorkspaceClassFocus {
    if (subject.kind !== "workspace" || subject.focus?.kind !== "class") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Workspace focus must be kind=class for this task."
      });
    }
    return subject.focus;
  }

  requireWorkspaceSearchFocus(subject: Subject): WorkspaceSearchFocus {
    if (subject.kind !== "workspace" || subject.focus?.kind !== "search") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Workspace focus must be kind=search for this task."
      });
    }
    return subject.focus;
  }

  requireWorkspaceFileFocus(subject: Subject): WorkspaceFileFocus {
    if (subject.kind !== "workspace" || subject.focus?.kind !== "file") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Workspace focus must be kind=file for this task."
      });
    }
    return subject.focus;
  }

  buildClassSubject(
    subject: Extract<Subject, { kind: "class" }> | WorkspaceSubject
  ): Extract<Subject, { kind: "class" }> {
    if (subject.kind === "class") {
      return subject;
    }

    const workspaceFocus = this.requireWorkspaceClassFocus(subject);
    return {
      kind: "class",
      className: workspaceFocus.className,
      artifact: workspaceFocus.artifact,
      projectPath: subject.projectPath,
      mapping: subject.mapping,
      scope: subject.scope,
      preferProjectVersion: subject.preferProjectVersion,
      strictVersion: subject.strictVersion
    };
  }

  async resolveClassArtifactReference(
    subject: Extract<Subject, { kind: "class" }> | WorkspaceSubject,
    classSubject: Extract<Subject, { kind: "class" }>,
    task: Extract<ArtifactContextTask, "class-overview" | "class-source" | "class-members">
  ): Promise<{ artifactId: string; artifact?: ResolveArtifactOutput; version?: string; warnings: string[] }> {
    if (subject.kind === "workspace") {
      return this.resolveWorkspaceArtifactReference(subject, classSubject.artifact);
    }
    return this.resolveArtifactReference(classSubject, task);
  }

  async resolveWorkspaceArtifactReference(
    subject: WorkspaceSubject,
    artifactRef: ArtifactRef | undefined
  ): Promise<{ artifactId: string; artifact?: ResolveArtifactOutput; version?: string; warnings: string[] }> {
    if (!artifactRef) {
      return this.resolveArtifactReference(subject);
    }
    if (artifactRef.type === "resolved-id") {
      return {
        artifactId: artifactRef.artifactId,
        warnings: []
      };
    }
    const artifact = await this.deps.resolveArtifact({
      target: artifactRef.target,
      mapping: subject.mapping,
      scope: subject.scope,
      projectPath: subject.projectPath,
      preferProjectVersion: subject.preferProjectVersion,
      strictVersion: subject.strictVersion
    });
    return {
      artifactId: artifact.artifactId,
      artifact,
      warnings: [...artifact.warnings]
    };
  }

  resolveTask(task: InspectMinecraftInput["task"], subject: Subject | undefined) {
    if (task && task !== "auto") {
      return task;
    }
    if (!subject) {
      return "versions";
    }
    switch (subject.kind) {
      case "version":
      case "artifact":
        return "artifact";
      case "workspace":
        switch (subject.focus?.kind) {
          case "class":
            return "class-overview";
          case "search":
            return "search";
          case "file":
            return "file";
          default:
            return "artifact";
        }
      case "class":
        return "class-overview";
      case "file":
        return "file";
      case "search":
        return "search";
    }
  }

  summarizeRequestedSubject(subject: Subject): Record<string, unknown> {
    if (subject.kind === "search") {
      if (subject.queryMode !== "auto") {
        return subject;
      }
      const { queryMode: _queryMode, ...requestedSubject } = subject;
      return requestedSubject;
    }
    if (subject.kind === "workspace" && subject.focus?.kind === "search") {
      if (subject.focus.queryMode !== "auto") {
        return subject;
      }
      const { queryMode: _queryMode, ...requestedFocus } = subject.focus;
      return {
        ...subject,
        focus: requestedFocus
      };
    }
    return subject;
  }

  async exampleVersionForSubject(
    subject: Extract<Subject, { kind: "class" | "search" | "file" }>
  ): Promise<string> {
    if ("projectPath" in subject && typeof subject.projectPath === "string") {
      const detectedVersion = await this.deps.detectProjectMinecraftVersion(subject.projectPath);
      if (detectedVersion) {
        return detectedVersion;
      }
    }
    return "<version>";
  }

  async buildArtifactContextSuggestedCall(
    task: ArtifactContextTask,
    subject: Extract<Subject, { kind: "class" | "search" | "file" }>
  ): Promise<ReturnType<typeof buildSuggestedCall>> {
    return buildSuggestedCall({
      tool: "inspect-minecraft",
      params: {
        task,
        subject: {
          ...subject,
          artifact: {
            type: "resolve-target",
            target: {
              kind: "version",
              value: await this.exampleVersionForSubject(subject)
            }
          }
        }
      }
    });
  }

  taskForSubject(subject: Subject): ConcreteInspectMinecraftTask {
    return this.resolveTask(undefined, subject) as ConcreteInspectMinecraftTask;
  }

  invalidTaskSubjectError(task: ConcreteInspectMinecraftTask, subject: Subject): never {
    if (task === "class-source" && subject.kind === "version") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "class-source requires a class subject; version subjects resolve artifacts, not class names.",
        details: {
          nextAction: "Retry class-source with subject.kind=class and attach artifact context, or use task=artifact to inspect the version first.",
          ...buildSuggestedCall({
            tool: "inspect-minecraft",
            params: {
              task: "class-source",
              subject: {
                kind: "class",
                className: "net.minecraft.world.item.Item",
                artifact: {
                  type: "resolve-target",
                  target: {
                    kind: "version",
                    value: subject.version
                  }
                }
              }
            }
          })
        }
      });
    }

    const suggestedTask = this.taskForSubject(subject);
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `${task} is not compatible with subject.kind="${subject.kind}".`,
      details: {
        nextAction: suggestedTask === "artifact"
          ? `Retry with task=artifact for this ${subject.kind} subject, or reshape the subject so it supplies the input that ${task} needs.`
          : `Retry with task=${suggestedTask} for this subject, or reshape the subject so it supplies the input that ${task} needs.`,
        ...buildSuggestedCall({
          tool: "inspect-minecraft",
          params: {
            task: suggestedTask,
            subject
          }
        })
      }
    });
  }

  async resolveBinaryBackedClass(
    className: string,
    input: {
      version?: string;
      mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    }
  ): Promise<{ className: string; warnings: string[] } | undefined> {
    if (!this.deps.checkSymbolExists || !input.version) {
      return undefined;
    }
    let lookup: CheckSymbolExistsOutput;
    try {
      lookup = await this.deps.checkSymbolExists({
        version: input.version,
        kind: "class",
        name: className,
        sourceMapping: input.mapping ?? "obfuscated",
        nameMode: className.includes(".") ? "fqcn" : "auto",
        maxCandidates: 10
      });
    } catch (caughtError) {
      if (isAppError(caughtError)) {
        return undefined;
      }
      throw caughtError;
    }
    const resolvedClassName = lookup.resolvedSymbol?.name;
    if (!resolvedClassName) {
      return undefined;
    }
    return {
      className: resolvedClassName,
      warnings: lookup.warnings
    };
  }

  async resolveArtifactReference(
    subject: Subject,
    task?: ArtifactContextTask
  ): Promise<{ artifactId: string; artifact?: ResolveArtifactOutput; version?: string; warnings: string[] }> {
    if (subject.kind === "artifact") {
      return this.resolveArtifactRef(subject.artifact, subject);
    }
    if (subject.kind === "class" || subject.kind === "file" || subject.kind === "search") {
      if (!subject.artifact) {
        const suggestedTask: ArtifactContextTask = task
          ?? (subject.kind === "class"
            ? "class-overview"
            : subject.kind === "search"
              ? "search"
              : "file");
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `${subject.kind} subject requires artifact context.`,
          details: {
            nextAction: "Add subject.artifact or use subject.kind=workspace so inspect-minecraft can resolve the artifact first.",
            ...(await this.buildArtifactContextSuggestedCall(suggestedTask, subject))
          }
        });
      }
      return this.resolveArtifactRef(subject.artifact, subject);
    }
    if (subject.kind === "version") {
      const artifact = await this.deps.resolveArtifact({
        target: { kind: "version", value: subject.version },
        mapping: subject.mapping,
        scope: subject.scope,
        projectPath: subject.projectPath,
        preferProjectVersion: subject.preferProjectVersion,
        strictVersion: subject.strictVersion
      });
      return {
        artifactId: artifact.artifactId,
        artifact,
        version: subject.version,
        warnings: [...artifact.warnings]
      };
    }
    const version = await this.deps.detectProjectMinecraftVersion(subject.projectPath);
    if (!version) {
      return {
        artifactId: "",
        version: undefined,
        warnings: [`Could not infer Minecraft version from ${subject.projectPath}.`]
      };
    }
    const artifact = await this.deps.resolveArtifact({
      target: { kind: "version", value: version },
      mapping: subject.mapping,
      scope: subject.scope,
      projectPath: subject.projectPath,
      preferProjectVersion: subject.preferProjectVersion ?? true,
      strictVersion: subject.strictVersion
    });
    return {
      artifactId: artifact.artifactId,
      artifact,
      version,
      warnings: [...artifact.warnings]
    };
  }

  async resolveArtifactRef(
    ref: ArtifactRef,
    subject: Extract<Subject, { kind: "artifact" | "class" | "file" | "search" }>
  ): Promise<{ artifactId: string; artifact?: ResolveArtifactOutput; warnings: string[] }> {
    if (ref.type === "resolved-id") {
      return {
        artifactId: ref.artifactId,
        warnings: []
      };
    }

    const artifact = await this.deps.resolveArtifact({
      target: ref.target,
      mapping: "mapping" in subject ? subject.mapping : undefined,
      scope: "scope" in subject ? subject.scope : undefined,
      projectPath: "projectPath" in subject ? subject.projectPath : undefined,
      preferProjectVersion: "preferProjectVersion" in subject ? subject.preferProjectVersion : undefined,
      strictVersion: "strictVersion" in subject ? subject.strictVersion : undefined
    });
    return {
      artifactId: artifact.artifactId,
      artifact,
      warnings: [...artifact.warnings]
    };
  }

  private handleVersions(input: InspectMinecraftInput, detail: DetailLevel, include: string[]) {
    return handleVersions(this, input, detail, include);
  }

  private handleArtifact(subject: Subject, detail: DetailLevel, include: string[]) {
    return handleArtifact(this, subject, detail, include);
  }

  private handleClassOverview(subject: Subject, detail: DetailLevel, include: string[]) {
    return handleClassOverview(this, subject, detail, include);
  }

  private handleClassSource(subject: Subject, detail: DetailLevel, include: string[]) {
    return handleClassSource(this, subject, detail, include);
  }

  private handleClassMembers(subject: Subject, detail: DetailLevel, include: string[], limit: number | undefined) {
    return handleClassMembers(this, subject, detail, include, limit);
  }

  private handleSearch(subject: Subject, detail: DetailLevel, include: string[], limit: number | undefined, cursor: string | undefined) {
    return handleSearch(this, subject, detail, include, limit, cursor);
  }

  private handleFile(subject: Subject, detail: DetailLevel, include: string[]) {
    return handleFile(this, subject, detail, include);
  }

  private handleListFiles(subject: Subject, detail: DetailLevel, include: string[], limit: number | undefined, cursor: string | undefined) {
    return handleListFiles(this, subject, detail, include, limit, cursor);
  }
}
