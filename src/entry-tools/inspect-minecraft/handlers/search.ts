import { buildEntryToolResult, createNextAction, createSummarySubject, type DetailLevel, type Summary } from "../../response-contract.js";
import { capArray, nextActionsOrUndefined } from "../../request-normalizers.js";
import { classNameToFilePath, hasPartialVanillaCoverage, hitTargetsVanillaNamespace, looksLikeClassQuery, type Subject, requireWorkspaceSearchFocus, resolveWorkspaceArtifactReference, summarizeRequestedSubject, invalidTaskSubjectError, resolveBinaryBackedClass, resolveArtifactReference, type InspectMinecraftDeps } from "../internal.js";

export async function handleSearch(
deps: InspectMinecraftDeps,
  subject: Subject,
  detail: DetailLevel,
  include: string[],
  limit: number | undefined,
  cursor: string | undefined
) {
  if (subject.kind !== "search" && !(subject.kind === "workspace" && subject.focus?.kind === "search")) {
    invalidTaskSubjectError("search", subject);
  }

  const searchSubject = subject.kind === "search" ? subject : requireWorkspaceSearchFocus(subject);
  const requestedSubject = summarizeRequestedSubject(subject);
  const queryMode = searchSubject.queryMode ?? "auto";
  const artifact = subject.kind === "search"
    ? await resolveArtifactReference(deps, subject, "search")
    : await resolveWorkspaceArtifactReference(deps, subject, searchSubject.artifact);
  const search = await deps.searchClassSource({
    artifactId: artifact.artifactId,
    query: searchSubject.query,
    intent: searchSubject.intent,
    match: searchSubject.match,
    queryMode,
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

  const needsBinaryBackedClassHit =
    subject.kind === "workspace" &&
    hasPartialVanillaCoverage(artifact.artifact) &&
    looksLikeClassQuery(searchSubject.query) &&
    !search.hits.some((hit) => hitTargetsVanillaNamespace(hit));
  const binaryBackedClassHit = needsBinaryBackedClassHit
    ? await resolveBinaryBackedClass(deps, searchSubject.query, {
        version: artifact.version,
        mapping: subject.mapping
      })
    : undefined;
  const binaryBackedHitRecord = binaryBackedClassHit == null
    ? undefined
    : {
        filePath: classNameToFilePath(binaryBackedClassHit.className),
        score: 100,
        matchedIn: "symbol" as const,
        reasonCodes: ["binary-class-lookup"],
        symbol: {
          symbolKind: "class" as const,
          symbolName: binaryBackedClassHit.className.split(".").at(-1) ?? binaryBackedClassHit.className,
          qualifiedName: binaryBackedClassHit.className,
          line: 1
        }
      };
  const effectiveHits =
    binaryBackedHitRecord == null
      ? search.hits
      : [
          binaryBackedHitRecord,
          ...search.hits.filter((hit) => hit.filePath !== binaryBackedHitRecord.filePath)
        ];

  const sampledHits = capArray(effectiveHits, 5);
  const isAutoSeparatorMiss =
    effectiveHits.length === 0 &&
    queryMode === "auto" &&
    /[._$]/.test(searchSubject.query);
  const literalRetrySubject = subject.kind === "search"
    ? {
        ...subject,
        queryMode: "literal" as const
      }
    : {
        ...subject,
        focus: {
          ...searchSubject,
          kind: "search" as const,
          queryMode: "literal" as const
        }
      };
  const summary: Summary = {
    status: effectiveHits.length > 0 ? "ok" : "not_found",
    headline: effectiveHits.length > 0
      ? `Found ${effectiveHits.length} source hits for ${searchSubject.query}.`
      : `No source hits were found for ${searchSubject.query}.`,
    subject: createSummarySubject({
      task: "search",
      requested: requestedSubject,
      query: searchSubject.query,
      artifactId: artifact.artifactId
    }),
    counts: {
      hits: effectiveHits.length
    },
    nextActions: nextActionsOrUndefined([
      ...(effectiveHits.length > 0
        ? [
            createNextAction("inspect-minecraft", {
              task: "file",
              subject: {
                kind: "file",
                filePath: effectiveHits[0]!.filePath,
                artifact: {
                  type: "resolved-id",
                  artifactId: artifact.artifactId
                }
              },
              include: ["source"]
            })
          ]
        : []),
      ...(isAutoSeparatorMiss
        ? [
            createNextAction("inspect-minecraft", {
              task: "search",
              subject: literalRetrySubject
            })
          ]
        : [])
    ]),
    ...(isAutoSeparatorMiss
      ? {
          notes: [
            "Separator query returned no indexed hits. Retry with queryMode=\"literal\" for an explicit full substring scan."
          ]
        }
      : binaryBackedClassHit
        ? {
            notes: [
              "Source coverage was partial, so inspect-minecraft returned a binary-backed class match for the vanilla symbol."
            ]
          }
        : {})
  };
  return {
    ...buildEntryToolResult({
      task: "search",
      summary,
      detail,
      include,
      blocks: {
        subject: {
          requested: requestedSubject,
          resolved: {
            artifactId: artifact.artifactId
          }
        },
        search: {
          query: searchSubject.query,
          hits: detail === "summary" ? sampledHits.items : effectiveHits,
          nextCursor: search.nextCursor
        }
      },
      alwaysBlocks: ["subject"]
    }),
    warnings: [...artifact.warnings, ...(binaryBackedClassHit?.warnings ?? [])]
  };
}
