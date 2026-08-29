import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { type AppError, ERROR_CODES, createError, isAppError } from "../errors.js";
import type {
  ResponseContext as ExplorerResponseContext,
  SignatureMember
} from "../minecraft-explorer-service.js";
import type { SourceService } from "../source-service.js";
import type {
  DecompiledFallback,
  DecompiledMember,
  FindClassInput,
  FindClassMatch,
  FindClassOutput,
  GetClassMembersInput,
  GetClassMembersOutput,
  GetClassMembersStatus,
  GetClassSourceInput,
  GetClassSourceOutput,
  SourceMode
} from "../source-service.js";
import type {
  ArtifactProvenance,
  ArtifactScope,
  MappingSourcePriority,
  ResolvedSourceArtifact,
  SourceMapping,
  SourceTargetInput
} from "../types.js";
import * as artifactResolver from "./artifact-resolver.js";
import * as classSourceHelpers from "./class-source-helpers.js";
import { buildClassSourceSnippet } from "./class-source/snippet-builder.js";
import { remapAndCountMembers, sliceMembersWithLimit, projectMembersForWire, projectMembersByLevel, type MemberProjection } from "./class-source/members-builder.js";
import { collectDidYouMeanCandidates, type DidYouMeanCandidate } from "./did-you-mean.js";
import { matchesMemberPattern } from "./member-pattern.js";
import { findNestedJarClasses, resolveUniqueNestedJarForClass } from "./nested-jars.js";
import { buildPageContextKey, encodeOffsetCursor, resolveCursorOffset } from "../page-cursor.js";
import {
  dedupeQualityFlags,
  inheritArtifactMapping,
  normalizeMapping,
  normalizeOptionalString,
  normalizePathStyle
} from "./shared-utils.js";
import { isUnobfuscatedVersion } from "../version-service.js";

const MEMBERS_STATUS_LEGACY = process.env.MEMBERS_STATUS_LEGACY === "1";

/**
 * Unobfuscated Minecraft versions (26.1+) ship their runtime and decompiled source
 * in deobfuscated (mojang) names directly — there is no real obfuscated namespace to
 * map to. An artifact whose stored namespace label is "obfuscated" is therefore a
 * mislabel for a mojang request: the bytes already carry mojang names.
 *
 * Without this reconciliation, requestedMapping="mojang" !== mappingApplied="obfuscated"
 * triggers a cascade of doomed work: resolveClassNameForLookup attempts a mojang->obfuscated
 * class remap, remapSignatureMembers tries to remap every member obfuscated->mojang and drops
 * them all (counts.total===0), which forces a spurious decompiledFallback, disables
 * memberPattern, and floods the response with one "Could not remap ..." warning per member.
 *
 * Collapsing mappingApplied to the requested mojang namespace makes the whole pipeline an
 * identity no-op: members are returned from bytecode with correct mojang names, memberPattern
 * applies, and the per-member warning flood disappears. This is the single highest-impact
 * token-efficiency fix for unobfuscated versions.
 */
export function reconcileUnobfuscatedNamespace(
  version: string | undefined,
  requestedMapping: SourceMapping,
  mappingApplied: SourceMapping
): SourceMapping {
  if (
    version &&
    requestedMapping === "mojang" &&
    mappingApplied === "obfuscated" &&
    isUnobfuscatedVersion(version)
  ) {
    return "mojang";
  }
  return mappingApplied;
}

type MemberAccess = "public" | "all";

function normalizeStrictPositiveInt(
  value: number | undefined,
  field: string
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `${field} must be a positive integer.`,
      details: { field, value }
    });
  }
  return value;
}

function normalizeMemberAccess(access: MemberAccess | undefined): MemberAccess {
  if (access == null) {
    return "public";
  }
  if (access === "public" || access === "all") {
    return access;
  }
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: `access must be "public" or "all".`,
    details: { access }
  });
}

function looksLikeDeobfuscatedClassName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("net.minecraft.") || trimmed.startsWith("com.mojang.")) {
    return true;
  }
  const simpleName = trimmed.split(/[.$]/).at(-1) ?? trimmed;
  return /^[A-Z][A-Za-z0-9_$]{2,}$/.test(simpleName);
}

function obfuscatedNamespaceHint(className: string): string {
  return `Artifact is indexed in obfuscated runtime names. Deobfuscated names like "${className}" usually require mapping="mojang" or a find-mapping lookup to obfuscated names.`;
}

function hasPartialNetMinecraftCoverage(qualityFlags: string[]): boolean {
  return qualityFlags.includes("partial-source-no-net-minecraft");
}

/**
 * Whether "this artifact is indexed in obfuscated names, ask for mapping=mojang"
 * is TRUE for this artifact, from the pieces of it the caller sees.
 *
 * Two artifact kinds report `mappingApplied: "obfuscated"` without being an
 * obfuscated Minecraft index, and the hint is simply false for them:
 *  - a native dependency artifact, where the resolver SUBSTITUTES "obfuscated"
 *    after the mapping pipeline declines (its class names are already the
 *    library's own, so no mapping exists to ask for), and
 *  - a shell jar, which holds no classes at all — its content lives in the
 *    nested jars, and no mapping choice can change that.
 *
 * `looksLikeDeobfuscatedClassName` matches any capitalized simple name, so
 * without these exclusions an ordinary library class such as "GameTest"
 * qualifies and the caller is told to remap a jar that was never obfuscated.
 */
function isObfuscatedNamespaceHintTrue(input: {
  mappingApplied: SourceMapping | undefined;
  qualityFlags: readonly string[];
  nativeDependency: boolean;
  className: string;
}): boolean {
  return (
    input.mappingApplied === "obfuscated" &&
    !input.nativeDependency &&
    !input.qualityFlags.includes("shell-jar") &&
    looksLikeDeobfuscatedClassName(input.className)
  );
}

function shouldSuggestObfuscatedMapping(
  artifact: ReturnType<SourceService["getArtifact"]>,
  className: string
): boolean {
  return isObfuscatedNamespaceHintTrue({
    mappingApplied: artifact.mappingApplied,
    qualityFlags: artifact.qualityFlags,
    nativeDependency: artifact.provenance?.dependencyResolution != null,
    className
  });
}

function classNameToClassPath(className: string): string {
  const normalized = normalizePathStyle(className.trim()).replace(/\//g, ".");
  const segments = normalized.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "";
  }

  const firstTypeSegment = segments.findIndex((segment) => /^[A-Z_$]/.test(segment));
  if (firstTypeSegment < 0) {
    return segments.join("/");
  }

  const packagePath = segments.slice(0, firstTypeSegment).join("/");
  const typePath = segments.slice(firstTypeSegment).join("$");
  return packagePath ? `${packagePath}/${typePath}` : typePath;
}

export function resolveClassFilePath(svc: SourceService, artifactId: string, className: string): string | undefined {
  const normalizedClassName = className.trim();
  const classPath = classNameToClassPath(normalizedClassName);
  if (!classPath) {
    return undefined;
  }
  const candidates = new Set<string>([`${classPath}.java`]);
  const innerIndex = classPath.indexOf("$");
  if (innerIndex > 0) {
    candidates.add(`${classPath.slice(0, innerIndex)}.java`);
  }

  const simpleName = normalizedClassName.split(/[.$]/).at(-1);
  if (!simpleName) {
    return undefined;
  }
  const lastSlash = classPath.lastIndexOf("/");
  const expectedPrefix = lastSlash < 0 ? "" : classPath.slice(0, lastSlash + 1);
  return svc.filesRepo.findBestClassLookupPath(
    artifactId,
    [...candidates],
    normalizedClassName,
    simpleName,
    expectedPrefix
  );
}

