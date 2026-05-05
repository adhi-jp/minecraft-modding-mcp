import assert from "node:assert/strict";
import test from "node:test";

import {
  validateInjection,
  validateShadow,
  validateAccessor,
  type ResolvedTargetMembers,
  type ValidationIssue,
  type ResolvedMember
} from "../src/mixin-validator.ts";

const dummyMember = (name: string): ResolvedTargetMembers["methods"][number] => ({
  ownerFqn: "net.minecraft.world.entity.LivingEntity",
  name,
  javaSignature: `public void ${name}()`,
  jvmDescriptor: "()V",
  accessFlags: 0x0001,
  isSynthetic: false
});

const dummyField = (name: string): ResolvedTargetMembers["fields"][number] => ({
  ownerFqn: "net.minecraft.world.entity.LivingEntity",
  name,
  javaSignature: `public int ${name}`,
  jvmDescriptor: "I",
  accessFlags: 0x0002,
  isSynthetic: false
});

test("validateInjection is exported and resolves a hit against in-memory targetMembers", () => {
  const issues: ValidationIssue[] = [];
  const resolvedMembers: ResolvedMember[] = [];
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    [
      "net.minecraft.world.entity.LivingEntity",
      {
        className: "net.minecraft.world.entity.LivingEntity",
        constructors: [],
        fields: [],
        methods: [dummyMember("tick")]
      }
    ]
  ]);
  validateInjection(
    { annotation: "Inject", method: "tick", line: 10 },
    targetMembers,
    ["net.minecraft.world.entity.LivingEntity"],
    issues,
    resolvedMembers
  );
  assert.equal(issues.length, 0);
  assert.equal(resolvedMembers.length, 1);
  assert.equal(resolvedMembers[0]!.status, "resolved");
});

test("validateShadow is exported and reports missing field", () => {
  const issues: ValidationIssue[] = [];
  const resolvedMembers: ResolvedMember[] = [];
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    [
      "Owner",
      {
        className: "Owner",
        constructors: [],
        fields: [dummyField("airSupply")],
        methods: []
      }
    ]
  ]);
  validateShadow(
    { kind: "field", name: "missingField", line: 4 },
    targetMembers,
    ["Owner"],
    issues,
    resolvedMembers
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.kind, "field-not-found");
  assert.equal(resolvedMembers[0]!.status, "not-found");
});

test("validateAccessor is exported and resolves an @Accessor hit", () => {
  const issues: ValidationIssue[] = [];
  const resolvedMembers: ResolvedMember[] = [];
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    [
      "Owner",
      {
        className: "Owner",
        constructors: [],
        fields: [dummyField("airSupply")],
        methods: []
      }
    ]
  ]);
  validateAccessor(
    { annotation: "Accessor", name: "getAirSupply", targetName: "airSupply", line: 7 },
    targetMembers,
    ["Owner"],
    issues,
    resolvedMembers
  );
  assert.equal(issues.length, 0);
  assert.equal(resolvedMembers.length, 1);
  assert.equal(resolvedMembers[0]!.status, "resolved");
});
