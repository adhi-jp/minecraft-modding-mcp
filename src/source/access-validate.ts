import { parseAccessTransformer } from "../access-transformer-parser.js";
import { parseAccessWidener } from "../access-widener-parser.js";
import { buildSuggestedCall } from "../build-suggested-call.js";
import { ERROR_CODES, createError } from "../errors.js";
import {
  validateParsedAccessTransformer,
  validateParsedAccessWidener
} from "../mixin-validator.js";
import type {
  AccessTransformerValidationResult,
  AccessWidenerValidationResult,
  ResolvedTargetMembers
} from "../mixin-validator.js";
import type { SourceService } from "../source-service.js";
import { remapSignatureMembers } from "./lifecycle.js";
import { normalizeMapping, normalizeOptionalString } from "./shared-utils.js";
import type {
  ValidateAccessTransformerInput,
  ValidateAccessTransformerOutput,
  ValidateAccessWidenerInput,
  ValidateAccessWidenerOutput
} from "../source-service.js";
import type {
  AccessTransformerNamespace,
  RuntimeValidationProvenance,
  SourceMapping
} from "../types.js";

function normalizeAccessWidenerNamespace(namespace: string | undefined): SourceMapping | undefined {
  const normalized = namespace?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "named") {
    return "yarn";
  }
  if (
    normalized === "obfuscated" ||
    normalized === "mojang" ||
    normalized === "intermediary" ||
    normalized === "yarn"
  ) {
    return normalized;
  }
  return undefined;
}

function isSourceMappingNamespace(
  namespace: string
): namespace is SourceMapping {
  return (
    namespace === "obfuscated" ||
    namespace === "mojang" ||
    namespace === "intermediary" ||
    namespace === "yarn"
  );
}

