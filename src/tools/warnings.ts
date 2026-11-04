import { classifyWarnings } from "../warning-details.js";
import { translateToolNamesInText } from "./translation.js";
import type { CatalogWarning } from "./types.js";

/**
 * Notices services attach to routine successes. They ask nothing of the
 * caller, so catalog replies leave them out of the warnings; where one carries
 * a fact a caller can use, the tool reports it in its result instead.
 */
export const ROUTINE_NOTICES: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp }> = [
  {
    // Added to every read of decompiled source (src/source/class-source.ts).
    id: "decompiled-source",
    pattern: /^Source is decompiled: method\/accessor names may differ from the jar the workspace compiles against\./
  },
  {
    // Added to every version-target resolution (src/source/artifact-resolver.ts).
    id: "version-resolution",
    pattern: /^Resolved Minecraft .+ from \S+\.$/
  },
  {
    // Added when a resolution picks a Loom cache source jar (src/source/artifact-resolver.ts).
    id: "loom-resolution",
    pattern: /^Resolved source-backed artifact from Loom cache candidate: .+\.$/
  },
  {
    // Added to every search of a sources jar (src/mod-search-service.ts); nothing to act on.
    id: "source-jar-search",
    pattern: /^Detected source jar; searching Java entries directly without decompilation\.$/
  },
  {
    // Added to every remap answered from the remap cache (src/mod-remap-service.ts);
    // mod-remap reports it as `remap.fromCache`.
    id: "remap-cache-hit",
    pattern: /^Result served from cache\.$/
  }
];

export function isRoutineNotice(message: string): boolean {
  return ROUTINE_NOTICES.some((notice) => notice.pattern.test(message));
}

/**
 * The structured `meta.warnings` of a catalog reply: routine notices removed
 * (whether a service string or an already structured warning), service strings
 * classified, 8.x tool names translated, and duplicates (same code and
 * message) removed.
 */
export function buildCatalogWarnings(
  warnings: ReadonlyArray<string | CatalogWarning>,
  currentTool: string
): CatalogWarning[] {
  const texts = warnings.filter(
    (entry): entry is string => typeof entry === "string" && !isRoutineNotice(entry)
  );
  const classified = classifyWarnings(texts);
  const structured: CatalogWarning[] = [];
  let textIndex = 0;
  for (const entry of warnings) {
    if (typeof entry === "string") {
      if (isRoutineNotice(entry)) continue;
      const detail = classified[textIndex];
      textIndex += 1;
      structured.push({
        code: detail?.code ?? "general",
        severity: detail?.severity ?? "info",
        message: translateToolNamesInText(entry, currentTool)
      });
      continue;
    }
    if (isRoutineNotice(entry.message)) continue;
    structured.push({
      code: entry.code,
      severity: entry.severity,
      message: translateToolNamesInText(entry.message, currentTool)
    });
  }
  const seen = new Set<string>();
  return structured.filter((warning) => {
    const key = `${warning.code}\u0000${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
