import { buildSuggestedCall } from "../build-suggested-call.js";
import { mapWithConcurrencyLimit } from "../concurrency.js";
import { ERROR_CODES, createError, isAppError } from "../errors.js";
import type { SignatureMember, MinecraftExplorerService } from "../minecraft-explorer-service.js";
import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  DiffClassMemberDelta,
  DiffClassSignaturesInput,
  DiffClassSignaturesOutput,
  DiffMember,
  DiffMemberChange,
  TraceSymbolLifecycleInput,
  TraceSymbolLifecycleOutput,
  TraceSymbolLifecycleTimelineEntry
} from "../source-service.js";
import type { SourceService } from "../source-service.js";
import type { MappingSourcePriority, SourceMapping } from "../types.js";
import type { SymbolResolutionOutput as MappingSymbolResolutionOutput } from "../mapping-service.js";
import { rebuildJavaSignature, remapJvmDescriptor } from "./descriptor-utils.js";

const TRACE_LIFECYCLE_MAX_CONCURRENCY = 3;

type DiffClassChange = "added" | "removed" | "present_in_both" | "absent_in_both";
type DiffMemberChangedField = "accessFlags" | "isSynthetic" | "javaSignature" | "jvmDescriptor";

type LifecycleScanEntry = {
  version: string;
  exists: boolean;
  reason?: TraceSymbolLifecycleTimelineEntry["reason"];
  determinate: boolean;
};

type SignatureSnapshot = {
  constructors: SignatureMember[];
  fields: SignatureMember[];
  methods: SignatureMember[];
  warnings: string[];
};

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit == null) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

function normalizeMapping(mapping: SourceMapping | undefined): SourceMapping {
  if (mapping == null) {
    return "obfuscated";
  }
  if (
    mapping === "obfuscated" ||
    mapping === "mojang" ||
    mapping === "intermediary" ||
    mapping === "yarn"
  ) {
    return mapping;
  }
  throw createError({
    code: ERROR_CODES.MAPPING_UNAVAILABLE,
    message: `Unsupported mapping "${mapping}".`,
    details: {
      mapping,
      nextAction: "Try mapping=obfuscated which is always available.",
      ...buildSuggestedCall({ tool: "resolve-artifact", params: { mapping: "obfuscated" } })
    }
  });
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function looksLikeClassSegment(name: string): boolean {
  const trimmed = name.trim();
  return /^[A-Z_$]/.test(trimmed);
}

function looksLikeJvmMethodDescriptor(descriptor: string | undefined): boolean {
  const trimmed = descriptor?.trim();
  if (!trimmed || !trimmed.startsWith("(")) {
    return false;
  }
  const closing = trimmed.indexOf(")");
  return closing > 0 && closing < trimmed.length - 1;
}

function parseQualifiedMethodSymbol(symbol: string): {
  className: string;
  methodName: string;
  inlineDescriptor?: string;
} {
  const trimmed = symbol.trim();
  const descriptorStart = trimmed.indexOf("(");
  const qualifiedSymbol = descriptorStart >= 0 ? trimmed.slice(0, descriptorStart) : trimmed;
  const inlineDescriptor = descriptorStart >= 0 ? trimmed.slice(descriptorStart).trim() : undefined;
  const separator = qualifiedSymbol.lastIndexOf(".");
  if (separator <= 0 || separator >= qualifiedSymbol.length - 1) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `symbol must be in the form "fully.qualified.Class.method".`,
      details: { symbol }
    });
  }

  const className = qualifiedSymbol.slice(0, separator);
  const methodName = qualifiedSymbol.slice(separator + 1);
  if (
    !className ||
    !methodName ||
    className.includes("/") ||
    methodName.includes(".") ||
    /\s/.test(methodName)
  ) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `symbol must be in the form "fully.qualified.Class.method".`,
      details: { symbol }
    });
  }

  return {
    className,
    methodName,
    ...(inlineDescriptor ? { inlineDescriptor } : {})
  };
}

function sortDiffMembers(members: DiffMember[]): DiffMember[] {
  return [...members].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    const descriptorCompare = left.jvmDescriptor.localeCompare(right.jvmDescriptor);
    if (descriptorCompare !== 0) {
      return descriptorCompare;
    }

    return left.ownerFqn.localeCompare(right.ownerFqn);
  });
}

function sortDiffMemberChanges(changes: DiffMemberChange[]): DiffMemberChange[] {
  return [...changes].sort((left, right) => {
    const keyCompare = left.key.localeCompare(right.key);
    if (keyCompare !== 0) {
      return keyCompare;
    }

    const fromOwnerCompare = (left.from?.ownerFqn ?? "").localeCompare(right.from?.ownerFqn ?? "");
    if (fromOwnerCompare !== 0) {
      return fromOwnerCompare;
    }

    return (left.to?.ownerFqn ?? "").localeCompare(right.to?.ownerFqn ?? "");
  });
}

