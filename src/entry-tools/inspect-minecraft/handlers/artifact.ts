import { buildEntryToolResult, createNextAction, createSummarySubject, type DetailLevel, type Summary } from "../../response-contract.js";
import { nextActionsOrUndefined } from "../../request-normalizers.js";
import { type Subject, resolveArtifactReference, type InspectMinecraftDeps } from "../internal.js";

export async function handleArtifact(
deps: InspectMinecraftDeps,
  subject: Subject,
  detail: DetailLevel,
  include: string[]
) {
  const resolved = await resolveArtifactReference(deps, subject);
  if (!resolved.artifactId) {
    const summary: Summary = {
      status: "blocked",
      headline: "Could not resolve an artifact without a Minecraft version.",
      subject: createSummarySubject({
        task: "artifact"
      }),
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
    subject: createSummarySubject({
      task: "artifact",
      artifactId: resolved.artifactId,
      version: resolved.version
    }),
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
              artifactAlias: resolved.artifact.artifactAlias,
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
