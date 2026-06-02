import { ERROR_CODES, createError } from "../errors.js";
import { log } from "../logger.js";
import {
  createSearchHitAccumulator,
  decodeSearchCursor,
  encodeSearchCursor
} from "../search-hit-accumulator.js";
import type { SourceService } from "../source-service.js";
import type {
  QueryMode,
  SearchClassSourceInput,
  SearchClassSourceOutput,
  SearchScope,
  SearchSourceHit,
  SymbolKind
} from "../source-service.js";
import { normalizePathStyle } from "./shared-utils.js";

type SearchIntent = "symbol" | "text" | "path";
type SearchMatch = "exact" | "prefix" | "contains" | "regex";

interface IndexedSymbolHit {
  symbol: {
    filePath: string;
    symbolKind: string;
    symbolName: string;
    qualifiedName: string | undefined;
    line: number;
  };
  score: number;
  matchIndex: number;
}

const SYMBOL_KINDS: SymbolKind[] = ["class", "interface", "enum", "record", "method", "field"];
const MAX_REGEX_QUERY_LENGTH = 200;
const MAX_REGEX_RESULT_LIMIT = 100;
const MAX_HELPER_REGEX_CACHE = 128;
const GLOB_REGEX_CACHE = new Map<string, RegExp>();

export { MAX_REGEX_QUERY_LENGTH, MAX_REGEX_RESULT_LIMIT };

function rememberCachedRegex(cache: Map<string, RegExp>, key: string, regex: RegExp): RegExp {
  if (cache.size >= MAX_HELPER_REGEX_CACHE) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, regex);
  return regex;
}

function isSymbolKind(value: string): value is SymbolKind {
  return SYMBOL_KINDS.includes(value as SymbolKind);
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit == null) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

export function normalizeIntent(intent: SearchIntent | undefined): SearchIntent {
  if (intent === "path" || intent === "text") {
    return intent;
  }
  return "symbol";
}

export function normalizeMatch(match: SearchMatch | undefined): SearchMatch {
  if (match === "exact" || match === "contains" || match === "regex") {
    return match;
  }
  return "prefix";
}

export function canUseIndexedSearchPath(
  indexedSearchEnabled: boolean,
  intent: SearchIntent,
  match: SearchMatch,
  _scope: SearchScope | undefined
): boolean {
  if (!indexedSearchEnabled) {
    return false;
  }
  if (intent !== "text" && intent !== "path") {
    return false;
  }
  if (match === "regex") {
    return false;
  }

  // packagePrefix and fileGlob are applied as post-filters on indexed candidates.
  return true;
}

export function buildGlobRegex(pattern: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(pattern);
  if (cached) {
    GLOB_REGEX_CACHE.delete(pattern);
    GLOB_REGEX_CACHE.set(pattern, cached);
    return cached;
  }

  const REGEX_META = /[-/\\^$+.()|[\]{}]/;
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      result += ".*";
      i += 2;
      if (pattern[i] === "/") {
        result += "(?:/)?";
        i += 1;
      }
    } else if (ch === "*") {
      result += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      result += "[^/]";
      i += 1;
    } else {
      result += REGEX_META.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return rememberCachedRegex(GLOB_REGEX_CACHE, pattern, new RegExp(`^${result}$`));
}

export function globToSqlLike(pattern: string): string {
  let result = "";
  for (const char of pattern) {
    if (char === "*") {
      result += "%";
      continue;
    }
    if (char === "?") {
      result += "_";
      continue;
    }
    if (char === "%" || char === "_" || char === "\\") {
      result += `\\${char}`;
      continue;
    }
    result += char;
  }
  return result;
}

export function checkPackagePrefix(filePath: string, packagePrefix?: string): boolean {
  if (!packagePrefix) {
    return true;
  }

  const normalizedPrefix = packagePrefix.replace(/\.+/g, "/").replace(/\/+$/, "");
  return normalizePathStyle(filePath).startsWith(`${normalizedPrefix}/`);
}

export function buildSearchCursorContext(input: {
  artifactId: string;
  query: string;
  intent: SearchIntent;
  match: SearchMatch;
  queryMode: QueryMode;
  scope: SearchScope | undefined;
}): string {
  return JSON.stringify({
    artifactId: input.artifactId,
    query: input.query,
    intent: input.intent,
    match: input.match,
    queryMode: input.queryMode,
    packagePrefix: input.scope?.packagePrefix ?? "",
    fileGlob: input.scope?.fileGlob ?? "",
    symbolKind: input.scope?.symbolKind ?? ""
  });
}