export async function resolveClassNameForLookup(svc: SourceService, input: {
  className: string;
  version?: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority: MappingSourcePriority | undefined;
  gradleUserHome?: string;
  warnings: string[];
  context: string;
}): Promise<string> {
  if (input.sourceMapping === input.targetMapping) {
    return input.className;
  }
  if (!input.version) {
    input.warnings.push(
      `Could not map class "${input.className}" from ${input.sourceMapping} to ${input.targetMapping} for ${input.context} because version is unavailable.`
    );
    return input.className;
  }
  try {
    const mapped = await svc.mappingService.findMapping({
      version: input.version,
      kind: "class",
      name: input.className,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      gradleUserHome: input.gradleUserHome
    });
    if (mapped.resolved && mapped.resolvedSymbol) {
      return mapped.resolvedSymbol.name;
    }
    input.warnings.push(
      `Could not map class "${input.className}" from ${input.sourceMapping} to ${input.targetMapping} for ${input.context}.`
    );
  } catch {
    input.warnings.push(
      `Mapping lookup failed for class "${input.className}" while preparing ${input.context} in ${input.targetMapping}.`
    );
  }
  return input.className;
}

export function buildFallbackProvenance(svc: SourceService, input: {
  artifactId: string;
  origin: ResolvedSourceArtifact["origin"];
  requestedMapping: SourceMapping;
  mappingApplied: SourceMapping;
}): ArtifactProvenance {
  const artifact = svc.getArtifact(input.artifactId);
  const fallbackTarget: SourceTargetInput = artifact.version
    ? { kind: "version", value: artifact.version }
    : artifact.coordinate
      ? { kind: "coordinate", value: artifact.coordinate }
      : { kind: "jar", value: artifact.sourceJarPath ?? artifact.binaryJarPath ?? input.artifactId };

  const transformChain =
    artifact.provenance?.transformChain && artifact.provenance.transformChain.length > 0
      ? artifact.provenance.transformChain
      : [`mapping:${input.requestedMapping}->${input.mappingApplied}`];

  return {
    target: fallbackTarget,
    resolvedAt: artifact.updatedAt,
    resolvedFrom: {
      origin: artifact.origin,
      sourceJarPath: artifact.sourceJarPath,
      binaryJarPath: artifact.binaryJarPath,
      coordinate: artifact.coordinate,
      version: artifact.version,
      repoUrl: artifact.repoUrl
    },
    transformChain
  };
}

/**
 * Near-miss candidates from the requested artifact's index followed by any the
 * lookup's final artifact contributes, deduplicated by FQN so a class present in
 * both is reported once, under the requested artifact.
 */
function unionDidYouMeanCandidates(
  svc: SourceService,
  requestedArtifactId: string,
  endedOnArtifactId: string,
  className: string
): DidYouMeanCandidate[] {
  const requested = collectDidYouMeanCandidates(svc, requestedArtifactId, className);
  if (endedOnArtifactId === requestedArtifactId) {
    return requested;
  }
  const seen = new Set(requested.map((candidate) => candidate.className));
  const fromFallback = collectDidYouMeanCandidates(
    svc,
    endedOnArtifactId,
    className,
    endedOnArtifactId
  ).filter((candidate) => !seen.has(candidate.className));
  return [...requested, ...fromFallback];
}

export function buildClassSourceNotFoundError(svc: SourceService, input: {
  className: string;
  lookupClassName: string;
  /**
   * Artifact the lookup ended on. TWO internal paths move it off the requested
   * artifact: the binary fallback, and the nested-jar redirect that follows a
   * shell jar's bundled inner jar.
   */
  artifactId: string;
  /**
   * Artifact the caller actually asked about. Both internal redirects swap the
   * active artifact mid-lookup, but the error must keep answering about the
   * requested one: reporting the redirect target sends the caller to an artifact
   * they never named. Defaults to `artifactId` for paths with no redirect.
   */
  requestedArtifactId?: string;
  /**
   * Mapping and quality flags OF THE REQUESTED ARTIFACT. `details.artifactId`
   * names the requested artifact, so `details.mapping` (which reaches
   * `error.context` through the allowlist) and `details.qualityFlags` have to
   * describe that same artifact. The nested-jar redirect REPLACES the active
   * values with the inner jar's, which would otherwise publish one artifact's
   * identity beside another's namespace and quality — and point the
   * `suggestedCall` at an index holding neither the class nor its siblings.
   */
  mappingApplied: SourceMapping;
  requestedMapping: SourceMapping;
  qualityFlags: string[];
  /**
   * The mapping the CALLER wrote in the request, undefined when they omitted it.
   * Distinct from `requestedMapping`, which falls back to the artifact's own
   * namespace: only the caller-supplied value can tell whether the obfuscated
   * namespace hint would be re-asking for an argument that is already present.
   */
  callerSuppliedMapping?: SourceMapping;
  /**
   * Whether the REQUESTED artifact is a native dependency, i.e. its provenance
   * carries `dependencyResolution`. Such artifacts are handed
   * `mappingApplied: "obfuscated"` by substitution rather than by being an
   * obfuscated index, which the obfuscated namespace hint must not mistake for
   * a missing mapping argument.
   */
  nativeDependency?: boolean;
  attemptedBinaryFallback: boolean;
  filePath?: string;
  targetKind?: string;
  targetValue?: string;
  scope?: ArtifactScope;
  projectPath?: string;
  version?: string;
  nestedJars?: string[];
}): AppError {
  const simpleName = input.className.split(/[.$]/).at(-1) ?? input.className;
  const requestedArtifactId = input.requestedArtifactId ?? input.artifactId;
  const details: Record<string, unknown> = {
    artifactId: requestedArtifactId,
    ...(input.artifactId !== requestedArtifactId ? { fallbackArtifactId: input.artifactId } : {}),
    className: input.className,
    mapping: input.mappingApplied,
    qualityFlags: input.qualityFlags,
    ...(input.lookupClassName !== input.className ? { lookupClassName: input.lookupClassName } : {}),
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.targetKind ? { targetKind: input.targetKind } : {}),
    ...(input.targetValue ? { targetValue: input.targetValue } : {}),
    ...(input.attemptedBinaryFallback ? { binaryFallbackAttempted: true } : {}),
    ...(input.nestedJars && input.nestedJars.length > 0 ? { nestedJars: input.nestedJars } : {}),
    // Candidates are hints from the symbol index, never assertions that the
    // class exists at the suggested location; empty when nothing usable.
    //
    // Both indexes are consulted, requested artifact first. Collecting from the
    // requested artifact ALONE is empty by construction in the scenario the
    // partial-source fallback exists to serve: that artifact is the one without
    // net.minecraft symbols, which is why the fallback fired and indexed the other
    // jar. Candidates from the artifact the caller did not name carry its id.
    didYouMean: unionDidYouMeanCandidates(svc, requestedArtifactId, input.artifactId, input.className)
  };

  let nextAction = `Use find-class to resolve the correct fully-qualified name for "${simpleName}".`;
  let suggestionSpec: { tool: string; params: Record<string, unknown> } = {
    tool: "find-class",
    params: { className: simpleName, artifactId: requestedArtifactId }
  };

  if (input.targetKind === "version" && input.scope && input.scope !== "merged" && !input.projectPath) {
    nextAction +=
      ` If the class exists in a modded environment, retry with scope: "merged" and projectPath pointing to your mod project.`;
  } else if (input.targetKind === "version" && input.scope && input.scope !== "merged" && input.projectPath) {
    nextAction += ` The class may exist in merged sources; retry with scope: "merged".`;
  }

  if (hasPartialNetMinecraftCoverage(input.qualityFlags)) {
    nextAction =
      `Resolved source coverage does not include net.minecraft for "${input.className}",` +
      (input.attemptedBinaryFallback
        ? " and binary fallback did not produce source for that class."
        : " and a binary fallback has not produced source for that class.") +
      " Use get-class-api-matrix or find-mapping instead of find-class for vanilla API discovery.";
    if (input.version) {
      suggestionSpec = {
        tool: "get-class-api-matrix",
        params: {
          version: input.version,
          className: input.className,
          classNameMapping: input.requestedMapping
        }
      };
    } else {
      suggestionSpec = {
        tool: "find-class",
        params: { className: simpleName, artifactId: requestedArtifactId }
      };
    }
  }

  // Two gates, because the hint fails in two independent ways.
  //
  // `isObfuscatedNamespaceHintTrue` decides whether the claim is even true of
  // this artifact — a dependency jar or a shell jar reports "obfuscated"
  // without being an obfuscated index, and used to be told to remap itself.
  //
  // The second gate is about the ASK, not the claim: the hint ends in
  // `mapping="mojang"`, so firing it at a caller who already sent a
  // non-obfuscated mapping asks for the argument they just supplied and sends
  // them round the same call again. The generic backstop in
  // `dropSatisfiedParameterAsks` cannot rescue this one — it matches an
  // imperative "Provide/Pass mapping", and the sentence is concatenated into
  // the same `nextAction` string as the find-class guidance, which is published
  // as a single hint that no mid-string excision can repair.
  const callerAskedForNonObfuscatedMapping =
    input.callerSuppliedMapping != null && input.callerSuppliedMapping !== "obfuscated";
  if (
    !callerAskedForNonObfuscatedMapping &&
    isObfuscatedNamespaceHintTrue({
      mappingApplied: input.mappingApplied,
      qualityFlags: input.qualityFlags,
      nativeDependency: input.nativeDependency === true,
      className: input.className
    })
  ) {
    nextAction += ` ${obfuscatedNamespaceHint(input.className)}`;
  }

  details.nextAction = nextAction;
  Object.assign(details, buildSuggestedCall(suggestionSpec));

  // Split-source workspaces can omit client-only classes from merged indexes;
  // the vanilla scope decompiles the client jar, which contains them. Offer
  // the retry as an example using existing scope enum values only.
  if (input.targetKind === "version" && input.version && input.scope !== "vanilla") {
    const scopeRetry = buildSuggestedCall({
      tool: "get-class-source",
      params: undefined,
      examples: [
        {
          params: {
            className: input.className,
            target: { kind: "version", value: input.version },
            scope: "vanilla"
          },
          reason:
            "Client-only classes can be missing from merged split-source indexes; scope \"vanilla\" decompiles the client jar, which contains them."
        }
      ]
    });
    if (scopeRetry.exampleCalls?.length) {
      const existing = Array.isArray(details.exampleCalls) ? details.exampleCalls : [];
      details.exampleCalls = [...existing, ...scopeRetry.exampleCalls];
    }
  }

  return createError({
    code: ERROR_CODES.CLASS_NOT_FOUND,
    message: `Source for class "${input.className}" was not found.`,
    details
  });
}

