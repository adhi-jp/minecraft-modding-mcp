/**
 * Shared fixtures for mixin-validator unit tests. Factored out of
 * tests/mixin-validator.test.ts when that file was split into per-feature
 * slices (utils / resolution / warnings / provenance / health / status-schema)
 * so the slices share one definition of the member/target/mixin/provenance
 * builders and the ValidationResult/ValidationIssue type aliases.
 */

import type { SignatureMember } from "../../src/minecraft-explorer-service.ts";
import type { ParsedMixin } from "../../src/mixin-parser.ts";
import {
  validateParsedMixin,
  type ResolvedTargetMembers,
  type MixinValidationProvenance
} from "../../src/mixin-validator.ts";

export type ValidationResult = ReturnType<typeof validateParsedMixin>;
export type ValidationIssue = ValidationResult["issues"][number];

export function makeMember(overrides: Partial<SignatureMember> & { name: string }): SignatureMember {
  return {
    ownerFqn: "net.minecraft.entity.player.PlayerEntity",
    javaSignature: "void " + overrides.name + "()",
    jvmDescriptor: "()V",
    accessFlags: 1,
    isSynthetic: false,
    ...overrides
  };
}

export function makeTargetMembers(className: string, opts: {
  methods?: string[];
  fields?: string[];
  constructors?: string[];
}): ResolvedTargetMembers {
  return {
    className,
    constructors: (opts.constructors ?? []).map((n) => makeMember({ name: n, ownerFqn: className })),
    methods: (opts.methods ?? []).map((n) => makeMember({ name: n, ownerFqn: className })),
    fields: (opts.fields ?? []).map((n) =>
      makeMember({ name: n, ownerFqn: className, javaSignature: "int " + n, jvmDescriptor: "I" })
    )
  };
}

export function makeParsedMixin(overrides: Partial<ParsedMixin> = {}): ParsedMixin {
  return {
    className: "TestMixin",
    targets: [{ className: "PlayerEntity" }],
    imports: new Map(),
    injections: [],
    shadows: [],
    accessors: [],
    parseWarnings: [],
    ...overrides
  };
}

export function makeProvenance(overrides: Partial<MixinValidationProvenance> = {}): MixinValidationProvenance {
  return {
    version: "1.21",
    jarPath: "/fake/jar.jar",
    requestedMapping: "mojang",
    mappingApplied: "mojang",
    ...overrides
  };
}
