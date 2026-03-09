import { z } from "zod";

import type {
  FindClassOutput,
  GetArtifactFileOutput,
  GetClassMembersOutput,
  GetClassSourceOutput,
  ListArtifactFilesOutput,
  ResolveArtifactOutput,
  SearchClassSourceOutput
} from "./source-service.js";
import type { ListVersionsOutput } from "./version-service.js";
import { createError, ERROR_CODES, isAppError } from "./errors.js";
import { buildIncludeSchema, detailSchema, positiveIntSchema } from "./v3/entry-tool-schema.js";
import {
  buildEntryToolResult,
  buildEntryToolMeta,
  createNextAction,
  createTruncationMeta,
  type DetailLevel,
  type NextAction,
  type Summary
} from "./v3/response-contract.js";
import { capArray, nextActionsOrUndefined, resolveDetail, resolveInclude } from "./v3/request-normalizers.js";

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
    queryMode: z.enum(["auto", "token", "literal"]).optional()
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
    queryMode: z.enum(["auto", "token", "literal"]).optional()
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
  includeSnapshots: z.boolean().optional(),
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
  if (value.includeSnapshots !== undefined && value.task && value.task !== "versions") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["includeSnapshots"],
      message: "includeSnapshots is only supported for task=versions."
    });
  }
});

export type InspectMinecraftInput = z.infer<typeof inspectMinecraftSchema>;

type ArtifactRef = z.infer<typeof artifactRefSchema>;
type Subject = z.infer<typeof subjectSchema>;
type WorkspaceSubject = Extract<Subject, { kind: "workspace" }>;
type WorkspaceClassFocus = Extract<z.infer<typeof workspaceFocusSchema>, { kind: "class" }>;
type WorkspaceSearchFocus = Extract<z.infer<typeof workspaceFocusSchema>, { kind: "search" }>;
type WorkspaceFileFocus = Extract<z.infer<typeof workspaceFocusSchema>, { kind: "file" }>;

