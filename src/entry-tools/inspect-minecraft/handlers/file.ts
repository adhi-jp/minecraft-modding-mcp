import { buildEntryToolResult, createSummarySubject, type DetailLevel, type Summary } from "../../response-contract.js";
import { type Subject, type InspectMinecraftService } from "../../inspect-minecraft-service.js";

export async function handleFile(
svc: InspectMinecraftService,
  subject: Subject,
  detail: DetailLevel,
  include: string[]
) {
  if (subject.kind !== "file" && !(subject.kind === "workspace" && subject.focus?.kind === "file")) {
    svc.invalidTaskSubjectError("file", subject);
  }
  const fileSubject = subject.kind === "file" ? subject : svc.requireWorkspaceFileFocus(subject);
  const artifact = subject.kind === "file"
    ? await svc.resolveArtifactReference(subject, "file")
    : await svc.resolveWorkspaceArtifactReference(subject, fileSubject.artifact);
  const file = await svc.deps.getArtifactFile({
    artifactId: artifact.artifactId,
    filePath: fileSubject.filePath
  });
  const summary: Summary = {
    status: "ok",
    headline: `Read ${file.filePath}.`,
    subject: createSummarySubject({
      task: "file",
      requested: subject,
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
      alwaysBlocks: ["subject"]
    }),
    warnings: [...artifact.warnings]
  };
}