function toLower(value: string): string {
  return value.toLocaleLowerCase();
}

export function compileRegex(query: string): RegExp {
  try {
    return new RegExp(query, "i");
  } catch {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Invalid regex query.",
      details: { query }
    });
  }
}

export function findMatchIndex(target: string, query: string, match: SearchMatch, pattern?: RegExp): number {
  if (!query) {
    return -1;
  }

  if (match === "regex") {
    if (!pattern) {
      return -1;
    }
    pattern.lastIndex = 0;
    const result = pattern.exec(target);
    return result?.index ?? -1;
  }

  if (match === "exact") {
    return target === query ? 0 : -1;
  }

  const normalizedTarget = toLower(target);
  const normalizedQuery = toLower(query);

  if (match === "prefix") {
    return normalizedTarget.startsWith(normalizedQuery) ? 0 : -1;
  }

  return normalizedTarget.indexOf(normalizedQuery);
}

/**
 * Content-aware variant of findMatchIndex for searching within file text.
 */
export function findContentMatchIndex(content: string, query: string, match: SearchMatch, pattern?: RegExp): number {
  if (!query) {
    return -1;
  }

  if (match === "regex") {
    if (!pattern) {
      return -1;
    }
    pattern.lastIndex = 0;
    const result = pattern.exec(content);
    return result?.index ?? -1;
  }

  if (match === "exact") {
    return content.indexOf(query);
  }

  const normalizedContent = toLower(content);
  const normalizedQuery = toLower(query);
  return normalizedContent.indexOf(normalizedQuery);
}

export function scoreSymbolMatch(match: SearchMatch, index: number, symbolKind: SymbolKind): number {
  const matchBase =
    match === "exact" ? 350 : match === "prefix" ? 310 : match === "contains" ? 270 : 250;
  const kindBonus =
    symbolKind === "class" || symbolKind === "interface" || symbolKind === "record"
      ? 25
      : symbolKind === "enum"
        ? 20
        : symbolKind === "method"
          ? 15
          : 8;

  return matchBase + kindBonus + Math.max(0, 80 - Math.min(80, index));
}

export function scoreTextMatch(match: SearchMatch, index: number): number {
  const matchBase = match === "exact" ? 280 : match === "prefix" ? 250 : match === "contains" ? 220 : 200;
  return matchBase + Math.max(0, 90 - Math.min(90, Math.floor(index / 2)));
}

export function scorePathMatch(match: SearchMatch, index: number): number {
  const matchBase = match === "exact" ? 260 : match === "prefix" ? 230 : match === "contains" ? 210 : 190;
  return matchBase + Math.max(0, 100 - Math.min(100, index));
}

export function matchRegexIndex(target: string, regex: RegExp): number {
  regex.lastIndex = 0;
  const result = regex.exec(target);
  return result?.index ?? -1;
}

