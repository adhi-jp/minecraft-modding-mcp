import { ERROR_CODES, createError } from "../errors.js";
import type { SourceService } from "../source-service.js";
import type {
  ResolveWorkspaceSymbolInput,
  ResolveWorkspaceSymbolOutput
} from "../source-service.js";
import { isUnobfuscatedVersion } from "../version-service.js";
import type { WorkspaceCompileMappingOutput } from "../workspace-mapping-service.js";
import { runUnobfuscatedRuntimeCheck } from "./lifecycle/runtime-check.js";

/**
 * Minecraft 26.1+ ships its runtime in Mojang names, so a Loom project for it has no
 * `mappings` declaration: it compiles against the runtime names directly. Resolving a
 * workspace symbol there is an identity lookup, checked against runtime bytecode the
 * same way checkSymbolExists validates unobfuscated versions.
 */
async function resolveUnobfuscatedWorkspaceSymbol(
  svc: SourceService,
  input: ResolveWorkspaceSymbolInput,
  context: {
    version: string;
    querySymbol: ResolveWorkspaceSymbolOutput["querySymbol"];
    sourcePriorityApplied: ResolveWorkspaceSymbolOutput["mappingContext"]["sourcePriorityApplied"];
  }
): Promise<ResolveWorkspaceSymbolOutput> {
  const { version, querySymbol, sourcePriorityApplied } = context;
  const workspaceDetection: WorkspaceCompileMappingOutput = {
    resolved: true,
    mappingApplied: "mojang",
    evidence: [],
    warnings: [
      `Minecraft ${version} is unobfuscated; no mappings declaration is needed — symbols are resolved against runtime (Mojang) names.`
    ]
  };
  // The requested/defaulted sourceMapping label is echoed unchanged: on 26.1+ an
  // "obfuscated" label already means the as-shipped Mojang names, and rewriting it to
  // "mojang" would break callers that compare namespace labels for equality.
  const base = {
    querySymbol,
    mappingContext: {
      version,
      sourceMapping: input.sourceMapping,
      targetMapping: "mojang" as const,
      sourcePriorityApplied,
      unobfuscatedRuntime: true
    },
    resolved: false,
    status: "not_found" as const,
    candidates: [],
    candidateCount: 0,
    warnings: [...workspaceDetection.warnings]
  };

  // The runtime names are both the "obfuscated" (as-shipped) and the Mojang names;
  // intermediary and yarn names do not exist for these versions.
  if (input.sourceMapping !== "obfuscated" && input.sourceMapping !== "mojang") {
    return {
      ...base,
      status: "mapping_unavailable",
      workspaceDetection,
      warnings: [
        ...base.warnings,
        `sourceMapping "${input.sourceMapping}" has no names on unobfuscated Minecraft ${version}; pass sourceMapping "mojang" (or "obfuscated") to resolve against runtime names.`
      ]
    };
  }

  const runtime = await runUnobfuscatedRuntimeCheck(
    svc,
    {
      version,
      kind: querySymbol.kind,
      name: querySymbol.name,
      owner: querySymbol.owner,
      descriptor: querySymbol.descriptor,
      sourceMapping: input.sourceMapping,
      signatureMode: "exact"
    },
    base
  );
  if (!runtime) {
    // Mirrors checkSymbolExists: a symbol that could not be checked is not reported missing.
    return {
      ...base,
      status: "mapping_unavailable",
      workspaceDetection,
      warnings: [
        ...base.warnings,
        `Minecraft ${version} runtime jar could not be resolved; symbol existence was not verified.`
      ]
    };
  }
  if (!runtime.verified) {
    // The jar was reached but did not answer (short class name, class that failed to
    // load for a reason other than being absent): the result carries the reason, and
    // an unanswered lookup is not a definitive miss. `not_found` stays reserved for a
    // class confirmed missing or a member lookup that completed without a match.
    return { ...runtime.result, status: "mapping_unavailable", workspaceDetection };
  }
  return { ...runtime.result, workspaceDetection };
}

