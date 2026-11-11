import { ERROR_CODES, createError } from "../errors.js";
import { log } from "../logger.js";
import { isRawSqliteCorruptionError } from "../storage/sqlite.js";
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
import { clampLimit, normalizePathStyle, rememberCachedRegex } from "./shared-utils.js";
import { isProvenUnobfuscatedArtifact } from "./class-source.js";
import { findEnclosingSymbol } from "./declaration-ranges.js";

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
const GLOB_REGEX_CACHE = new Map<string, RegExp>();
const GLOB_EXPANSIONS_REGEX_CACHE = new Map<string, RegExp>();

function isSymbolKind(value: string): value is SymbolKind {
  return SYMBOL_KINDS.includes(value as SymbolKind);
}

function normalizeIntent(intent: SearchIntent | undefined): SearchIntent {
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

// Regex source for a glob in which `**/`, `**`, `*` and `?` are wildcards and
// every other character, braces included, is literal.
function globToRegexSource(pattern: string): string {
  const REGEX_META = /[-/\\^$+.()|[\]{}]/;
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        result += "(?:.*/)?";
        i += 3;
      } else {
        result += ".*";
        i += 2;
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
  return result;
}

/**
 * The whole globs a brace glob stands for, when it holds exactly one balanced
 * `{…}` group with two or more alternatives and no other brace character; an
 * alternative may hold `/`, `*` and `?`. Undefined for every other glob, which
 * reads each brace as a literal character.
 */
function braceExpansions(glob: string): string[] | undefined {
  const open = glob.indexOf("{");
  const close = glob.indexOf("}");
  if (open < 0 || close < open || glob.includes("{", open + 1) || glob.includes("}", close + 1)) {
    return undefined;
  }
  const alternatives = glob.slice(open + 1, close).split(",");
  if (alternatives.length < 2) {
    return undefined;
  }
  const before = glob.slice(0, open);
  const after = glob.slice(close + 1);
  return alternatives.map((alternative) => `${before}${alternative}${after}`);
}

function cachedGlobRegex(cache: Map<string, RegExp>, pattern: string, build: () => string): RegExp {
  const cached = cache.get(pattern);
  if (cached) {
    cache.delete(pattern);
    cache.set(pattern, cached);
    return cached;
  }
  return rememberCachedRegex(cache, pattern, new RegExp(`^${build()}$`));
}

function buildGlobRegex(pattern: string): RegExp {
  return cachedGlobRegex(GLOB_REGEX_CACHE, pattern, () => globToRegexSource(pattern));
}

/** One alternative per whole expansion, so matching costs at most one glob match per alternative. */
function buildExpansionsRegex(pattern: string, expansions: string[]): RegExp {
  return cachedGlobRegex(GLOB_EXPANSIONS_REGEX_CACHE, pattern, () => `(?:${expansions.map(globToRegexSource).join("|")})`);
}

/**
 * The search scope with the reading of its fileGlob settled once, by the scope
 * probe: `fileGlobExpansions` is set when the glob reads its brace group as
 * alternation, and absent when every brace is a literal character.
 */
type ResolvedScope = SearchScope & { fileGlobExpansions?: string[] };

/** The exact fileGlob check of a scope in the reading the search settled on. */
function scopeGlobRegex(scope: Pick<ResolvedScope, "fileGlob" | "fileGlobExpansions"> | undefined): RegExp | undefined {
  if (!scope?.fileGlob) {
    return undefined;
  }
  const glob = normalizePathStyle(scope.fileGlob);
  return scope.fileGlobExpansions ? buildExpansionsRegex(glob, scope.fileGlobExpansions) : buildGlobRegex(glob);
}

/**
 * The text of a normalized glob before its first wildcard, which every path the
 * glob selects starts with. Under alternation it also ends at the `{`.
 */
function globLiteralPrefix(glob: string, alternation: boolean): string {
  const wildcardIndex = glob.search(alternation ? /[*?{]/ : /[*?]/);
  return wildcardIndex < 0 ? glob : glob.slice(0, wildcardIndex);
}

function globToSqlLike(pattern: string): string {
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

/**
 * The LIKE filter of the bounded symbol candidate query for a glob without `**`.
 * A LIKE pattern cannot express alternation, so under alternation the glob
 * filters by its literal prefix: still a superset of the paths it selects, and
 * still narrow enough that out-of-scope symbols do not fill the candidate limit.
 */
function symbolFilePathLike(glob: string, alternation: boolean): string | undefined {
  if (!alternation) {
    return globToSqlLike(glob);
  }
  const prefix = globLiteralPrefix(glob, true);
  return prefix ? `${globToSqlLike(prefix)}%` : undefined;
}

function packagePrefixPath(packagePrefix: string): string {
  return `${packagePrefix.replace(/\.+/g, "/").replace(/\/+$/, "")}/`;
}

function checkPackagePrefix(filePath: string, packagePrefix?: string): boolean {
  if (!packagePrefix) {
    return true;
  }

  return normalizePathStyle(filePath).startsWith(packagePrefixPath(packagePrefix));
}

/**
 * A literal file_path prefix every path accepted by the scope starts with, or
 * undefined when the scope implies none. The indexed candidate query matches it
 * with an ASCII case-insensitive LIKE, a superset of checkPackagePrefix and the
 * glob regex (indexed paths are stored with `/` separators), so both exact
 * checks still run on every candidate.
 */
function indexedScopePathPrefix(scope: ResolvedPathScope | undefined): string | undefined {
  const packagePath = scope?.packagePrefix ? packagePrefixPath(scope.packagePrefix) : undefined;
  let globPath: string | undefined;
  if (scope?.fileGlob) {
    globPath = globLiteralPrefix(normalizePathStyle(scope.fileGlob), scope.fileGlobExpansions !== undefined) || undefined;
  }
  if (packagePath && globPath) {
    // Keep the longer when one extends the other; otherwise either is a superset.
    return globPath.startsWith(packagePath) ? globPath : packagePath;
  }
  return packagePath ?? globPath;
}

type PathScope = Pick<SearchScope, "packagePrefix" | "fileGlob">;
type ResolvedPathScope = Pick<ResolvedScope, "packagePrefix" | "fileGlob" | "fileGlobExpansions">;

const SCOPE_PROBE_PAGE_SIZE = 1000;

/**
 * The caller's path filters, or undefined when it sets neither. An empty or
 * whitespace-only value counts as absent, as the indexed symbol query treats a
 * packagePrefix.
 */
function callerPathScope(scope: SearchScope | undefined): PathScope | undefined {
  const packagePrefix = scope?.packagePrefix?.trim() ? scope.packagePrefix : undefined;
  const fileGlob = scope?.fileGlob?.trim() ? scope.fileGlob : undefined;
  if (!packagePrefix && !fileGlob) {
    return undefined;
  }
  return {
    ...(packagePrefix ? { packagePrefix } : {}),
    ...(fileGlob ? { fileGlob } : {})
  };
}

/** Lower-cases A-Z only, the case folding of SQLite LIKE. */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/**
 * True when at least one indexed file path of the artifact passes `scope`. Every
 * intent applies packagePrefix and fileGlob to file paths, so when no path passes
 * no search can return a hit. packagePrefix is compared ignoring ASCII case: the
 * indexed symbol query applies it only through SQLite LIKE, so a case-sensitive
 * test would rule out paths that symbol search still returns. The LIKE prefix
 * from indexedScopePathPrefix narrows the walk to a superset of both filters,
 * and the walk stops at the first passing path.
 */
function anyIndexedPathInScope(svc: SourceService, artifactId: string, scope: ResolvedPathScope): boolean {
  const packagePath = scope.packagePrefix ? asciiLowerCase(packagePrefixPath(scope.packagePrefix)) : undefined;
  const glob = scopeGlobRegex(scope);
  const likePrefix = indexedScopePathPrefix(scope);
  let cursor: string | undefined;
  do {
    const page = svc.filesRepo.listFiles(artifactId, {
      limit: SCOPE_PROBE_PAGE_SIZE,
      cursor,
      ...(likePrefix ? { prefix: likePrefix } : {})
    });
    svc.metrics.recordSearchDbRoundtrip();
    for (const filePath of page.items) {
      if ((!packagePath || asciiLowerCase(filePath).startsWith(packagePath)) && (!glob || glob.test(filePath))) {
        return true;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

/**
 * Runs the scope probe and settles how this search reads the caller's fileGlob.
 * The literal reading wins whenever it matches an indexed path, so a glob that
 * matched before searches exactly as before; only a glob with one brace group
 * whose literal reading matches nothing is probed again as alternation.
 * Undefined when neither reading matches an indexed path.
 */
function probeScopeReading(
  svc: SourceService,
  artifactId: string,
  scope: PathScope
): { fileGlobExpansions?: string[] } | undefined {
  if (anyIndexedPathInScope(svc, artifactId, scope)) {
    return {};
  }
  const expansions = scope.fileGlob ? braceExpansions(normalizePathStyle(scope.fileGlob)) : undefined;
  if (expansions && anyIndexedPathInScope(svc, artifactId, { ...scope, fileGlobExpansions: expansions })) {
    return { fileGlobExpansions: expansions };
  }
  return undefined;
}

function buildSearchCursorContext(input: {
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

function compileRegex(query: string): RegExp {
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

function findMatchIndex(target: string, query: string, match: SearchMatch, pattern?: RegExp): number {
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
  // Both "contains" and "prefix" map to a substring search here. For free-text
  // content, `prefix` is intentionally treated as "contains": file bodies are
  // searched grep-style and the default match for intent=text resolves to
  // "prefix" (see normalizeMatch), so anchoring at the start of the file would
  // yield almost no hits. Symbol/path prefix anchoring lives in findMatchIndex.
  return normalizedContent.indexOf(normalizedQuery);
}

function scoreSymbolMatch(match: SearchMatch, index: number, symbolKind: SymbolKind): number {
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

function scoreTextMatch(match: SearchMatch, index: number): number {
  const matchBase = match === "exact" ? 280 : match === "prefix" ? 250 : match === "contains" ? 220 : 200;
  return matchBase + Math.max(0, 90 - Math.min(90, Math.floor(index / 2)));
}

function scorePathMatch(match: SearchMatch, index: number): number {
  const matchBase = match === "exact" ? 260 : match === "prefix" ? 230 : match === "contains" ? 210 : 190;
  return matchBase + Math.max(0, 100 - Math.min(100, index));
}

const SHELL_WARNING_NAMED_JARS = 3;

export async function searchClassSource(svc: SourceService, input: SearchClassSourceInput): Promise<SearchClassSourceOutput> {
  const startedAt = Date.now();
  try {
    const artifact = svc.getArtifact(input.artifactId);
    const originalQuery = input.query.trim();
    if (!originalQuery) {
      const reportedMapping = svc.reportedArtifactNamespace(artifact);
      return {
        hits: [],
        mappingApplied: reportedMapping,
        returnedNamespace: reportedMapping,
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
    const reportedNamespace = svc.reportedArtifactNamespace(artifact);
    const searchWarnings: string[] = [];
    const isShellJar = artifact.qualityFlags.includes("shell-jar");
    if (isShellJar) {
      const bundled = artifact.provenance?.nestedJars ?? [];
      const named = bundled.slice(0, SHELL_WARNING_NAMED_JARS).map((entry) => `"${entry}"`).join(", ");
      const bundledNote = bundled.length === 0
        ? ""
        : bundled.length > SHELL_WARNING_NAMED_JARS
          ? ` It bundles ${bundled.length} jars, including ${named}.`
          : ` It bundles ${named}.`;
      searchWarnings.push(
        `This artifact is a Jar-in-Jar shell: its own index holds none of the bundled classes, so this search cannot find them.${bundledNote} Use find-class on this artifact to search the bundled class inventories; get-class-source and get-class-members read a found class from its nested jar, and the artifactId that get-class-source then returns covers that one nested jar only.`
      );
    }
    let translatedInfo: SearchClassSourceOutput["translatedQuery"];
    let query = originalQuery;
    let translationPackagePrefix: string | undefined;
    const prepareSymbolQuery = (name: string): void => {
      const lastDot = name.lastIndexOf(".");
      query = name.slice(lastDot + 1);
      if (lastDot >= 0 && !input.scope?.packagePrefix) {
        translationPackagePrefix = name.slice(0, lastDot);
      }
    };
    const identityQuery = intent === "symbol" && originalQuery.includes(".") && /^[\w.$]+$/.test(originalQuery)
      && input.queryNamespace !== undefined && (
        input.queryNamespace === artifactMapping || (
          isProvenUnobfuscatedArtifact(svc, artifact) &&
          ((input.queryNamespace === "mojang" && artifactMapping === "obfuscated")
            || (input.queryNamespace === "obfuscated" && artifactMapping === "mojang"))
        )
      );
    if (identityQuery) {
      prepareSymbolQuery(originalQuery);
    }

    if (
      input.queryNamespace
      && input.queryNamespace !== artifactMapping
      && !artifact.version
      && !identityQuery
    ) {
      searchWarnings.push(
        `queryNamespace=${input.queryNamespace} could not be applied because the artifact has no version recorded; namespace translation requires a version. Running literal search in ${reportedNamespace} instead.`
      );
    }

    if (
      input.queryNamespace
      && input.queryNamespace !== artifactMapping
      && artifact.version
      && !identityQuery
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
            if (resolvedName) {
              if (resolvedName !== originalQuery) {
                translatedInfo = {
                  original: originalQuery,
                  translated: resolvedName,
                  fromNamespace: input.queryNamespace,
                  toNamespace: artifactMapping
                };
              }
              prepareSymbolQuery(resolvedName);
            }
          } else if (translated.status === "ambiguous") {
            const candidateCount = translated.candidateCount ?? translated.candidates?.length ?? 0;
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: translation for "${originalQuery}" was ambiguous (${candidateCount} candidates); running literal search instead. Narrow the query with a more specific FQCN or call find-mapping directly.`
            );
          } else if (translated.status === "not_found") {
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: no ${reportedNamespace} mapping found for "${originalQuery}"; running literal search instead.`
            );
          } else if (translated.status === "mapping_unavailable") {
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: mapping data unavailable for version ${artifact.version}; running literal search instead.`
            );
          } else {
            searchWarnings.push(
              `queryNamespace=${input.queryNamespace}: could not translate "${originalQuery}" to ${reportedNamespace}; running literal search instead.`
            );
          }
        } catch (caughtError) {
          searchWarnings.push(
            `queryNamespace=${input.queryNamespace}: translation failed (${caughtError instanceof Error ? caughtError.message : String(caughtError)}); running literal search instead.`
          );
        }
      } else if (intent === "symbol") {
        searchWarnings.push(
          `queryNamespace=${input.queryNamespace} requires a fully-qualified class name for translation; running literal search in ${reportedNamespace} instead. Resolve "${originalQuery}" to an FQCN with find-class or find-mapping first.`
        );
      } else if (intent === "text" || intent === "path") {
        searchWarnings.push(
          `queryNamespace=${input.queryNamespace} has no effect when intent="${intent}" — ${intent} search is a literal match against the artifact's ${reportedNamespace} index. Use intent="symbol" for namespace translation.`
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
    // Checked against the caller's scope, not one the namespace translation derived.
    // When no indexed path passes it, no intent can return a hit, so no search runs.
    const pathScope = callerPathScope(input.scope);
    const scopeReading = pathScope ? probeScopeReading(svc, artifact.artifactId, pathScope) : {};
    const scopeMatchesNoPath = scopeReading === undefined;
    // Every glob consumer below reads the fileGlob the way the probe settled.
    const searchScope: ResolvedScope | undefined = scope && scopeReading?.fileGlobExpansions
      ? { ...scope, fileGlobExpansions: scopeReading.fileGlobExpansions }
      : scope;
    if (pathScope && scopeMatchesNoPath && !isShellJar) {
      // A shell's index is empty, and its own warning already says why.
      searchWarnings.push(unmatchedScopeWarning(pathScope, Boolean(artifact.binaryJarPath)));
    }
    const accumulator = createSearchHitAccumulator(limit, cursor);
    const indexedSearchEnabled = svc.config.indexedSearchEnabled !== false;
    if (match === "regex" && !scopeMatchesNoPath) {
      svc.metrics.recordSearchRegexFallback();
    }
    const intentStartedAt = Date.now();

    // The content that verified each content hit, held only while the accumulator holds
    // the hit, so the returned page's enclosing declarations need no second read.
    const hitContents = new WeakMap<SearchSourceHit, string>();
    const recordHit = (hit: SearchSourceHit, content?: string): void => {
      accumulator.add(hit);
      if (content !== undefined) {
        hitContents.set(hit, content);
      }
    };
    const recordWarning = (warning: string): void => {
      searchWarnings.push(warning);
    };
    const tokenOnlyTextIntent = intent === "text" && queryMode === "token";
    let indexedWindowFull = false;
    const runFullScan = (): void => {
      if (intent === "path") {
        searchPathIntent(svc, artifact.artifactId, query, match, searchScope, regexPattern, recordHit);
      } else {
        searchTextIntent(svc, artifact.artifactId, query, match, searchScope, regexPattern, recordHit, recordWarning);
      }
    };
    if (scopeMatchesNoPath) {
      // Skipped: the page stays empty and records no search-path metrics.
    } else if (intent === "symbol") {
      searchSymbolIntent(svc, artifact.artifactId, query, match, searchScope, regexPattern, recordHit);
    } else if (queryMode === "literal" && intent === "text") {
      svc.metrics.recordSearchFallback();
      searchTextIntent(svc, artifact.artifactId, query, match, searchScope, regexPattern, recordHit, recordWarning);
    } else if (!indexedSearchEnabled) {
      svc.metrics.recordIndexedDisabled();
      if (!tokenOnlyTextIntent) {
        svc.metrics.recordSearchFallback();
        runFullScan();
      }
    } else if (match !== "regex") {
      // packagePrefix and a fileGlob's literal directory prefix narrow the indexed
      // candidate query (see indexedScopePathPrefix); both scope filters are also
      // checked exactly on every candidate.
      try {
        if (intent === "path") {
          const outcome = searchPathIntentIndexed(svc, artifact.artifactId, query, match, searchScope, recordHit);
          indexedWindowFull = outcome.windowFull;
          if (outcome.containedButNoneStarted) {
            searchWarnings.push(pathPrefixMissWarning(query));
          }
        } else {
          const outcome = searchTextIntentIndexed(svc, artifact.artifactId, query, match, searchScope, recordHit);
          indexedWindowFull = outcome.windowFull;
          // A shell's index is empty, and its own warning already says why.
          if (!outcome.windowFull && outcome.noCandidateInScope && queryMode === "auto" && !isShellJar) {
            searchWarnings.push(noTokenMatchWarning(query));
          }
        }
        svc.metrics.recordSearchIndexedHit();
      } catch (caughtError) {
        // A token-only search has no full-scan fallback, so swallowing a damaged
        // index here would return an empty page indistinguishable from "no
        // matches". Surface it so the call fails and the cache is rechecked.
        if (tokenOnlyTextIntent && isRawSqliteCorruptionError(caughtError)) {
          throw caughtError;
        }
        svc.metrics.recordSearchFallback();
        log("warn", "search.indexed_fallback", {
          artifactId: artifact.artifactId,
          intent,
          match,
          reason: caughtError instanceof Error ? caughtError.message : String(caughtError)
        });
        if (!tokenOnlyTextIntent) {
          runFullScan();
        }
      }
    } else {
      if (!tokenOnlyTextIntent) {
        svc.metrics.recordSearchFallback();
        runFullScan();
      }
    }
    if (!scopeMatchesNoPath) {
      svc.metrics.recordSearchIntentDuration(intent, Date.now() - intentStartedAt);
    }

    const finalizedHits = accumulator.finalize();
    const page: SearchSourceHit[] = finalizedHits.page;
    for (const hit of page) {
      const content = hitContents.get(hit);
      if (content === undefined) {
        continue;
      }
      const enclosingSymbol = findEnclosingSymbol(hit.filePath, content, hit.line!);
      if (enclosingSymbol) {
        hit.enclosingSymbol = enclosingSymbol;
      }
    }
    if (indexedWindowFull && page.length < limit) {
      searchWarnings.push(indexedCandidateWindowWarning(intent, indexedCandidateLimitForMatch(svc, match)));
    }
    svc.metrics.recordSearchRowsReturned(page.length);
    const nextCursor = finalizedHits.nextCursorHit
      ? encodeSearchCursor(finalizedHits.nextCursorHit, cursorContext)
      : undefined;

    svc.metrics.recordSearchTokenBytesReturned(
      Buffer.byteLength(JSON.stringify({ hits: page }), "utf8")
    );

    const reportedMapping = svc.reportedArtifactNamespace(artifact);
    return {
      hits: page,
      nextCursor,
      ...(cursorIgnored ? { cursorIgnored: true } : {}),
      mappingApplied: reportedMapping,
      returnedNamespace: reportedMapping,
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

function searchSymbolIntent(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: ResolvedScope | undefined,
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

function searchTextIntentIndexed(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: ResolvedScope | undefined,
  onHit: (hit: SearchSourceHit, content: string) => void
): { windowFull: boolean; noCandidateInScope: boolean } {
  const candidateLimit = indexedCandidateLimitForMatch(svc, match);
  const pathPrefix = indexedScopePathPrefix(scope);
  const indexed = svc.filesRepo.searchFileCandidates(artifactId, {
    query,
    match,
    limit: candidateLimit,
    mode: "text",
    ...(pathPrefix ? { pathPrefix } : {})
  });
  svc.metrics.recordSearchDbRoundtrip(indexed.dbRoundtrips);
  svc.metrics.recordSearchRowsScanned(indexed.scannedRows);

  if (indexed.items.length === 0) {
    svc.metrics.recordSearchIndexedZeroShortcircuit();
    return { windowFull: false, noCandidateInScope: true };
  }

  const globFilter = scopeGlobRegex(scope);
  const candidatePaths = indexed.items
    .filter((candidate) => candidate.matchedIn !== "path")
    .map((candidate) => candidate.filePath)
    .filter((filePath) => checkPackagePrefix(filePath, scope?.packagePrefix))
    .filter((filePath) => !globFilter || globFilter.test(filePath));

  const candidateContentRows = svc.filesRepo.getFileContentsByPaths(artifactId, candidatePaths);
  svc.metrics.recordSearchDbRoundtrip();
  svc.metrics.recordSearchRowsScanned(candidateContentRows.length);

  for (const candidate of candidateContentRows) {
    const contentIndex = findContentMatchIndex(candidate.content, query, match);
    if (contentIndex < 0) {
      continue;
    }

    onHit({
      filePath: candidate.filePath,
      score: scoreTextMatch(match, contentIndex),
      matchedIn: "content",
      reasonCodes: ["content_match", `text_${match}`, "indexed"],
      ...contentMatchLocation(candidate.content, contentIndex)
    }, candidate.content);
  }
  // The candidates do not depend on the caller's cursor, so neither does this answer.
  return { windowFull: isCandidateWindowFull(indexed), noCandidateInScope: candidatePaths.length === 0 };
}

function searchPathIntentIndexed(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: ResolvedScope | undefined,
  onHit: (hit: SearchSourceHit) => void
): { windowFull: boolean; containedButNoneStarted: boolean } {
  const candidateLimit = indexedCandidateLimitForMatch(svc, match);
  const pathPrefix = indexedScopePathPrefix(scope);
  const indexed = svc.filesRepo.searchFileCandidates(artifactId, {
    query,
    limit: candidateLimit,
    mode: "path",
    ...(pathPrefix ? { pathPrefix } : {})
  });
  svc.metrics.recordSearchDbRoundtrip(indexed.dbRoundtrips);
  svc.metrics.recordSearchRowsScanned(indexed.scannedRows);

  if (indexed.items.length === 0) {
    svc.metrics.recordSearchIndexedZeroShortcircuit();
    return { windowFull: false, containedButNoneStarted: false };
  }

  const globFilter = scopeGlobRegex(scope);
  const candidateRows: Array<{ filePath: string; pathIndex: number }> = [];
  const inScope = (filePath: string): boolean =>
    checkPackagePrefix(filePath, scope?.packagePrefix) && (!globFilter || globFilter.test(filePath));

  for (const candidate of indexed.items) {
    if (candidate.matchedIn === "content") {
      continue;
    }

    if (!inScope(candidate.filePath)) {
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
  // Only an empty prefix search reads the examined candidates again.
  const containedButNoneStarted = match === "prefix" && candidateRows.length === 0
    && indexed.items.some((candidate) => candidate.matchedIn !== "content"
      && inScope(candidate.filePath)
      && findMatchIndex(candidate.filePath, query, "contains") >= 0);
  return { windowFull: isCandidateWindowFull(indexed), containedButNoneStarted };
}

/** Line number and surrounding lines of the match at `contentIndex`, as search-mod-source reports them. */
export function contentMatchLocation(content: string, contentIndex: number): { line: number; context: string } {
  let lineIndex = 0;
  let lineStart = 0;
  let previousLineStart = 0;
  for (
    let newline = content.indexOf("\n");
    newline !== -1 && newline < contentIndex;
    newline = content.indexOf("\n", newline + 1)
  ) {
    lineIndex += 1;
    previousLineStart = lineStart;
    lineStart = newline + 1;
  }
  // Slice the matching line and its neighbours in place instead of splitting the
  // whole file; the result equals extractLineContext over content.split("\n").
  const lineEnd = content.indexOf("\n", lineStart);
  const nextLineEnd = lineEnd === -1 ? -1 : content.indexOf("\n", lineEnd + 1);
  return {
    line: lineIndex + 1,
    context: content.slice(previousLineStart, nextLineEnd === -1 ? content.length : nextLineEnd)
  };
}

/**
 * True when the index held more candidates than the window it returned: the
 * repository reports that with a continuation cursor, which the single-window
 * indexed search never follows.
 */
function isCandidateWindowFull(indexed: { nextCursor?: string }): boolean {
  return indexed.nextCursor !== undefined;
}

function indexedCandidateWindowWarning(intent: SearchIntent, candidateLimit: number): string {
  const fullScan = intent === "text"
    ? 'queryMode="literal" for a full substring scan'
    : 'match="regex" for a full path scan';
  return `indexed ${intent} search examined only its candidate window (the first ${candidateLimit} index candidates) and more matched the index, so results may be incomplete. Use ${fullScan}, or narrow the scope with packagePrefix or a fileGlob that starts with a literal directory.`;
}

function noTokenMatchWarning(query: string): string {
  return `indexed text search: no file in the searched scope has index tokens matching "${query}". A possible cause: the index compares each query word with whole tokens, the last word with the start of a token when match is "prefix", and an identifier such as removeBarriers is one token, so a word that starts inside an identifier is not found this way. queryMode: "literal" scans file text for the query as a substring.`;
}

function pathPrefixMissWarning(query: string): string {
  return `the indexed paths this search examined in scope contain "${query}" but none starts with it; match "prefix", the default, compares a path query from the start of the full file path, such as com/example/Foo.java. Use match: "contains" to match anywhere in the path, or find-class to find a class by its simple name.`;
}

function unmatchedScopeWarning(scope: PathScope, hasBackingJar: boolean): string {
  const subject = scope.packagePrefix && scope.fileGlob
    ? `packagePrefix "${scope.packagePrefix}" with fileGlob "${scope.fileGlob}"`
    : scope.packagePrefix
      ? `packagePrefix "${scope.packagePrefix}"`
      : `fileGlob "${scope.fileGlob}"`;
  const backingJarNote = hasBackingJar
    ? " Text entries of the backing jar, such as files under assets/ or data/, are served by exact path with get-artifact-file (read-through delivery)."
    : "";
  const wildcardNote = scope.fileGlob && /[*?]/.test(scope.fileGlob)
    ? " In fileGlob, * and ? do not match /; ** does."
    : "";
  if (!scope.fileGlob || !isResourceShapedGlob(normalizePathStyle(scope.fileGlob))) {
    return `${subject} matches no indexed file path, so no file was searched. The index holds this artifact's Java source paths only. A class of another library or loader API is searched through that library's own artifact, for example with target { kind: "dependency", group, name }.${wildcardNote}`;
  }
  return `${subject} matches no indexed file path, so no file was searched. Indexed artifacts currently include Java source only; non-Java resources are not indexed.${backingJarNote}${wildcardNote}`;
}

/**
 * True when a glob can only name non-Java files: its last segment ends in a
 * literal extension other than `java` (any case), or it starts at `assets/` or
 * `data/` and its last segment does not end in a literal `.java`.
 */
function isResourceShapedGlob(glob: string): boolean {
  const segments = glob.split("/");
  const lastSegment = segments[segments.length - 1]!;
  const extension = /\.([A-Za-z0-9]+)$/.exec(lastSegment)?.[1];
  if (extension !== undefined && extension.toLowerCase() !== "java") {
    return true;
  }
  return (segments[0] === "assets" || segments[0] === "data") && !/\.java$/i.test(lastSegment);
}

const ASCII_RE = /^[\x00-\x7F]*$/;

/** True when every code unit is ASCII, so SQLite LIKE folds case identically to JS. */
function isAsciiNeedle(query: string): boolean {
  return ASCII_RE.test(query);
}

function searchScanBudgetWarning(byteBudget: number): string {
  return `search scan budget of ${byteBudget} bytes reached; results may be incomplete. Narrow the query or scope (packagePrefix / fileGlob) to scan fewer files.`;
}

function searchTextIntent(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: ResolvedScope | undefined,
  regexPattern: RegExp | undefined,
  onHit: (hit: SearchSourceHit, content: string) => void,
  onWarning?: (warning: string) => void
): void {
  const glob = scopeGlobRegex(scope);
  const byteBudget = Math.max(1, svc.config.searchScanMaxBytes ?? Number.MAX_SAFE_INTEGER);
  let scannedBytes = 0;
  let truncated = false;

  const passesScope = (filePath: string): boolean =>
    checkPackagePrefix(filePath, scope?.packagePrefix) && (!glob || glob.test(filePath));

  const emitIfMatch = (filePath: string, content: string): void => {
    const contentIndex = findContentMatchIndex(content, query, match, regexPattern);
    if (contentIndex < 0) {
      return;
    }
    onHit({
      filePath,
      score: scoreTextMatch(match, contentIndex),
      matchedIn: "content",
      reasonCodes: ["content_match", `text_${match}`],
      ...contentMatchLocation(content, contentIndex)
    }, content);
  };

  // FAST PATH: an ASCII, non-regex needle narrows candidates via a content LIKE
  // prefilter (a proven superset of the JS match), so only matching files are
  // hydrated instead of scanning the whole corpus. The unchanged JS post-verify in
  // emitIfMatch removes any over-included rows.
  if (match !== "regex" && isAsciiNeedle(query)) {
    const candidateLimit = indexedCandidateLimitForMatch(svc, match);
    const { filePaths, scannedRows } = svc.filesRepo.searchContentLikeCandidatePaths(
      artifactId,
      query,
      candidateLimit
    );
    svc.metrics.recordSearchDbRoundtrip();
    svc.metrics.recordSearchRowsScanned(scannedRows);

    // The prefilter caps candidates at candidateLimit ordered by file_path. Below the
    // cap the candidate set is exhaustive, so the JS post-verify yields exactly the old
    // full-scan hits. AT the cap more matches may exist beyond the path-ordered cut, and
    // dropping them would change the scored top-K page and its cursor — so fall
    // through to the exhaustive paged scan below to preserve identical results.
    if (scannedRows < candidateLimit) {
      svc.metrics.recordSearchLikePrefilter();
      const scopedPaths = filePaths.filter(passesScope);
      const rows = svc.filesRepo.getFileContentsByPaths(artifactId, scopedPaths);
      svc.metrics.recordSearchDbRoundtrip();
      svc.metrics.recordSearchRowsScanned(rows.length);

      for (const row of rows) {
        if (scannedBytes >= byteBudget) {
          truncated = true;
          break;
        }
        scannedBytes += row.contentBytes;
        emitIfMatch(row.filePath, row.content);
      }

      if (truncated) {
        svc.metrics.recordSearchScanTruncated();
        onWarning?.(searchScanBudgetWarning(byteBudget));
      }
      return;
    }
    // Cap overflow: fall through to the exhaustive scan (rare; only common-token queries).
  }

  // SLOW PATH: regex (cannot be pushed to SQL) or non-ASCII needles (SQLite LIKE
  // would fold case differently than JS) scan the corpus page by page.
  const pageSize = Math.max(1, svc.config.searchScanPageSize ?? 250);
  let cursor: string | undefined = undefined;

  outer: while (true) {
    const page = svc.filesRepo.listFileRows(artifactId, { limit: pageSize, cursor });
    svc.metrics.recordSearchDbRoundtrip();
    svc.metrics.recordSearchRowsScanned(page.items.length);

    for (const row of page.items) {
      if (!passesScope(row.filePath)) {
        continue;
      }
      if (scannedBytes >= byteBudget) {
        truncated = true;
        break outer;
      }
      scannedBytes += row.contentBytes;
      emitIfMatch(row.filePath, row.content);
    }

    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  if (truncated) {
    svc.metrics.recordSearchScanTruncated();
    onWarning?.(searchScanBudgetWarning(byteBudget));
  }
}

function searchPathIntent(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: ResolvedScope | undefined,
  regexPattern: RegExp | undefined,
  onHit: (hit: SearchSourceHit) => void
): void {
  const pageSize = Math.max(1, svc.config.searchScanPageSize ?? 250);
  const glob = scopeGlobRegex(scope);
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

      const pathIndex = findMatchIndex(filePath, query, match, regexPattern);
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

function findSymbolHits(
  svc: SourceService,
  artifactId: string,
  query: string,
  match: SearchMatch,
  scope: ResolvedScope | undefined,
  regexPattern: RegExp | undefined
): IndexedSymbolHit[] {
  if (match !== "regex") {
    const filePathLike =
      scope?.fileGlob && !scope.fileGlob.includes("**")
        ? symbolFilePathLike(normalizePathStyle(scope.fileGlob), scope.fileGlobExpansions !== undefined)
        : undefined;
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

    const globFilter = scopeGlobRegex(scope);
    const result: IndexedSymbolHit[] = [];
    for (const symbol of scoped.items) {
      if (globFilter && !globFilter.test(symbol.filePath)) {
        continue;
      }
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

  // Stream rows instead of materializing every symbol: regex scans on large
  // artifacts only keep matching rows in memory this way.
  const candidates = svc.symbolsRepo.iterateSymbolsForArtifact(artifactId, scope?.symbolKind);
  svc.metrics.recordSearchDbRoundtrip();
  let rowsScanned = 0;
  const result: IndexedSymbolHit[] = [];
  const glob = scopeGlobRegex(scope);

  for (const symbol of candidates) {
    rowsScanned += 1;
    if (!checkPackagePrefix(symbol.filePath, scope?.packagePrefix)) {
      continue;
    }

    if (glob && !glob.test(symbol.filePath)) {
      continue;
    }

    if (!isSymbolKind(symbol.symbolKind)) {
      continue;
    }

    const index = findMatchIndex(symbol.symbolName, query, match, regexPattern);
    if (index < 0) {
      continue;
    }

    result.push({
      symbol,
      score: scoreSymbolMatch(match, index, symbol.symbolKind),
      matchIndex: index
    });
  }
  svc.metrics.recordSearchRowsScanned(rowsScanned);

  return result;
}

function indexedCandidateLimit(svc: SourceService): number {
  return Math.min(Math.max(svc.config.maxSearchHits * 5, 500), 5000);
}

function indexedCandidateLimitForMatch(svc: SourceService, match: SearchMatch): number {
  const base = indexedCandidateLimit(svc);
  if (match === "exact" || match === "prefix") {
    // Exact/prefix matches are more selective — fewer candidates needed
    return Math.min(base, 500);
  }
  // Contains matches need more candidates
  return base;
}
