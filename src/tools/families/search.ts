import { z } from "zod";

import {
  hasPartialVanillaCoverage,
  hitTargetsVanillaNamespace,
  looksLikeClassQuery
} from "../../entry-tools/inspect-minecraft/internal.js";
import type { SearchClassSourceOutput, SearchScope } from "../../source-service.js";
import { resolveCatalogTarget, withMappingApplied, type CatalogTarget } from "../artifact-target.js";
import { defined } from "../items.js";
import { detailSchema, mappingSchema, nonEmptyString, numericInput, targetSchema } from "../schemas.js";
import { serviceSentenceId } from "../translation.js";
import type {
  CatalogNextAction,
  CatalogStatus,
  CatalogToolSpec,
  CatalogTruncation,
  CatalogWarning
} from "../types.js";

/**
 * Search family: `source-search` searches the indexed source of one artifact
 * for declarations by name, for text inside files, or for file paths. The
 * search itself is the source service's; this module maps the request, the
 * statuses and the paging onto the catalog conventions.
 */

const ALL_TARGET_KINDS = ["artifact", "version", "jar", "coordinate", "workspace", "dependency"] as const;

/** The most hits one page returns, and the lower cap of a regular-expression search (the search service's limits). */
const MAX_HITS = 200;
const MAX_REGEX_HITS = 100;

const sourceSearchInput = z
  .strictObject({
    target: targetSchema(ALL_TARGET_KINDS),
    query: nonEmptyString,
    intent: z
      .enum(["symbol", "text", "path"])
      .default("symbol")
      .describe("symbol: declarations by name; text: file contents; path: file paths."),
    match: z
      .enum(["exact", "prefix", "contains", "regex"])
      .default("prefix")
      .describe("exact is case-sensitive; text intent treats prefix as contains."),
    queryMode: z
      .enum(["auto", "token", "literal"])
      .default("auto")
      .describe("Text intent: auto and token search the index; literal scans every file."),
    packagePrefix: nonEmptyString.optional().describe('e.g. "net.minecraft.world.item".'),
    fileGlob: nonEmptyString.optional().describe('e.g. "net/minecraft/world/**/*.java".'),
    symbolKind: z
      .enum(["class", "interface", "enum", "record", "method", "field"])
      .optional()
      .describe('Only with intent "symbol".'),
    mapping: mappingSchema
      .optional()
      .describe("Namespace of the query; hits keep the artifact's namespace."),
    limit: numericInput(z.number().int().min(1).max(MAX_HITS))
      .default(20)
      .describe(`Hits per page; default 20, at most ${MAX_REGEX_HITS} with match "regex".`),
    cursor: nonEmptyString.optional().describe("meta.pagination.nextCursor of the same search."),
    detail: detailSchema("standard").describe("summary drops context; full adds score, reasonCodes, artifactContents.")
  })
  .superRefine((value, ctx) => {
    if (value.symbolKind !== undefined && value.intent !== "symbol") {
      ctx.addIssue({
        code: "custom",
        path: ["symbolKind"],
        message: '"symbolKind" is accepted only with intent "symbol".'
      });
    }
    if (value.intent === "text" && value.queryMode === "token" && value.match === "regex") {
      // A token search only reads index candidates by whole words, so it would
      // run no search at all and report the query as not found.
      ctx.addIssue({
        code: "custom",
        path: ["queryMode"],
        message: 'queryMode "token" does not run a regular expression; use queryMode "auto" or "literal" with match "regex".'
      });
    }
    if (value.match === "regex" && value.limit > MAX_REGEX_HITS) {
      ctx.addIssue({
        code: "custom",
        path: ["limit"],
        message: `With match "regex", limit is at most ${MAX_REGEX_HITS}.`
      });
    }
  });

type SourceSearchInput = z.output<typeof sourceSearchInput>;

/**
 * The ids (see `SERVICE_SENTENCE_REWRITES`) of the service sentences that
 * report a query the search could not translate from `mapping` into the
 * artifact's namespace, so it searched the query as given. A symbol search
 * that then finds nothing has not shown that the name is absent.
 */
const UNTRANSLATED_QUERY_SENTENCES: ReadonlySet<string> = new Set([
  "search-query-no-version",
  "search-query-ambiguous",
  "search-query-not-found",
  "search-query-mapping-unavailable",
  "search-query-untranslated",
  "search-query-translation-failed",
  "search-query-not-qualified"
]);

/**
 * Untranslated-query sentences that are noise when `mapping` already names
 * the artifact's reported namespace: on an unobfuscated Minecraft runtime
 * the stored label is `obfuscated` while the names are Mojang's, so the
 * service treats `mapping: "mojang"` as a namespace to translate from,
 * although nothing needs translating.
 */
const SAME_NAMESPACE_NOISE: ReadonlySet<string> = new Set(["search-query-not-qualified", "search-query-intent"]);

/**
 * The service's warning that the artifact is a Jar-in-Jar shell, whose own
 * index holds none of the classes it bundles: a search of it without hits has
 * not shown that a class is absent.
 */