type InspectMinecraftDeps = {
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
  constructor(private readonly deps: InspectMinecraftDeps) {}

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

  private requireWorkspaceClassFocus(subject: Subject): WorkspaceClassFocus {
    if (subject.kind !== "workspace" || subject.focus?.kind !== "class") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Workspace focus must be kind=class for this task."
      });
    }
    return subject.focus;
  }

  private requireWorkspaceSearchFocus(subject: Subject): WorkspaceSearchFocus {
    if (subject.kind !== "workspace" || subject.focus?.kind !== "search") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Workspace focus must be kind=search for this task."
      });
    }
    return subject.focus;
  }

  private requireWorkspaceFileFocus(subject: Subject): WorkspaceFileFocus {
    if (subject.kind !== "workspace" || subject.focus?.kind !== "file") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Workspace focus must be kind=file for this task."
      });
    }
    return subject.focus;
  }

  private buildClassSubject(
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

  private async resolveClassArtifactReference(
    subject: Extract<Subject, { kind: "class" }> | WorkspaceSubject,
    classSubject: Extract<Subject, { kind: "class" }>
  ): Promise<{ artifactId: string; artifact?: ResolveArtifactOutput; version?: string; warnings: string[] }> {
    if (subject.kind === "workspace") {
      return this.resolveWorkspaceArtifactReference(subject, classSubject.artifact);
    }
    return this.resolveArtifactReference(classSubject);
  }

  private async resolveWorkspaceArtifactReference(
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

  private resolveTask(task: InspectMinecraftInput["task"], subject: Subject | undefined) {
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

  private async resolveArtifactReference(
    subject: Subject
  ): Promise<{ artifactId: string; artifact?: ResolveArtifactOutput; version?: string; warnings: string[] }> {
    if (subject.kind === "artifact") {
      return this.resolveArtifactRef(subject.artifact, subject);
    }
    if (subject.kind === "class" || subject.kind === "file" || subject.kind === "search") {
      if (!subject.artifact) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `${subject.kind} subject requires artifact context.`
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

  private async resolveArtifactRef(
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

  private async handleVersions(
    input: InspectMinecraftInput,
    detail: DetailLevel,
    include: string[]
  ) {
    const versions = await this.deps.listVersions({
      includeSnapshots: input.includeSnapshots,
      limit: input.limit
    });
    const summary: Summary = {
      status: "ok",
      headline: `Found ${versions.totalAvailable} Minecraft versions.`,
      counts: {
        releases: versions.releases.length,
        snapshots: versions.snapshots?.length ?? 0
      },
      nextActions: nextActionsOrUndefined([
        createNextAction("inspect-minecraft", {
          task: "artifact",
          subject: {
            kind: "version",
            version: versions.latest.release ?? versions.releases[0]?.id
          }
        })
      ])
    };

    return {
      ...buildEntryToolResult({
        task: "versions",
        summary,
        detail,
        include,
        blocks: {
          versions: {
            latest: versions.latest,
            releases: detail === "summary" ? versions.releases.slice(0, 5) : versions.releases,
            snapshots: input.includeSnapshots ? versions.snapshots : undefined,
            cached: versions.cached
          }
        }
      }),
      warnings: []
    };
  }

  private async handleArtifact(
    subject: Subject,
    detail: DetailLevel,
    include: string[]
  ) {
    const resolved = await this.resolveArtifactReference(subject);
    if (!resolved.artifactId) {
      const summary: Summary = {
        status: "blocked",
        headline: "Could not resolve an artifact without a Minecraft version.",
        nextActions: nextActionsOrUndefined([
          createNextAction("inspect-minecraft", {
            task: "artifact",
            subject: {
              kind: "version",
              version: "1.21.10"
            }
          })
        ])
      };
      return {
        ...buildEntryToolResult({
          task: "artifact",
          summary,
          detail,
          include,
          blocks: {
            subject: {
              requested: subject
            }
          },
          alwaysBlocks: ["subject"]
        }),
        warnings: resolved.warnings
      };
    }

    const summary: Summary = {
      status: "ok",
      headline: `Resolved artifact ${resolved.artifactId}.`,
      counts: {
        warnings: resolved.warnings.length
      }
    };
    return {
      ...buildEntryToolResult({
        task: "artifact",
        summary,
        detail,
        include,
        blocks: {
          subject: {
            requested: subject,
            resolved: {
              artifactId: resolved.artifactId,
              version: resolved.version
            }
          },
          artifact: resolved.artifact
            ? {
                artifactId: resolved.artifact.artifactId,
                origin: resolved.artifact.origin,
                mappingApplied: resolved.artifact.mappingApplied,
                version: resolved.artifact.version,
                artifactContents: resolved.artifact.artifactContents
              }
            : { artifactId: resolved.artifactId }
        },
        alwaysBlocks: ["subject"]
      }),
      warnings: resolved.warnings
    };
  }

  private async handleClassOverview(
    subject: Subject,
    detail: DetailLevel,
    include: string[]
  ) {
    if (subject.kind !== "class" && !(subject.kind === "workspace" && subject.focus?.kind === "class")) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "class-overview requires a class or workspace focus subject."
      });
    }

    const classSubject = this.buildClassSubject(subject);
    const className = classSubject.className;
    const artifact = await this.resolveClassArtifactReference(subject, classSubject);

    if (!artifact.artifactId) {
      const summary: Summary = {
        status: "blocked",
        headline: `Could not resolve artifact context for ${className}.`
      };
      return {
        ...buildEntryToolResult({
          task: "class-overview",
          summary,
          detail,
          include,
          blocks: {
            subject: {
              requested: subject
            }
          },
          alwaysBlocks: ["subject"]
        }),
        warnings: artifact.warnings
      };
    }

    const matches = await this.deps.findClass({
      artifactId: artifact.artifactId,
      className,
      limit: 10
    });

    if (matches.total === 0) {
      const summary: Summary = {
        status: "not_found",
        headline: `No class match was found for ${className}.`
      };
      return {
        ...buildEntryToolResult({
          task: "class-overview",
          summary,
          detail,
          include,
          blocks: {
            subject: {
              requested: subject,
              resolved: {
                artifactId: artifact.artifactId
              }
            }
          },
          alwaysBlocks: ["subject"]
        }),
        warnings: [...artifact.warnings, ...matches.warnings]
      };
    }

    if (matches.total > 1) {
      const candidateActions: NextAction[] = matches.matches.slice(0, 3).map((match) =>
        createNextAction("inspect-minecraft", {
          task: "class-source",
          subject: {
            kind: "class",
            className: match.qualifiedName,
            artifact: {
              type: "resolved-id",
              artifactId: artifact.artifactId
            }
          },
          include: ["source"]
        })
      );
      const summary: Summary = {
        status: "ambiguous",
        headline: `Found ${matches.total} class matches for ${className}.`,
        counts: {
          matches: matches.total
        },
        nextActions: nextActionsOrUndefined(candidateActions)
      };
      return {
        ...buildEntryToolResult({
          task: "class-overview",
          summary,
          detail,
          include,
          blocks: {
            subject: {
              requested: subject,
              resolved: {
                artifactId: artifact.artifactId
              }
            },
            candidates: matches.matches
          },
          alwaysBlocks: ["subject"]
        }),
        warnings: [...artifact.warnings, ...matches.warnings]
      };
    }

    const match = matches.matches[0]!;
    const metadata = await this.deps.getClassSource({
      className: match.qualifiedName,
      artifactId: artifact.artifactId,
      mode: "metadata"
    });
    const summary: Summary = {
      status: "ok",
      headline: `Resolved class overview for ${match.qualifiedName}.`,
      counts: {
        totalLines: metadata.totalLines
      },
      nextActions: nextActionsOrUndefined([
        createNextAction("inspect-minecraft", {
          task: "class-source",
          subject: {
            kind: "class",
            className: match.qualifiedName,
            artifact: {
              type: "resolved-id",
              artifactId: artifact.artifactId
            }
          },
          include: ["source"]
        })
      ])
    };
    return {
      ...buildEntryToolResult({
        task: "class-overview",
        summary,
        detail,
        include,
        blocks: {
          subject: {
            requested: subject,
            resolved: {
              artifactId: artifact.artifactId,
              className: match.qualifiedName
            }
          },
          artifact: artifact.artifact
            ? {
                artifactId: artifact.artifact.artifactId,
                version: artifact.artifact.version,
                origin: artifact.artifact.origin
              }
            : { artifactId: artifact.artifactId },
          class: {
            className: match.qualifiedName,
            filePath: match.filePath,
            totalLines: metadata.totalLines,
            returnedNamespace: metadata.returnedNamespace
          }
        },
        alwaysBlocks: ["subject"]
      }),
      warnings: [...artifact.warnings, ...matches.warnings, ...metadata.warnings]
    };
  }

  private async handleClassSource(
    subject: Subject,
    detail: DetailLevel,
    include: string[]
  ) {
    if (subject.kind !== "class" && !(subject.kind === "workspace" && subject.focus?.kind === "class")) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "class-source requires a class or workspace focus subject."
      });
    }
    const classSubject = this.buildClassSubject(subject);
    const className = classSubject.className;
    const artifactContext = await this.resolveClassArtifactReference(subject, classSubject);
    const source = await this.deps.getClassSource({
      className,
      artifactId: artifactContext.artifactId || undefined,
      mapping: classSubject.mapping,
      scope: classSubject.scope,
      projectPath: classSubject.projectPath,
      preferProjectVersion: classSubject.preferProjectVersion,
      strictVersion: classSubject.strictVersion,
      mode: include.includes("source") || detail === "full" ? "snippet" : "metadata"
    });
    const summary: Summary = {
      status: "ok",
      headline: `Resolved source for ${source.className}.`,
      counts: {
        totalLines: source.totalLines
      }
    };
    return {
      ...buildEntryToolResult({
        task: "class-source",
        summary,
        detail,
        include,
        blocks: {
          subject: {
            requested: subject,
            resolved: {
              artifactId: source.artifactId,
              className: source.className
            }
          },
          source: {
            className: source.className,
            mode: source.mode,
            returnedRange: source.returnedRange,
            totalLines: source.totalLines,
            sourceText: source.sourceText
          }
        },
        alwaysBlocks: ["subject"]
      }),
      warnings: [...artifactContext.warnings, ...source.warnings]
    };
  }

  private async handleClassMembers(
    subject: Subject,
    detail: DetailLevel,
    include: string[],
    limit: number | undefined
  ) {
    if (subject.kind !== "class" && !(subject.kind === "workspace" && subject.focus?.kind === "class")) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "class-members requires a class or workspace focus subject."
      });
    }
    const classSubject = this.buildClassSubject(subject);
    const artifact = await this.resolveClassArtifactReference(subject, classSubject);
    const members = await this.deps.getClassMembers({
      className: classSubject.className,
      artifactId: artifact.artifactId || undefined,
      mapping: classSubject.mapping,
      scope: classSubject.scope,
      projectPath: classSubject.projectPath,
      preferProjectVersion: classSubject.preferProjectVersion,
      strictVersion: classSubject.strictVersion,
      maxMembers: limit
    });
    const summary: Summary = {
      status: members.truncated ? "partial" : "ok",
      headline: `Collected ${members.counts.total} members for ${members.className}.`,
      counts: members.counts
    };
    return {
      ...buildEntryToolResult({
        task: "class-members",
        summary,
        detail,
        include,
        blocks: {
          subject: {
            requested: subject,
            resolved: {
              artifactId: members.artifactId,
              className: members.className
            }
          },
          members: include.includes("members") || detail !== "summary"
            ? members.members
            : {
                counts: members.counts
              }
        },
        alwaysBlocks: ["subject"]
      }),
      warnings: [...artifact.warnings, ...members.warnings],
      ...(members.truncated
        ? {
            meta: buildEntryToolMeta({
              detail,
              include,
              warnings: [...artifact.warnings, ...members.warnings],
              truncated: createTruncationMeta({
                omittedGroups: ["members"],
                nextActions: [
                  createNextAction("inspect-minecraft", {
                    task: "class-members",
                    detail: "full",
                    include: ["members"],
                    subject
                  })
                ]
              })
            })
          }
        : {})
    };
  }

  private async handleSearch(
    subject: Subject,
    detail: DetailLevel,
    include: string[],
    limit: number | undefined,
    cursor: string | undefined
  ) {
    if (subject.kind !== "search" && !(subject.kind === "workspace" && subject.focus?.kind === "search")) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "search requires a search or workspace focus subject."
      });
    }

    const searchSubject = subject.kind === "search" ? subject : this.requireWorkspaceSearchFocus(subject);
    const artifact = subject.kind === "search"
      ? await this.resolveArtifactReference(subject)
      : await this.resolveWorkspaceArtifactReference(subject, searchSubject.artifact);
    const search = await this.deps.searchClassSource({
      artifactId: artifact.artifactId,
      query: searchSubject.query,
      intent: searchSubject.intent,
      match: searchSubject.match,
      queryMode: searchSubject.queryMode,
      limit,
      cursor,
      scope: searchSubject.packagePrefix || searchSubject.fileGlob || searchSubject.symbolKind
        ? {
            packagePrefix: searchSubject.packagePrefix,
            fileGlob: searchSubject.fileGlob,
            symbolKind: searchSubject.symbolKind
          }
        : undefined
    });

    const sampledHits = capArray(search.hits, 5);
    const summary: Summary = {
      status: search.hits.length > 0 ? "ok" : "not_found",
      headline: search.hits.length > 0
        ? `Found ${search.hits.length} source hits for ${searchSubject.query}.`
        : `No source hits were found for ${searchSubject.query}.`,
      counts: {
        hits: search.hits.length
      }
    };
    return {
      ...buildEntryToolResult({
        task: "search",
        summary,
        detail,
        include,
        blocks: {
          subject: {
            requested: subject,
            resolved: {
              artifactId: artifact.artifactId
            }
          },
          search: {
            query: searchSubject.query,
            hits: detail === "summary" ? sampledHits.items : search.hits,
            nextCursor: search.nextCursor
          }
        },
        alwaysBlocks: ["subject"]
      }),
      warnings: [...artifact.warnings]
    };
  }

  private async handleFile(
    subject: Subject,
    detail: DetailLevel,
    include: string[]
  ) {
    if (subject.kind !== "file" && !(subject.kind === "workspace" && subject.focus?.kind === "file")) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "file task requires a file or workspace focus subject."
      });
    }
    const fileSubject = subject.kind === "file" ? subject : this.requireWorkspaceFileFocus(subject);
    const artifact = subject.kind === "file"
      ? await this.resolveArtifactReference(subject)
      : await this.resolveWorkspaceArtifactReference(subject, fileSubject.artifact);
    const file = await this.deps.getArtifactFile({
      artifactId: artifact.artifactId,
      filePath: fileSubject.filePath
    });
    const summary: Summary = {
      status: "ok",
      headline: `Read ${file.filePath}.`,
      counts: {
        bytes: file.contentBytes
      }
    };
    return {
      ...buildEntryToolResult({
        task: "file",
        summary,
        detail,
        include,
        blocks: {
          subject: {
            requested: subject,
            resolved: {
              artifactId: artifact.artifactId,
              filePath: file.filePath
            }
          },
          file: {
            filePath: file.filePath,
            contentBytes: file.contentBytes,
            truncated: file.truncated,
            content: include.includes("source") || detail !== "summary" ? file.content : undefined
          }
        },
        alwaysBlocks: ["subject"]
      }),
      warnings: [...artifact.warnings]
    };
  }

  private async handleListFiles(
    subject: Subject,
    detail: DetailLevel,
    include: string[],
    limit: number | undefined,
    cursor: string | undefined
  ) {
    const artifact = await this.resolveArtifactReference(subject);
    const files = await this.deps.listArtifactFiles({
      artifactId: artifact.artifactId,
      limit,
      cursor
    });
    const sampled = capArray(files.items, 10);
    const summary: Summary = {
      status: "ok",
      headline: `Listed ${files.items.length} files for ${artifact.artifactId}.`,
      counts: {
        files: files.items.length
      }
    };
    return {
      ...buildEntryToolResult({
        task: "list-files",
        summary,
        detail,
        include,
        blocks: {
          subject: {
            requested: subject,
            resolved: {
              artifactId: artifact.artifactId
            }
          },
          files: {
            items: detail === "summary" ? sampled.items : files.items,
            nextCursor: files.nextCursor
          }
        },
        alwaysBlocks: ["subject"]
      }),
      warnings: [...artifact.warnings, ...files.warnings]
    };
  }
}
