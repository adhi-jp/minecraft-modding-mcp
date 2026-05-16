import { buildSuggestedCall } from "../../build-suggested-call.js";
import { mapWithConcurrencyLimit } from "../../concurrency.js";
import { ERROR_CODES, createError, isAppError } from "../../errors.js";
import type {
  SourceService,
  TraceSymbolLifecycleInput,
  TraceSymbolLifecycleOutput,
  TraceSymbolLifecycleTimelineEntry
} from "../../source-service.js";
import { normalizeOptionalString } from "../shared-utils.js";
import {
  normalizeMapping,
  rejectLifecycleClassLikeInput,
  releaseLifecycleMappingGraph,
  resolveToObfuscatedClassName,
  resolveToObfuscatedMemberName
} from "./mapping-helpers.js";

const TRACE_LIFECYCLE_MAX_CONCURRENCY = 3;

type LifecycleScanEntry = {
  version: string;
  exists: boolean;
  reason?: TraceSymbolLifecycleTimelineEntry["reason"];
  determinate: boolean;
};

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit == null) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.trunc(limit)));
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
            versionWarnings,
            input.gradleUserHome
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
            versionWarnings,
            input.gradleUserHome
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
