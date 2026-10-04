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
  // Fabric/Loom call the obfuscated namespace "official"; treat it as obfuscated
  // (matches the tiny-parser alias) instead of silently assuming intermediary.
  if (normalized === "official") {
    return "obfuscated";
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

/**
 * Refuses a verdict that would be computed against another loader's bytecode,
 * and marks a cross-version one as approximate.
 *
 * A runtime fallback could serve a NeoForge 1.21.10 AT-patched jar to a Fabric
 * 1.21.11 workspace; validation then reported `valid: true` with a
 * `resolvedRuntimeJavaSignature` taken from bytecode the project never runs.
 * A different loader's access flags are simply not evidence about this one, so
 * that case fails loudly. A same-loader version drift still yields a verdict —
 * flagged, never silent.
 */
function guardRuntimeEvidence(
  provenance: RuntimeValidationProvenance<SourceMapping | AccessTransformerNamespace> | undefined,
  warnings: string[],
  subject: "Access Widener" | "Access Transformer"
): { approximate?: boolean; approximationReasons?: string[] } {
  if (!provenance) {
    return {};
  }
  if (provenance.loaderMismatch) {
    throw createError({
      code: ERROR_CODES.CONTEXT_UNRESOLVED,
      message:
        `${subject} validation resolved a ${provenance.servedLoader} runtime jar for a ` +
        `${provenance.expectedLoader} workspace; a different loader's bytecode cannot certify these entries.`,
      details: {
        jarPath: provenance.jarPath,
        servedLoader: provenance.servedLoader,
        expectedLoader: provenance.expectedLoader,
        version: provenance.version,
        ...(provenance.requestedVersion ? { requestedVersion: provenance.requestedVersion } : {}),
        requestedScope: provenance.requestedScope,
        appliedScope: provenance.appliedScope,
        nextAction:
          `Point gradleUserHome at the Gradle home holding this workspace's own ${provenance.expectedLoader} runtime jars, ` +
          "or run the Gradle task that generates them. Omitting projectPath validates against the vanilla jar instead of another loader's."
      }
    });
  }
  if (!provenance.versionApproximated) {
    return {};
  }
  const reason =
    `Runtime evidence comes from Minecraft ${provenance.version}, not the requested ` +
    `${provenance.requestedVersion}; entries were checked against a different version's bytecode.`;
  warnings.push(reason);
  return { approximate: true, approximationReasons: [reason] };
}

/**
 * Loads the runtime members of every class in `classFqns` from the jar, remapping each class name
 * and its members from `fromNamespace` into the jar's `lookupMapping` when they differ. Namespaces
 * outside the source-mapping set (such as SRG) cannot be remapped: the class is looked up by its
 * original name and a "Could not map class" warning is recorded.
 */
async function loadClassMembers(
  svc: SourceService,
  classFqns: Iterable<string>,
  options: {
    fromNamespace: SourceMapping | AccessTransformerNamespace;
    lookupMapping: SourceMapping | AccessTransformerNamespace;
    resolvedVersion: string;
    jarPath: string;
    input: Pick<ValidateAccessWidenerInput, "sourcePriority" | "projectPath" | "gradleUserHome">;
    warnings: string[];
  }
): Promise<Map<string, ResolvedTargetMembers>> {
  const { fromNamespace, lookupMapping, resolvedVersion, jarPath, input, warnings } = options;
  const needsLookupMapping = fromNamespace !== lookupMapping;
  const mapping =
    needsLookupMapping && isSourceMappingNamespace(fromNamespace) && isSourceMappingNamespace(lookupMapping)
      ? { from: fromNamespace, to: lookupMapping }
      : undefined;
  const membersByClass = new Map<string, ResolvedTargetMembers>();
  for (const fqn of classFqns) {
    let lookupFqn = fqn;
    if (needsLookupMapping) {
      if (!mapping) {
        warnings.push(`Could not map class "${fqn}" from ${fromNamespace} to ${lookupMapping}.`);
      } else {
        try {
          const mapped = await svc.mappingService.findMapping({
            version: resolvedVersion,
            kind: "class",
            name: fqn,
            sourceMapping: mapping.from,
            targetMapping: mapping.to,
            sourcePriority: input.sourcePriority,
            projectPath: input.projectPath,
            gradleUserHome: input.gradleUserHome
          });
          if (mapped.resolved && mapped.resolvedSymbol) {
            lookupFqn = mapped.resolvedSymbol.name;
          } else {
            warnings.push(`Could not map class "${fqn}" from ${fromNamespace} to ${lookupMapping}.`);
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
      if (mapping) {
        const remap = (members: typeof sig.methods, kind: "method" | "field") =>
          svc.remapSignatureMembers(
            members,
            kind,
            resolvedVersion,
            mapping.to,
            mapping.from,
            input.sourcePriority,
            warnings,
            input.projectPath,
            input.gradleUserHome
          );
        const [ctorResult, methodResult, fieldResult] = await Promise.all([
          remap(sig.constructors, "method"),
          remap(sig.methods, "method"),
          remap(sig.fields, "field")
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
  return membersByClass;
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

  // Fabric Loader also reads the classTweaker format; it is out of scope here rather than an
  // accessWidener file with a bad header, so it gets no verdict.
  const header = content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  if (header && /^classTweaker(\s|$)/.test(header)) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `The classTweaker format is not supported (header "${header}"); only accessWidener v1/v2 files can be validated.`,
      details: { unsupportedFormat: "classTweaker", header }
    });
  }

  const warnings: string[] = [];
  const parsed = parseAccessWidener(content);

  const headerNamespaceRaw = normalizeOptionalString(parsed.namespace);
  const overrideMapping = input.mapping ? normalizeMapping(input.mapping) : undefined;
  const headerNamespace = normalizeAccessWidenerNamespace(headerNamespaceRaw);
  if (!headerNamespace && !overrideMapping) {
    // No usable namespace resolved and no override: surface the intermediary
    // assumption so it is never silent (previously only warned when a header
    // namespace was present but unsupported).
    warnings.push(
      headerNamespaceRaw
        ? `Unsupported access widener namespace "${headerNamespaceRaw}". Assuming intermediary.`
        : `Access widener namespace not declared; assuming intermediary. Pass mapping=… to set it explicitly.`
    );
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
  let approximation: { approximate?: boolean; approximationReasons?: string[] } = {};

  if (runtimeAware) {
    provenance = await svc.resolveAccessWidenerRuntimeArtifact({
      version,
      awNamespace,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    approximation = guardRuntimeEvidence(provenance, warnings, "Access Widener");
    resolvedVersion = provenance.version;
    jarPath = provenance.jarPath;
    lookupMapping = provenance.mappingApplied;
  } else {
    ({ jarPath } = await svc.versionService.resolveVersionJar(version));
  }
  // Collect unique class FQNs from entries
  const classFqns = new Set<string>();
  for (const entry of parsed.entries) {
    const fqn = entry.target.replace(/\//g, ".");
    classFqns.add(fqn);
  }

  const membersByClass = await loadClassMembers(svc, classFqns, {
    fromNamespace: awNamespace,
    lookupMapping,
    resolvedVersion,
    jarPath,
    input,
    warnings
  });

  const result: AccessWidenerValidationResult = validateParsedAccessWidener(parsed, membersByClass, warnings, {
    includeRuntimeEvidence: runtimeAware
  });
  if (provenance) {
    result.provenance = provenance;
  }
  if (approximation.approximate) {
    result.approximate = true;
    result.approximationReasons = approximation.approximationReasons;
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
  let approximation: { approximate?: boolean; approximationReasons?: string[] } = {};

  if (runtimeAware) {
    provenance = await svc.resolveAccessTransformerRuntimeArtifact({
      version,
      atNamespace,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    approximation = guardRuntimeEvidence(provenance, warnings, "Access Transformer");
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

  const classFqns = new Set(parsed.entries.map((entry) => entry.owner));
  const membersByClass = await loadClassMembers(svc, classFqns, {
    fromNamespace: atNamespace,
    lookupMapping,
    resolvedVersion,
    jarPath,
    input,
    warnings
  });

  const result: AccessTransformerValidationResult = validateParsedAccessTransformer(parsed, membersByClass, warnings, {
    includeRuntimeEvidence: runtimeAware
  });
  if (provenance) {
    result.provenance = provenance;
  }
  if (approximation.approximate) {
    result.approximate = true;
    result.approximationReasons = approximation.approximationReasons;
  }
  return result;
}
