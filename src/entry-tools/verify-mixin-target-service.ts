import { z } from "zod";

import { buildSuggestedCall } from "../build-suggested-call.js";
import { createError, ERROR_CODES, isAppError } from "../errors.js";
import { suggestSimilar } from "../mixin-validator.js";
import type {
  ArtifactProvenance,
  ArtifactScope,
  DependencyResolutionProvenance,
  MappingSourcePriority,
  ResolveArtifactTargetInput,
  SourceMapping,
  WorkspaceResolutionProvenance
} from "../types.js";

export const VERIFY_MIXIN_TARGET_OFF = process.env.VERIFY_MIXIN_TARGET_OFF === "1";

export type VerifyMixinTargetInput = {
  owner: string;
  member:
    | { kind: "method"; name: string; descriptor?: string }
    | { kind: "field"; name: string; descriptor?: string };
  mixinMemberName?: string;
  mapping?: SourceMapping;
  autoRemap?: boolean;
  sourcePriority?: MappingSourcePriority;
  projectPath?: string;
  gradleUserHome?: string;
  target?: ResolveArtifactTargetInput;
  scope?: ArtifactScope;
  preferProjectVersion?: boolean;
  strictVersion?: boolean;
};

export type VerifyMixinTargetMatch = {
  name: string;
  descriptor: string;
  accessFlags: string[];
  javaSignature?: string;
};

export type VerifyMixinTargetCandidate = {
  name: string;
  descriptor: string;
  reason: string;
};

type SuggestedAnnotation = "@Shadow" | "@Accessor" | "@Invoker" | "@Inject-only";

export type AccessorAdvice = {
  suggestedAnnotation: SuggestedAnnotation | null;
  reasoning: string;
  exampleSnippet: string;
  candidates?: Array<{
    annotation: "@Shadow" | "@Accessor" | "@Invoker";
    reasoning: string;
    exampleSnippet: string;
  }>;
};

export type VerifyMixinTargetOutput = {
  exists: boolean;
  resolvedOwner: { className: string; mapping: SourceMapping };
  matches: VerifyMixinTargetMatch[];
  candidates: VerifyMixinTargetCandidate[];
  accessorAdvice?: AccessorAdvice;
  warnings: string[];
  provenance: {
    artifactId: string;
    mappingNamespace: SourceMapping;
    workspaceResolution?: WorkspaceResolutionProvenance;
    dependencyResolution?: DependencyResolutionProvenance;
  };
};

type ExplorerSignatureMember = {
  ownerFqn: string;
  name: string;
  javaSignature: string;
  jvmDescriptor: string;
  accessFlags: number;
  isSynthetic: boolean;
  sourceLine?: number;
};

type ExplorerSignatureOutput = {
  classAccessFlags?: number;
  constructors: ExplorerSignatureMember[];
  methods: ExplorerSignatureMember[];
  fields: ExplorerSignatureMember[];
  warnings: string[];
};

export type VerifyMixinTargetDeps = {
  resolveArtifact: (input: {
    target: ResolveArtifactTargetInput;
    mapping?: SourceMapping;
    sourcePriority?: MappingSourcePriority;
    projectPath?: string;
    gradleUserHome?: string;
    scope?: ArtifactScope;
    preferProjectVersion?: boolean;
    strictVersion?: boolean;
  }) => Promise<{
    artifactId: string;
    mappingApplied: SourceMapping;
    binaryJarPath?: string;
    version?: string;
    provenance?: ArtifactProvenance;
    warnings?: string[];
  }>;
  getSignature: (input: {
    fqn: string;
    jarPath: string;
    access: "public" | "all";
    includeSynthetic: boolean;
    includeInherited: boolean;
  }) => Promise<ExplorerSignatureOutput>;
  /**
   * Optional mapping translator used by autoRemap to convert owner/member names
   * from the request namespace into the artifact namespace. When absent,
   * autoRemap is unavailable and a namespace mismatch surfaces as an error.
   */
  findMapping?: (input: {
    version: string;
    kind: "class" | "field" | "method";
    name: string;
    owner?: string;
    descriptor?: string;
    sourceMapping: SourceMapping;
    targetMapping: SourceMapping;
  }) => Promise<{
    resolved: boolean;
    resolvedSymbol?: { name: string; owner?: string; descriptor?: string };
  }>;
};