const SHELL_JAR_SENTENCE =
  /^This artifact is a Jar-in-Jar shell: its own index holds none of the bundled classes, so this search cannot find them\.(?: It bundles [\s\S]*?\.)? Use find-class on this artifact to search the bundled class inventories; get-class-source and get-class-members read a found class from its nested jar, and the artifactId that get-class-source then returns covers that one nested jar only\.$/;

/**
 * The service sentences that report an incomplete search, with the limit
 * that cut it: the indexed search read only its window of index candidates,
 * or the full scan stopped at its byte budget (`MCP_SEARCH_SCAN_MAX_BYTES`).
 */
const INCOMPLETE_SEARCH_SENTENCES: ReadonlyArray<{ readonly limitedBy: string; readonly pattern: RegExp }> = [
  {
    limitedBy: "candidateWindow",
    pattern:
      /^indexed (?:text|path) search examined only its candidate window \(the first \d+ index candidates\) and more matched the index, so results may be incomplete\. Use (?:queryMode="literal" for a full substring scan|match="regex" for a full path scan), or narrow the scope with packagePrefix or a fileGlob that starts with a literal directory\.$/
  },
  {
    limitedBy: "candidateWindow",
    pattern:
      /^indexed symbol search examined only its candidate window \(the first \d+ matching symbols by name\) and more matched the index, so results may be incomplete\. Use a longer query, narrow the scope with packagePrefix, symbolKind or fileGlob, or use match="regex" for a full symbol scan\.$/
  },
  {
    limitedBy: "scanBudget",
    pattern:
      /^search scan budget of \d+ bytes reached; results may be incomplete\. Narrow the query or scope \(packagePrefix \/ fileGlob\) to scan fewer files\.$/
  }
];

/** Characters the index splits a text query at; such a query can miss indexed hits that a literal scan finds. */
const SEPARATOR_CHARACTERS = /[._$]/;

function searchScope(input: SourceSearchInput): SearchScope | undefined {
  const scope = defined({ packagePrefix: input.packagePrefix, fileGlob: input.fileGlob, symbolKind: input.symbolKind });
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function searchTruncation(warnings: readonly string[]): CatalogTruncation[] {
  const truncation: CatalogTruncation[] = [];
  for (const { limitedBy, pattern } of INCOMPLETE_SEARCH_SENTENCES) {
    if (warnings.some((warning) => pattern.test(warning))) truncation.push({ field: "hits", limitedBy });
  }
  return truncation;
}

/**
 * `partial` when the service reports an incomplete search; otherwise `ok`
 * with hits. A search without hits is `unavailable` when it could not have
 * found the class: the artifact is a Jar-in-Jar shell, or a symbol query in
 * another namespace than the artifact's could not be translated from
 * `mapping`. Any other search without hits is `not_found`.
 */
function searchStatus(
  input: SourceSearchInput,
  output: SearchClassSourceOutput,
  truncation: readonly CatalogTruncation[],
  sameNamespace: boolean
): CatalogStatus {
  if (truncation.length > 0) return "partial";
  if (output.hits.length > 0) return "ok";
  const warnings = output.warnings ?? [];
  if (warnings.some((warning) => SHELL_JAR_SENTENCE.test(warning))) return "unavailable";
  const untranslated =
    input.intent === "symbol" &&
    !sameNamespace &&
    warnings.some((warning) => UNTRANSLATED_QUERY_SENTENCES.has(serviceSentenceId(warning) ?? ""));
  return untranslated ? "unavailable" : "not_found";
}

type ServiceHit = SearchClassSourceOutput["hits"][number];

/**
 * What `source-search` does with each field of a service hit. The map is
 * checked against the service's hit type, so a field the search service adds
 * fails the type check until it is kept or left out here on purpose, instead
 * of disappearing from the reply unnoticed.
 */
const HIT_FIELDS = {
  filePath: "keep",
  matchedIn: "keep",
  symbol: "keep",
  line: "keep",
  context: "keep",
  score: "keep",
  reasonCodes: "keep",
  enclosingSymbol: "keep"
} as const satisfies Record<keyof ServiceHit, "keep" | "drop">;

function catalogHit(hit: ServiceHit): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [field, disposition] of Object.entries(HIT_FIELDS)) {
    const value = hit[field as keyof ServiceHit];
    if (disposition === "keep" && value !== undefined) kept[field] = value;
  }
  return kept;
}

/** The search service's warning for a scope that matches no indexed path: no file was searched. */
const UNMATCHED_SCOPE_SENTENCE = / matches no indexed file path, so no file was searched\./;

/**
 * The one follow-up call of a reply: the next page while one exists;
 * otherwise, for an indexed text search without hits whose query holds a
 * separator character, the same search as a literal scan. A regular
 * expression, or a server with indexed search switched off, already scans
 * every file, so the literal scan would repeat the same search; and a scope
 * that matches no indexed path searches no file in any mode.
 */
