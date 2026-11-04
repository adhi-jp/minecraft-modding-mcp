import { z } from "zod";

import { mapWithConcurrencyLimit } from "../../concurrency.js";
import { createError, ERROR_CODES, isAppError } from "../../errors.js";
import { normalizeOptionalProjectPath } from "../../gradle-paths.js";
import type { SymbolReference, SymbolResolutionOutput } from "../../mapping/types.js";
import type { ResolveWorkspaceSymbolOutput } from "../../source-service.js";
import { createWorkspaceSymbolContext } from "../../source/symbol-resolver.js";
import type { SourceMapping } from "../../types.js";
import { defined, failedItem, FollowUps, itemCounts, type FailedItem } from "../items.js";
import {
  detailSchema,
  mappingSchema,
  nonEmptyString,
  numericInput,
  SYMBOL_KINDS,
  symbolSchema,
  targetSchema
} from "../schemas.js";
import type {
  CatalogCall,
  CatalogServices,
  CatalogStatus,
  CatalogToolSpec,
  CatalogTruncation,
  CatalogWarning
} from "../types.js";

/**
 * Symbol family: whether classes, fields and methods exist, what they are
 * called in another namespace, how one class reads across the four
 * namespaces, and in which versions a method exists. These tools read the
 * mapping data of a Minecraft version; they resolve no source artifact, so
 * their replies carry no `result.artifact`. `mapping` (the namespace the
 * names are written in) is required on every tool of the family.
 */

const SYMBOL_TARGET_KINDS = ["version", "workspace"] as const;

/** Symbols looked up at the same time within one call. */
const ITEM_CONCURRENCY = 4;

/** A class, field or method as the catalog writes it in requests and replies. */
type CatalogSymbol = z.output<typeof symbolSchema>;

type SymbolTarget = {
  kind: (typeof SYMBOL_TARGET_KINDS)[number];
  version?: string;
  projectPath?: string;
};

const symbolsSchema = z
  .array(symbolSchema)
  .min(1)
  .max(50)
  .describe("1-50 classes, fields or methods.");

const requiredMapping = mappingSchema.describe("Namespace the names are written in.");
const nameModeSchema = z
  .enum(["fqcn", "auto"])
  .default("auto")
  .describe("auto: dotless classes looked up as given, any namespace; fqcn: qualified only");
const signatureModeSchema = z
  .enum(["exact", "name-only"])
  .optional()
  .describe(
    "exact: a method matches only with its descriptor, which is then required. name-only: a method matches by owner and name, ignoring any descriptor. " +
      "Default: a method with a descriptor is looked up as exact; every other symbol as name-only."
  );

/** The mode a symbol is looked up with: an explicit choice wins; otherwise a method's descriptor picks its overload. */
function effectiveSignatureMode(symbol: CatalogSymbol, requested: "exact" | "name-only" | undefined): "exact" | "name-only" {
  if (requested !== undefined) return requested;
  return symbol.kind === "method" && symbol.descriptor !== undefined ? "exact" : "name-only";
}
const maxCandidatesSchema = numericInput(z.number().int().min(1).max(200)).default(5).describe("Candidates per symbol; default 5.");

/** Classes need a fully qualified name under `requirement`; reports each dotless one. */
function requireQualifiedClasses(symbols: readonly CatalogSymbol[], ctx: z.RefinementCtx, requirement: string): void {
  symbols.forEach((symbol, index) => {
    if (symbol.kind === "class" && !symbol.className.includes(".")) {
      ctx.addIssue({
        code: "custom",
        path: ["symbols", index, "className"],
        message: `"className" must be fully qualified ${requirement}.`
      });
    }
  });
}

