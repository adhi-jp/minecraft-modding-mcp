import { buildEntryToolResult, createNextAction, createSummarySubject, type DetailLevel, type NextAction, type Summary } from "../../response-contract.js";
import { nextActionsOrUndefined } from "../../request-normalizers.js";
import { hasPartialVanillaCoverage, type Subject, buildClassSubject, resolveClassArtifactReference, invalidTaskSubjectError, resolveBinaryBackedClass, type InspectMinecraftDeps } from "../internal.js";

export async function handleClassOverview(
deps: InspectMinecraftDeps,
  subject: Subject,
  detail: DetailLevel,
  include: string[]
) {
  if (subject.kind !== "class" && !(subject.kind === "workspace" && subject.focus?.kind === "class")) {
    invalidTaskSubjectError("class-overview", subject);
  }

  const classSubject = buildClassSubject(subject);
  const className = classSubject.className;
  const artifact = await resolveClassArtifactReference(deps, subject, classSubject, "class-overview");

  if (!artifact.artifactId) {
    const summary: Summary = {
      status: "blocked",
      headline: `Could not resolve artifact context for ${className}.`,
      subject: createSummarySubject({
        task: "class-overview",
        requested: subject,
        className
      })
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

  const matches = await deps.findClass({
    artifactId: artifact.artifactId,
    className,
    limit: 10
  });

  if (matches.total === 0) {
    const partialSourceFallback =
      subject.kind === "workspace" && hasPartialVanillaCoverage(artifact.artifact)
        ? await resolveBinaryBackedClass(deps, className, {
            version: artifact.version,
            mapping: classSubject.mapping
          })
        : undefined;
    if (partialSourceFallback) {
      const metadata = await deps.getClassSource({
        className: partialSourceFallback.className,
        artifactId: artifact.artifactId,
        mapping: classSubject.mapping,
        scope: classSubject.scope,
        projectPath: classSubject.projectPath,
        preferProjectVersion: classSubject.preferProjectVersion,
        strictVersion: classSubject.strictVersion,
        mode: "metadata"
      });
      const summary: Summary = {
        status: "ok",
        headline: `Resolved class overview for ${partialSourceFallback.className}.`,
        subject: createSummarySubject({
          task: "class-overview",
          requested: subject,
          className: partialSourceFallback.className,
          artifactId: metadata.artifactId
        }),
        counts: {
          totalLines: metadata.totalLines
        },
        notes: [
          "Source coverage was partial, so inspect-minecraft confirmed the vanilla class through binary-backed symbol lookup."
        ]
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
                artifactId: metadata.artifactId,
                className: partialSourceFallback.className
              }
            },
            class: {
              className: partialSourceFallback.className,
              totalLines: metadata.totalLines,
              returnedNamespace: metadata.returnedNamespace
            }
          },
          alwaysBlocks: ["subject"]
        }),
        warnings: [
          ...artifact.warnings,
          ...matches.warnings,
          ...partialSourceFallback.warnings,
          ...metadata.warnings
        ]
      };
    }

    const summary: Summary = {
      status: "not_found",
      headline: `No class match was found for ${className}.`,
      subject: createSummarySubject({
        task: "class-overview",
        requested: subject,
        className,
        artifactId: artifact.artifactId
      })
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
      subject: createSummarySubject({
        task: "class-overview",
        requested: subject,
        className,
        artifactId: artifact.artifactId
      }),
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
  const metadata = await deps.getClassSource({
    className: match.qualifiedName,
    artifactId: artifact.artifactId,
    mode: "metadata"
  });
  const summary: Summary = {
    status: "ok",
    headline: `Resolved class overview for ${match.qualifiedName}.`,
    subject: createSummarySubject({
      task: "class-overview",
      requested: subject,
      className: match.qualifiedName,
      artifactId: artifact.artifactId
    }),
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