function followUp(
  input: SourceSearchInput,
  artifactId: string,
  output: SearchClassSourceOutput,
  indexedSearchEnabled: boolean
): CatalogNextAction | undefined {
  const sameSearch = {
    target: { kind: "artifact", artifactId },
    query: input.query,
    intent: input.intent,
    match: input.match,
    queryMode: input.queryMode,
    ...defined({
      packagePrefix: input.packagePrefix,
      fileGlob: input.fileGlob,
      symbolKind: input.symbolKind,
      mapping: input.mapping
    }),
    limit: input.limit,
    detail: input.detail
  };
  if (output.nextCursor !== undefined) {
    return {
      tool: "source-search",
      params: { ...sameSearch, cursor: output.nextCursor },
      reason: "Read the next page of hits."
    };
  }
  if (
    output.hits.length === 0 &&
    input.intent === "text" &&
    input.queryMode === "auto" &&
    input.match !== "regex" &&
    indexedSearchEnabled &&
    SEPARATOR_CHARACTERS.test(input.query) &&
    !(output.warnings ?? []).some((warning) => UNMATCHED_SCOPE_SENTENCE.test(warning))
  ) {
    return {
      tool: "source-search",
      params: { ...sameSearch, queryMode: "literal" },
      reason: 'The index splits a query at ".", "_" and "$"; a literal scan matches the query as written.'
    };
  }
  return undefined;
}

export const sourceSearchSpec: CatalogToolSpec<SourceSearchInput> = {
  name: "source-search",
  description:
    "Search one artifact's indexed source: declarations by name (intent symbol, default), file text (text) or " +
    "file paths (path). status: ok, not_found, partial (search incomplete) or unavailable (no hit and query not " +
    "translated from mapping, or a Jar-in-Jar shell). Pages with cursor. " +
    'Example: {"target":{"kind":"artifact","artifactId":"..."},"query":"BlockPos"}',
  annotations: { readOnlyHint: true },
  inputSchema: sourceSearchInput,
  examples: [
    { target: { kind: "artifact", artifactId: "artifact-id" }, query: "BlockPos" },
    {
      target: { kind: "version", version: "1.21.10" },
      query: "registerBlocks",
      intent: "text",
      packagePrefix: "net.minecraft.world.level.block"
    }
  ],
  statuses: ["ok", "partial", "not_found", "unavailable"],
  primaryKey: "hits",
  detailProjection: {
    default: "standard",
    minimumLevel: {
      context: "standard",
      score: "full",
      reasonCodes: "full"
    }
  },
  handler: async (input, call) => {
    const target = input.target as CatalogTarget;
    const shared = await resolveCatalogTarget(call.services, target, defined({ mapping: input.mapping }));
    const output = await call.services.searchClassSource({
      artifactId: shared.artifactId,
      query: input.query,
      intent: input.intent,
      match: input.match,
      queryMode: input.queryMode,
      limit: input.limit,
      ...defined({ scope: searchScope(input), cursor: input.cursor, queryNamespace: input.mapping })
    });
    const artifact = withMappingApplied(shared.artifact, output.mappingApplied);
    const sameNamespace = input.mapping !== undefined && input.mapping === artifact.mappingApplied;
    const serviceWarnings = (output.warnings ?? []).filter(
      (warning) => !(sameNamespace && SAME_NAMESPACE_NOISE.has(serviceSentenceId(warning) ?? ""))
    );
    const truncation = searchTruncation(serviceWarnings);
    const warnings: Array<string | CatalogWarning> = [...shared.warnings, ...serviceWarnings];
    if (output.cursorIgnored === true) {
      warnings.push({
        code: "cursor-ignored",
        severity: "warning",
        message: "The cursor does not belong to this search; the hits start from the first page."
      });
    }
    // A class-like query without a hit in the Minecraft namespace, in a
    // workspace whose sources omit that namespace, cannot have found its class.
    if (
      target.kind === "workspace" &&
      hasPartialVanillaCoverage(shared.resolved) &&
      looksLikeClassQuery(input.query) &&
      !output.hits.some(hitTargetsVanillaNamespace)
    ) {
      warnings.push({
        code: "source-coverage-partial",
        severity: "warning",
        message:
          "The workspace sources omit net.minecraft, so this search cannot find Minecraft classes; " +
          "class-find confirms a Minecraft class in the binary jar."
      });
    }
    const nextAction = followUp(input, shared.artifactId, output, call.config.indexedSearchEnabled !== false);
    return {
      result: {
        status: searchStatus(input, output, truncation, sameNamespace),
        hits: output.hits.map(catalogHit),
        ...(output.translatedQuery !== undefined ? { translatedQuery: output.translatedQuery } : {}),
        artifact,
        ...(input.detail === "full" ? { artifactContents: output.artifactContents } : {})
      },
      warnings,
      nextActions: nextAction !== undefined ? [nextAction] : [],
      pagination: {
        hasMore: output.nextCursor !== undefined,
        ...(output.nextCursor !== undefined ? { nextCursor: output.nextCursor } : {})
      },
      truncation
    };
  }
};

export const SEARCH_TOOL_SPECS: readonly CatalogToolSpec[] = [sourceSearchSpec];