export async function searchClassSource(svc: SourceService, input: SearchClassSourceInput): Promise<SearchClassSourceOutput> {
  const startedAt = Date.now();
  try {
    const artifact = svc.getArtifact(input.artifactId);
    const originalQuery = input.query.trim();
    if (!originalQuery) {
      return {
        hits: [],
        mappingApplied: artifact.mappingApplied ?? "obfuscated",
        returnedNamespace: artifact.mappingApplied ?? "obfuscated",
        artifactContents: svc.buildArtifactContentsSummary({
          origin: artifact.origin,
          sourceJarPath: artifact.sourceJarPath,
          isDecompiled: artifact.isDecompiled,
          qualityFlags: artifact.qualityFlags
        })
      };
    }

    const intent = normalizeIntent(input.intent);
    const match = normalizeMatch(input.match);

    const artifactMapping = artifact.mappingApplied ?? "obfuscated";
    const searchWarnings: string[] = [];
    let translatedInfo: SearchClassSourceOutput["translatedQuery"];
    let query = originalQuery;
    let translationPackagePrefix: string | undefined;

    if (
      input.queryNamespace
      && input.queryNamespace !== artifactMapping
      && !artifact.version
    ) {
      searchWarnings.push(
        `queryNamespace=${input.queryNamespace} could not be applied because the artifact has no version recorded; namespace translation requires a version. Running literal search in ${artifactMapping} instead.`
      );
    }

    if (
      input.queryNamespace
      && input.queryNamespace !== artifactMapping
      && artifact.version
    ) {
      if (intent === "symbol" && originalQuery.includes(".") && /^[\w.$]+$/.test(originalQuery)) {
        try {
          const translated = await svc.mappingService.findMapping({
            version: artifact.version,
            kind: "class",
            name: originalQuery,
            sourceMapping: input.queryNamespace,
            targetMapping: artifactMapping,
            sourcePriority: input.sourcePriority,
            gradleUserHome: input.gradleUserHome,
            signatureMode: "name-only",
            maxCandidates: 5
          });
          if (translated.resolved === true && translated.resolvedSymbol) {
            const resolvedName = translated.resolvedSymbol.symbol
              ?? translated.resolvedSymbol.name;
            if (resolvedName && resolvedName !== originalQuery) {
              translatedInfo = {
                original: originalQuery,
                translated: resolvedName,
                fromNamespace: input.queryNamespace,
                toNamespace: artifactMapping
              };
              if (resolvedName.includes(".")) {
                const lastDot = resolvedName.lastIndexOf(".");
                const simpleName = resolvedName.slice(lastDot + 1);
                const packagePart = resolvedName.slice(0, lastDot);
                query = simpleName;
                if (!input.scope?.packagePrefix) {
                  translationPackagePrefix = packagePart;
                }
              } else {
                query = resolvedName;
              }
            }
          } else if (translated.status === "ambiguous") {
            const candidateCount = translated.candidateCount ?? translated.candidates?.length ?? 0;
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: translation for "${originalQuery}" was ambiguous (${candidateCount} candidates); running literal search instead. Narrow the query with a more specific FQCN or call find-mapping directly.`
            );
          } else if (translated.status === "not_found") {
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: no ${artifactMapping} mapping found for "${originalQuery}"; running literal search instead.`
            );
          } else if (translated.status === "mapping_unavailable") {
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: mapping data unavailable for version ${artifact.version}; running literal search instead.`
            );
          } else {
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: could not translate "${originalQuery}" to ${artifactMapping}; running literal search instead.`
            );
          }
        } catch (caughtError) {
          searchWarnings.push(
            `queryNamespace=${input.queryNamespace}: translation failed (${caughtError instanceof Error ? caughtError.message : String(caughtError)}); running literal search instead.`
          );
        }
      } else if (intent === "text" || intent === "path") {
        searchWarnings.push(
          `queryNamespace=${input.queryNamespace} has no effect when intent="${intent}" — ${intent} search is a literal match against the artifact's ${artifactMapping} index. Use intent="symbol" for namespace translation.`
        );
      }
    }
    if (match === "regex" && query.length > MAX_REGEX_QUERY_LENGTH) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `Regex query exceeds max length of ${MAX_REGEX_QUERY_LENGTH} characters.`,
        details: {
          queryLength: query.length,
          maxLength: MAX_REGEX_QUERY_LENGTH
        }
      });
    }
    const searchLimitCap =
      match === "regex"
        ? Math.max(1, Math.min(svc.config.maxSearchHits, MAX_REGEX_RESULT_LIMIT))
        : svc.config.maxSearchHits;
    const scope: SearchScope | undefined = translationPackagePrefix
      ? { ...(input.scope ?? {}), packagePrefix: translationPackagePrefix }
      : input.scope;
    if (scope?.symbolKind && intent !== "symbol") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'symbolKind filter is only supported when intent="symbol".'
      });
    }
    const limit = clampLimit(input.limit, 20, searchLimitCap);
    const regexPattern = match === "regex" ? compileRegex(query) : undefined;
    const queryMode = input.queryMode ?? "auto";
    svc.metrics.recordSearchQueryMode(queryMode);
    const cursorContext = buildSearchCursorContext({
      artifactId: artifact.artifactId,
      query,
      intent,
      match,
      queryMode,
      scope
    });
    const decodedCursor = decodeSearchCursor(input.cursor);
    const cursor = decodedCursor?.contextKey === cursorContext ? decodedCursor : undefined;
    // A provided cursor that did not decode, or whose context key does not match
    // this query, is silently dropped and the scan restarts from page one. Flag
    // it so callers do not assume they are continuing a previous page.
    const cursorIgnored = input.cursor != null && cursor == null;
    const accumulator = createSearchHitAccumulator(limit, cursor);
    const indexedSearchEnabled = svc.config.indexedSearchEnabled !== false;
    if (match === "regex") {
      svc.metrics.recordSearchRegexFallback();
    }
    const intentStartedAt = Date.now();

    const recordHit = (hit: SearchSourceHit): void => {
      accumulator.add(hit);
    };
    const tokenOnlyTextIntent = intent === "text" && queryMode === "token";
    if (intent === "symbol") {
      searchSymbolIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
    } else if (queryMode === "literal" && intent === "text") {
      svc.metrics.recordSearchFallback();
      searchTextIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
    } else if (!indexedSearchEnabled) {
      svc.metrics.recordIndexedDisabled();
      if (!tokenOnlyTextIntent) {
        svc.metrics.recordSearchFallback();
        if (intent === "path") {
          searchPathIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
        } else {
          searchTextIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
        }
      }
    } else if (canUseIndexedSearchPath(indexedSearchEnabled, intent, match, scope)) {
      try {
        if (intent === "path") {
          searchPathIntentIndexed(svc, artifact.artifactId, query, match, scope, recordHit);
        } else {
          searchTextIntentIndexed(svc, artifact.artifactId, query, match, scope, recordHit);
        }
        svc.metrics.recordSearchIndexedHit();
      } catch (caughtError) {
        svc.metrics.recordSearchFallback();
        log("warn", "search.indexed_fallback", {
          artifactId: artifact.artifactId,
          intent,
          match,
          reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
        });
        if (!tokenOnlyTextIntent) {
          if (intent === "path") {
            searchPathIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
          } else {
            searchTextIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
          }
        }
      }
    } else {
      if (!tokenOnlyTextIntent) {
        svc.metrics.recordSearchFallback();
        if (intent === "path") {
          searchPathIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
        } else {
          searchTextIntent(svc, artifact.artifactId, query, match, scope, regexPattern, recordHit);
        }
      }
    }
    svc.metrics.recordSearchIntentDuration(intent, Date.now() - intentStartedAt);

    const finalizedHits = accumulator.finalize();
    const page = finalizedHits.page;
    svc.metrics.recordSearchRowsReturned(page.length);
    const nextCursor = finalizedHits.nextCursorHit
      ? encodeSearchCursor(finalizedHits.nextCursorHit, cursorContext)
      : undefined;

    svc.metrics.recordSearchTokenBytesReturned(
      Buffer.byteLength(JSON.stringify({ hits: page }), "utf8")
    );

    return {
      hits: page,
      nextCursor,
      ...(cursorIgnored ? { cursorIgnored: true } : {}),
      mappingApplied: artifact.mappingApplied ?? "obfuscated",
      returnedNamespace: artifact.mappingApplied ?? "obfuscated",
      artifactContents: svc.buildArtifactContentsSummary({
        origin: artifact.origin,
        sourceJarPath: artifact.sourceJarPath,
        isDecompiled: artifact.isDecompiled,
        qualityFlags: artifact.qualityFlags
      }),
      ...(translatedInfo ? { translatedQuery: translatedInfo } : {}),
      ...(searchWarnings.length > 0 ? { warnings: searchWarnings } : {})
    };
  } finally {
    svc.metrics.recordDuration("search_duration_ms", Date.now() - startedAt);
  }
}