function changedMemberFields(
  fromMember: DiffMember,
  toMember: DiffMember,
  includeDescriptor: boolean
): DiffMemberChangedField[] {
  const changed: DiffMemberChangedField[] = [];

  if (fromMember.accessFlags !== toMember.accessFlags) {
    changed.push("accessFlags");
  }
  if (fromMember.isSynthetic !== toMember.isSynthetic) {
    changed.push("isSynthetic");
  }
  if (fromMember.javaSignature !== toMember.javaSignature) {
    changed.push("javaSignature");
  }
  if (includeDescriptor && fromMember.jvmDescriptor !== toMember.jvmDescriptor) {
    changed.push("jvmDescriptor");
  }

  return changed;
}

function diffMembersByKey(
  fromMembersInput: DiffMember[],
  toMembersInput: DiffMember[],
  buildKey: (member: DiffMember) => string,
  includeDescriptorInModified: boolean
): DiffClassMemberDelta {
  const fromMembers = sortDiffMembers(fromMembersInput);
  const toMembers = sortDiffMembers(toMembersInput);
  const fromByKey = new Map<string, DiffMember>();
  const toByKey = new Map<string, DiffMember>();

  for (const member of fromMembers) {
    const key = buildKey(member);
    if (!fromByKey.has(key)) {
      fromByKey.set(key, member);
    }
  }
  for (const member of toMembers) {
    const key = buildKey(member);
    if (!toByKey.has(key)) {
      toByKey.set(key, member);
    }
  }

  const added: DiffMember[] = [];
  const removed: DiffMember[] = [];
  const modified: DiffMemberChange[] = [];

  for (const [key, toMember] of toByKey.entries()) {
    const fromMember = fromByKey.get(key);
    if (!fromMember) {
      added.push(toMember);
      continue;
    }

    const changed = changedMemberFields(fromMember, toMember, includeDescriptorInModified);
    if (changed.length > 0) {
      modified.push({
        key,
        from: fromMember,
        to: toMember,
        changed
      });
    }
  }

  for (const [key, fromMember] of fromByKey.entries()) {
    if (!toByKey.has(key)) {
      removed.push(fromMember);
    }
  }

  return {
    added: sortDiffMembers(added),
    removed: sortDiffMembers(removed),
    modified: sortDiffMemberChanges(modified)
  };
}

function emptyDiffDelta(): DiffClassMemberDelta {
  return {
    added: [],
    removed: [],
    modified: []
  };
}

function compactDiffDelta(delta: DiffClassMemberDelta): DiffClassMemberDelta {
  return {
    added: delta.added,
    removed: delta.removed,
    modified: delta.modified.map((change) => ({
      key: change.key,
      changed: [...change.changed]
    }))
  };
}

