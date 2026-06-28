import assert from "node:assert/strict";
import test from "node:test";

import { checkSymbolExistsSchema, validateMixinSchema, getClassSourceSchema, getClassMembersSchema, verifyMixinTargetMemberSchema, findMappingSchema } from "../src/tool-schemas.ts";

test("check-symbol-exists accepts a dotless class name with the default nameMode", () => {
  const parsed = checkSymbolExistsSchema.safeParse({
    version: "1.21.10",
    kind: "class",
    name: "ItemStack",
    sourceMapping: "mojang"
  });

  assert.ok(
    parsed.success,
    parsed.success ? "" : `dotless class name should parse by default: ${JSON.stringify(parsed.error.issues)}`
  );
});

test("check-symbol-exists kind=method without descriptor is accepted by the default signatureMode", () => {
  // Default signatureMode is now name-only (was exact), so a method query needs no descriptor.
  const parsed = checkSymbolExistsSchema.safeParse({
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated"
  });
  assert.ok(parsed.success, parsed.success ? "" : `should parse by default: ${JSON.stringify(parsed.error.issues)}`);

  // signatureMode=exact still requires a descriptor for methods.
  const strict = checkSymbolExistsSchema.safeParse({
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated",
    signatureMode: "exact"
  });
  assert.equal(strict.success, false);
});

test("find-mapping accepts a dotless class name under the default nameMode and rejects it with nameMode=fqcn", () => {
  // Default nameMode=auto relaxes the FQCN requirement for any sourceMapping (was obfuscated-only).
  assert.equal(
    findMappingSchema.safeParse({
      version: "1.21.10",
      kind: "class",
      name: "ItemStack",
      sourceMapping: "mojang",
      targetMapping: "intermediary"
    }).success,
    true
  );
  // nameMode=fqcn still requires a fully-qualified name.
  assert.equal(
    findMappingSchema.safeParse({
      version: "1.21.10",
      kind: "class",
      name: "ItemStack",
      sourceMapping: "mojang",
      targetMapping: "intermediary",
      nameMode: "fqcn"
    }).success,
    false
  );
});

test("validate-mixin omits version requirement for project mode", () => {
  const parsed = validateMixinSchema.safeParse({
    input: { mode: "project", path: "/workspace" }
  });

  assert.ok(
    parsed.success,
    parsed.success ? "" : `project mode should not require version: ${JSON.stringify(parsed.error.issues)}`
  );
});

test("validate-mixin still requires version for inline mode without project detection", () => {
  const parsed = validateMixinSchema.safeParse({
    input: { mode: "inline", source: "class X {}" }
  });

  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(parsed.error.issues.some((issue) => issue.path.includes("version")));
  }
});

test("get-class-source/get-class-members targets use the unified kind shape and reject the legacy type:artifact shape", () => {
  // New unified shape: same kind-based vocabulary as resolve-artifact, plus kind:"artifact".
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { kind: "artifact", artifactId: "x" } }).success, true);
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { kind: "version", value: "1.21.10" } }).success, true);
  assert.equal(getClassMembersSchema.safeParse({ className: "a.B", target: { kind: "artifact", artifactId: "x" } }).success, true);
  assert.equal(getClassMembersSchema.safeParse({ className: "a.B", target: { kind: "dependency", group: "g", name: "n" } }).success, true);

  // The legacy `{type:"artifact",artifactId}` form (no `kind` discriminator) no longer validates —
  // it must migrate to `{kind:"artifact",artifactId}`.
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { type: "artifact", artifactId: "x" } }).success, false);
  assert.equal(getClassMembersSchema.safeParse({ className: "a.B", target: { type: "artifact", artifactId: "x" } }).success, false);

  // Back-compat: the redundant `{type:"resolve",...}` wrapper still validates — the discriminated
  // union keys on `kind` and the now-ignored `type` key is stripped.
  assert.equal(getClassSourceSchema.safeParse({ className: "a.B", target: { type: "resolve", kind: "version", value: "1.21.10" } }).success, true);
});

test("get-class-source/get-class-members schemas default includeProvenance to false and accept true", () => {
  const target = { kind: "artifact", artifactId: "x" } as const;
  const source = getClassSourceSchema.parse({ className: "a.B", target });
  assert.equal(source.includeProvenance, false);
  assert.equal(getClassSourceSchema.parse({ className: "a.B", target, includeProvenance: true }).includeProvenance, true);
  const members = getClassMembersSchema.parse({ className: "a.B", target });
  assert.equal(members.includeProvenance, false);
  assert.equal(getClassMembersSchema.parse({ className: "a.B", target, includeProvenance: true }).includeProvenance, true);
  // includeDescriptors defaults false and is accepted.
  assert.equal(members.includeDescriptors, false);
  assert.equal(getClassMembersSchema.parse({ className: "a.B", target, includeDescriptors: true }).includeDescriptors, true);
});

test("verify-mixin-target member schema normalizes empty/whitespace descriptor to undefined", () => {
  // Empty / whitespace descriptors must normalize to undefined (treated as omitted),
  // matching every other optional descriptor field (optionalDescriptorString).
  const emptyCases: Array<{ kind: "method" | "field"; name: string; descriptor: string }> = [
    { kind: "method", name: "tick", descriptor: "" },
    { kind: "method", name: "tick", descriptor: "   " },
    { kind: "field", name: "airSupply", descriptor: "" },
    { kind: "field", name: "airSupply", descriptor: "\t " }
  ];
  for (const input of emptyCases) {
    const parsed = verifyMixinTargetMemberSchema.safeParse(input);
    assert.equal(parsed.success, true, `${input.kind} descriptor ${JSON.stringify(input.descriptor)} must parse`);
    if (parsed.success) {
      assert.equal(parsed.data.descriptor, undefined, "empty descriptor must normalize to undefined");
    }
  }
  // Guard against over-loosening: a real descriptor must survive verbatim (trimmed).
  const real = verifyMixinTargetMemberSchema.safeParse({ kind: "method", name: "tick", descriptor: "()V" });
  assert.equal(real.success, true);
  if (real.success) {
    assert.equal(real.data.descriptor, "()V");
  }
});