export function searchSymbolIntent(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: SearchScope | undefined,
  regexPattern: RegExp | undefined,
  onHit: (hit: SearchSourceHit) => void
): void {
  const matchedSymbols = findSymbolHits(svc, artifactId, query, match, scope, regexPattern);

  for (const item of matchedSymbols) {
    onHit({
      filePath: item.symbol.filePath,
      score: item.score,
      matchedIn: "symbol",
      reasonCodes: [`symbol_${match}`],
      symbol: {
        symbolKind: item.symbol.symbolKind as SymbolKind,
        symbolName: item.symbol.symbolName,
        qualifiedName: item.symbol.qualifiedName,
        line: item.symbol.line
      }
    });
  }
}

export function searchTextIntentIndexed(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: SearchScope | undefined,
  onHit: (hit: SearchSourceHit) => void
): void {
  const candidateLimit = indexedCandidateLimitForMatch(svc, match);
  const indexed = svc.filesRepo.searchFileCandidates(artifactId, {
    query,
    match,
    limit: candidateLimit,
    mode: "text"
  });
  svc.metrics.recordSearchDbRoundtrip(indexed.dbRoundtrips);
  svc.metrics.recordSearchRowsScanned(indexed.scannedRows);

  if (indexed.items.length === 0) {
    svc.metrics.recordSearchIndexedZeroShortcircuit();
    return;
  }

  const globFilter = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
  const candidatePaths = indexed.items
    .filter((candidate) => candidate.matchedIn !== "path")
    .map((candidate) => candidate.filePath)
    .filter((filePath) => checkPackagePrefix(filePath, scope?.packagePrefix))
    .filter((filePath) => !globFilter || globFilter.test(filePath));

  const candidateContentRows = svc.filesRepo.getFileContentsByPaths(artifactId, candidatePaths);
  svc.metrics.recordSearchDbRoundtrip();
  svc.metrics.recordSearchRowsScanned(candidateContentRows.length);

  const candidateRows: Array<{ filePath: string; contentIndex: number }> = [];

  for (const candidate of candidateContentRows) {
    const contentIndex = findContentMatchIndex(candidate.content, query, match);
    if (contentIndex < 0) {
      continue;
    }

    candidateRows.push({
      filePath: candidate.filePath,
      contentIndex
    });
  }

  for (const candidate of candidateRows) {
    onHit({
      filePath: candidate.filePath,
      score: scoreTextMatch(match, candidate.contentIndex),
      matchedIn: "content",
      reasonCodes: ["content_match", `text_${match}`, "indexed"]
    });
  }
}