export async function checkSymbolExistsInUnobfuscatedRuntime(
  svc: SourceService,
  input: CheckSymbolExistsInput,
  fallbackBase: CheckSymbolExistsOutput
): Promise<CheckSymbolExistsOutput | undefined> {
  const version = input.version.trim();
  const name = input.name.trim();
  const owner = input.owner?.trim();
  if (!version || !name) {
    return undefined;
  }

  if (input.kind === "class" && input.nameMode !== "fqcn" && !name.includes(".")) {
    return {
      ...fallbackBase,
      warnings: [
        ...fallbackBase.warnings,
        `Version ${version} is unobfuscated, but short class name "${name}" could not be checked against runtime bytecode without a fully-qualified name.`
      ]
    };
  }

  const querySymbol: MappingSymbolResolutionOutput["querySymbol"] =
    input.kind === "class"
      ? {
          kind: "class",
          name,
          symbol: name
        }
      : input.kind === "field"
        ? {
            kind: "field",
            owner,
            name,
            symbol: `${owner}.${name}`
          }
        : {
            kind: "method",
            owner,
            name,
            descriptor: input.descriptor?.trim(),
            symbol: `${owner}.${name}${input.descriptor?.trim() ?? ""}`
          };

  const targetClass = input.kind === "class" ? name : owner;
  if (!targetClass) {
    return fallbackBase;
  }

  let jarPath: string;
  try {
    ({ jarPath } = await svc.versionService.resolveVersionJar(version));
  } catch {
    return undefined;
  }

  let signature: Awaited<ReturnType<MinecraftExplorerService["getSignature"]>>;
  try {
    signature = await svc.explorerService.getSignature({
      fqn: targetClass,
      jarPath,
      access: "all"
    });
  } catch {
    return {
      ...fallbackBase,
      querySymbol,
      warnings: [
        ...fallbackBase.warnings,
        `Version ${version} is unobfuscated; runtime bytecode lookup could not load class "${targetClass}".`
      ]
    };
  }

  const warnings = [
    ...fallbackBase.warnings,
    ...signature.warnings,
    `Version ${version} is unobfuscated; validated symbol existence against runtime bytecode.`
  ];

  const buildResolved = (
    resolvedSymbol: MappingSymbolResolutionOutput["resolvedSymbol"]
  ): CheckSymbolExistsOutput => ({
    ...fallbackBase,
    querySymbol,
    resolved: true,
    status: "resolved",
    resolvedSymbol,
    candidates: resolvedSymbol
      ? [{
          ...resolvedSymbol,
          matchKind: "exact",
          confidence: 1
        }]
      : [],
    candidateCount: resolvedSymbol ? 1 : 0,
    warnings
  });

  const buildUnresolved = (status: CheckSymbolExistsOutput["status"]): CheckSymbolExistsOutput => ({
    ...fallbackBase,
    querySymbol,
    resolved: false,
    status,
    resolvedSymbol: undefined,
    candidates: [],
    candidateCount: 0,
    warnings
  });

  if (input.kind === "class") {
    return buildResolved({
      kind: "class",
      name,
      symbol: name
    });
  }

  if (input.kind === "field") {
    const matched = signature.fields.filter((field) => field.name === name);
    if (matched.length !== 1) {
      return buildUnresolved(matched.length > 1 ? "ambiguous" : "not_found");
    }
    return buildResolved({
      kind: "field",
      owner,
      name,
      symbol: `${owner}.${name}`
    });
  }

  const methodCandidates = signature.methods.filter((method) => method.name === name);
  if (input.signatureMode === "name-only") {
    if (methodCandidates.length !== 1) {
      return buildUnresolved(methodCandidates.length > 1 ? "ambiguous" : "not_found");
    }
    return buildResolved({
      kind: "method",
      owner,
      name,
      descriptor: methodCandidates[0]?.jvmDescriptor,
      symbol: `${owner}.${name}${methodCandidates[0]?.jvmDescriptor ?? ""}`
    });
  }

  const descriptor = input.descriptor?.trim();
  const matched = methodCandidates.filter((method) => method.jvmDescriptor === descriptor);
  if (matched.length !== 1) {
    return buildUnresolved(matched.length > 1 ? "ambiguous" : "not_found");
  }
  return buildResolved({
    kind: "method",
    owner,
    name,
    descriptor,
    symbol: `${owner}.${name}${descriptor ?? ""}`
  });
}

