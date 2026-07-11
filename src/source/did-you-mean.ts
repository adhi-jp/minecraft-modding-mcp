import { levenshteinDistance, suggestSimilar } from "../mixin/helpers.js";
import type { SourceService } from "../source-service.js";

export interface DidYouMeanCandidate {
  className: string;
  matchReason: string;
}

const TYPE_SYMBOL_KINDS = ["class", "interface", "enum", "record"];
const MAX_CANDIDATES = 8;
// Near-miss candidates come from a bounded prefix pool: typos inside the
// first characters are rare compared to suffix/mid-word slips, and an
// unbounded scan over every type symbol would not stay index-backed.
const EDIT_DISTANCE_POOL_PREFIX = 4;

function fqnOfRow(row: { qualifiedName?: string; filePath: string }): string {
  return row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", ".");
}

/**
 * Collects ranked near-miss class candidates from the artifact's symbol
 * index for a class that was not found: exact simple-name matches first
 * (the moved-FQN case), then case-insensitive matches, then bounded
 * edit-distance suggestions. Candidates are hints, never assertions that the
 * class exists at the suggested location. Returns an empty array when the
 * index has nothing usable.
 */
export function collectDidYouMeanCandidates(
  svc: SourceService,
  artifactId: string,
  className: string
): DidYouMeanCandidate[] {
  try {
    const simpleName = className.split(/[.$]/).at(-1) ?? className;
    if (!simpleName) {
      return [];
    }
    const out: DidYouMeanCandidate[] = [];
    const seen = new Set<string>([className]);
    const push = (fqn: string, matchReason: string): void => {
      if (seen.has(fqn) || out.length >= MAX_CANDIDATES) {
        return;
      }
      seen.add(fqn);
      out.push({ className: fqn, matchReason });
    };

    const exact = svc.symbolsRepo.findScopedSymbols({
      artifactId,
      query: simpleName,
      match: "exact",
      symbolKinds: TYPE_SYMBOL_KINDS,
      limit: 50
    });
    for (const row of exact.items) {
      push(fqnOfRow(row), "exact-simple-name");
    }

    // One index-backed prefix query (lower(symbol_name) LIKE 'pref%') feeds
    // both the case-insensitive and the edit-distance tiers: a case variant
    // shares the lowercased prefix, and a leading-wildcard `contains` scan
    // would defeat the symbol-name index on every not-found error.
    const prefixPool = svc.symbolsRepo.findScopedSymbols({
      artifactId,
      query: simpleName.slice(0, EDIT_DISTANCE_POOL_PREFIX),
      match: "prefix",
      symbolKinds: TYPE_SYMBOL_KINDS,
      limit: 200
    });
    for (const row of prefixPool.items) {
      if (row.symbolName === simpleName) continue;
      if (row.symbolName.toLowerCase() !== simpleName.toLowerCase()) continue;
      push(fqnOfRow(row), "case-insensitive");
    }
    const poolNames = [...new Set(prefixPool.items.map((row) => row.symbolName))];
    for (const suggestion of suggestSimilar(simpleName, poolNames)) {
      const distance = levenshteinDistance(simpleName.toLowerCase(), suggestion.toLowerCase());
      for (const row of prefixPool.items) {
        if (row.symbolName !== suggestion) continue;
        push(fqnOfRow(row), `edit-distance:${distance}`);
      }
    }
    return out;
  } catch {
    // Candidate collection must never turn the not-found error into a
    // different failure; a broken index simply yields no suggestions.
    return [];
  }
}
