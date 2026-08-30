import { buildEntryToolResult, buildEntryToolMeta, createNextAction, createSummarySubject, createTruncationMeta, type DetailLevel, type Summary } from "../../response-contract.js";
import { type ArtifactRef, type Subject, buildClassSubject, resolveClassArtifactReference, invalidTaskSubjectError, type InspectMinecraftDeps } from "../internal.js";

function artifactSelectedByFor(ref: ArtifactRef | undefined): "caller" | "tool" {
  if (!ref) {
    return "tool";
  }
  if (ref.type === "resolved-id") {
    return "caller";
  }
  return ref.target.kind === "jar" ? "caller" : "tool";
}

export async function handleClassMembers(
deps: InspectMinecraftDeps,
  subject: Subject,
  detail: DetailLevel,
  include: string[],
  limit: number | undefined
) {
  if (subject.kind !== "class" && !(subject.kind === "workspace" && subject.focus?.kind === "class")) {
    invalidTaskSubjectError("class-members", subject);
  }
  const classSubject = buildClassSubject(subject);
  const artifact = await resolveClassArtifactReference(deps, subject, classSubject, "class-members");
  const members = await deps.getClassMembers({
    className: classSubject.className,
    artifactId: artifact.artifactId || undefined,
    // The artifactId above is one WE produced - resolveClassArtifactReference
    // collapses every subject shape to one, including the workspace
    // auto-resolution that happens with no artifact reference at all. Only the
    // caller's own reference says whether they picked the artifact: a
    // resolved-id names it outright, and a jar target names the exact jar.
    // Anything else (a version/coordinate target, or an omitted reference) is
    // ours, so a missing binary jar is not their input to fix.
    artifactSelectedBy: artifactSelectedByFor(classSubject.artifact),
    mapping: classSubject.mapping,
    scope: classSubject.scope,
    projectPath: classSubject.projectPath,
    gradleUserHome: classSubject.gradleUserHome,
    preferProjectVersion: classSubject.preferProjectVersion,
    strictVersion: classSubject.strictVersion,
    maxMembers: limit,
    includeDescriptors: include.includes("descriptors")
  });
  const summary: Summary = {
    status: members.truncated ? "partial" : "ok",
    headline: `Collected ${members.counts.total} members for ${members.className}.`,
    subject: createSummarySubject({
      task: "class-members",
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
              omittedGroups: detail === "summary" ? ["members"] : [],
              nextActions: [
                createNextAction("inspect-minecraft", {
                  task: "class-members",
                  detail: "full",
                  include: ["members"],
                  limit: Math.min(members.counts.total, 5000),
                  subject
                })
              ]
            })
          })
        }
      : {})
  };
}
