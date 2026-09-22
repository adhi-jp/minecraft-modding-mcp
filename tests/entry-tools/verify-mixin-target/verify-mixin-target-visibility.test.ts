import assert from "node:assert/strict";
import test from "node:test";

import {
  VerifyMixinTargetService,
  type VerifyMixinTargetDeps
} from "../../../src/entry-tools/verify-mixin-target-service.ts";

type Member = {
  ownerFqn: string;
  name: string;
  javaSignature: string;
  jvmDescriptor: string;
  accessFlags: number;
  isSynthetic: boolean;
};

function buildDeps(members: { fields?: Member[]; methods?: Member[] }): VerifyMixinTargetDeps {
  return {
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.21.10",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      provenance: undefined,
      warnings: []
    }),
    getSignature: async () => ({
      constructors: [],
      methods: members.methods ?? [],
      fields: members.fields ?? [],
      warnings: []
    })
  };
}

const baseInput = {
  owner: "net.minecraft.world.entity.LivingEntity",
  target: { kind: "version" as const, value: "1.21.10" }
};

test("package-private field without mixinMemberName is described as package-private, not private", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "airSupply",
          javaSignature: "int airSupply",
          jvmDescriptor: "I",
          accessFlags: 0x0000, // no access bits set -> package-private
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "airSupply" }
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Shadow", "suggestedAnnotation must not change");
  assert.match(result.accessorAdvice?.reasoning ?? "", /package-private/i);
  assert.doesNotMatch(result.accessorAdvice?.reasoning ?? "", /\bis private\b/i);
});

test("package-private method without mixinMemberName is described as package-private, not private", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "doInternal",
          javaSignature: "void doInternal()",
          jvmDescriptor: "()V",
          accessFlags: 0x0000, // package-private
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "doInternal" }
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, null, "suggestedAnnotation must not change");
  assert.match(result.accessorAdvice?.reasoning ?? "", /package-private/i);
  assert.doesNotMatch(result.accessorAdvice?.reasoning ?? "", /\bis private\b/i);
  const candidates = result.accessorAdvice?.candidates ?? [];
  assert.equal(candidates.length, 2, "must still offer @Shadow and @Invoker candidates");
  for (const candidate of candidates) {
    assert.match(candidate.reasoning, /package-private/i, `candidate ${candidate.annotation} reasoning: ${candidate.reasoning}`);
    assert.doesNotMatch(candidate.reasoning, /\bthe private\b/i, `candidate ${candidate.annotation} reasoning: ${candidate.reasoning}`);
  }
});

test("package-private field with a mixinMemberName that doesn't match accessor conventions is described as package-private", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "airSupply",
          javaSignature: "int airSupply",
          jvmDescriptor: "I",
          accessFlags: 0x0000, // package-private
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "airSupply" },
    mixinMemberName: "customName"
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Shadow", "suggestedAnnotation must not change");
  assert.match(result.accessorAdvice?.reasoning ?? "", /package-private/i);
  assert.doesNotMatch(result.accessorAdvice?.reasoning ?? "", /\bis private\b/i);
});