const ACCESSOR_NAME_RE = /^(get|set|is)([A-Z]\w*)$/;
const INVOKER_NAME_RE = /^(invoke|call)([A-Z]\w*)$/;

function decodeAccessFlags(flags: number | undefined, kind: "method" | "field"): string[] {
  const labels: string[] = [];
  if (flags == null) {
    return labels;
  }
  if ((flags & 0x0001) !== 0) labels.push("public");
  if ((flags & 0x0002) !== 0) labels.push("private");
  if ((flags & 0x0004) !== 0) labels.push("protected");
  if ((flags & 0x0008) !== 0) labels.push("static");
  if ((flags & 0x0010) !== 0) labels.push("final");
  if ((flags & 0x0020) !== 0) labels.push("synchronized");
  if ((flags & 0x0040) !== 0) labels.push(kind === "method" ? "bridge" : "volatile");
  if ((flags & 0x0080) !== 0) labels.push(kind === "method" ? "varargs" : "transient");
  if ((flags & 0x0100) !== 0) labels.push("native");
  if ((flags & 0x0400) !== 0) labels.push("abstract");
  if ((flags & 0x0800) !== 0) labels.push("strictfp");
  if (labels.length === 0) {
    labels.push("package-private");
  }
  return labels;
}

function visibilityFromFlags(flags: number | undefined): "public" | "protected" | "private" | "package-private" {
  if (flags == null) return "package-private";
  if ((flags & 0x0001) !== 0) return "public";
  if ((flags & 0x0004) !== 0) return "protected";
  if ((flags & 0x0002) !== 0) return "private";
  return "package-private";
}

function buildExampleSnippet(
  annotation: SuggestedAnnotation,
  member: VerifyMixinTargetInput["member"],
  match: VerifyMixinTargetMatch | undefined,
  mixinMemberName: string | undefined
): string {
  const accessFlags = match?.accessFlags ?? [];
  const isFinal = accessFlags.includes("final");
  const targetName = member.name;
  if (annotation === "@Inject-only") {
    return `// "${targetName}" is already visible to the mixin (target access: ${accessFlags.filter((f) => f === "public" || f === "protected" || f === "private" || f === "package-private")[0] ?? "unknown"}); use @Inject directly without @Shadow.`;
  }
  if (annotation === "@Shadow") {
    if (member.kind === "field") {
      const finalTag = isFinal ? "@Shadow @Final\n" : "@Shadow\n";
      return `${finalTag}private <type> ${targetName};`;
    }
    return `@Shadow\nprivate <returnType> ${targetName}(<params>);`;
  }
  if (annotation === "@Accessor") {
    const accessorName = mixinMemberName ?? `get${targetName.charAt(0).toUpperCase()}${targetName.slice(1)}`;
    const isSetter = mixinMemberName !== undefined && /^set[A-Z]/.test(mixinMemberName);
    if (isSetter) {
      return `@Accessor("${targetName}")\nvoid ${accessorName}(<type> value);`;
    }
    return `@Accessor("${targetName}")\n<returnType> ${accessorName}();`;
  }
  const invokerName = mixinMemberName ?? `invoke${targetName.charAt(0).toUpperCase()}${targetName.slice(1)}`;
  return `@Invoker("${targetName}")\n<returnType> ${invokerName}(<params>);`;
}