export function searchPathIntentIndexed(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: SearchScope | undefined,
  onHit: (hit: SearchSourceHit) => void
): void {
  const candidateLimit = indexedCandidateLimitForMatch(svc, match);
  const indexed = svc.filesRepo.searchFileCandidates(artifactId, {
    query,
    limit: candidateLimit,
    mode: "path"
  });
  svc.metrics.recordSearchDbRoundtrip(indexed.dbRoundtrips);
  svc.metrics.recordSearchRowsScanned(indexed.scannedRows);

  if (indexed.items.length === 0) {
    svc.metrics.recordSearchIndexedZeroShortcircuit();
    return;
  }

  const globFilter = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
  const candidateRows: Array<{ filePath: string; pathIndex: number }> = [];

  for (const candidate of indexed.items) {
    if (candidate.matchedIn === "content") {
      continue;
    }

    if (!checkPackagePrefix(candidate.filePath, scope?.packagePrefix)) {
      continue;
    }

    if (globFilter && !globFilter.test(candidate.filePath)) {
      continue;
    }

    const pathIndex = findMatchIndex(candidate.filePath, query, match);
    if (pathIndex < 0) {
      continue;
    }

    candidateRows.push({
      filePath: candidate.filePath,
      pathIndex
    });
  }
  for (const candidate of candidateRows) {
    onHit({
      filePath: candidate.filePath,
      score: scorePathMatch(match, candidate.pathIndex),
      matchedIn: "path",
      reasonCodes: ["path_match", `path_${match}`, "indexed"]
    });
  }
}

export function searchTextIntent(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: SearchScope | undefined,
  regexPattern: RegExp | undefined,
  onHit: (hit: SearchSourceHit) => void
): void {
  const pageSize = Math.max(1, svc.config.searchScanPageSize ?? 250);
  const glob = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
  let cursor: string | undefined = undefined;

  while (true) {
    const page = svc.filesRepo.listFileRows(artifactId, { limit: pageSize, cursor });
    svc.metrics.recordSearchDbRoundtrip();
    svc.metrics.recordSearchRowsScanned(page.items.length);

    for (const row of page.items) {
      if (!checkPackagePrefix(row.filePath, scope?.packagePrefix)) {
        continue;
      }
      if (glob && !glob.test(row.filePath)) {
        continue;
      }

      const contentIndex =
        match === "regex"
          ? matchRegexIndex(row.content, regexPattern as RegExp)
          : findContentMatchIndex(row.content, query, match);
      if (contentIndex < 0) {
        continue;
      }

      onHit({
        filePath: row.filePath,
        score: scoreTextMatch(match, contentIndex),
        matchedIn: "content",
        reasonCodes: ["content_match", `text_${match}`]
      });
    }

    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }
}

