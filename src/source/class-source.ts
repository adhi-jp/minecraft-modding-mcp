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
import { collectDidYouMeanCandidates } from "./did-you-mean.js";
import { matchesMemberPattern } from "./member-pattern.js";
import { resolveUniqueNestedJarForClass } from "./nested-jars.js";
import { buildPageContextKey, encodeOffsetCursor, resolveCursorOffset } from "../page-cursor.js";
import { dedupeQualityFlags, normalizeMapping, normalizeOptionalString, normalizePathStyle } from "./shared-utils.js";
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

export function buildClassSourceNotFoundError(svc: SourceService, input: {
  className: string;
  lookupClassName: string;
  artifactId: string;
  mappingApplied: SourceMapping;
  requestedMapping: SourceMapping;
  qualityFlags: string[];
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
  const details: Record<string, unknown> = {
    artifactId: input.artifactId,
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
    didYouMean: collectDidYouMeanCandidates(svc, input.artifactId, input.className)
  };

  let nextAction = `Use find-class to resolve the correct fully-qualified name for "${simpleName}".`;
  let suggestionSpec: { tool: string; params: Record<string, unknown> } = {
    tool: "find-class",
    params: { className: simpleName, artifactId: input.artifactId }
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
        params: { className: simpleName, artifactId: input.artifactId }
      };
    }
  }

  if (input.mappingApplied === "obfuscated" && looksLikeDeobfuscatedClassName(input.className)) {
    nextAction += ` ${obfuscatedNamespaceHint(input.className)}`;
  }

  details.nextAction = nextAction;
  Object.assign(details, buildSuggestedCall(suggestionSpec));

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
    if (filteredMatches.length === 0 && partialVanillaLookup) {
      warnings.push(
        `Artifact source coverage is partial and excludes net.minecraft; returning non-vanilla matches for "${className}" would be misleading. Use get-class-source/get-class-members for binary fallback or get-class-api-matrix for mapped API inspection.`
      );
    }
    if (filteredMatches.length === 0 && artifact.mappingApplied === "obfuscated" && looksLikeDeobfuscatedClassName(className)) {
      warnings.push(`No exact class symbol matched "${className}". ${obfuscatedNamespaceHint(className)}`);
    }
    return { matches: filteredMatches, total: filteredMatches.length, warnings };
  }

  const result = svc.symbolsRepo.findScopedSymbols({
    artifactId,
    query: className,
    match: "exact",
    symbolKinds: TYPE_SYMBOL_KINDS,
    limit: limit * 5
  });
  const matches: FindClassMatch[] = [];
  for (const row of result.items) {
    if (matches.length >= limit) break;
    const isTypeSymbol = row.symbolKind === "class" || row.symbolKind === "interface" ||
      row.symbolKind === "enum" || row.symbolKind === "record";
    if (!isTypeSymbol) continue;
    matches.push({
      qualifiedName: row.qualifiedName ?? row.filePath.replace(/\.java$/, "").replaceAll("/", "."),
      filePath: row.filePath,
      line: row.line,
      symbolKind: row.symbolKind
    });
  }
  const partialVanillaLookup =
    hasPartialNetMinecraftCoverage(artifact.qualityFlags) && looksLikeDeobfuscatedClassName(className);
  const filteredMatches =
    partialVanillaLookup && matches.every((match) =>
      !match.qualifiedName.startsWith("net.minecraft.") && !match.qualifiedName.startsWith("com.mojang.")
    )
      ? []
      : matches;
  if (filteredMatches.length === 0 && partialVanillaLookup) {
    warnings.push(
      `Artifact source coverage is partial and excludes net.minecraft; returning non-vanilla matches for "${className}" would be misleading. Use get-class-source/get-class-members for binary fallback or get-class-api-matrix for mapped API inspection.`
    );
  }
  if (filteredMatches.length === 0 && artifact.mappingApplied === "obfuscated" && looksLikeDeobfuscatedClassName(className)) {
    warnings.push(`No exact class symbol matched "${className}". ${obfuscatedNamespaceHint(className)}`);
  }
  return { matches: filteredMatches, total: filteredMatches.length, warnings };
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
    requestedMapping = input.mapping != null ? requestedMapping : (artifact.requestedMapping ?? requestedMapping);
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
      qualityFlags: activeQualityFlags
    });
    if (!fallbackResolved || fallbackResolved.artifactId === activeArtifactId) {
      return false;
    }

    activeArtifactId = fallbackResolved.artifactId;
    activeOrigin = fallbackResolved.origin;
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
      className,
      lookupClassName: activeLookupClassName,
      mappingApplied: activeMappingApplied,
      requestedMapping,
      qualityFlags: activeQualityFlags,
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
      className,
      lookupClassName: activeLookupClassName,
      mappingApplied: activeMappingApplied,
      requestedMapping,
      qualityFlags: activeQualityFlags,
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
  if (activeOrigin === "decompiled") {
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
      isDecompiled: activeOrigin === "decompiled",
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
    throw createError({
      code: ERROR_CODES.CONTEXT_UNRESOLVED,
      message: `Class members require a binary jar, but artifact "${artifactId}" has no binaryJarPath.`,
      details: {
        artifactId,
        className,
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
  const fetchSignature = (jarPath: string) =>
    svc.explorerService.getSignature({
      fqn: lookupClassName,
      jarPath,
      access,
      includeSynthetic,
      includeInherited,
      memberPattern: requestedMapping === mappingApplied ? memberPattern : undefined
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
    signatureConstructors = signature.constructors;
    signatureFields = signature.fields;
    signatureMethods = signature.methods;
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
      minecraftVersion: version ?? "unknown",
      mappingType: "unknown",
      mappingNamespace: mappingApplied === "intermediary" ? "obfuscated" : mappingApplied,
      jarHash: "",
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
    context: signatureContext,
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
      isDecompiled: origin === "decompiled",
      qualityFlags: fallbackQualityFlags
    }),
    ...(decompiledFallback ? { decompiledFallback } : {}),
    ...(decompiledMemberCounts ? { decompiledMemberCounts } : {}),
    ...statusFields,
    warnings
  };
}