export function buildDecompiledFallback(svc: SourceService, artifactId: string, lookupClassName: string, memberPattern: string | undefined, maxMembers: number): { fallback: DecompiledFallback; counts: NonNullable<GetClassMembersOutput["decompiledMemberCounts"]>; truncated: boolean } | undefined {
  const filePath = resolveClassFilePath(svc, artifactId, lookupClassName);
  if (!filePath) {
    return undefined;
  }
  const row = svc.filesRepo.getFileContent(artifactId, filePath);
  if (!row) {
    return undefined;
  }
  const extracted = classSourceHelpers.extractDecompiledMembers(lookupClassName, filePath, row.content);
  const filterByPattern = (list: DecompiledMember[]): DecompiledMember[] => {
    if (!memberPattern) {
      return list;
    }
    return list.filter((entry) => matchesMemberPattern(entry.name, memberPattern));
  };
  let constructors = filterByPattern(extracted.constructors);
  let fields = filterByPattern(extracted.fields);
  let methods = filterByPattern(extracted.methods);
  const constructorsBefore = constructors.length;
  const fieldsBefore = fields.length;
  const methodsBefore = methods.length;
  const totalBefore = constructorsBefore + fieldsBefore + methodsBefore;
  if (totalBefore === 0) {
    return undefined;
  }
  let remaining = maxMembers;
  const takeWithinLimit = <T,>(list: T[]): T[] => {
    if (remaining <= 0) {
      return [];
    }
    const slice = list.slice(0, remaining);
    remaining -= slice.length;
    return slice;
  };
  constructors = takeWithinLimit(constructors);
  fields = takeWithinLimit(fields);
  methods = takeWithinLimit(methods);
  return {
    fallback: {
      constructors,
      fields,
      methods,
      origin: "source-extracted"
    },
    counts: {
      constructors: constructorsBefore,
      fields: fieldsBefore,
      methods: methodsBefore,
      total: totalBefore
    },
    truncated: totalBefore > maxMembers
  };
}

/**
 * Apply a member projection to the decompiled fallback so it honors the same
 * `projection` contract as the bytecode members block. The fallback only carries
 * names + source line + kind (no signatures), so any non-"full" level reduces to
 * the member name (the array it lives in already conveys the kind). Keeps the
 * full shape for the default "full" level.
 */
function projectDecompiledFallback(fallback: DecompiledFallback, level: MemberProjection): DecompiledFallback {
  if (level === "full") {
    return fallback;
  }
  const reduce = (member: DecompiledMember): DecompiledMember => ({ name: member.name });
  return {
    constructors: fallback.constructors.map(reduce),
    fields: fallback.fields.map(reduce),
    methods: fallback.methods.map(reduce),
    origin: fallback.origin
  };
}

// The class-like symbol kinds findClass returns. MUST stay in sync with the JS-side
// isTypeSymbol checks below; pushed down to SQL so non-type rows are never fetched.
const TYPE_SYMBOL_KINDS = ["class", "interface", "enum", "record"];