export async function resolveWorkspaceSymbol(svc: SourceService, input: ResolveWorkspaceSymbolInput): Promise<ResolveWorkspaceSymbolOutput> {
  const projectPath = input.projectPath?.trim();
  const version = input.version?.trim();
  const kind = input.kind;
  const name = input.name?.trim();
  const owner = input.owner?.trim();
  const descriptor = input.descriptor?.trim();
  if (!projectPath || !version || !name) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "projectPath, version, and name must be non-empty strings.",
      details: {
        projectPath: input.projectPath,
        version: input.version,
        name: input.name
      }
    });
  }

  if (kind !== "class" && kind !== "field" && kind !== "method") {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Unsupported symbol kind "${kind}".`,
      details: { kind }
    });
  }
  if (kind === "class") {
    if (owner) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "owner is not allowed when kind=class. Use name as FQCN.",
        details: { owner: input.owner, name: input.name }
      });
    }
    if (descriptor) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "descriptor is not allowed when kind=class.",
        details: { descriptor: input.descriptor }
      });
    }
  } else if (!owner) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "owner is required when kind is field or method.",
      details: { kind, owner: input.owner }
    });
  }
  if (kind === "field" && descriptor) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "descriptor is not allowed when kind=field.",
      details: { descriptor: input.descriptor }
    });
  }
  if (kind === "method" && !descriptor) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "descriptor is required when kind=method."
    });
  }

  const querySymbol =
    kind === "class"
      ? {
          kind,
          name: name.replace(/\//g, "."),
          symbol: name.replace(/\//g, ".")
        }
      : {
          kind,
          name,
          owner: owner?.replace(/\//g, "."),
          descriptor: kind === "method" ? descriptor : undefined,
          symbol: `${owner?.replace(/\//g, ".")}.${name}${kind === "method" ? descriptor : ""}`
        };
  const sourcePriorityApplied = input.sourcePriority ?? svc.config.mappingSourcePriority;

  const workspaceDetection = await svc.workspaceMappingService.detectCompileMapping({
    projectPath
  });
  // No evidence also means no build script was found at all (a missing, mistyped or
  // empty projectPath). Only a build that was read and declares no mappings is a
  // 26.1+ Loom project compiling against the runtime names.
  if (
    !workspaceDetection.resolved &&
    workspaceDetection.evidence.length === 0 &&
    isUnobfuscatedVersion(version) &&
    (await svc.workspaceMappingService.hasReadableBuildScript(projectPath))
  ) {
    return resolveUnobfuscatedWorkspaceSymbol(svc, input, { version, querySymbol, sourcePriorityApplied });
  }
  const warnings = [...workspaceDetection.warnings];
  if (!workspaceDetection.resolved || !workspaceDetection.mappingApplied) {
    return {
      querySymbol,
      mappingContext: {
        version,
        sourceMapping: input.sourceMapping,
        sourcePriorityApplied
      },
      resolved: false,
      status: "mapping_unavailable",
      candidates: [],
      candidateCount: 0,
      workspaceDetection,
      warnings
    };
  }

  const mappingApplied = workspaceDetection.mappingApplied;
  if (kind === "method") {
    const methodOwner = owner as string;
    const methodDescriptor = descriptor as string;
    const exact = await svc.mappingService.resolveMethodMappingExact({
      version,
      owner: methodOwner,
      name,
      descriptor: methodDescriptor,
      sourceMapping: input.sourceMapping,
      targetMapping: mappingApplied,
      sourcePriority: input.sourcePriority,
      gradleUserHome: input.gradleUserHome,
      maxCandidates: input.maxCandidates
    });

    return {
      ...exact,
      workspaceDetection,
      warnings: [...warnings, ...exact.warnings]
    };
  }

  if (kind === "class") {
    const className = name.replace(/\//g, ".");
    const matrix = await svc.mappingService.getClassApiMatrix({
      version,
      className,
      classNameMapping: input.sourceMapping,
      includeKinds: ["class"],
      sourcePriority: input.sourcePriority,
      gradleUserHome: input.gradleUserHome
    });

    const resolvedClass = matrix.classIdentity[mappingApplied];
    if (!resolvedClass) {
      return {
        querySymbol,
        mappingContext: {
          version,
          sourceMapping: input.sourceMapping,
          targetMapping: mappingApplied,
          sourcePriorityApplied
        },
        resolved: false,
        status: "not_found",
        candidates: [],
        candidateCount: 0,
        workspaceDetection,
        warnings: [...warnings, ...matrix.warnings]
      };
    }

    const normalizedClass = resolvedClass.replace(/\//g, ".");
    const resolvedSymbol = {
      kind: "class" as const,
      name: normalizedClass,
      symbol: normalizedClass
    };
    const resolvedCandidate = {
      ...resolvedSymbol,
      matchKind: "exact" as const,
      confidence: 1
    };

    return {
      querySymbol,
      mappingContext: {
        version,
        sourceMapping: input.sourceMapping,
        targetMapping: mappingApplied,
        sourcePriorityApplied
      },
      resolved: true,
      status: "resolved",
      resolvedSymbol,
      candidates: [resolvedCandidate],
      candidateCount: 1,
      workspaceDetection,
      warnings: [...warnings, ...matrix.warnings]
    };
  }

  // By this point the method and class branches have already returned; only the field
  // branch reaches the generic findMapping fallthrough.
  const mapped = await svc.mappingService.findMapping({
    version,
    kind,
    name,
    owner,
    descriptor,
    sourceMapping: input.sourceMapping,
    targetMapping: mappingApplied,
    sourcePriority: input.sourcePriority,
    gradleUserHome: input.gradleUserHome,
    maxCandidates: input.maxCandidates
  });

  const filtered = mapped.candidates.filter((candidate) => candidate.kind === kind);
  let status: ResolveWorkspaceSymbolOutput["status"];
  if (mapped.status === "mapping_unavailable") {
    status = "mapping_unavailable";
  } else if (filtered.length === 1) {
    status = "resolved";
  } else if (filtered.length > 1) {
    status = "ambiguous";
  } else {
    status = "not_found";
  }

  return {
    querySymbol: mapped.querySymbol,
    mappingContext: mapped.mappingContext,
    resolved: status === "resolved",
    status,
    resolvedSymbol: status === "resolved" ? filtered[0] : undefined,
    candidates: filtered,
    candidateCount: mapped.candidateCount,
    candidatesTruncated: mapped.candidatesTruncated,
    workspaceDetection,
    warnings: [...warnings, ...mapped.warnings]
  };
}