export async function validateAccessWidener(svc: SourceService, input: ValidateAccessWidenerInput): Promise<ValidateAccessWidenerOutput> {
  const version = input.version.trim();
  if (!version) {
    throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "version must be non-empty." });
  }
  const content = input.content;
  if (!content.trim()) {
    throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "content must be non-empty." });
  }

  const warnings: string[] = [];
  const parsed = parseAccessWidener(content);

  const headerNamespaceRaw = normalizeOptionalString(parsed.namespace);
  const overrideMapping = input.mapping ? normalizeMapping(input.mapping) : undefined;
  const headerNamespace = normalizeAccessWidenerNamespace(headerNamespaceRaw);
  if (!headerNamespace && headerNamespaceRaw && !overrideMapping) {
    warnings.push(`Unsupported access widener namespace "${headerNamespaceRaw}". Assuming intermediary.`);
  }

  const awNamespace = overrideMapping ?? headerNamespace ?? "intermediary";
  if (overrideMapping && headerNamespace && overrideMapping !== headerNamespace) {
    warnings.push(
      `Using mapping override "${overrideMapping}" instead of header namespace "${headerNamespaceRaw}".`
    );
  }
  const runtimeAware = input.projectPath != null || input.scope != null || input.preferProjectVersion === true;
  let resolvedVersion = version;
  let jarPath: string;
  let lookupMapping: SourceMapping = "obfuscated";
  let provenance: RuntimeValidationProvenance<SourceMapping> | undefined;

  if (runtimeAware) {
    provenance = await svc.resolveAccessWidenerRuntimeArtifact({
      version,
      awNamespace,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    resolvedVersion = provenance.version;
    jarPath = provenance.jarPath;
    lookupMapping = provenance.mappingApplied;
  } else {
    ({ jarPath } = await svc.versionService.resolveVersionJar(version));
  }
  const needsLookupMapping = awNamespace !== lookupMapping;

  // Collect unique class FQNs from entries
  const classFqns = new Set<string>();
  for (const entry of parsed.entries) {
    const fqn = entry.target.replace(/\//g, ".");
    classFqns.add(fqn);
  }

  const membersByClass = new Map<string, ResolvedTargetMembers>();
  for (const fqn of classFqns) {
    let lookupFqn = fqn;

    if (needsLookupMapping) {
      try {
        const mapped = await svc.mappingService.findMapping({
          version: resolvedVersion,
          kind: "class",
          name: fqn,
          sourceMapping: awNamespace,
          targetMapping: lookupMapping,
          sourcePriority: input.sourcePriority,
          projectPath: input.projectPath,
          gradleUserHome: input.gradleUserHome
        });
        if (mapped.resolved && mapped.resolvedSymbol) {
          lookupFqn = mapped.resolvedSymbol.name;
        } else {
          warnings.push(`Could not map class "${fqn}" from ${awNamespace} to ${lookupMapping}.`);
        }
      } catch {
        warnings.push(`Mapping lookup failed for class "${fqn}".`);
      }
    }

    try {
      const sig = await svc.explorerService.getSignature({
        fqn: lookupFqn,
        jarPath,
        access: "all"
      });
      warnings.push(...sig.warnings);
      let constructors = sig.constructors;
      let methods = sig.methods;
      let fields = sig.fields;
      if (needsLookupMapping) {
        const [ctorResult, methodResult, fieldResult] = await Promise.all([
          svc.remapSignatureMembers(
            sig.constructors,
            "method",
            resolvedVersion,
            lookupMapping,
            awNamespace,
            input.sourcePriority,
            warnings,
            input.projectPath,
            input.gradleUserHome
          ),
          svc.remapSignatureMembers(
            sig.methods,
            "method",
            resolvedVersion,
            lookupMapping,
            awNamespace,
            input.sourcePriority,
            warnings,
            input.projectPath,
            input.gradleUserHome
          ),
          svc.remapSignatureMembers(
            sig.fields,
            "field",
            resolvedVersion,
            lookupMapping,
            awNamespace,
            input.sourcePriority,
            warnings,
            input.projectPath,
            input.gradleUserHome
          )
        ]);
        constructors = ctorResult.members;
        methods = methodResult.members;
        fields = fieldResult.members;
      }
      membersByClass.set(fqn, {
        className: fqn,
        classAccessFlags: sig.classAccessFlags,
        constructors,
        methods,
        fields
      });
    } catch {
      warnings.push(`Could not load signature for class "${lookupFqn}".`);
    }
  }

  const result: AccessWidenerValidationResult = validateParsedAccessWidener(parsed, membersByClass, warnings, {
    includeRuntimeEvidence: runtimeAware
  });
  if (provenance) {
    result.provenance = provenance;
  }
  return result;
}

export async function validateAccessTransformer(svc: SourceService, input: ValidateAccessTransformerInput): Promise<ValidateAccessTransformerOutput> {
  const version = input.version.trim();
  if (!version) {
    throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "version must be non-empty." });
  }
  const content = input.content;
  if (!content.trim()) {
    throw createError({ code: ERROR_CODES.INVALID_INPUT, message: "content must be non-empty." });
  }

  const warnings: string[] = [];
  const parsed = parseAccessTransformer(content);
  const atNamespace = await svc.resolveAccessTransformerNamespace({
    atNamespace: input.atNamespace,
    projectPath: input.projectPath
  });
  const runtimeAware = input.projectPath != null || input.scope != null || input.preferProjectVersion === true;
  let resolvedVersion = version;
  let jarPath: string;
  let lookupMapping: SourceMapping | AccessTransformerNamespace = "obfuscated";
  let provenance: RuntimeValidationProvenance<AccessTransformerNamespace> | undefined;

  if (runtimeAware) {
    provenance = await svc.resolveAccessTransformerRuntimeArtifact({
      version,
      atNamespace,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    resolvedVersion = provenance.version;
    jarPath = provenance.jarPath;
    lookupMapping = provenance.mappingApplied;
  } else {
    if (atNamespace === "srg") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "atNamespace=srg requires projectPath and scope=loader so a Forge runtime jar can be resolved."
      });
    }
    ({ jarPath } = await svc.versionService.resolveVersionJar(version));
  }

  const needsLookupMapping = atNamespace !== lookupMapping;
  const classFqns = new Set(parsed.entries.map((entry) => entry.owner));
  const membersByClass = new Map<string, ResolvedTargetMembers>();

  for (const fqn of classFqns) {
    let lookupFqn = fqn;
    if (needsLookupMapping) {
      if (!isSourceMappingNamespace(atNamespace) || !isSourceMappingNamespace(lookupMapping)) {
        warnings.push(`Could not map class "${fqn}" from ${atNamespace} to ${lookupMapping}.`);
      } else {
        try {
          const mapped = await svc.mappingService.findMapping({
            version: resolvedVersion,
            kind: "class",
            name: fqn,
            sourceMapping: atNamespace,
            targetMapping: lookupMapping,
            sourcePriority: input.sourcePriority,
            projectPath: input.projectPath,
            gradleUserHome: input.gradleUserHome
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            lookupFqn = mapped.resolvedSymbol.name;
          } else {
            warnings.push(`Could not map class "${fqn}" from ${atNamespace} to ${lookupMapping}.`);
          }
        } catch {
          warnings.push(`Mapping lookup failed for class "${fqn}".`);
        }
      }
    }

    try {
      const sig = await svc.explorerService.getSignature({
        fqn: lookupFqn,
        jarPath,
        access: "all"
      });
      warnings.push(...sig.warnings);
      let constructors = sig.constructors;
      let methods = sig.methods;
      let fields = sig.fields;

      if (needsLookupMapping && isSourceMappingNamespace(atNamespace) && isSourceMappingNamespace(lookupMapping)) {
        const [ctorResult, methodResult, fieldResult] = await Promise.all([
          svc.remapSignatureMembers(
            sig.constructors,
            "method",
            resolvedVersion,
            lookupMapping,
            atNamespace,
            input.sourcePriority,
            warnings,
            input.projectPath,
            input.gradleUserHome
          ),
          svc.remapSignatureMembers(
            sig.methods,
            "method",
            resolvedVersion,
            lookupMapping,
            atNamespace,
            input.sourcePriority,
            warnings,
            input.projectPath,
            input.gradleUserHome
          ),
          svc.remapSignatureMembers(
            sig.fields,
            "field",
            resolvedVersion,
            lookupMapping,
            atNamespace,
            input.sourcePriority,
            warnings,
            input.projectPath,
            input.gradleUserHome
          )
        ]);
        constructors = ctorResult.members;
        methods = methodResult.members;
        fields = fieldResult.members;
      }

      membersByClass.set(fqn, {
        className: fqn,
        classAccessFlags: sig.classAccessFlags,
        constructors,
        methods,
        fields
      });
    } catch {
      warnings.push(`Could not load signature for class "${lookupFqn}".`);
    }
  }

  const result: AccessTransformerValidationResult = validateParsedAccessTransformer(parsed, membersByClass, warnings, {
    includeRuntimeEvidence: runtimeAware
  });
  if (provenance) {
    result.provenance = provenance;
  }
  return result;
}