export function searchPathIntent(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: SearchScope | undefined,
  regexPattern: RegExp | undefined,
  onHit: (hit: SearchSourceHit) => void
): void {
  const pageSize = Math.max(1, svc.config.searchScanPageSize ?? 250);
  const glob = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;
  let cursor: string | undefined = undefined;

  while (true) {
    const page = svc.filesRepo.listFiles(artifactId, { limit: pageSize, cursor });
    svc.metrics.recordSearchDbRoundtrip();
    svc.metrics.recordSearchRowsScanned(page.items.length);

    for (const filePath of page.items) {
      if (!checkPackagePrefix(filePath, scope?.packagePrefix)) {
        continue;
      }
      if (glob && !glob.test(filePath)) {
        continue;
      }

      const pathIndex =
        match === "regex"
          ? matchRegexIndex(filePath, regexPattern as RegExp)
          : findMatchIndex(filePath, query, match);
      if (pathIndex < 0) {
        continue;
      }

      onHit({
        filePath,
        score: scorePathMatch(match, pathIndex),
        matchedIn: "path",
        reasonCodes: ["path_match", `path_${match}`]
      });
    }

    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }
}

export function findSymbolHits(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: SearchScope | undefined,
  regexPattern: RegExp | undefined
): IndexedSymbolHit[] {
  if (match !== "regex") {
    const filePathLike = scope?.fileGlob ? globToSqlLike(normalizePathStyle(scope.fileGlob)) : undefined;
    const scoped = svc.symbolsRepo.findScopedSymbols({
      artifactId,
      query,
      match,
      symbolKind: scope?.symbolKind,
      packagePrefix: scope?.packagePrefix,
      filePathLike,
      limit: indexedCandidateLimit(svc)
    });
    svc.metrics.recordSearchDbRoundtrip();
    svc.metrics.recordSearchRowsScanned(scoped.items.length);

    const result: IndexedSymbolHit[] = [];
    for (const symbol of scoped.items) {
      if (!isSymbolKind(symbol.symbolKind)) {
        continue;
      }
      const index = findMatchIndex(symbol.symbolName, query, match);
      if (index < 0) {
        continue;
      }
      result.push({
        symbol,
        score: scoreSymbolMatch(match, index, symbol.symbolKind),
        matchIndex: index
      });
    }
    return result;
  }

  const candidates = svc.symbolsRepo.listSymbolsForArtifact(artifactId, scope?.symbolKind);
  svc.metrics.recordSearchDbRoundtrip();
  svc.metrics.recordSearchRowsScanned(candidates.length);
  const result: IndexedSymbolHit[] = [];
  const glob = scope?.fileGlob ? buildGlobRegex(normalizePathStyle(scope.fileGlob)) : undefined;

  for (const symbol of candidates) {
    if (!checkPackagePrefix(symbol.filePath, scope?.packagePrefix)) {
      continue;
    }

    if (glob && !glob.test(symbol.filePath)) {
      continue;
    }

    if (!isSymbolKind(symbol.symbolKind)) {
      continue;
    }

    const index =
      match === "regex"
        ? matchRegexIndex(symbol.symbolName, regexPattern as RegExp)
        : findMatchIndex(symbol.symbolName, query, match);
    if (index < 0) {
      continue;
    }

    result.push({
      symbol,
      score: scoreSymbolMatch(match, index, symbol.symbolKind),
      matchIndex: index
    });
  }

  return result;
}

export function indexedCandidateLimit(svc: SourceService): number {
  return Math.min(Math.max(svc.config.maxSearchHits * 5, 500), 5000);
}

export function indexedCandidateLimitForMatch(svc: SourceService, match: SearchMatch): number {
  const base = indexedCandidateLimit(svc);
  if (match === "exact" || match === "prefix") {
    // Exact/prefix matches are more selective — fewer candidates needed
    return Math.min(base, 500);
  }
  // Contains matches need more candidates
  return base;
}