/** Methods need a descriptor under `requirement`; reports each one that lacks it. */
function requireMethodDescriptors(symbols: readonly CatalogSymbol[], ctx: z.RefinementCtx, requirement: string): void {
  symbols.forEach((symbol, index) => {
    if (symbol.kind === "method" && symbol.descriptor === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["symbols", index, "descriptor"],
        message: `A method needs "descriptor" ${requirement}.`
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Names, statuses and service text
// ---------------------------------------------------------------------------

/** The service query of a catalog symbol. */
function serviceQuery(symbol: CatalogSymbol): { kind: CatalogSymbol["kind"]; name: string; owner?: string; descriptor?: string } {
  if (symbol.kind === "class") return { kind: "class", name: symbol.className };
  return { kind: symbol.kind, name: symbol.memberName!, owner: symbol.className, ...defined({ descriptor: symbol.descriptor }) };
}

/** A service symbol reference in the catalog's form. */
function catalogSymbol(reference: Pick<SymbolReference, "kind" | "name" | "owner" | "descriptor">): CatalogSymbol {
  if (reference.kind === "class") return { kind: "class", className: reference.name };
  return {
    kind: reference.kind,
    className: reference.owner ?? "",
    memberName: reference.name,
    ...defined({ descriptor: reference.descriptor })
  };
}

function resolutionStatus(status: SymbolResolutionOutput["status"]): CatalogStatus {
  switch (status) {
    case "resolved":
      return "ok";
    case "not_found":
      return "not_found";
    case "ambiguous":
      return "ambiguous";
    case "mapping_unavailable":
      return "unavailable";
  }
}

/** The status of a symbol whose lookup failed with `code`. */
function failureStatus(code: string): CatalogStatus {
  switch (code) {
    case ERROR_CODES.INVALID_INPUT:
      return "invalid";
    case ERROR_CODES.CLASS_NOT_FOUND:
      return "not_found";
    case ERROR_CODES.MAPPING_NOT_APPLIED:
    case ERROR_CODES.MAPPING_UNAVAILABLE:
      return "unavailable";
    default:
      return "error";
  }
}

type SymbolTool = "symbol-check" | "symbol-map" | "class-mappings" | "symbol-trace";

/**
 * A mapping-service sentence that names an input the catalog spells
 * differently or does not take (`sourceMapping`, `owner`, the `disambiguation`
 * hints, `signatureMode` on `symbol-trace`), with its catalog wording per tool.
 * `null` leaves the sentence out for that tool; a tool without an entry
 * keeps the sentence as it is. Each pattern matches one whole service
 * sentence, so paths and symbol names inside other text pass unchanged.
 */
type ServiceSentence = {
  pattern: RegExp;
  replacements: Partial<Record<SymbolTool, string | null>>;
};

const RAISE_MAX_CANDIDATES = "Raise maxCandidates up to 200 to inspect the full candidate list.";

const SERVICE_SENTENCES: readonly ServiceSentence[] = [
  {
    // mapping-service findMapping, ambiguous result
    pattern: /^(Ambiguous mapping: \d+ candidates matched\. Provide a stricter symbol input) or disambiguation hints\.$/,
    replacements: { "symbol-check": "$1.", "symbol-map": "$1.", "symbol-trace": "$1." }
  },
  {
    // mapping-service findMapping, ambiguous method
    pattern:
      /^Retry with signatureMode="exact" plus a JVM descriptor, or pass disambiguation\.descriptorHint, or raise maxCandidates up to 200 to inspect the full candidate list\.$/,
    replacements: {
      "symbol-check": 'Retry with signatureMode="exact" plus a JVM descriptor, or raise maxCandidates up to 200 to inspect the full candidate list.',
      "symbol-map": 'Retry with signatureMode="exact" plus a JVM descriptor, or raise maxCandidates up to 200 to inspect the full candidate list.',
      "symbol-trace": "Pass symbol.descriptor to pick one overload."
    }
  },
  {
    // mapping-service findMapping, ambiguous class or field
    pattern: /^Raise maxCandidates up to 200 to inspect the full candidate list, or use disambiguation\.ownerHint to narrow the search\.$/,
    replacements: { "symbol-check": RAISE_MAX_CANDIDATES, "symbol-map": RAISE_MAX_CANDIDATES, "symbol-trace": null }
  },
  {
    // mapping-service resolveMethodMappingExact, ambiguous and cut at maxCandidates
    pattern: /^Raise maxCandidates up to 200 to inspect the full candidate list, or narrow the lookup via find-mapping disambiguation hints\.$/,
    replacements: { "symbol-map": RAISE_MAX_CANDIDATES, "symbol-trace": null }
  },
  {
    // mapping-service resolveMethodMappingExact, candidates rejected before the verdict
    pattern:
      /^(\d+ further name-matched candidate\(s\) were rejected before the verdict \(\d+ by owner, \d+ by descriptor\) and are not reported); use find-mapping for the unfiltered list\.$/,
    replacements: {
      "symbol-map": "$1; use symbol-map with toMapping and without exact for the unfiltered list.",
      "symbol-trace": "$1."
    }
  },
  {
    // mapping-service resolveMethodMappingExact, owner-strict miss of a className
    // without a package (the service calls it the owner)
    pattern:
      /^(Exact method resolution is owner-strict: .* An inherited or relocated member cannot resolve here — )use find-mapping for an owner-agnostic lookup, or (query the declaring class directly\. ".*" is also not fully qualified: an unqualified) owner (cannot be projected into \S+ and can never match), so supply the fully-qualified owner\.$/,
    replacements: {
      "symbol-map":
        "$1use symbol-map with toMapping and without exact for an owner-agnostic lookup, or $2 className $3, so pass a fully qualified className.",
      "symbol-trace": "$1$2 className $3, so pass a fully qualified className."
    }
  },
  {
    // mapping-service resolveMethodMappingExact, owner-strict miss
    pattern:
      /^(Exact method resolution is owner-strict: .* An inherited or relocated member cannot resolve here — )use find-mapping for an owner-agnostic lookup, or (query the declaring class directly\..*)$/,
    replacements: {
      "symbol-map": "$1use symbol-map with toMapping and without exact for an owner-agnostic lookup, or $2",
      "symbol-trace": "$1$2"
    }
  },
  {
    // mapping-service checkSymbolExists/findMapping, method overloads under name-only matching
    pattern: /^(Multiple method overloads matched name ".*" in owner ".*"\.) Retry with signatureMode="exact" plus a JVM descriptor to pick one overload\.$/,
    replacements: { "symbol-trace": "$1 Pass symbol.descriptor to pick one overload." }
  },
  {
    // symbol resolver, workspace symbol on an unobfuscated version
    pattern:
      /^sourceMapping ("[a-z]+") has no names on unobfuscated Minecraft (\S+); pass sourceMapping "mojang" \(or "obfuscated"\) to resolve against runtime names\.$/,
    replacements: {
      "symbol-map": 'mapping $1 has no names on unobfuscated Minecraft $2; pass mapping "mojang" (or "obfuscated") to resolve against runtime names.'
    }
  }
];

/**
 * The mapping loader's sentence for a version whose metadata (the version
 * manifest or the version's document, which locate the mapping files) could
 * not be fetched: a refused or timed-out request, an error status, or an
 * unreadable response. A version that is missing from the manifest or that
 * has no mapping files is a different sentence and stays as it is.
 */
const MAPPING_FETCH_FAILED =
  /^Failed to resolve version metadata for "(.+?)": ((?:Request failed for|Request timed out for|Response from) "[\s\S]*|Minecraft version manifest response is invalid\.)$/;

/**
 * A mapping data fetch failure as its own warning, so an outage is told apart
 * from a version without mapping data: both leave the lookups `unavailable`.
 */
function mappingFetchFailedWarning(warning: string): CatalogWarning | undefined {
  const match = MAPPING_FETCH_FAILED.exec(warning);
  if (match === null) return undefined;
  return {
    code: "mapping-fetch-failed",
    severity: "warning",
    message:
      `The mapping data of Minecraft ${match[1]} could not be fetched (${match[2]!.replace(/\.$/, "")}), ` +
      "so the lookups that need it are unavailable. Retry the call once the download works."
  };
}

/**
 * Service warnings in the catalog wording of `tool`; sentences without a
 * catalog form are left out, and a mapping data fetch failure becomes a
 * `mapping-fetch-failed` warning.
 */
function catalogServiceWarnings(warnings: readonly string[], tool: SymbolTool): Array<string | CatalogWarning> {
  const kept: Array<string | CatalogWarning> = [];
  for (const warning of warnings) {
    const fetchFailed = mappingFetchFailedWarning(warning);
    if (fetchFailed !== undefined) {
      kept.push(fetchFailed);
      continue;
    }
    const sentence = SERVICE_SENTENCES.find((entry) => entry.pattern.test(warning));
    const replacement = sentence?.replacements[tool];
    if (sentence === undefined || replacement === undefined) {
      kept.push(warning);
    } else if (replacement !== null) {
      kept.push(warning.replace(sentence.pattern, replacement));
    }
  }
  return kept;
}

type ResolutionItem = {
  symbol: CatalogSymbol;
  status: CatalogStatus;
  [field: string]: unknown;
};

/**
 * The item for one resolution. With `compact`, the candidate list is left
 * out when it is empty or only repeats an exact `match`.
 */
function resolutionItem(
  symbol: CatalogSymbol,
  output: SymbolResolutionOutput,
  compact: boolean,
  index: number,
  truncation: CatalogTruncation[]
): ResolutionItem {
  const candidates = output.candidates.map((candidate) => ({
    ...catalogSymbol(candidate),
    matchKind: candidate.matchKind,
    confidence: candidate.confidence
  }));
  const repeatsMatch =
    output.resolved &&
    output.resolvedSymbol !== undefined &&
    candidates.length === 1 &&
    output.candidateCount === 1 &&
    output.candidatesTruncated !== true &&
    candidates[0]!.matchKind === "exact" &&
    (candidates[0]!.confidence === undefined || candidates[0]!.confidence === 1);
  if (output.candidatesTruncated === true) {
    truncation.push({ field: `items[${index}].candidates`, limitedBy: "maxCandidates" });
  }
  return {
    symbol,
    status: resolutionStatus(output.status),
    ...(output.resolvedSymbol !== undefined ? { match: catalogSymbol(output.resolvedSymbol) } : {}),
    ...(compact && (candidates.length === 0 || repeatsMatch) ? {} : { candidates }),
    candidateCount: output.candidateCount,
    ...defined({
      ambiguityReasons: output.ambiguityReasons,
      unobfuscatedRuntime: output.mappingContext.unobfuscatedRuntime === true ? true : undefined,
      runtimeValidated: output.mappingContext.runtimeValidated === true ? true : undefined
    })
  };
}

/**
 * The target with its `projectPath` in this host's spelling (a Windows drive
 * or `\\wsl$`/`\\wsl.localhost` path on a WSL host becomes its Linux path),
 * as the 8.x workspace routes read it.
 */
function normalizedTarget(target: SymbolTarget): SymbolTarget {
  const projectPath = normalizeOptionalProjectPath(target.projectPath);
  return { kind: target.kind, ...defined({ version: target.version, projectPath }) };
}

/**
 * The Minecraft version a symbol target names: `target.version`, or the
 * version a workspace declares in its gradle.properties.
 */
async function targetVersion(services: CatalogServices, target: SymbolTarget): Promise<string> {
  if (target.kind === "version") return target.version!;
  const projectPath = target.projectPath!;
  const detected = await services.workspaceMappingService.detectProjectMinecraftVersion(projectPath);
  if (detected === undefined) {
    throw createError({
      code: ERROR_CODES.WORKSPACE_VERSION_UNRESOLVED,
      message: `Could not read a Minecraft version from ${projectPath}.`,
      details: {
        projectPath,
        nextAction:
          'Declare minecraft_version (or mc_version) in gradle.properties, or pass target {"kind":"version","version":"..."}.'
      }
    });
  }
  return detected;
}

type LookupOutcome<T> = { symbol: CatalogSymbol; output: T };

/** Runs `lookup` for every symbol; a symbol whose lookup throws becomes a failed item. */
async function lookUpEach<T>(
  symbols: readonly CatalogSymbol[],
  call: CatalogCall,
  followUps: FollowUps,
  lookup: (symbol: CatalogSymbol) => Promise<T>
): Promise<Array<LookupOutcome<T> | FailedItem<{ symbol: CatalogSymbol }>>> {
  return mapWithConcurrencyLimit(symbols, ITEM_CONCURRENCY, async (symbol) => {
    try {
      return { symbol, output: await lookup(symbol) };
    } catch (caught) {
      return failedItem({ symbol }, caught, call, followUps, failureStatus);
    }
  });
}

// ---------------------------------------------------------------------------
// symbol-check
// ---------------------------------------------------------------------------

const symbolCheckInput = z
  .strictObject({
    target: targetSchema(SYMBOL_TARGET_KINDS, { version: [], workspace: [] }),
    mapping: requiredMapping,
    symbols: symbolsSchema,
    nameMode: nameModeSchema,
    signatureMode: signatureModeSchema,
    maxCandidates: maxCandidatesSchema
  })
  .superRefine((value, ctx) => {
    if (value.signatureMode === "exact") requireMethodDescriptors(value.symbols, ctx, 'with signatureMode "exact"');
    if (value.nameMode === "fqcn") requireQualifiedClasses(value.symbols, ctx, 'with nameMode "fqcn"');
  });

type SymbolCheckInput = z.output<typeof symbolCheckInput>;

export const symbolCheckSpec: CatalogToolSpec<SymbolCheckInput> = {
  name: "symbol-check",
  description:
    "Check whether 1-50 classes, fields or methods exist in a Minecraft version's mappings. mapping (required) is " +
    "the namespace the names are written in. Item status: ok, not_found, ambiguous, unavailable. " +
    'Example: {"target":{"kind":"version","version":"1.21.10"},"mapping":"mojang","symbols":[{"kind":"class","className":"net.minecraft.world.item.Item"}]}',
  annotations: { readOnlyHint: true },
  inputSchema: symbolCheckInput,
  examples: [
    {
      target: { kind: "version", version: "1.21.10" },
      mapping: "mojang",
      symbols: [{ kind: "class", className: "net.minecraft.world.item.Item" }]
    },
    {
      target: { kind: "workspace", projectPath: "/path/to/mod" },
      mapping: "yarn",
      symbols: [{ kind: "method", className: "net.minecraft.item.Item", memberName: "getName" }]
    }
  ],
  statuses: ["ok", "not_found", "ambiguous", "unavailable", "invalid", "error"],
  primaryKey: "items",
  handler: async (input, call) => {
    const version = await targetVersion(call.services, normalizedTarget(input.target as SymbolTarget));
    const followUps = new FollowUps(call.tool);
    const truncation: CatalogTruncation[] = [];
    const warnings: Array<string | CatalogWarning> = [];
    const outcomes = await lookUpEach(input.symbols, call, followUps, (symbol) =>
      call.services.checkSymbolExists({
        version,
        ...serviceQuery(symbol),
        sourceMapping: input.mapping,
        nameMode: input.nameMode,
        signatureMode: effectiveSignatureMode(symbol, input.signatureMode),
        maxCandidates: input.maxCandidates
      })
    );
    const items = outcomes.map((outcome, index) => {
      if (!("output" in outcome)) return outcome;
      warnings.push(...catalogServiceWarnings(outcome.output.warnings, "symbol-check"));
      return resolutionItem(outcome.symbol, outcome.output, true, index, truncation);
    });
    return {
      result: { items, counts: itemCounts(items), version, mapping: input.mapping },
      warnings,
      nextActions: followUps.list(),
      truncation
    };
  }
};

// ---------------------------------------------------------------------------
// symbol-map
// ---------------------------------------------------------------------------

const symbolMapInput = z
  .strictObject({
    target: targetSchema(SYMBOL_TARGET_KINDS, { version: ["projectPath"], workspace: [] }),
    mapping: requiredMapping,
    toMapping: mappingSchema
      .optional()
      .describe("Destination namespace; with a workspace target, default its compile names."),
    symbols: symbolsSchema,
    exact: z
      .boolean()
      .default(false)
      .describe("Methods only: match owner, name and full descriptor strictly."),
    nameMode: nameModeSchema,
    signatureMode: signatureModeSchema,
    maxCandidates: maxCandidatesSchema,
    detail: detailSchema("summary").describe(
      "summary: no empty or repeated candidates; standard: all; full: adds provenance."
    )
  })
  .superRefine((value, ctx) => {
    if (value.toMapping === undefined && value.target.kind === "version") {
      ctx.addIssue({
        code: "custom",
        path: ["toMapping"],
        message: '"toMapping" is required with a version target; only a workspace target defaults it.'
      });
    }
    if (value.exact) {
      value.symbols.forEach((symbol, index) => {
        if (symbol.kind !== "method") {
          ctx.addIssue({
            code: "custom",
            path: ["symbols", index, "kind"],
            message: 'exact: true maps methods only; use kind "method".'
          });
        }
      });
      requireMethodDescriptors(value.symbols, ctx, "with exact: true");
      return;
    }
    if (value.target.kind === "workspace" && value.toMapping === undefined) {
      requireMethodDescriptors(value.symbols, ctx, "to map to the workspace's compile names");
      requireQualifiedClasses(value.symbols, ctx, "to map to the workspace's compile names");
      return;
    }
    if (value.signatureMode === "exact") requireMethodDescriptors(value.symbols, ctx, 'with signatureMode "exact"');
    if (value.nameMode === "fqcn") requireQualifiedClasses(value.symbols, ctx, 'with nameMode "fqcn"');
  });

type SymbolMapInput = z.output<typeof symbolMapInput>;

export const symbolMapSpec: CatalogToolSpec<SymbolMapInput> = {
  name: "symbol-map",
  description:
    "Map 1-50 class, field or method names from mapping to toMapping for a Minecraft version. exact: true maps " +
    "methods strictly by owner, name and descriptor. A workspace target without toMapping maps to the names the " +
    "project compiles against. " +
    'Example: {"target":{"kind":"version","version":"1.21.10"},"mapping":"obfuscated","toMapping":"mojang","symbols":[{"kind":"class","className":"dhl"}]}',
  annotations: { readOnlyHint: true },
  inputSchema: symbolMapInput,
  examples: [
    {
      target: { kind: "version", version: "1.21.10" },
      mapping: "obfuscated",
      toMapping: "mojang",
      symbols: [{ kind: "class", className: "dhl" }]
    },
    {
      target: { kind: "version", version: "1.21.10" },
      mapping: "intermediary",
      toMapping: "yarn",
      exact: true,
      symbols: [{ kind: "method", className: "net.minecraft.class_1937", memberName: "method_8320", descriptor: "(Lnet/minecraft/class_2338;)Lnet/minecraft/class_2680;" }]
    },
    {
      target: { kind: "workspace", projectPath: "/path/to/mod" },
      mapping: "mojang",
      symbols: [{ kind: "class", className: "net.minecraft.world.item.Item" }]
    }
  ],
  statuses: ["ok", "not_found", "ambiguous", "unavailable", "invalid", "error"],
  primaryKey: "items",
  detailProjection: {
    default: "summary",
    minimumLevel: { mappingContext: "full", provenance: "full" }
  },
  handler: async (input, call) => {
    const target = normalizedTarget(input.target as SymbolTarget);
    const version = await targetVersion(call.services, target);
    const projectPath = target.projectPath;
    const followUps = new FollowUps(call.tool);
    const truncation: CatalogTruncation[] = [];
    const warnings: Array<string | CatalogWarning> = [];
    // Without toMapping, a workspace target maps to the project's compile names; that lookup
    // already matches methods strictly by owner, name and descriptor, with or without exact.
    const toWorkspaceNames = target.kind === "workspace" && input.toMapping === undefined;
    const workspaceContext = toWorkspaceNames
      ? createWorkspaceSymbolContext(projectPath!, call.services.workspaceMappingService)
      : undefined;

    const outcomes = await lookUpEach(
      input.symbols,
      call,
      followUps,
      (symbol): Promise<SymbolResolutionOutput | ResolveWorkspaceSymbolOutput> => {
        const query = serviceQuery(symbol);
        if (toWorkspaceNames) {
          return call.services.resolveWorkspaceSymbol({
            projectPath: projectPath!,
            version,
            ...query,
            sourceMapping: input.mapping,
            maxCandidates: input.maxCandidates
          }, workspaceContext);
        }
        if (input.exact) {
          return call.services.resolveMethodMappingExact({
            version,
            owner: query.owner!,
            name: query.name,
            descriptor: query.descriptor!,
            sourceMapping: input.mapping,
            targetMapping: input.toMapping!,
            maxCandidates: input.maxCandidates,
            ...defined({ projectPath })
          });
        }
        return call.services.findMapping({
          version,
          ...query,
          sourceMapping: input.mapping,
          targetMapping: input.toMapping!,
          nameMode: input.nameMode,
          signatureMode: effectiveSignatureMode(symbol, input.signatureMode),
          maxCandidates: input.maxCandidates,
          ...defined({ projectPath })
        });
      }
    );

    let workspace: ResolveWorkspaceSymbolOutput["workspaceDetection"] | undefined;
    const items = outcomes.map((outcome, index) => {
      if (!("output" in outcome)) return outcome;
      const output = outcome.output;
      warnings.push(...catalogServiceWarnings(output.warnings, "symbol-map"));
      if ("workspaceDetection" in output) workspace ??= output.workspaceDetection;
      return {
        ...resolutionItem(outcome.symbol, output, input.detail === "summary", index, truncation),
        mappingContext: output.mappingContext,
        ...defined({ provenance: output.provenance })
      };
    });

    const toMapping: SourceMapping | undefined = input.toMapping ?? workspace?.mappingApplied;
    return {
      result: {
        items,
        counts: itemCounts(items),
        version,
        mapping: input.mapping,
        ...defined({ toMapping }),
        ...(toWorkspaceNames && workspace !== undefined
          ? {
              workspace: {
                resolved: workspace.resolved,
                ...defined({ mappingApplied: workspace.mappingApplied }),
                ...(input.detail === "full" ? { evidence: workspace.evidence } : {})
              }
            }
          : {})
      },
      warnings,
      nextActions: followUps.list(),
      truncation
    };
  }
};

// ---------------------------------------------------------------------------
// class-mappings
// ---------------------------------------------------------------------------

const classMappingsInput = z.strictObject({
  version: nonEmptyString.describe('Minecraft version, e.g. "1.21.10".'),
  className: nonEmptyString.describe("Class name in mapping's namespace."),
  mapping: requiredMapping,
  kinds: z.array(z.enum(SYMBOL_KINDS)).min(1).optional().describe("Row kinds to list; default all."),
  limit: numericInput(z.number().int().min(1).max(5000)).optional().describe("Rows per page; default all."),
  cursor: nonEmptyString.optional().describe("meta.pagination.nextCursor of the previous page.")
});

type ClassMappingsInput = z.output<typeof classMappingsInput>;

export const classMappingsSpec: CatalogToolSpec<ClassMappingsInput> = {
  name: "class-mappings",
  description:
    "List one class and its fields and methods with their names in all four namespaces (obfuscated, mojang, " +
    "intermediary, yarn) for a Minecraft version. Pages with limit and cursor. " +
    'Example: {"version":"1.21.10","className":"net.minecraft.world.item.Item","mapping":"mojang"}',
  annotations: { readOnlyHint: true },
  inputSchema: classMappingsInput,
  examples: [
    { version: "1.21.10", className: "net.minecraft.world.item.Item", mapping: "mojang" },
    { version: "1.21.10", className: "net.minecraft.class_1792", mapping: "intermediary", kinds: ["method"], limit: 50 }
  ],
  statuses: ["ok"],
  primaryKey: "rows",
  handler: async (input, call) => {
    // The listing's cursor is tied to the kinds as written, so the same set
    // in another order, repeated, or as all three kinds (the default) is
    // passed in one form: a cursor then fits every spelling of the listing.
    const kinds = input.kinds === undefined ? undefined : SYMBOL_KINDS.filter((kind) => input.kinds!.includes(kind));
    const includeKinds = kinds !== undefined && kinds.length < SYMBOL_KINDS.length ? kinds : undefined;
    const output = await call.services.getClassApiMatrix({
      version: input.version,
      className: input.className,
      classNameMapping: input.mapping,
      ...defined({ includeKinds, maxRows: input.limit, cursor: input.cursor })
    });
    const warnings: Array<string | CatalogWarning> = catalogServiceWarnings(output.warnings, "class-mappings");
    if (output.cursorIgnored === true) {
      warnings.push({
        code: "cursor-ignored",
        severity: "warning",
        message: "The cursor does not belong to this listing; the rows start from the first row."
      });
    }
    const nextActions =
      output.nextCursor !== undefined
        ? [
            {
              tool: "class-mappings",
              params: {
                version: input.version,
                className: input.className,
                mapping: input.mapping,
                ...defined({ kinds: input.kinds, limit: input.limit }),
                cursor: output.nextCursor
              },
              reason: "Read the next page."
            }
          ]
        : [];
    return {
      result: {
        rows: output.rows,
        rowCount: output.rowCount,
        className: output.className,
        classIdentity: output.classIdentity,
        version: output.version,
        mapping: output.classNameMapping,
        ...defined({
          ambiguousRowCount: output.ambiguousRowCount,
          unobfuscatedRuntime: output.unobfuscatedRuntime
        })
      },
      warnings,
      nextActions,
      pagination: {
        hasMore: output.nextCursor !== undefined,
        ...defined({ nextCursor: output.nextCursor })
      },
      truncation: output.rowsTruncated === true ? [{ field: "rows", limitedBy: "limit" }] : []
    };
  }
};

// ---------------------------------------------------------------------------
// symbol-trace
// ---------------------------------------------------------------------------

const symbolTraceInput = z
  .strictObject({
    symbol: symbolSchema.describe('A method: {"kind":"method","className","memberName","descriptor"?}.'),
    mapping: requiredMapping,
    fromVersion: nonEmptyString.optional().describe("Oldest version scanned; default the oldest listed."),
    toVersion: nonEmptyString.optional().describe("Newest version scanned; default the newest listed."),
    maxVersions: numericInput(z.number().int().min(1).max(400)).default(120).describe("Most versions scanned, newest kept; default 120."),
    includeSnapshots: z.boolean().default(false),
    withTimeline: z.boolean().default(false).describe("Add one entry per scanned version.")
  })
  .superRefine((value, ctx) => {
    if (value.symbol.kind !== "method") {
      ctx.addIssue({ code: "custom", path: ["symbol", "kind"], message: 'symbol-trace traces methods; use kind "method".' });
    }
  });

type SymbolTraceInput = z.output<typeof symbolTraceInput>;

/** The lifecycle service's own sentences for a symbol it cannot read and for a cut scan. */
const LIFECYCLE_SYMBOL_FORM = 'symbol must be in the form "fully.qualified.Class.method".';
const SCAN_CUT_SENTENCE = /^Version scan truncated to \d+ entries\. Effective fromVersion is now ".+"\.$/;

/**
 * A lifecycle error about the method's form, worded for `symbol-trace`'s
 * `symbol` object. Code, classification and any suggested call are kept.
 */
function catalogTraceError(caught: unknown, symbol: CatalogSymbol): unknown {
  if (!isAppError(caught) || caught.code !== ERROR_CODES.INVALID_INPUT || caught.message !== LIFECYCLE_SYMBOL_FORM) {
    return caught;
  }
  const { symbol: _packed, nextAction: _hint, ...details } = (caught.details ?? {}) as Record<string, unknown>;
  const message =
    typeof details.classLikeSymbol === "string"
      ? `symbol.memberName "${symbol.memberName}" reads as a class name; symbol-trace traces a method: put its class in symbol.className and the method's simple name in symbol.memberName.`
      : "symbol.className must be a fully qualified class name and symbol.memberName the method's simple name.";
  return createError({
    code: caught.code,
    message,
    details: {
      ...details,
      nextAction:
        "Pass the declaring class as symbol.className and the method name as symbol.memberName; symbol.descriptor picks one overload."
    }
  });
}

export const symbolTraceSpec: CatalogToolSpec<SymbolTraceInput> = {
  name: "symbol-trace",
  description:
    "Scan Minecraft versions for one method: first and last versions with it, versions between that lack it, " +
    "and whether the newest scanned has it. status: ok, not_found, unavailable (nothing could be checked). " +
    'Example: {"symbol":{"kind":"method","className":"net.minecraft.server.MinecraftServer","memberName":"tickServer"},"mapping":"mojang","toVersion":"1.21.10"}',
  annotations: { readOnlyHint: true },
  inputSchema: symbolTraceInput,
  examples: [
    {
      symbol: { kind: "method", className: "net.minecraft.server.MinecraftServer", memberName: "tickServer" },
      mapping: "mojang",
      fromVersion: "1.21.1",
      toVersion: "1.21.10"
    }
  ],
  statuses: ["ok", "not_found", "unavailable"],
  primaryKey: "lifecycle",
  handler: async (input, call) => {
    const output = await call.services
      .traceSymbolLifecycle({
        symbol: `${input.symbol.className}.${input.symbol.memberName}`,
        mapping: input.mapping,
        includeSnapshots: input.includeSnapshots,
        maxVersions: input.maxVersions,
        // The timeline tells a version that lacks the method from one that could not be checked.
        includeTimeline: true,
        ...defined({ descriptor: input.symbol.descriptor, fromVersion: input.fromVersion, toVersion: input.toVersion })
      })
      .catch((caught: unknown) => {
        throw catalogTraceError(caught, input.symbol);
      });
    const timeline = output.timeline ?? [];
    const checked = timeline.some((entry) => entry.reason !== "unresolved");
    const status: CatalogStatus = output.presence.firstSeen !== undefined ? "ok" : checked ? "not_found" : "unavailable";
    return {
      result: {
        status,
        lifecycle: {
          symbol: catalogSymbol({
            kind: "method",
            name: output.query.methodName,
            owner: output.query.className,
            ...defined({ descriptor: output.query.descriptor })
          }),
          mapping: output.query.mapping,
          range: output.range,
          presence: output.presence,
          ...(input.withTimeline ? { timeline } : {})
        }
      },
      warnings: catalogServiceWarnings(output.warnings, "symbol-trace"),
      truncation: output.warnings.some((warning) => SCAN_CUT_SENTENCE.test(warning))
        ? [{ field: "lifecycle.range", limitedBy: "maxVersions" }]
        : []
    };
  }
};

export const SYMBOL_TOOL_SPECS: readonly CatalogToolSpec[] = [symbolCheckSpec, symbolMapSpec, classMappingsSpec, symbolTraceSpec];
