import { buildSuggestedCall } from "../../build-suggested-call.js";
import { ERROR_CODES, createError } from "../../errors.js";
import type { SignatureMember } from "../../minecraft-explorer-service.js";
import type { SourceService } from "../../source-service.js";
import type { MappingSourcePriority, SourceMapping } from "../../types.js";
import { rebuildJavaSignature, remapJvmDescriptor } from "../descriptor-utils.js";

export function normalizeMapping(mapping: SourceMapping | undefined): SourceMapping {
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

function looksLikeClassSegment(name: string): boolean {
  const trimmed = name.trim();
  return /^[A-Z_$]/.test(trimmed);
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