export async function traceSymbolLifecycle(svc: SourceService, input: TraceSymbolLifecycleInput): Promise<TraceSymbolLifecycleOutput> {
  const mapping = normalizeMapping(input.mapping);

  const {
    className: userClassName,
    methodName: userMethodName,
    inlineDescriptor
  } = parseQualifiedMethodSymbol(input.symbol);
  const descriptor = normalizeOptionalString(input.descriptor)
    ?? (looksLikeJvmMethodDescriptor(inlineDescriptor) ? normalizeOptionalString(inlineDescriptor) : undefined);
  const includeTimeline = input.includeTimeline ?? false;
  const includeSnapshots = input.includeSnapshots ?? false;
  const maxVersions = clampLimit(input.maxVersions, 120, 400);

  const manifestOrder = await svc.versionService.listVersionIds({ includeSnapshots });
  if (manifestOrder.length === 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: "No Minecraft versions were returned by manifest.",
      details: {
        includeSnapshots,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }

  const chronological = [...manifestOrder].reverse();
  const requestedFrom = normalizeOptionalString(input.fromVersion) ?? chronological[0];
  const requestedTo = normalizeOptionalString(input.toVersion) ?? chronological[chronological.length - 1];
  const fromIndex = chronological.indexOf(requestedFrom);
  const toIndex = chronological.indexOf(requestedTo);

  if (fromIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `fromVersion "${requestedFrom}" was not found in manifest.`,
      details: {
        fromVersion: requestedFrom,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (toIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `toVersion "${requestedTo}" was not found in manifest.`,
      details: {
        toVersion: requestedTo,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (fromIndex > toIndex) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "fromVersion must be older than or equal to toVersion.",
      details: { fromVersion: requestedFrom, toVersion: requestedTo }
    });
  }

  let selectedVersions = chronological.slice(fromIndex, toIndex + 1);
  const warnings: string[] = [];
  if (selectedVersions.length > maxVersions) {
    selectedVersions = selectedVersions.slice(selectedVersions.length - maxVersions);
    warnings.push(
      `Version scan truncated to ${maxVersions} entries. Effective fromVersion is now "${selectedVersions[0]}".`
    );
  }

  const referenceVersion = selectedVersions[selectedVersions.length - 1];
  rejectLifecycleClassLikeInput(svc, {
    symbol: input.symbol,
    className: userClassName,
    methodName: userMethodName,
    mapping,
    version: referenceVersion,
    sourcePriority: input.sourcePriority
  });

  const scannedResults = await mapWithConcurrencyLimit(
    selectedVersions,
    TRACE_LIFECYCLE_MAX_CONCURRENCY,
    async (version) => {
      const versionWarnings: string[] = [];

      try {
        const [obfuscatedClassName, obfuscatedMethod, resolvedJar] = await Promise.all([
          resolveToObfuscatedClassName(
            svc,
            userClassName,
            version,
            mapping,
            input.sourcePriority,
            versionWarnings
          ),
          resolveToObfuscatedMemberName(
            svc,
            userMethodName,
            userClassName,
            descriptor,
            "method",
            version,
            mapping,
            input.sourcePriority,
            versionWarnings
          ),
          svc.versionService.resolveVersionJar(version)
        ]);

        const signature = await svc.explorerService.getSignature({
          fqn: obfuscatedClassName,
          jarPath: resolvedJar.jarPath,
          access: "all",
          includeSynthetic: true
        });
        const sameNameMethods = signature.methods.filter((method) => method.name === obfuscatedMethod.name);
        const effectiveDescriptor = obfuscatedMethod.descriptor ?? descriptor;
        const matchesDescriptor = effectiveDescriptor
          ? sameNameMethods.some((method) => method.jvmDescriptor === effectiveDescriptor)
          : sameNameMethods.length > 0;
        const reason =
          !matchesDescriptor && descriptor && sameNameMethods.length > 0 ? "descriptor-mismatch" : undefined;

        return {
          entry: {
            version,
            exists: matchesDescriptor,
            reason,
            determinate: true
          } satisfies LifecycleScanEntry,
          warnings: versionWarnings
        };
      } catch (caughtError) {
        if (isAppError(caughtError) && caughtError.code === ERROR_CODES.CLASS_NOT_FOUND) {
          return {
            entry: {
              version,
              exists: false,
              reason: "class-not-found",
              determinate: true
            } satisfies LifecycleScanEntry,
            warnings: versionWarnings
          };
        }

        versionWarnings.push(
          `Failed to evaluate ${version}: ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`
        );
        return {
          entry: {
            version,
            exists: false,
            reason: "unresolved",
            determinate: false
          } satisfies LifecycleScanEntry,
          warnings: versionWarnings
        };
      } finally {
        releaseLifecycleMappingGraph(svc, version, input.sourcePriority);
      }
    }
  );

  const scanned = scannedResults.map((result) => result.entry);
  for (const result of scannedResults) {
    warnings.push(...result.warnings);
  }

  const determinate = scanned.filter((entry) => entry.determinate);
  const present = determinate.filter((entry) => entry.exists);
  const firstSeen = present[0]?.version;
  const lastSeen = present[present.length - 1]?.version;
  const missingBetween: string[] = [];

  if (firstSeen && lastSeen) {
    const firstSeenIndex = determinate.findIndex((entry) => entry.version === firstSeen);
    const lastSeenIndex = determinate.findIndex((entry) => entry.version === lastSeen);
    for (let index = firstSeenIndex; index <= lastSeenIndex; index += 1) {
      const entry = determinate[index];
      if (entry && !entry.exists) {
        missingBetween.push(entry.version);
      }
    }
  }

  const toVersionEntry = scanned.find((entry) => entry.version === selectedVersions[selectedVersions.length - 1]);
  const existsNow = toVersionEntry?.determinate ? toVersionEntry.exists : false;
  if (toVersionEntry && !toVersionEntry.determinate) {
    warnings.push(`Latest requested version "${toVersionEntry.version}" could not be evaluated.`);
  }

  return {
    query: {
      className: userClassName,
      methodName: userMethodName,
      descriptor,
      mapping
    },
    range: {
      fromVersion: selectedVersions[0],
      toVersion: selectedVersions[selectedVersions.length - 1],
      scannedCount: selectedVersions.length
    },
    presence: {
      firstSeen,
      lastSeen,
      missingBetween,
      existsNow
    },
    timeline: includeTimeline
      ? scanned.map((entry) => ({
          version: entry.version,
          exists: entry.exists,
          reason: entry.reason
        }))
      : undefined,
    warnings
  };
}

export async function diffClassSignatures(svc: SourceService, input: DiffClassSignaturesInput): Promise<DiffClassSignaturesOutput> {
  const className = input.className.trim();
  const fromVersion = input.fromVersion.trim();
  const toVersion = input.toVersion.trim();
  const includeFullDiff = input.includeFullDiff ?? true;
  if (!className || !fromVersion || !toVersion) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "className, fromVersion, and toVersion must be non-empty strings.",
      details: {
        className: input.className,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion
      }
    });
  }

  const mapping = normalizeMapping(input.mapping);

  const manifestOrder = await svc.versionService.listVersionIds();
  if (manifestOrder.length === 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: "No Minecraft versions were returned by manifest.",
      details: {
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }

  const chronological = [...manifestOrder].reverse();
  const fromIndex = chronological.indexOf(fromVersion);
  const toIndex = chronological.indexOf(toVersion);

  if (fromIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `fromVersion "${fromVersion}" was not found in manifest.`,
      details: {
        fromVersion,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (toIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `toVersion "${toVersion}" was not found in manifest.`,
      details: {
        toVersion,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (fromIndex > toIndex) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "fromVersion must be older than or equal to toVersion.",
      details: { fromVersion, toVersion }
    });
  }

  const mappingWarnings: string[] = [];
  const obfuscatedFromClassName = await resolveToObfuscatedClassName(
    svc,
    className,
    fromVersion,
    mapping,
    input.sourcePriority,
    mappingWarnings
  );
  const obfuscatedToClassName =
    fromVersion === toVersion
      ? obfuscatedFromClassName
      : await resolveToObfuscatedClassName(
          svc,
          className,
          toVersion,
          mapping,
          input.sourcePriority,
          mappingWarnings
        );

  const [fromResolved, toResolved] = await Promise.all([
    svc.versionService.resolveVersionJar(fromVersion),
    svc.versionService.resolveVersionJar(toVersion)
  ]);

  const loadSignature = async (
    version: string,
    jarPath: string,
    obfuscatedClassName: string
  ): Promise<SignatureSnapshot | undefined> => {
    try {
      const signature = await svc.explorerService.getSignature({
        fqn: obfuscatedClassName,
        jarPath,
        access: "all",
        includeSynthetic: false,
        includeInherited: false
      });
      return {
        constructors: signature.constructors,
        fields: signature.fields,
        methods: signature.methods,
        warnings: signature.warnings
      };
    } catch (caughtError) {
      if (isAppError(caughtError) && caughtError.code === ERROR_CODES.CLASS_NOT_FOUND) {
        return undefined;
      }
      throw caughtError;
    }
  };

  const [fromSignature, toSignature] = await Promise.all([
    loadSignature(fromVersion, fromResolved.jarPath, obfuscatedFromClassName),
    loadSignature(toVersion, toResolved.jarPath, obfuscatedToClassName)
  ]);

  const warnings: string[] = [...mappingWarnings];
  if (fromSignature) {
    warnings.push(...fromSignature.warnings.map((warning) => `[${fromVersion}] ${warning}`));
  }
  if (toSignature) {
    warnings.push(...toSignature.warnings.map((warning) => `[${toVersion}] ${warning}`));
  }

  let classChange: DiffClassChange = "present_in_both";
  if (!fromSignature && !toSignature) {
    classChange = "absent_in_both";
    warnings.push(`Class "${className}" was not found in both versions.`);
  } else if (!fromSignature) {
    classChange = "added";
  } else if (!toSignature) {
    classChange = "removed";
  }

  const fromMembers = fromSignature ?? {
    constructors: [],
    fields: [],
    methods: [],
    warnings: []
  };
  const toMembers = toSignature ?? {
    constructors: [],
    fields: [],
    methods: [],
    warnings: []
  };

  const constructors =
    classChange === "added"
      ? {
          added: sortDiffMembers(toMembers.constructors),
          removed: [],
          modified: []
        }
      : classChange === "removed"
        ? {
            added: [],
            removed: sortDiffMembers(fromMembers.constructors),
            modified: []
          }
        : classChange === "absent_in_both"
          ? emptyDiffDelta()
          : diffMembersByKey(fromMembers.constructors, toMembers.constructors, (member) => member.jvmDescriptor, false);

  const methods =
    classChange === "added"
      ? {
          added: sortDiffMembers(toMembers.methods),
          removed: [],
          modified: []
        }
      : classChange === "removed"
        ? {
            added: [],
            removed: sortDiffMembers(fromMembers.methods),
            modified: []
          }
        : classChange === "absent_in_both"
          ? emptyDiffDelta()
          : diffMembersByKey(
              fromMembers.methods,
              toMembers.methods,
              (member) => `${member.name}#${member.jvmDescriptor}`,
              false
            );

  const fields =
    classChange === "added"
      ? {
          added: sortDiffMembers(toMembers.fields),
          removed: [],
          modified: []
        }
      : classChange === "removed"
        ? {
            added: [],
            removed: sortDiffMembers(fromMembers.fields),
            modified: []
          }
        : classChange === "absent_in_both"
          ? emptyDiffDelta()
          : diffMembersByKey(fromMembers.fields, toMembers.fields, (member) => member.name, true);

  // Remap diff delta members for non-obfuscated mappings
  const remapDelta = async (
    delta: DiffClassMemberDelta,
    kind: "field" | "method"
  ): Promise<DiffClassMemberDelta> => {
    const [addedResult, removedResult] = await Promise.all([
      svc.remapSignatureMembers(delta.added, kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings),
      svc.remapSignatureMembers(delta.removed, kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings)
    ]);
    const remappedModified = await Promise.all(
      delta.modified.map(async (change) => {
        if (!change.from || !change.to) {
          throw createError({
            code: ERROR_CODES.INTERNAL,
            message: "Modified diff members are missing before remap.",
            details: {
              key: change.key,
              kind,
              fromVersion,
              toVersion,
              mapping
            }
          });
        }
        const [fromResult, toResult] = await Promise.all([
          svc.remapSignatureMembers([change.from], kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings),
          svc.remapSignatureMembers([change.to], kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings)
        ]);
        const fromMember = fromResult.members[0];
        const toMember = toResult.members[0];
        if (!fromMember || !toMember) {
          throw createError({
            code: ERROR_CODES.INTERNAL,
            message: "Failed to remap modified diff members.",
            details: {
              key: change.key,
              kind,
              fromVersion,
              toVersion,
              mapping
            }
          });
        }
        return { ...change, from: fromMember, to: toMember };
      })
    );
    return { added: addedResult.members, removed: removedResult.members, modified: remappedModified };
  };

  const [remappedConstructors, remappedMethods, remappedFields] = await Promise.all([
    remapDelta(constructors, "method"),
    remapDelta(methods, "method"),
    remapDelta(fields, "field")
  ]);

  const summary = {
    constructors: {
      added: remappedConstructors.added.length,
      removed: remappedConstructors.removed.length,
      modified: remappedConstructors.modified.length
    },
    methods: {
      added: remappedMethods.added.length,
      removed: remappedMethods.removed.length,
      modified: remappedMethods.modified.length
    },
    fields: {
      added: remappedFields.added.length,
      removed: remappedFields.removed.length,
      modified: remappedFields.modified.length
    },
    total: {
      added: remappedConstructors.added.length + remappedMethods.added.length + remappedFields.added.length,
      removed: remappedConstructors.removed.length + remappedMethods.removed.length + remappedFields.removed.length,
      modified: remappedConstructors.modified.length + remappedMethods.modified.length + remappedFields.modified.length
    }
  };

  return {
    query: {
      className,
      fromVersion,
      toVersion,
      mapping
    },
    range: {
      fromVersion,
      toVersion
    },
    classChange,
    constructors: includeFullDiff ? remappedConstructors : compactDiffDelta(remappedConstructors),
    methods: includeFullDiff ? remappedMethods : compactDiffDelta(remappedMethods),
    fields: includeFullDiff ? remappedFields : compactDiffDelta(remappedFields),
    summary,
    warnings
  };
}

export function rejectLifecycleClassLikeInput(svc: SourceService, input: {
  symbol: string;
  className: string;
  methodName: string;
  mapping: SourceMapping;
  version?: string;
  sourcePriority?: MappingSourcePriority;
}): void {
  void svc;
  if (!looksLikeClassSegment(input.methodName)) {
    return;
  }

  const classLikeSymbol = `${input.className}.${input.methodName}`;
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: `symbol must be in the form "fully.qualified.Class.method".`,
    details: {
      symbol: input.symbol,
      classLikeSymbol,
      nextAction: "Pass lifecycle input as Class.method and use the separate descriptor field for exact overload matching.",
      ...(input.version
        ? buildSuggestedCall({
            tool: "check-symbol-exists",
            params: {
              version: input.version,
              kind: "class",
              name: classLikeSymbol,
              sourceMapping: input.mapping
            }
          })
        : {})
    }
  });
}

