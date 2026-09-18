import { ERROR_CODES, isAppError } from "../../errors.js";
import type { MinecraftExplorerService } from "../../minecraft-explorer-service.js";
import type { SymbolResolutionOutput as MappingSymbolResolutionOutput } from "../../mapping-service.js";
import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  SourceService
} from "../../source-service.js";

/**
 * What a runtime-bytecode existence check established.
 *
 * `verified` is true when the runtime jar answered: the class loaded and the member
 * lookup ran to completion, or the class was confirmed missing (CLASS_NOT_FOUND). It
 * is false when the check could not be performed - a short class name, a member query
 * without an owner, or a class that failed to load for any other reason (unreadable
 * jar, malformed class file) - and `result` is then the fallback base with the
 * explanatory warning appended, so it still carries the caller's own status.
 */
export interface UnobfuscatedRuntimeCheck {
  verified: boolean;
  result: CheckSymbolExistsOutput;
}

/**
 * check-symbol-exists's runtime fallback: the result of `runUnobfuscatedRuntimeCheck`
 * alone. Its callers keep the fallback base's status whenever the check could not be
 * performed, so they need no `verified` flag.
 */
export async function checkSymbolExistsInUnobfuscatedRuntime(
  svc: SourceService,
  input: CheckSymbolExistsInput,
  fallbackBase: CheckSymbolExistsOutput
): Promise<CheckSymbolExistsOutput | undefined> {
  return (await runUnobfuscatedRuntimeCheck(svc, input, fallbackBase))?.result;
}

/**
 * Checks a symbol against the Minecraft runtime jar of an unobfuscated version, whose
 * names are the Mojang names. Undefined when the version or name is empty or the
 * runtime jar cannot be resolved.
 */
export async function runUnobfuscatedRuntimeCheck(
  svc: SourceService,
  input: CheckSymbolExistsInput,
  fallbackBase: CheckSymbolExistsOutput
): Promise<UnobfuscatedRuntimeCheck | undefined> {
  const version = input.version.trim();
  const name = input.name.trim();
  const owner = input.owner?.trim();
  if (!version || !name) {
    return undefined;
  }

  if (input.kind === "class" && input.nameMode !== "fqcn" && !name.includes(".")) {
    return {
      verified: false,
      result: {
        ...fallbackBase,
        warnings: [
          ...fallbackBase.warnings,
          `Version ${version} is unobfuscated, but short class name "${name}" could not be checked against runtime bytecode without a fully-qualified name.`
        ]
      }
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
    return { verified: false, result: fallbackBase };
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
      access: "all",
      // Method existence is asked relative to the owner type, so inherited methods count:
      // `level.getGameTime()` exists on Level even though it is declared on a supertype.
      // Scoped to methods only: fields already resolved correctly without an inheritance
      // walk, and including inherited fields would let a shadowed field name match twice
      // and flip a previously-resolved field to "ambiguous".
      includeInherited: input.kind === "method"
    });
  } catch (error) {
    // Only CLASS_NOT_FOUND is an answer; any other failure means the lookup never completed.
    const classMissing = isAppError(error) && error.code === ERROR_CODES.CLASS_NOT_FOUND;
    return {
      verified: classMissing,
      result: {
        ...fallbackBase,
        querySymbol,
        warnings: [
          ...fallbackBase.warnings,
          classMissing
            ? `Class "${targetClass}" was not found in the Minecraft ${version} runtime jar; it does not exist (or is not in this jar).`
            : `Version ${version} is unobfuscated; runtime bytecode lookup could not load class "${targetClass}".`
        ]
      }
    };
  }

  const warnings = [...fallbackBase.warnings, ...signature.warnings];
  // Runtime validation is reported as the structured
  // mappingContext.runtimeValidated flag instead of a per-response sentence.
  const runtimeValidatedContext = {
    ...fallbackBase.mappingContext,
    runtimeValidated: true
  };

  // From here on the class loaded, so every answer below is a completed lookup.
  const buildResolved = (
    resolvedSymbol: MappingSymbolResolutionOutput["resolvedSymbol"]
  ): UnobfuscatedRuntimeCheck => ({
    verified: true,
    result: {
      ...fallbackBase,
      mappingContext: runtimeValidatedContext,
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
    }
  });

  const buildUnresolved = (status: CheckSymbolExistsOutput["status"]): UnobfuscatedRuntimeCheck => ({
    verified: true,
    result: {
      ...fallbackBase,
      mappingContext: runtimeValidatedContext,
      querySymbol,
      resolved: false,
      status,
      resolvedSymbol: undefined,
      candidates: [],
      candidateCount: 0,
      warnings
    }
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

  // The bytecode reader lists constructors apart from methods (and only the owner's
  // own: constructors are not inherited), so "<init>" is answered from them.
  const methodCandidates = (name === "<init>" ? signature.constructors : signature.methods).filter(
    (method) => method.name === name
  );
  const signatureMode = input.signatureMode ?? "name-only";
  if (signatureMode === "name-only") {
    // Existence semantics: any overload with this name means the method exists. Multiple
    // overloads are not "ambiguous" for a name-only existence check — only zero matches
    // is not_found. (Use signatureMode: "exact" with a descriptor to pin one overload.)
    if (methodCandidates.length === 0) {
      return buildUnresolved("not_found");
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
  // An exact descriptor pins a single overload. Multiple matches only arise when an
  // inherited method is overridden (same name + descriptor, different owner) and
  // includeInherited surfaces both copies — that is the same logical method, not an
  // ambiguity. Only zero matches is not_found. (Mirrors the name-only fix above.)
  if (matched.length === 0) {
    return buildUnresolved("not_found");
  }
  return buildResolved({
    kind: "method",
    owner,
    name,
    descriptor,
    symbol: `${owner}.${name}${descriptor ?? ""}`
  });
}