export function findClass(svc: SourceService, input: FindClassInput): FindClassOutput {
  const className = input.className.trim();
  if (!className) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "className must be non-empty."
    });
  }
  const inputArtifactId = input.artifactId.trim();
  if (!inputArtifactId) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "artifactId must be non-empty."
    });
  }
  const artifact = svc.getArtifact(inputArtifactId);
  const artifactId = artifact.artifactId;

  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const warnings: string[] = [];
  const isQualified = className.includes(".");

  if (isQualified) {
    // The innermost simple name (handles both dot- and $-separated inner types).
    const simpleName = className.split(/[.$]/).at(-1) ?? className;
    const directPath = `${classNameToClassPath(className)}.java`;
    // The extractor stores ONE (outer) qualifiedName per file, so a nested type's
    // FQCN never equals any stored qualifiedName and its synthetic file path
    // (pkg/Outer/Inner.java) does not exist. resolveClassFilePath maps the FQCN —
    // inner classes included — to the real outer file, which we match on.
    const resolvedFilePath = resolveClassFilePath(svc, artifactId, className);
    const result = svc.symbolsRepo.findScopedSymbols({
      artifactId,
      query: simpleName,
      match: "exact",
      symbolKinds: TYPE_SYMBOL_KINDS,
      limit: limit * 5
    });
    const matches = result.items
      .filter((row) => {
        const isTypeSymbol = row.symbolKind === "class" || row.symbolKind === "interface" ||
          row.symbolKind === "enum" || row.symbolKind === "record";
        if (!isTypeSymbol) return false;
        const rowQualified = row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", ".");
        return (
          rowQualified === className ||
          row.filePath === directPath ||
          (resolvedFilePath != null && row.filePath === resolvedFilePath)
        );
      })
      .map((row) => {
        const rowQualified = row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", ".");
        // For an inner-class match the stored qualifiedName is the outer type; the
        // caller asked for the full nested FQCN, so report that.
        const isInnerMatch = rowQualified !== className && row.filePath !== directPath;
        return {
          qualifiedName: isInnerMatch ? className : rowQualified,
          filePath: row.filePath,
          line: row.line,
          symbolKind: row.symbolKind
        };
      })
      .slice(0, limit);
    const partialVanillaLookup =
      hasPartialNetMinecraftCoverage(artifact.qualityFlags) && looksLikeDeobfuscatedClassName(className);
    const filteredMatches =
      partialVanillaLookup && matches.every((match) =>
        !match.qualifiedName.startsWith("net.minecraft.") && !match.qualifiedName.startsWith("com.mojang.")
      )
        ? []
        : matches;
    return finishFindClass(svc, {
      artifact,
      artifactId,
      className,
      matches: filteredMatches,
      partialVanillaLookup,
      warnings
    });
  }

  const result = svc.symbolsRepo.findScopedSymbols({
    artifactId,
    query: className,
    match: "exact",
    symbolKinds: TYPE_SYMBOL_KINDS,
    limit: limit * 5
  });
  // The extractor stores ONE qualifiedName per FILE (the top-level type), so a
  // nested type's row carries its OUTER type's FQN. Reporting that verbatim
  // returned a qualifiedName that did not contain the searched token at all —
  // feeding match[0] into get-class-source then fetched the wrong class.
  const candidates: FindClassMatch[] = [];
  for (const row of result.items) {
    const isTypeSymbol = row.symbolKind === "class" || row.symbolKind === "interface" ||
      row.symbolKind === "enum" || row.symbolKind === "record";
    if (!isTypeSymbol) continue;
    const enclosingQualifiedName =
      row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", ".");
    const enclosingSimpleName = enclosingQualifiedName.split(".").at(-1) ?? enclosingQualifiedName;
    const nested = enclosingSimpleName !== row.symbolName;
    candidates.push({
      qualifiedName: nested ? `${enclosingQualifiedName}.${row.symbolName}` : enclosingQualifiedName,
      filePath: row.filePath,
      line: row.line,
      symbolKind: row.symbolKind,
      ...(nested ? { nested: true, enclosingClass: enclosingQualifiedName } : {})
    });
  }
  // A top-level type named exactly like the query is what the caller almost
  // always means; a nested type that merely shares the simple name comes after.
  candidates.sort((left, right) => {
    const leftNested = left.nested === true ? 1 : 0;
    const rightNested = right.nested === true ? 1 : 0;
    if (leftNested !== rightNested) return leftNested - rightNested;
    return left.qualifiedName.localeCompare(right.qualifiedName);
  });
  const matches = candidates.slice(0, limit);
  const partialVanillaLookup =
    hasPartialNetMinecraftCoverage(artifact.qualityFlags) && looksLikeDeobfuscatedClassName(className);
  const filteredMatches =
    partialVanillaLookup && matches.every((match) =>
      !match.qualifiedName.startsWith("net.minecraft.") && !match.qualifiedName.startsWith("com.mojang.")
    )
      ? []
      : matches;
  return finishFindClass(svc, {
    artifact,
    artifactId,
    className,
    matches: filteredMatches,
    partialVanillaLookup,
    warnings
  });
}

/**
 * Shared tail for both findClass branches: coverage/namespace warnings plus a
 * machine-usable recovery route.
 *
 * An empty result on an artifact whose index excludes net.minecraft is
 * internally consistent but externally contradictory — get-class-source answers
 * the SAME class from the binary fallback. The caller therefore gets both the
 * reason and the exact call that works.
 */
function finishFindClass(
  svc: SourceService,
  input: {
    artifact: ReturnType<SourceService["getArtifact"]>;
    artifactId: string;
    className: string;
    matches: FindClassMatch[];
    partialVanillaLookup: boolean;
    warnings: string[];
  }
): FindClassOutput {
  const { artifact, artifactId, className, matches, partialVanillaLookup, warnings } = input;
  let suggestedCall: FindClassOutput["suggestedCall"];
  if (matches.length === 0 && partialVanillaLookup) {
    warnings.push(
      `Artifact source coverage is partial and excludes net.minecraft; returning non-vanilla matches for "${className}" would be misleading. Use get-class-source/get-class-members for binary fallback or get-class-api-matrix for mapped API inspection.`
    );
    suggestedCall = buildSuggestedCall({
      tool: "get-class-source",
      params: {
        className,
        target: { kind: "artifact", artifactId },
        mode: "metadata"
      }
    }).suggestedCall;
  }
  if (matches.length === 0 && shouldSuggestObfuscatedMapping(artifact, className)) {
    warnings.push(`No exact class symbol matched "${className}". ${obfuscatedNamespaceHint(className)}`);
  }
  return {
    matches,
    total: matches.length,
    warnings,
    ...(suggestedCall ? { suggestedCall } : {})
  };
}

export async function findClassIncludingNested(
  svc: SourceService,
  input: FindClassInput
): Promise<FindClassOutput> {
  const indexed = findClass(svc, input);
  if (indexed.total > 0) {
    return indexed;
  }

  const artifact = svc.getArtifact(input.artifactId.trim());
  const inventory = artifact.provenance?.nestedJars;
  if (
    !artifact.qualityFlags.includes("shell-jar") ||
    !artifact.binaryJarPath ||
    !inventory ||
    inventory.length === 0
  ) {
    return indexed;
  }

  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const matches = await findNestedJarClasses({
    cacheDir: svc.config.cacheDir,
    outerJarPath: artifact.binaryJarPath,
    outerSignature: artifact.artifactId,
    inventory,
    className: input.className,
    limit
  });
  return {
    matches,
    total: matches.length,
    warnings: indexed.warnings
  };
}