function inferAnnotation(
  member: VerifyMixinTargetInput["member"],
  match: VerifyMixinTargetMatch | undefined,
  mixinMemberName: string | undefined
): AccessorAdvice {
  const visibility = match ? deriveVisibility(match.accessFlags) : "private";
  if (visibility === "public" || visibility === "protected") {
    return {
      suggestedAnnotation: "@Inject-only",
      reasoning: `Target "${member.name}" is ${visibility}; it is already visible to the mixin without @Shadow. Use @Inject directly.`,
      exampleSnippet: buildExampleSnippet("@Inject-only", member, match, mixinMemberName)
    };
  }
  if (mixinMemberName) {
    if (member.kind === "field" && ACCESSOR_NAME_RE.test(mixinMemberName)) {
      return {
        suggestedAnnotation: "@Accessor",
        reasoning: `mixin member "${mixinMemberName}" follows the get/set/is convention — inferred field "${member.name}" via prefix removal.`,
        exampleSnippet: buildExampleSnippet("@Accessor", member, match, mixinMemberName)
      };
    }
    if (member.kind === "method" && INVOKER_NAME_RE.test(mixinMemberName)) {
      return {
        suggestedAnnotation: "@Invoker",
        reasoning: `mixin member "${mixinMemberName}" follows the invoke/call convention — inferred method "${member.name}" via prefix removal.`,
        exampleSnippet: buildExampleSnippet("@Invoker", member, match, mixinMemberName)
      };
    }
    return {
      suggestedAnnotation: "@Shadow",
      reasoning: `Target "${member.name}" is private. mixin member "${mixinMemberName}" does not match accessor/invoker prefix conventions; @Shadow is appropriate.`,
      exampleSnippet: buildExampleSnippet("@Shadow", member, match, mixinMemberName)
    };
  }
  if (member.kind === "field") {
    return {
      suggestedAnnotation: "@Shadow",
      reasoning: `Target "${member.name}" is private; use @Shadow to access it from the mixin.`,
      exampleSnippet: buildExampleSnippet("@Shadow", member, match, mixinMemberName)
    };
  }
  return {
    suggestedAnnotation: null,
    reasoning: `Target method "${member.name}" is private and no mixinMemberName was supplied; cannot decide between @Shadow and @Invoker. Choose @Shadow when the mixin overrides the method, @Invoker when it only needs to call it.`,
    exampleSnippet: "// Provide mixinMemberName to receive a concrete @Shadow or @Invoker template.",
    candidates: [
      {
        annotation: "@Shadow",
        reasoning: "Use @Shadow to override or read the private method body from the mixin.",
        exampleSnippet: buildExampleSnippet("@Shadow", member, match, mixinMemberName)
      },
      {
        annotation: "@Invoker",
        reasoning: "Use @Invoker when the mixin only needs to invoke the private method without redeclaring the body.",
        exampleSnippet: buildExampleSnippet("@Invoker", member, match, mixinMemberName)
      }
    ]
  };
}

function deriveVisibility(
  accessFlags: string[]
): "public" | "protected" | "private" | "package-private" {
  if (accessFlags.includes("public")) return "public";
  if (accessFlags.includes("protected")) return "protected";
  if (accessFlags.includes("private")) return "private";
  return "package-private";
}

function buildMatch(member: ExplorerSignatureMember, kind: "method" | "field"): VerifyMixinTargetMatch {
  return {
    name: member.name,
    descriptor: member.jvmDescriptor,
    accessFlags: decodeAccessFlags(member.accessFlags, kind),
    javaSignature: member.javaSignature,
    ...(member.sourceLine ? { sourceLine: member.sourceLine } : {})
  };
}

export class VerifyMixinTargetService {
  constructor(private readonly deps: VerifyMixinTargetDeps) {}