export function releaseLifecycleMappingGraph(svc: SourceService, version: string, sourcePriority: MappingSourcePriority | undefined): void {
  if (
    "releaseGraphCacheEntry" in svc.mappingService &&
    typeof svc.mappingService.releaseGraphCacheEntry === "function"
  ) {
    svc.mappingService.releaseGraphCacheEntry(version, sourcePriority);
  }
}

export async function resolveToObfuscatedClassName(
  svc: SourceService,
  className: string,
  version: string,
  mapping: SourceMapping,
  sourcePriority: MappingSourcePriority | undefined,
  warnings: string[]
): Promise<string> {
  return svc.resolveClassNameForLookup({
    className,
    version,
    sourceMapping: mapping,
    targetMapping: "obfuscated",
    sourcePriority,
    warnings,
    context: "bytecode lookup"
  });
}

export async function resolveToObfuscatedMemberName(
  svc: SourceService,
  name: string,
  ownerInSourceMapping: string,
  descriptor: string | undefined,
  kind: "field" | "method",
  version: string,
  mapping: SourceMapping,
  sourcePriority: MappingSourcePriority | undefined,
  warnings: string[]
): Promise<{ name: string; descriptor?: string }> {
  if (mapping === "obfuscated") {
    return {
      name,
      descriptor: kind === "method" ? descriptor : undefined
    };
  }
  try {
    const canResolveMethodExactly =
      kind === "method" &&
      descriptor &&
      "resolveMethodMappingExact" in svc.mappingService &&
      typeof svc.mappingService.resolveMethodMappingExact === "function";
    const mapped = canResolveMethodExactly
      ? await svc.mappingService.resolveMethodMappingExact({
          version,
          owner: ownerInSourceMapping,
          name,
          descriptor,
          sourceMapping: mapping,
          targetMapping: "obfuscated",
          sourcePriority
        })
      : await svc.mappingService.findMapping({
          version,
          kind,
          name,
          owner: ownerInSourceMapping,
          descriptor,
          // When we do have a descriptor this path is an exact lookup (the resolveMethodMappingExact
          // fast path is chosen instead whenever possible). findMapping's service-layer default is
          // "name-only" to match the public tool schema, so we must opt in to strict semantics here
          // to preserve the descriptor-aware overload selection this caller relies on.
          signatureMode:
            kind === "method"
              ? descriptor
                ? "exact"
                : "name-only"
              : undefined,
          sourceMapping: mapping,
          targetMapping: "obfuscated",
          sourcePriority
        });
    warnings.push(...mapped.warnings);
    if (mapped.resolved && mapped.resolvedSymbol) {
      return {
        name: mapped.resolvedSymbol.name,
        descriptor: kind === "method" ? mapped.resolvedSymbol.descriptor ?? descriptor : undefined
      };
    }
    if (canResolveMethodExactly && (mapped.status === "not_found" || mapped.status === "mapping_unavailable")) {
      const fallbackMapped = await svc.mappingService.findMapping({
        version,
        kind,
        name,
        owner: ownerInSourceMapping,
        descriptor,
        signatureMode: "exact",
        sourceMapping: mapping,
        targetMapping: "obfuscated",
        sourcePriority
      });
      warnings.push(...fallbackMapped.warnings);
      if (fallbackMapped.resolved && fallbackMapped.resolvedSymbol) {
        return {
          name: fallbackMapped.resolvedSymbol.name,
          descriptor: kind === "method" ? fallbackMapped.resolvedSymbol.descriptor ?? descriptor : undefined
        };
      }
    }
    warnings.push(`Could not map ${kind} "${name}" from ${mapping} to obfuscated.`);
  } catch (caughtError) {
    warnings.push(
      `Mapping lookup failed for ${kind} "${name}": ${caughtError instanceof Error ? caughtError.message : String(caughtError)}`
    );
  }
  return {
    name,
    descriptor: kind === "method" ? descriptor : undefined
  };
}

