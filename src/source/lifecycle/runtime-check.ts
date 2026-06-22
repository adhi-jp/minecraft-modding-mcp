import type { MinecraftExplorerService } from "../../minecraft-explorer-service.js";
import type { SymbolResolutionOutput as MappingSymbolResolutionOutput } from "../../mapping-service.js";
import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  SourceService
} from "../../source-service.js";

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
  const signatureMode = input.signatureMode ?? "name-only";
  if (signatureMode === "name-only") {
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
