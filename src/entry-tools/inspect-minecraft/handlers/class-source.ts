import { buildEntryToolResult, createSummarySubject, type DetailLevel, type Summary } from "../../response-contract.js";
import { type Subject, type InspectMinecraftService } from "../../inspect-minecraft-service.js";

export async function handleClassSource(
svc: InspectMinecraftService,
  subject: Subject,
  detail: DetailLevel,
  include: string[]
) {
  if (subject.kind !== "class" && !(subject.kind === "workspace" && subject.focus?.kind === "class")) {
    svc.invalidTaskSubjectError("class-source", subject);
  }
  const classSubject = svc.buildClassSubject(subject);
  const className = classSubject.className;
  const artifactContext = await svc.resolveClassArtifactReference(subject, classSubject, "class-source");
  const source = await svc.deps.getClassSource({
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
    subject: createSummarySubject({
      task: "class-source",
      requested: subject,
      className: source.className,
      artifactId: source.artifactId
    }),
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