export async function remapSignatureMembers(
  svc: SourceService,
  members: SignatureMember[],
  kind: "field" | "method",
  version: string,
  sourceMapping: SourceMapping,
  targetMapping: SourceMapping,
  sourcePriority: MappingSourcePriority | undefined,
  warnings: string[],
  projectPath?: string
): Promise<{ members: SignatureMember[]; failedNames: Set<string> }> {
  const failedNames = new Set<string>();
  if (sourceMapping === targetMapping) {
    return { members, failedNames };
  }

  const memberKeyToRemapped = new Map<string, string>();
  const memberDescriptorRemapped = new Map<string, string>();
  const ownerToRemapped = new Map<string, string>();

  for (const member of members) {
    const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
    if (!memberKeyToRemapped.has(memberKey)) {
      memberKeyToRemapped.set(memberKey, member.name);
    }
    if (!ownerToRemapped.has(member.ownerFqn)) {
      ownerToRemapped.set(member.ownerFqn, member.ownerFqn);
    }
  }

  const ownerEntries = [...ownerToRemapped.entries()];
  await Promise.all(
    ownerEntries.map(async ([obfuscatedFqn]) => {
      try {
        const mapped = await svc.mappingService.findMapping({
          version,
          kind: "class",
          name: obfuscatedFqn,
          sourceMapping,
          targetMapping,
          sourcePriority,
          projectPath
        });
        if (mapped.resolved && mapped.resolvedSymbol) {
          ownerToRemapped.set(obfuscatedFqn, mapped.resolvedSymbol.name);
        }
      } catch {
        // keep source FQN as fallback
      }
    })
  );

  const descriptorClassRefs = new Set<string>();
  for (const member of members) {
    for (const match of member.jvmDescriptor.matchAll(/L([^;]+);/g)) {
      const dotFqn = match[1]!.replace(/\//g, ".");
      if (!ownerToRemapped.has(dotFqn)) {
        descriptorClassRefs.add(dotFqn);
      }
    }
  }
  if (descriptorClassRefs.size > 0) {
    const refs = [...descriptorClassRefs];
    for (const ref of refs) {
      ownerToRemapped.set(ref, ref);
    }
    await Promise.all(
      refs.map(async (dotFqn) => {
        try {
          const mapped = await svc.mappingService.findMapping({
            version,
            kind: "class",
            name: dotFqn,
            sourceMapping,
            targetMapping,
            sourcePriority,
            projectPath
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            ownerToRemapped.set(dotFqn, mapped.resolvedSymbol.name);
          }
        } catch {
          // keep source name as fallback
        }
      })
    );
  }

  const classMap = new Map<string, string>();
  for (const [src, tgt] of ownerToRemapped) {
    if (src !== tgt) {
      classMap.set(src, tgt);
    }
  }

  const canResolveMethodExactly =
    kind === "method" &&
    "resolveMethodMappingExact" in svc.mappingService &&
    typeof svc.mappingService.resolveMethodMappingExact === "function";

  const memberEntries = [...memberKeyToRemapped.entries()];
  await Promise.all(
    memberEntries.map(async ([key, _sourceName]) => {
      const [ownerFqn, name, descriptor] = key.split("\0");
      try {
        const targetOwner = ownerToRemapped.get(ownerFqn!) ?? ownerFqn;

        if (canResolveMethodExactly && descriptor) {
          try {
            const exactResult = await svc.mappingService.resolveMethodMappingExact({
              version,
              owner: ownerFqn!,
              name: name!,
              descriptor,
              sourceMapping,
              targetMapping,
              sourcePriority,
              projectPath
            });
            if (exactResult.resolved && exactResult.resolvedSymbol) {
              memberKeyToRemapped.set(key, exactResult.resolvedSymbol.name);
              if (exactResult.resolvedSymbol.descriptor) {
                memberDescriptorRemapped.set(key, exactResult.resolvedSymbol.descriptor);
              }
              return;
            }
          } catch (exactError) {
            warnings.push(
              `Exact method resolution failed for "${name}" (falling back to name-based lookup): ${exactError instanceof Error ? exactError.message : String(exactError)}`
            );
          }
        }

        const remappedDescriptorHint = kind === "method" && descriptor
          ? remapJvmDescriptor(descriptor, classMap)
          : undefined;

        const mapped = await svc.mappingService.findMapping({
          version,
          kind,
          name,
          owner: ownerFqn,
          descriptor: kind === "method" ? descriptor : undefined,
          signatureMode: kind === "method" && descriptor ? "exact" : undefined,
          sourceMapping,
          targetMapping,
          sourcePriority,
          projectPath,
          disambiguation: {
            ownerHint: targetOwner,
            descriptorHint: remappedDescriptorHint
          }
        });
        if (mapped.resolved && mapped.resolvedSymbol) {
          memberKeyToRemapped.set(key, mapped.resolvedSymbol.name);
          if (kind === "method" && mapped.resolvedSymbol.descriptor) {
            memberDescriptorRemapped.set(key, mapped.resolvedSymbol.descriptor);
          }
        } else if (mapped.status === "ambiguous" && mapped.candidates && mapped.candidates.length > 0) {
          const ownerMatched = mapped.candidates.filter(
            (c) => c.owner === targetOwner
          );
          const best = ownerMatched.length > 0 ? ownerMatched : mapped.candidates;
          if (best.length > 0) {
            memberKeyToRemapped.set(key, best[0]!.name);
            if (best[0]!.confidence < 0.9) {
              failedNames.add(name!);
            }
          } else {
            warnings.push(`Could not remap ${kind} "${name}" from ${sourceMapping} to ${targetMapping}.`);
            failedNames.add(name!);
          }
        } else {
          warnings.push(`Could not remap ${kind} "${name}" from ${sourceMapping} to ${targetMapping}.`);
          failedNames.add(name!);
        }
      } catch {
        warnings.push(`Remap failed for ${kind} "${name}" from ${sourceMapping} to ${targetMapping}.`);
        failedNames.add(name!);
      }
    })
  );

  const isField = kind === "field";
  return {
    members: members.map((member) => {
      const memberKey = `${member.ownerFqn}\0${member.name}\0${member.jvmDescriptor}`;
      const remappedName = memberKeyToRemapped.get(memberKey) ?? member.name;
      const remappedOwner = ownerToRemapped.get(member.ownerFqn) ?? member.ownerFqn;
      const remappedDescriptor = memberDescriptorRemapped.get(memberKey)
        ?? remapJvmDescriptor(member.jvmDescriptor, classMap);
      return {
        ...member,
        name: remappedName,
        ownerFqn: remappedOwner,
        jvmDescriptor: remappedDescriptor,
        javaSignature: rebuildJavaSignature(
          { name: remappedName, ownerFqn: remappedOwner, accessFlags: member.accessFlags },
          remappedDescriptor,
          isField
        )
      };
    }),
    failedNames
  };
}
