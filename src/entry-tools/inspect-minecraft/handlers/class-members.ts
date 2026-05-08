import { buildEntryToolResult, buildEntryToolMeta, createNextAction, createSummarySubject, createTruncationMeta, type DetailLevel, type Summary } from "../../response-contract.js";
import { type Subject, type InspectMinecraftService } from "../../inspect-minecraft-service.js";

export async function handleClassMembers(
svc: InspectMinecraftService,
  subject: Subject,
  detail: DetailLevel,
  include: string[],
  limit: number | undefined
) {
  if (subject.kind !== "class" && !(subject.kind === "workspace" && subject.focus?.kind === "class")) {
    svc.invalidTaskSubjectError("class-members", subject);
  }
  const classSubject = svc.buildClassSubject(subject);
  const artifact = await svc.resolveClassArtifactReference(subject, classSubject, "class-members");
  const members = await svc.deps.getClassMembers({
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
    subject: createSummarySubject({
      task: "class-members",
      requested: subject,
      className: members.className,
      artifactId: members.artifactId
    }),
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
          ? {
              ...members.members,
              ...(members.decompiledFallback ? { decompiledFallback: members.decompiledFallback } : {}),
              ...(members.decompiledMemberCounts ? { decompiledMemberCounts: members.decompiledMemberCounts } : {})
            }
          : {
              counts: members.counts,
              ...(members.decompiledMemberCounts ? { decompiledMemberCounts: members.decompiledMemberCounts } : {})
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
