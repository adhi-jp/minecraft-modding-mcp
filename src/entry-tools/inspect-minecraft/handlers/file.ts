import { buildEntryToolResult, createSummarySubject, type DetailLevel, type Summary } from "../../response-contract.js";
import { type Subject, requireWorkspaceFileFocus, resolveWorkspaceArtifactReference, invalidTaskSubjectError, resolveArtifactReference, type InspectMinecraftDeps } from "../internal.js";

export async function handleFile(
deps: InspectMinecraftDeps,
  subject: Subject,
  detail: DetailLevel,
  include: string[]
) {
  if (subject.kind !== "file" && !(subject.kind === "workspace" && subject.focus?.kind === "file")) {
    invalidTaskSubjectError("file", subject);
  }
  const fileSubject = subject.kind === "file" ? subject : requireWorkspaceFileFocus(subject);
  const artifact = subject.kind === "file"
    ? await resolveArtifactReference(deps, subject, "file")
    : await resolveWorkspaceArtifactReference(deps, subject, fileSubject.artifact);
  if (!artifact.artifactId) {
    const summary: Summary = {
      status: "blocked",
      headline: `Could not resolve artifact context for ${fileSubject.filePath}.`,
      subject: createSummarySubject({
        task: "file",
        filePath: fileSubject.filePath
      })
    };
    return {
      ...buildEntryToolResult({
        task: "file",
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
  const file = await deps.getArtifactFile({
    artifactId: artifact.artifactId,
    filePath: fileSubject.filePath
  });
  const summary: Summary = {
    status: "ok",
    headline: `Read ${file.filePath}.`,
    subject: createSummarySubject({
      task: "file",
      filePath: file.filePath,
      artifactId: artifact.artifactId
    }),
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
      alwaysBlocks: ["subject", "file"]
    }),
    warnings: [...artifact.warnings]
  };
}
