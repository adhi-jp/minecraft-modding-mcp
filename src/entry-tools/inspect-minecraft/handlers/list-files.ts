import { buildEntryToolResult, createNextAction, createSummarySubject, type DetailLevel, type Summary } from "../../response-contract.js";
import { capArray, nextActionsOrUndefined } from "../../request-normalizers.js";
import { hasPartialVanillaCoverage, type Subject, resolveArtifactReference, type InspectMinecraftDeps } from "../internal.js";

export async function handleListFiles(
deps: InspectMinecraftDeps,
  subject: Subject,
  detail: DetailLevel,
  include: string[],
  limit: number | undefined,
  cursor: string | undefined
) {
  const artifact = await resolveArtifactReference(deps, subject, "list-files");
  const files = await deps.listArtifactFiles({
    artifactId: artifact.artifactId,
    limit,
    cursor
  });
  const sampled = capArray(files.items, 10);
  const partialCoverage = subject.kind === "workspace" && hasPartialVanillaCoverage(artifact.artifact);
  const nextActions = [
    ...(files.items.length > 0
      ? [
          createNextAction("inspect-minecraft", {
            task: "file",
            subject: {
              kind: "file",
              filePath: files.items[0],
              artifact: {
                type: "resolved-id",
                artifactId: artifact.artifactId
              }
            }
          })
        ]
      : []),
    ...(partialCoverage
      ? [
          createNextAction("inspect-minecraft", {
            task: "class-source",
            subject: {
              kind: "workspace",
              projectPath: subject.projectPath,
              mapping: subject.mapping,
              scope: subject.scope,
              gradleUserHome: subject.gradleUserHome,
              preferProjectVersion: subject.preferProjectVersion,
              strictVersion: subject.strictVersion,
              focus: {
                kind: "class",
                className: "net.minecraft.world.item.Item"
              }
            }
          })
        ]
      : [])
  ];
  const summary: Summary = {
    status: partialCoverage ? "partial" : "ok",
    headline: `Listed ${files.items.length} files for ${artifact.artifactId}.`,
    subject: createSummarySubject({
      task: "list-files",
      artifactId: artifact.artifactId
    }),
    counts: {
      files: files.items.length
    },
    nextActions: nextActionsOrUndefined(nextActions),
    ...(partialCoverage
      ? {
          notes: [
            "This listing is partial because the resolved source artifact does not contain net.minecraft entries."
          ]
        }
      : {})
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
          nextCursor: files.nextCursor,
          ...(partialCoverage
            ? {
                coverage: {
                  sourceCoverage: "partial",
                  missingNamespaces: ["net.minecraft"]
                }
              }
            : {})
        }
      },
      alwaysBlocks: ["subject"]
    }),
    warnings: [...artifact.warnings, ...files.warnings]
  };
}