  async execute(input: VerifyMixinTargetInput): Promise<VerifyMixinTargetOutput> {
    if (VERIFY_MIXIN_TARGET_OFF) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "verify-mixin-target is disabled by VERIFY_MIXIN_TARGET_OFF=1.",
        details: { fieldErrors: [{ path: "tool", message: "verify-mixin-target is disabled." }] }
      });
    }
    if (!input.target) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "verify-mixin-target requires a target.",
        details: { fieldErrors: [{ path: "target", message: "target is required" }] }
      });
    }
    let owner = input.owner.trim();
    if (!owner) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "owner must be non-empty."
      });
    }
    let member: VerifyMixinTargetInput["member"] = input.member;
    let memberName = member.name.trim();
    if (!memberName) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "member.name must be non-empty."
      });
    }
    const resolved = await this.deps.resolveArtifact({
      target: input.target,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion,
      strictVersion: input.strictVersion
    });
    const warnings: string[] = [...(resolved.warnings ?? [])];
    if (input.mapping && input.mapping !== resolved.mappingApplied) {
      if (input.autoRemap) {
        const remapped = await this.applyAutoRemap(input, resolved, owner, member, warnings);
        owner = remapped.owner;
        member = remapped.member;
        memberName = member.name;
      } else {
        throw createError({
          code: ERROR_CODES.NAMESPACE_MISMATCH,
          message:
            `verify-mixin-target requires owner and member.name to be in the artifact's namespace `
            + `("${resolved.mappingApplied}"), but the request supplied mapping="${input.mapping}". `
            + `Set autoRemap=true to translate names automatically, supply owner+member in the artifact namespace, `
            + `or omit the mapping argument so the resolver picks the namespace automatically.`,
          details: {
            owner,
            requestedMapping: input.mapping,
            mappingApplied: resolved.mappingApplied,
            artifactId: resolved.artifactId,
            nextAction:
              `Retry with autoRemap=true, or with mapping="${resolved.mappingApplied}" and owner/member already in that namespace, `
              + `or use find-mapping to translate before calling verify-mixin-target.`
          }
        });
      }
    }
    if (!resolved.binaryJarPath) {
      throw createError({
        code: ERROR_CODES.CONTEXT_UNRESOLVED,
        message: `verify-mixin-target requires a binary jar but artifact "${resolved.artifactId}" has none.`,
        details: { artifactId: resolved.artifactId, owner }
      });
    }
    let signature: ExplorerSignatureOutput;
    try {
      signature = await this.deps.getSignature({
        fqn: owner,
        jarPath: resolved.binaryJarPath,
        access: "all",
        includeSynthetic: false,
        includeInherited: false
      });
    } catch (error) {
      if (isAppError(error) && error.code === ERROR_CODES.CLASS_NOT_FOUND) {
        throw createError({
          code: ERROR_CODES.CLASS_NOT_FOUND,
          message: error.message,
          details: {
            ...(error.details ?? {}),
            owner,
            artifactId: resolved.artifactId,
            nextAction: `Use find-class to locate the canonical FQCN for "${owner}" before retrying verify-mixin-target.`,
            ...buildSuggestedCall({
              tool: "find-class",
              params: {
                artifactId: resolved.artifactId,
                className: owner.includes(".") ? owner.slice(owner.lastIndexOf(".") + 1) : owner
              }
            })
          }
        });
      }
      throw error;
    }
    warnings.push(...(signature.warnings ?? []));

    const memberPool: ExplorerSignatureMember[] =
      member.kind === "method"
        ? [...signature.constructors, ...signature.methods]
        : [...signature.fields];
    const allMemberNames = memberPool.map((m) => m.name);
    const exactNameHits = memberPool.filter((m) => m.name === memberName);
    let matches: VerifyMixinTargetMatch[];
    let candidates: VerifyMixinTargetCandidate[] = [];
    if (member.descriptor) {
      const descriptorHits = exactNameHits.filter((m) => m.jvmDescriptor === member.descriptor);
      if (descriptorHits.length > 0) {
        matches = descriptorHits.map((m) => buildMatch(m, member.kind));
      } else {
        matches = [];
        candidates = exactNameHits.map((m) => ({
          name: m.name,
          descriptor: m.jvmDescriptor,
          reason: `name match, descriptor ${m.jvmDescriptor} differs from requested ${member.descriptor}`
        }));
      }
    } else {
      matches = exactNameHits.map((m) => buildMatch(m, member.kind));
    }

    if (matches.length === 0 && candidates.length === 0) {
      const suggestions = suggestSimilar(memberName, allMemberNames);
      candidates = suggestions.flatMap((suggestion) =>
        memberPool
          .filter((m) => m.name === suggestion)
          .map((m) => ({
            name: m.name,
            descriptor: m.jvmDescriptor,
            reason: `name "${m.name}" is similar to requested "${memberName}"`
          }))
      );
    }

    const exists = matches.length > 0;
    let accessorAdvice: AccessorAdvice | undefined;
    if (matches.length === 1) {
      accessorAdvice = inferAnnotation(member, matches[0]!, input.mixinMemberName);
    }

    return {
      exists,
      resolvedOwner: { className: owner, mapping: resolved.mappingApplied },
      matches,
      candidates,
      ...(accessorAdvice ? { accessorAdvice } : {}),
      warnings,
      provenance: {
        artifactId: resolved.artifactId,
        mappingNamespace: resolved.mappingApplied,
        ...(resolved.provenance?.workspaceResolution
          ? { workspaceResolution: resolved.provenance.workspaceResolution }
          : {}),
        ...(resolved.provenance?.dependencyResolution
          ? { dependencyResolution: resolved.provenance.dependencyResolution }
          : {})
      }
    };
  }

  /**
   * Translate owner + member from the request namespace into the artifact
   * namespace via find-mapping, so a caller looking at yarn/intermediary
   * sources can verify against an obfuscated artifact in one call. Throws a
   * namespace-mismatch (or invalid-input) error when translation is impossible.
   */
  private async applyAutoRemap(
    input: VerifyMixinTargetInput,
    resolved: { mappingApplied: SourceMapping; artifactId: string; version?: string },
    owner: string,
    member: VerifyMixinTargetInput["member"],
    warnings: string[]
  ): Promise<{ owner: string; member: VerifyMixinTargetInput["member"] }> {
    const sourceMapping = input.mapping!;
    const targetMapping = resolved.mappingApplied;
    const mismatchDetails = {
      owner,
      member: member.name,
      requestedMapping: sourceMapping,
      mappingApplied: targetMapping,
      artifactId: resolved.artifactId
    };
    if (!this.deps.findMapping) {
      throw createError({
        code: ERROR_CODES.NAMESPACE_MISMATCH,
        message: `autoRemap is unavailable (no mapping translator configured); supply owner/member in the artifact namespace ("${targetMapping}").`,
        details: mismatchDetails
      });
    }
    const version = resolved.version ?? (input.target?.kind === "version" ? input.target.value : undefined);
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `autoRemap needs a Minecraft version to translate names; use target.kind="version" or a workspace that resolves one.`,
        details: mismatchDetails
      });
    }

    const classResult = await this.deps.findMapping({
      version,
      kind: "class",
      name: owner,
      sourceMapping,
      targetMapping
    });
    if (!classResult.resolved || !classResult.resolvedSymbol) {
      throw createError({
        code: ERROR_CODES.NAMESPACE_MISMATCH,
        message: `autoRemap could not translate owner "${owner}" from ${sourceMapping} to ${targetMapping}.`,
        details: {
          ...mismatchDetails,
          nextAction: `Confirm "${owner}" exists in ${sourceMapping} for ${version}, or supply owner/member already in ${targetMapping}.`
        }
      });
    }
    const translatedOwner = classResult.resolvedSymbol.name;

    // Look the member up by its source-namespace owner so find-mapping can
    // locate it, then take the translated name/descriptor.
    const memberResult = await this.deps.findMapping({
      version,
      kind: member.kind,
      name: member.name,
      owner,
      descriptor: member.descriptor,
      sourceMapping,
      targetMapping
    });
    if (!memberResult.resolved || !memberResult.resolvedSymbol) {
      throw createError({
        code: ERROR_CODES.NAMESPACE_MISMATCH,
        message: `autoRemap could not translate ${member.kind} "${member.name}" of "${owner}" from ${sourceMapping} to ${targetMapping}.`,
        details: mismatchDetails
      });
    }
    // Use the translated (target-namespace) descriptor only. Never fall back to
    // the request descriptor: it is still in the source namespace and would
    // never match the artifact's jvmDescriptor, turning a real member into a
    // false exists=false. When no descriptor could be translated, match by name.
    const translatedDescriptor = memberResult.resolvedSymbol.descriptor;
    if (member.descriptor && !translatedDescriptor) {
      warnings.push(
        `autoRemap could not translate the descriptor for ${member.kind} "${member.name}" into ${targetMapping}; matching by name only.`
      );
    }
    const translatedMember = (
      member.kind === "method"
        ? { kind: "method", name: memberResult.resolvedSymbol.name, ...(translatedDescriptor ? { descriptor: translatedDescriptor } : {}) }
        : { kind: "field", name: memberResult.resolvedSymbol.name, ...(translatedDescriptor ? { descriptor: translatedDescriptor } : {}) }
    ) as VerifyMixinTargetInput["member"];

    warnings.push(
      `autoRemap translated the target from ${sourceMapping} to ${targetMapping} (artifact namespace): `
      + `${owner}#${member.name} -> ${translatedOwner}#${translatedMember.name}.`
    );
    return { owner: translatedOwner, member: translatedMember };
  }
}

const memberDescriptorSchema = z.string().trim().min(1).optional();
const verifyMixinTargetMemberSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("method"),
    name: z.string().trim().min(1),
    descriptor: memberDescriptorSchema
  }),
  z.object({
    kind: z.literal("field"),
    name: z.string().trim().min(1),
    descriptor: memberDescriptorSchema
  })
]);

export const verifyMixinTargetMemberSchemaExport = verifyMixinTargetMemberSchema;
