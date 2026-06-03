import { z } from "zod";

import { createError, ERROR_CODES } from "../errors.js";
import { buildIncludeSchema, detailSchema, positiveIntSchema } from "./entry-tool-schema.js";
import { resolveDetail, resolveInclude } from "./request-normalizers.js";
import {
  TASKS,
  resolveTask,
  subjectSchema,
  type InspectMinecraftDeps
} from "./inspect-minecraft/internal.js";
import { handleVersions } from "./inspect-minecraft/handlers/versions.js";
import { handleArtifact } from "./inspect-minecraft/handlers/artifact.js";
import { handleClassOverview } from "./inspect-minecraft/handlers/class-overview.js";
import { handleClassSource } from "./inspect-minecraft/handlers/class-source.js";
import { handleClassMembers } from "./inspect-minecraft/handlers/class-members.js";
import { handleSearch } from "./inspect-minecraft/handlers/search.js";
import { handleFile } from "./inspect-minecraft/handlers/file.js";
import { handleListFiles } from "./inspect-minecraft/handlers/list-files.js";

const INCLUDE_GROUPS = ["warnings", "provenance", "candidates", "members", "descriptors", "source", "files", "samples", "artifact", "timings"] as const;

const nonEmptyString = z.string().trim().min(1);

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

export class InspectMinecraftService {
  constructor(private readonly deps: InspectMinecraftDeps) {}

  async execute(input: InspectMinecraftInput): Promise<Record<string, unknown> & { warnings?: string[] }> {
    const detail = resolveDetail(input.detail);
    const include = resolveInclude(input.include);
    const task = resolveTask(input.task, input.subject);

    switch (task) {
      case "versions":
        return handleVersions(this.deps, input, detail, include);
      case "artifact":
        return handleArtifact(this.deps, input.subject!, detail, include);
      case "class-overview":
        return handleClassOverview(this.deps, input.subject!, detail, include);
      case "class-source":
        return handleClassSource(this.deps, input.subject!, detail, include);
      case "class-members":
        return handleClassMembers(this.deps, input.subject!, detail, include, input.limit);
      case "search":
        return handleSearch(this.deps, input.subject!, detail, include, input.limit, input.cursor);
      case "file":
        return handleFile(this.deps, input.subject!, detail, include);
      case "list-files":
        return handleListFiles(this.deps, input.subject!, detail, include, input.limit, input.cursor);
      default:
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Unsupported inspect-minecraft task "${task}".`
        });
    }
  }
}