export async function getClassSource(svc: SourceService, input: GetClassSourceInput): Promise<GetClassSourceOutput> {
  const className = input.className.trim();
  if (!className) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "className must be non-empty."
    });
  }

  const mode: SourceMode = input.mode ?? "metadata";

  const startLine = normalizeStrictPositiveInt(input.startLine, "startLine");
  const endLine = normalizeStrictPositiveInt(input.endLine, "endLine");
  let maxLines = normalizeStrictPositiveInt(input.maxLines, "maxLines");
  const maxChars = normalizeStrictPositiveInt(input.maxChars, "maxChars");
  const outputFile = normalizeOptionalString(input.outputFile);

  if (mode === "snippet" && startLine == null && endLine == null && maxLines == null) {
    maxLines = 200;
  }

  if (startLine != null && endLine != null && startLine > endLine) {
    throw createError({
      code: ERROR_CODES.INVALID_LINE_RANGE,
      message: `Invalid line range: startLine (${startLine}) is greater than endLine (${endLine}).`,
      details: { startLine, endLine }
    });
  }

  const normalizedArtifactId = normalizeOptionalString(input.artifactId);
  if (normalizedArtifactId && input.target) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "artifactId and target are mutually exclusive.",
      details: { artifactId: normalizedArtifactId, target: input.target }
    });
  }

  let artifactId = normalizedArtifactId;
  let origin: ResolvedSourceArtifact["origin"] = "local-jar";
  // Derivation, tracked separately from origin: whether the indexed text was
  // produced by decompiling bytecode. Only the persisted flag answers that.
  let isDecompiled = false;
  let warnings: string[] = [];
  let requestedMapping: SourceMapping = normalizeMapping(input.mapping);
  let mappingApplied: SourceMapping = requestedMapping;
  let provenance: ArtifactProvenance | undefined;
  let qualityFlags: string[] = [];
  let sourceJarPath: string | undefined;
  let binaryJarPath: string | undefined;
  let version: string | undefined;
  let coordinate: string | undefined;
  if (!artifactId) {
    if (!input.target) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Either artifactId or target must be provided."
      });
    }

    const resolved = await svc.resolveArtifact({
      target: input.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    });
    artifactId = resolved.artifactId;
    origin = resolved.origin;
    isDecompiled = resolved.isDecompiled;
    warnings = [...resolved.warnings];
    requestedMapping = resolved.requestedMapping;
    mappingApplied = resolved.mappingApplied;
    provenance = resolved.provenance;
    qualityFlags = [...resolved.qualityFlags];
    sourceJarPath = resolved.resolvedSourceJarPath;
    binaryJarPath = resolved.binaryJarPath;
    version = resolved.version;
    coordinate = resolved.coordinate;
  } else {
    const artifact = svc.getArtifact(artifactId);
    artifactId = artifact.artifactId;
    origin = artifact.origin;
    isDecompiled = artifact.isDecompiled;
    requestedMapping = inheritArtifactMapping(input.mapping, artifact);
    mappingApplied = artifact.mappingApplied ?? requestedMapping;
    provenance = artifact.provenance;
    qualityFlags = artifact.qualityFlags;
    sourceJarPath = artifact.sourceJarPath;
    binaryJarPath = artifact.binaryJarPath;
    version = artifact.version;
    coordinate = artifact.coordinate;
  }

  version = await artifactResolver.resolveVersionContext(svc, {
    version,
    provenance,
    coordinate,
    projectPath: input.projectPath,
    preferProjectVersion: input.preferProjectVersion,
    warnings
  });

  mappingApplied = reconcileUnobfuscatedNamespace(version, requestedMapping, mappingApplied);

  let activeArtifactId = artifactId;
  let activeOrigin = origin;
  let activeIsDecompiled = isDecompiled;
  let activeProvenance = provenance;
  let activeQualityFlags = [...qualityFlags];
  let activeMappingApplied = mappingApplied;
  let activeSourceJarPath = sourceJarPath;
  let attemptedBinaryFallback = false;
  const tryBinaryFallback = async (): Promise<boolean> => {
    if (attemptedBinaryFallback) {
      return false;
    }
    attemptedBinaryFallback = true;
    const normalizedBinaryJarPath = normalizeOptionalString(binaryJarPath);
    if (!normalizedBinaryJarPath) {
      return false;
    }
    if (
      activeSourceJarPath &&
      normalizePathStyle(activeSourceJarPath) === normalizePathStyle(normalizedBinaryJarPath)
    ) {
      return false;
    }

    const fallbackResolved = await svc.resolveBinaryFallbackArtifact({
      binaryJarPath: normalizedBinaryJarPath,
      version,
      coordinate,
      requestedMapping,
      mappingApplied,
      provenance: activeProvenance,
      qualityFlags: activeQualityFlags,
      // A caller who declined decompilation must not pay for one here: the
      // fallback used to hardcode allowDecompile:true and silently ran a full
      // Vineflower pass on the binary jar.
      allowDecompile: input.allowDecompile
    });
    if (!fallbackResolved || fallbackResolved.artifactId === activeArtifactId) {
      return false;
    }

    activeArtifactId = fallbackResolved.artifactId;
    activeOrigin = fallbackResolved.origin;
    activeIsDecompiled = fallbackResolved.isDecompiled;
    activeMappingApplied = fallbackResolved.mappingApplied ?? activeMappingApplied;
    activeProvenance = fallbackResolved.provenance ?? activeProvenance;
    activeQualityFlags = dedupeQualityFlags([...(fallbackResolved.qualityFlags ?? []), "binary-fallback"]);
    activeSourceJarPath = fallbackResolved.sourceJarPath;
    warnings.push(
      `Falling back to binary artifact "${normalizedBinaryJarPath}" because source coverage for "${className}" was incomplete.`
    );
    if (activeMappingApplied !== requestedMapping) {
      warnings.push(
        `Fallback source text is indexed in ${activeMappingApplied} names; returned source is not remapped to ${requestedMapping}.`
      );
    }
    return true;
  };

  let attemptedNestedJarRedirect = false;
  const tryNestedJarRedirect = async (lookupClassName: string): Promise<boolean> => {
    if (attemptedNestedJarRedirect) {
      return false;
    }
    const inventory = activeProvenance?.nestedJars;
    const outerJarPath = normalizeOptionalString(binaryJarPath);
    if (!inventory || inventory.length === 0 || !outerJarPath) {
      return false;
    }
    attemptedNestedJarRedirect = true;
    const shellArtifactId = activeArtifactId;
    const match = await resolveUniqueNestedJarForClass({
      cacheDir: svc.config.cacheDir,
      outerJarPath,
      outerArtifactId: shellArtifactId,
      inventory,
      className: lookupClassName
    });
    if (!match) {
      return false;
    }
    const redirectResolved = await svc.resolveArtifact({
      target: { kind: "jar", value: match.extractedPath },
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome
    });
    activeArtifactId = redirectResolved.artifactId;
    activeOrigin = redirectResolved.origin;
    // The INNER jar's derivation: the shell that bundled it holds no source of
    // its own, so its flag says nothing about the text being returned here.
    activeIsDecompiled = redirectResolved.isDecompiled;
    activeMappingApplied = redirectResolved.mappingApplied ?? activeMappingApplied;
    activeProvenance = redirectResolved.provenance
      ? {
          ...redirectResolved.provenance,
          nestedJar: { entryName: match.entryName, shellArtifactId }
        }
      : activeProvenance;
    activeQualityFlags = dedupeQualityFlags([
      ...redirectResolved.qualityFlags,
      "nested-jar-redirect"
    ]);
    activeSourceJarPath = redirectResolved.resolvedSourceJarPath;
    warnings.push(
      `Class "${className}" lives in nested jar "${match.entryName}" bundled by the shell jar; the lookup was redirected there automatically.`
    );
    return true;
  };

  let activeLookupClassName = await svc.resolveClassNameForLookup({
    className,
    version,
    sourceMapping: requestedMapping,
    targetMapping: activeMappingApplied,
    sourcePriority: input.sourcePriority,
    gradleUserHome: input.gradleUserHome,
    warnings,
    context: "source lookup"
  });
  let filePath = resolveClassFilePath(svc, activeArtifactId, activeLookupClassName);
  if (!filePath && (await tryNestedJarRedirect(activeLookupClassName))) {
    filePath = resolveClassFilePath(svc, activeArtifactId, activeLookupClassName);
  }
  if (!filePath && (await tryBinaryFallback())) {
    activeLookupClassName = await svc.resolveClassNameForLookup({
      className,
      version,
      sourceMapping: requestedMapping,
      targetMapping: activeMappingApplied,
      sourcePriority: input.sourcePriority,
      gradleUserHome: input.gradleUserHome,
      warnings,
      context: "source lookup"
    });
    filePath = resolveClassFilePath(svc, activeArtifactId, activeLookupClassName);
  }
  if (!filePath) {
    throw buildClassSourceNotFoundError(svc, {
      artifactId: activeArtifactId,
      requestedArtifactId: artifactId,
      className,
      lookupClassName: activeLookupClassName,
      // The REQUESTED artifact's namespace and quality, matching the artifactId this
      // error reports. The nested-jar redirect replaces the active values with the
      // inner jar's, which would otherwise describe an artifact the caller never named.
      mappingApplied,
      requestedMapping,
      qualityFlags,
      callerSuppliedMapping: input.mapping,
      nativeDependency: provenance?.dependencyResolution != null,
      attemptedBinaryFallback,
      targetKind: input.target?.kind,
      targetValue:
        input.target && "value" in input.target ? input.target.value : undefined,
      scope: input.scope,
      projectPath: input.projectPath,
      version,
      nestedJars: activeProvenance?.nestedJars
    });
  }

  let row = svc.filesRepo.getFileContent(activeArtifactId, filePath);
  if (!row && (await tryNestedJarRedirect(activeLookupClassName))) {
    const redirectedFilePath = resolveClassFilePath(svc, activeArtifactId, activeLookupClassName);
    if (redirectedFilePath) {
      filePath = redirectedFilePath;
      row = svc.filesRepo.getFileContent(activeArtifactId, filePath);
    }
  }
  if (!row && (await tryBinaryFallback())) {
    activeLookupClassName = await svc.resolveClassNameForLookup({
      className,
      version,
      sourceMapping: requestedMapping,
      targetMapping: activeMappingApplied,
      sourcePriority: input.sourcePriority,
      gradleUserHome: input.gradleUserHome,
      warnings,
      context: "source lookup"
    });
    filePath = resolveClassFilePath(svc, activeArtifactId, activeLookupClassName) ?? filePath;
    row = svc.filesRepo.getFileContent(activeArtifactId, filePath);
  }
  if (!row) {
    throw buildClassSourceNotFoundError(svc, {
      artifactId: activeArtifactId,
      requestedArtifactId: artifactId,
      className,
      lookupClassName: activeLookupClassName,
      // The REQUESTED artifact's namespace and quality, matching the artifactId this
      // error reports. The nested-jar redirect replaces the active values with the
      // inner jar's, which would otherwise describe an artifact the caller never named.
      mappingApplied,
      requestedMapping,
      qualityFlags,
      callerSuppliedMapping: input.mapping,
      nativeDependency: provenance?.dependencyResolution != null,
      attemptedBinaryFallback,
      filePath,
      targetKind: input.target?.kind,
      targetValue:
        input.target && "value" in input.target ? input.target.value : undefined,
      scope: input.scope,
      projectPath: input.projectPath,
      version,
      nestedJars: activeProvenance?.nestedJars
    });
  }

  const snippet = buildClassSourceSnippet({
    filePath,
    content: row.content,
    mode,
    startLine,
    endLine,
    maxLines,
    maxChars
  });
  let sourceText = snippet.sourceText;
  const totalLines = snippet.totalLines;
  const returnedStart = snippet.returnedStart;
  const returnedEnd = snippet.returnedEnd;
  const truncated = snippet.truncated;
  const charsTruncated = snippet.charsTruncated;

  let resolvedOutputFile: string | undefined;
  if (outputFile) {
    const outputPath = isAbsolute(outputFile)
      ? outputFile
      : resolvePath(outputFile);
    await writeFile(outputPath, sourceText, "utf8");
    resolvedOutputFile = outputPath;
    sourceText = `[Written to ${outputPath}]`;
  }

  const normalizedProvenance =
    activeProvenance ??
    buildFallbackProvenance(svc, {
      artifactId: activeArtifactId,
      origin: activeOrigin,
      requestedMapping,
      mappingApplied: activeMappingApplied
    });

  const nextStartLine = snippet.nextStartLine;
  // Continuation guidance: when output was truncated and was not redirected to
  // a file, hand the caller the next line to read plus a replayable call that
  // re-reads from the already-resolved artifact (no re-resolution needed).
  // nextStartLine is only set for snippet/full mode, so `mode` here is never
  // "metadata". The caller's original endLine window is preserved so the
  // continuation never reads past the requested range.
  const continuation =
    nextStartLine != null && !resolvedOutputFile
      ? buildSuggestedCall({
          tool: "get-class-source",
          params: {
            className,
            target: { kind: "artifact", artifactId: activeArtifactId },
            mode,
            startLine: nextStartLine,
            ...(input.endLine != null ? { endLine: input.endLine } : {}),
            ...(maxLines != null ? { maxLines } : {}),
            ...(input.maxChars != null ? { maxChars: input.maxChars } : {})
          }
        })
      : undefined;

  // Decompiled source text can use different method/accessor names than the jar
  // the workspace actually compiles against (e.g. `getGameRenderState()` in the
  // decompiled source vs `gameRenderState()` in the runtime jar). Flag it so
  // callers verify names against get-class-members (bytecode-derived) before
  // copying signatures out of this source.
  //
  // The gate is the persisted `isDecompiled` flag, never `origin === "decompiled"`:
  // origin records WHERE the bytes came from, derivation records WHETHER the text
  // was decompiled, and the two disagree. A Jar-in-Jar shell keeps the origin the
  // resolver chose while ingest clears its derivation flag (src/source/indexer.ts),
  // so an origin-keyed gate warned about decompiled signatures for a jar that holds
  // no source at all. file-access, search, artifact-resolver and the mapping
  // pipeline all read the boolean; do not "restore consistency" by keying this
  // back on the origin.
  if (activeIsDecompiled) {
    activeQualityFlags = dedupeQualityFlags([
      ...activeQualityFlags,
      "decompiled-source-signatures-unverified"
    ]);
    warnings.push(
      "Source is decompiled: method/accessor names may differ from the jar the workspace "
      + "compiles against. Confirm signatures with get-class-members (bytecode-derived) "
      + "before copying names from this source."
    );
  }

  return {
    className,
    mode,
    sourceText,
    totalLines,
    returnedRange: {
      start: returnedStart,
      end: returnedEnd
    },
    truncated,
    ...(charsTruncated ? { charsTruncated } : {}),
    ...(snippet.outOfRange ? { outOfRange: true } : {}),
    ...(nextStartLine != null ? { nextStartLine } : {}),
    origin: activeOrigin,
    artifactId: activeArtifactId,
    requestedMapping,
    mappingApplied: activeMappingApplied,
    returnedNamespace: activeMappingApplied,
    provenance: normalizedProvenance,
    qualityFlags: activeQualityFlags,
    artifactContents: svc.buildArtifactContentsSummary({
      origin: activeOrigin,
      sourceJarPath: activeSourceJarPath,
      isDecompiled: activeIsDecompiled,
      qualityFlags: activeQualityFlags
    }),
    ...(continuation?.suggestedCall ? { suggestedCall: continuation.suggestedCall } : {}),
    ...(resolvedOutputFile ? { outputFile: resolvedOutputFile } : {}),
    warnings
  };
}

export async function getClassMembers(svc: SourceService, input: GetClassMembersInput): Promise<GetClassMembersOutput> {
  const className = input.className.trim();
  if (!className) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "className must be non-empty."
    });
  }

  let requestedMapping: SourceMapping = normalizeMapping(input.mapping);

  const access = normalizeMemberAccess(input.access);
  const includeSynthetic = input.includeSynthetic ?? false;
  const includeInherited = input.includeInherited ?? false;
  const memberPattern = normalizeOptionalString(input.memberPattern);
  const parsedMaxMembers = normalizeStrictPositiveInt(input.maxMembers, "maxMembers");
  const maxMembers = parsedMaxMembers == null ? 150 : Math.min(parsedMaxMembers, 5000);

  const normalizedArtifactId = normalizeOptionalString(input.artifactId);
  if (normalizedArtifactId && input.target) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "artifactId and target are mutually exclusive.",
      details: { artifactId: normalizedArtifactId, target: input.target }
    });
  }

  let artifactId = normalizedArtifactId;
  let origin: ResolvedSourceArtifact["origin"] = "local-jar";
  // See getClassSource: derivation is the persisted flag, not the origin.
  let isDecompiled = false;
  let warnings: string[] = [];
  let mappingApplied: SourceMapping = requestedMapping;
  let provenance: ArtifactProvenance | undefined;
  let qualityFlags: string[] = [];
  let binaryJarPath: string | undefined;
  let sourceJarPath: string | undefined;
  let coordinate: string | undefined;

  if (parsedMaxMembers != null && parsedMaxMembers > 5000) {
    warnings.push(`maxMembers was clamped to 5000 from ${parsedMaxMembers}.`);
  }

  let version: string | undefined;

  if (!artifactId) {
    if (!input.target) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Either artifactId or target must be provided."
      });
    }

    const resolved = await svc.resolveArtifact({
      target: input.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      allowDecompile: input.allowDecompile,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    });
    artifactId = resolved.artifactId;
    origin = resolved.origin;
    isDecompiled = resolved.isDecompiled;
    warnings.push(...resolved.warnings);
    requestedMapping = resolved.requestedMapping;
    mappingApplied = resolved.mappingApplied;
    provenance = resolved.provenance;
    qualityFlags = [...resolved.qualityFlags];
    binaryJarPath = resolved.binaryJarPath;
    sourceJarPath = resolved.resolvedSourceJarPath;
    version = resolved.version;
    coordinate = resolved.coordinate;
  } else {
    const artifact = svc.getArtifact(artifactId);
    artifactId = artifact.artifactId;
    origin = artifact.origin;
    isDecompiled = artifact.isDecompiled;
    requestedMapping = inheritArtifactMapping(input.mapping, artifact);
    mappingApplied = artifact.mappingApplied ?? requestedMapping;
    provenance = artifact.provenance;
    qualityFlags = artifact.qualityFlags;
    binaryJarPath = artifact.binaryJarPath;
    sourceJarPath = artifact.sourceJarPath;
    version = artifact.version;
    coordinate = artifact.coordinate;
  }

  version = await artifactResolver.resolveVersionContext(svc, {
    version,
    provenance,
    coordinate,
    projectPath: input.projectPath,
    preferProjectVersion: input.preferProjectVersion,
    warnings
  });

  mappingApplied = reconcileUnobfuscatedNamespace(version, requestedMapping, mappingApplied);

  if (requestedMapping !== "obfuscated" && !version) {
    throw createError({
      code: ERROR_CODES.MAPPING_NOT_APPLIED,
      message: `Non-obfuscated mapping "${requestedMapping}" requires a version, but none was resolved.`,
      details: {
        mapping: requestedMapping,
        nextAction:
          "Resolve with target: { kind: \"version\", value: ... } or specify a versioned coordinate.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }

  if (!binaryJarPath) {
    // The override below applies only when the TOOL picked this artifact
    // without the caller expressing an opinion on it: a version/coordinate
    // target, or falling through the workspace/dependency shapes. A caller who
    // passed `artifactId` directly, or `target: { kind: "jar", ... }`, named
    // the exact artifact/jar themselves - having no binary companion is then
    // exactly the input they can change.
    const artifactWasCallerNamed = Boolean(normalizedArtifactId) || input.target?.kind === "jar";
    throw createError({
      code: ERROR_CODES.CONTEXT_UNRESOLVED,
      message: `Class members require a binary jar, but artifact "${artifactId}" has no binaryJarPath.`,
      details: {
        artifactId,
        className,
        // `ERR_CONTEXT_UNRESOLVED` classifies as `code_issue` by code, which is
        // right for the sibling case (a caller naming a version no artifact
        // carries) and wrong when the artifact was resolved by the TOOL, since
        // whether it carries a binary jar is not something that request could
        // express. Published as caller-fixable it invites an endless retry of
        // an input that was never at fault, so this site overrides the default
        // for the tool-resolved case only.
        issueOrigin: artifactWasCallerNamed ? undefined : "tool_issue",
        nextAction:
          "Resolve with target: { kind: \"jar\" | \"version\", value: ... } or use an artifact that has a binary jar."
      }
    });
  }

  const lookupClassName = await svc.resolveClassNameForLookup({
    className,
    version,
    sourceMapping: requestedMapping,
    targetMapping: mappingApplied,
    sourcePriority: input.sourcePriority,
    gradleUserHome: input.gradleUserHome,
    warnings,
    context: "binary lookup"
  });

  let signatureContext: ExplorerResponseContext;
  let signatureConstructors: SignatureMember[];
  let signatureFields: SignatureMember[];
  let signatureMethods: SignatureMember[];
  let binaryExtractionFailed = false;
  let binaryExtractionFailureReason: string | undefined;
  let nestedJarRedirect: { entryName: string; shellArtifactId: string } | undefined;
  // A dependency (Maven/Gradle) artifact is served from its real cache path, in
  // which no number is a Minecraft version: the path yields a cache-layout
  // constant or the dependency's own coordinate version, and `version` here is
  // likewise that coordinate version. Every minecraftVersion source available on
  // this path is therefore wrong for such an artifact, so all of them are gated
  // below and the response reports the "unknown" sentinel instead.
  const dependencyOrigin = provenance?.dependencyResolution != null;
  const fetchSignature = (jarPath: string) =>
    svc.explorerService.getSignature({
      fqn: lookupClassName,
      jarPath,
      access,
      includeSynthetic,
      includeInherited,
      memberPattern: requestedMapping === mappingApplied ? memberPattern : undefined,
      dependencyOrigin
    });
  try {
    let signature;
    try {
      signature = await fetchSignature(binaryJarPath);
    } catch (missError) {
      const inventory = provenance?.nestedJars;
      if (
        !isAppError(missError) ||
        missError.code !== ERROR_CODES.CLASS_NOT_FOUND ||
        !inventory ||
        inventory.length === 0
      ) {
        throw missError;
      }
      const match = await resolveUniqueNestedJarForClass({
        cacheDir: svc.config.cacheDir,
        outerJarPath: binaryJarPath,
        outerArtifactId: artifactId,
        inventory,
        className: lookupClassName
      });
      if (!match) {
        throw missError;
      }
      nestedJarRedirect = { entryName: match.entryName, shellArtifactId: artifactId };
      warnings.push(
        `Class "${className}" lives in nested jar "${match.entryName}" bundled by the shell jar; members were read from it.`
      );
      signature = await fetchSignature(match.extractedPath);
    }
    warnings.push(...signature.warnings);
    signatureContext = signature.context;
    // Member annotations are opt-in: strip them unless requested. The
    // annotationDefault of annotation-type members is always kept. Cached
    // signature objects must not be mutated, so stripping copies.
    const stripAnnotations = (member: SignatureMember): SignatureMember => {
      if (!member.annotations) {
        return member;
      }
      const { annotations: _omitted, ...rest } = member;
      return rest;
    };
    const includeAnnotations = input.includeAnnotations ?? false;
    signatureConstructors = includeAnnotations
      ? signature.constructors
      : signature.constructors.map(stripAnnotations);
    signatureFields = includeAnnotations ? signature.fields : signature.fields.map(stripAnnotations);
    signatureMethods = includeAnnotations ? signature.methods : signature.methods.map(stripAnnotations);
  } catch (error) {
    if (isAppError(error) && error.code === ERROR_CODES.NESTED_JAR_AMBIGUOUS) {
      // A class living in several nested jars needs the caller's choice; the
      // candidates error must not degrade into a members_unavailable response.
      throw error;
    }
    if (isAppError(error) && error.code === ERROR_CODES.CLASS_NOT_FOUND) {
      // Re-raise with the shared recovery shape (find-class/api-matrix
      // suggestedCall, namespace + scope hints) instead of the sparse bytecode
      // error, so members and source agree on CLASS_NOT_FOUND guidance.
      throw buildClassSourceNotFoundError(svc, {
        artifactId,
        className,
        lookupClassName,
        mappingApplied,
        requestedMapping,
        qualityFlags,
        callerSuppliedMapping: input.mapping,
        nativeDependency: provenance?.dependencyResolution != null,
        attemptedBinaryFallback: true,
        targetKind: input.target?.kind,
        targetValue:
          input.target && "value" in input.target ? input.target.value : undefined,
        scope: input.scope,
        projectPath: input.projectPath,
        version,
        nestedJars: provenance?.nestedJars
      });
    }
    binaryExtractionFailed = true;
    binaryExtractionFailureReason = error instanceof Error ? error.message : String(error);
    signatureContext = {
      minecraftVersion: dependencyOrigin ? "unknown" : version ?? "unknown",
      mappingType: "unknown",
      mappingNamespace: mappingApplied === "intermediary" ? "obfuscated" : mappingApplied,
      jarSignature: "",
      generatedAt: new Date().toISOString()
    };
    signatureConstructors = [];
    signatureFields = [];
    signatureMethods = [];
  }

  const remapped = await remapAndCountMembers(svc, {
    signatureConstructors,
    signatureFields,
    signatureMethods,
    version,
    mappingApplied,
    requestedMapping,
    sourcePriority: input.sourcePriority,
    gradleUserHome: input.gradleUserHome,
    memberPattern,
    warnings
  });
  const counts = remapped.counts;
  // Offset cursor over the flat [constructors, fields, methods] member sequence.
  // The context key ties a cursor to this exact query so a stale cursor restarts.
  const memberCursorContext = buildPageContextKey([
    artifactId,
    lookupClassName,
    requestedMapping,
    mappingApplied,
    access,
    includeSynthetic,
    includeInherited,
    memberPattern
  ]);
  const { offset: memberOffset, cursorIgnored: memberCursorIgnored } = resolveCursorOffset(
    input.cursor,
    memberCursorContext
  );
  const sliced = sliceMembersWithLimit(remapped, counts.total, maxMembers, warnings, memberOffset);
  const constructors = sliced.constructors;
  const fields = sliced.fields;
  const methods = sliced.methods;
  // Slim the wire member shape: hoist a shared ownerFqn, drop accessFlags, omit
  // isSynthetic:false, and drop FIELD jvmDescriptor unless includeDescriptors.
  // Internal SignatureMember arrays above stay intact.
  const projection = input.projection ?? "full";
  const projectedMembers = projectMembersByLevel(
    projectMembersForWire(
      { constructors, fields, methods },
      includeInherited,
      input.includeDescriptors ?? false
    ),
    projection
  );
  const truncated = sliced.truncated;
  const nextCursor =
    sliced.nextOffset != null ? encodeOffsetCursor(sliced.nextOffset, memberCursorContext) : undefined;

  const baseProvenance =
    provenance ??
    buildFallbackProvenance(svc, {
      artifactId,
      origin,
      requestedMapping,
      mappingApplied
    });
  const normalizedProvenance = nestedJarRedirect
    ? { ...baseProvenance, nestedJar: nestedJarRedirect }
    : baseProvenance;

  let decompiledFallback: DecompiledFallback | undefined;
  let decompiledMemberCounts: GetClassMembersOutput["decompiledMemberCounts"];
  let fallbackQualityFlags = qualityFlags;

  if (counts.total === 0) {
    const namespaceMismatch = requestedMapping !== mappingApplied;
    const fallbackPattern = namespaceMismatch ? undefined : memberPattern;
    const sourceFallback = buildDecompiledFallback(svc, artifactId, lookupClassName, fallbackPattern, maxMembers);
    if (sourceFallback) {
      decompiledFallback = projectDecompiledFallback(sourceFallback.fallback, projection);
      decompiledMemberCounts = sourceFallback.counts;
      fallbackQualityFlags = dedupeQualityFlags([
        ...qualityFlags,
        "members-from-decompiled-source"
      ]);
      const namespaceNote = namespaceMismatch
        ? ` Member names are in ${mappingApplied} (artifact namespace); the request asked for ${requestedMapping}.`
        : "";
      warnings.push(
        "Bytecode member enumeration returned zero; populated decompiledFallback from decompiled source. "
        + "Descriptors and access modifiers are unavailable — use get-class-source for full details."
        + namespaceNote
      );
      if (sourceFallback.truncated) {
        const returnedTotal =
          decompiledFallback.constructors.length
          + decompiledFallback.fields.length
          + decompiledFallback.methods.length;
        warnings.push(`Member list was truncated to ${returnedTotal} entries (from ${sourceFallback.counts.total}).`);
      }
      if (namespaceMismatch && memberPattern) {
        warnings.push(
          `memberPattern="${memberPattern}" was not applied to decompiledFallback because the artifact namespace (${mappingApplied}) differs from the requested namespace (${requestedMapping}); filter the response client-side after mapping.`
        );
      }
    }
  }

  let statusFields: Pick<GetClassMembersOutput, "status" | "unavailableReason" | "suggestedCall"> = {};
  if (!MEMBERS_STATUS_LEGACY) {
    let status: GetClassMembersStatus;
    let unavailableReason: string | undefined;
    let suggestedCall: GetClassMembersOutput["suggestedCall"];
    if (counts.total > 0) {
      status = "ok";
    } else if (decompiledFallback) {
      status = "partial";
    } else if (binaryExtractionFailed) {
      status = "members_unavailable";
      unavailableReason =
        binaryExtractionFailureReason
        ?? `binary extraction failed for "${className}".`;
      suggestedCall = buildSuggestedCall({
        tool: "get-class-source",
        params: {
          target: { kind: "artifact", artifactId },
          className,
          mode: "snippet",
          mapping: requestedMapping
        }
      }).suggestedCall;
    } else {
      status = "ok";
    }
    statusFields = {
      status,
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(suggestedCall ? { suggestedCall } : {})
    };
  }

  return {
    className,
    members: projectedMembers,
    counts,
    truncated,
    ...(nextCursor ? { nextCursor } : {}),
    ...(memberCursorIgnored ? { cursorIgnored: true } : {}),
    context: {
      ...signatureContext,
      // The jar-derived context describes the BYTECODE the reader opened. The
      // members handed back have already been remapped into requestedMapping,
      // so echoing the jar namespace here contradicted `returnedNamespace` in
      // the same payload. Report what the response actually contains, and fill
      // the version the resolver established when the jar path yielded none —
      // except for a dependency artifact, whose resolver-side `version` is its
      // own coordinate version, not Minecraft's. Filling it here would only
      // swap one wrong value for another.
      ...(signatureContext.minecraftVersion === "unknown" && version && !dependencyOrigin
        ? { minecraftVersion: version }
        : {}),
      mappingNamespace: requestedMapping
    },
    origin,
    artifactId,
    requestedMapping,
    mappingApplied,
    returnedNamespace: requestedMapping,
    provenance: normalizedProvenance,
    qualityFlags: fallbackQualityFlags,
    artifactContents: svc.buildArtifactContentsSummary({
      origin,
      sourceJarPath,
      isDecompiled,
      qualityFlags: fallbackQualityFlags
    }),
    ...(decompiledFallback ? { decompiledFallback } : {}),
    ...(decompiledMemberCounts ? { decompiledMemberCounts } : {}),
    ...statusFields,
    warnings
  };
}
