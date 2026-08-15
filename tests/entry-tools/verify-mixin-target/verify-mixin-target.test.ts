import assert from "node:assert/strict";
import test from "node:test";

import { createError, ERROR_CODES, isAppError } from "../../../src/errors.ts";
import {
  VerifyMixinTargetService,
  type VerifyMixinTargetDeps,
  type VerifyMixinTargetInput
} from "../../../src/entry-tools/verify-mixin-target-service.ts";

type Member = {
  ownerFqn: string;
  name: string;
  javaSignature: string;
  jvmDescriptor: string;
  accessFlags: number;
  isSynthetic: boolean;
};

function buildDeps(members: {
  constructors?: Member[];
  fields?: Member[];
  methods?: Member[];
  resolveError?: Error;
  signatureError?: Error;
  workspaceProvenance?: { projectPath: string; cacheHit?: boolean };
}): VerifyMixinTargetDeps {
  return {
    resolveArtifact: async () => {
      if (members.resolveError) throw members.resolveError;
      return {
        artifactId: "minecraft-1.21.10",
        mappingApplied: "obfuscated",
        binaryJarPath: "/tmp/fake.jar",
        provenance: members.workspaceProvenance
          ? ({
              target: { kind: "version", value: "1.21.10" },
              resolvedAt: new Date().toISOString(),
              resolvedFrom: { origin: "local-jar" },
              transformChain: [],
              workspaceResolution: {
                projectPath: members.workspaceProvenance.projectPath,
                detected: { minecraftVersion: "1.21.10" },
                source: "test",
                cacheHit: members.workspaceProvenance.cacheHit ?? false,
                warnings: []
              }
            } as unknown as never)
          : undefined,
        warnings: []
      };
    },
    getSignature: async () => {
      if (members.signatureError) throw members.signatureError;
      return {
        constructors: members.constructors ?? [],
        methods: members.methods ?? [],
        fields: members.fields ?? [],
        warnings: []
      };
    }
  };
}

const baseInput: Omit<VerifyMixinTargetInput, "member"> = {
  owner: "net.minecraft.world.entity.LivingEntity",
  target: { kind: "version", value: "1.21.10" }
};

test("C1: existing method with explicit descriptor returns exists=true and matches=1", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "tick",
          javaSignature: "public void tick()",
          jvmDescriptor: "()V",
          accessFlags: 0x0001,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "tick", descriptor: "()V" }
  });
  assert.equal(result.exists, true);
  assert.equal(result.matches.length, 1);
  assert.ok(result.accessorAdvice);
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Inject-only");
});

test("C2: existing method with descriptor omitted returns all overloads as matches", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "tick",
          javaSignature: "public void tick()",
          jvmDescriptor: "()V",
          accessFlags: 0x0001,
          isSynthetic: false
        },
        {
          ownerFqn: "Owner",
          name: "tick",
          javaSignature: "public void tick(int)",
          jvmDescriptor: "(I)V",
          accessFlags: 0x0001,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "tick" }
  });
  assert.equal(result.exists, true);
  assert.equal(result.matches.length, 2);
  assert.equal(result.candidates.length, 0);
  assert.equal(
    result.accessorAdvice,
    undefined,
    "accessorAdvice must NOT be emitted for ambiguous overloads (matches.length > 1)"
  );
});

test("C3: name match with descriptor mismatch returns exists=false plus descriptor candidates", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "tick",
          javaSignature: "public void tick(int)",
          jvmDescriptor: "(I)V",
          accessFlags: 0x0001,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "tick", descriptor: "()V" }
  });
  assert.equal(result.exists, false);
  assert.equal(result.matches.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0]!.reason, /descriptor.*differs/);
  assert.equal(
    result.accessorAdvice,
    undefined,
    "accessorAdvice must NOT be emitted when exists=false"
  );
});

test("C4: method not found by name returns nearest neighbors via suggestSimilar", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "tickServer",
          javaSignature: "public void tickServer()",
          jvmDescriptor: "()V",
          accessFlags: 0x0001,
          isSynthetic: false
        },
        {
          ownerFqn: "Owner",
          name: "tickEnd",
          javaSignature: "public void tickEnd()",
          jvmDescriptor: "()V",
          accessFlags: 0x0001,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "tickServr" }
  });
  assert.equal(result.exists, false);
  assert.ok(result.candidates.length >= 1);
  assert.equal(
    result.candidates.some((c) => c.name === "tickServer"),
    true
  );
  assert.equal(
    result.accessorAdvice,
    undefined,
    "accessorAdvice must NOT be emitted when exists=false"
  );
});

test("C5: private field without mixinMemberName returns @Shadow", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "airSupply",
          javaSignature: "private int airSupply",
          jvmDescriptor: "I",
          accessFlags: 0x0002,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "airSupply" }
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Shadow");
  assert.match(result.accessorAdvice?.exampleSnippet ?? "", /@Shadow\nprivate /);
});

test("C5b: private method without mixinMemberName returns null + candidates", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "doInternal",
          javaSignature: "private void doInternal()",
          jvmDescriptor: "()V",
          accessFlags: 0x0002,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "doInternal" }
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, null);
  assert.equal(result.accessorAdvice?.candidates?.length, 2);
  const annotations = result.accessorAdvice?.candidates?.map((c) => c.annotation) ?? [];
  assert.ok(annotations.includes("@Shadow"));
  assert.ok(annotations.includes("@Invoker"));
});

test("C6: private field with getXxx mixinMemberName returns @Accessor", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "airSupply",
          javaSignature: "private int airSupply",
          jvmDescriptor: "I",
          accessFlags: 0x0002,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "airSupply" },
    mixinMemberName: "getAirSupply"
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Accessor");
  assert.match(result.accessorAdvice?.exampleSnippet ?? "", /@Accessor\("airSupply"\)/);
});

test("C7: private method with invokeXxx mixinMemberName returns @Invoker", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "doInternal",
          javaSignature: "private void doInternal()",
          jvmDescriptor: "()V",
          accessFlags: 0x0002,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "doInternal" },
    mixinMemberName: "invokeDoInternal"
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Invoker");
  assert.match(result.accessorAdvice?.exampleSnippet ?? "", /@Invoker\("doInternal"\)/);
});

test("C8: public method returns @Inject-only with reasoning", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "tick",
          javaSignature: "public void tick()",
          jvmDescriptor: "()V",
          accessFlags: 0x0001,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "method", name: "tick" }
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Inject-only");
  assert.match(result.accessorAdvice?.reasoning ?? "", /already visible/i);
});

test("C9: workspace target populates provenance.workspaceResolution", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        {
          ownerFqn: "Owner",
          name: "tick",
          javaSignature: "public void tick()",
          jvmDescriptor: "()V",
          accessFlags: 0x0001,
          isSynthetic: false
        }
      ],
      workspaceProvenance: { projectPath: "/workspace/demo-mod", cacheHit: false }
    })
  );
  const result = await service.execute({
    owner: "Owner",
    member: { kind: "method", name: "tick" },
    target: { kind: "workspace" },
    projectPath: "/workspace/demo-mod"
  });
  assert.ok(result.provenance.workspaceResolution);
  assert.equal(result.provenance.workspaceResolution!.projectPath, "/workspace/demo-mod");
});

test("C10: owner not found rethrows ERR_CLASS_NOT_FOUND with find-class suggestedCall", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      signatureError: createError({
        code: ERROR_CODES.CLASS_NOT_FOUND,
        message: "Class \"Owner\" was not found."
      })
    })
  );
  await assert.rejects(
    () =>
      service.execute({
        owner: "Owner",
        member: { kind: "method", name: "tick" },
        target: { kind: "version", value: "1.21.10" }
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.CLASS_NOT_FOUND);
      const details = (err as { details?: { suggestedCall?: { tool?: string } } }).details ?? {};
      assert.equal(details.suggestedCall?.tool, "find-class");
      return true;
    }
  );
});

test("C11: VERIFY_MIXIN_TARGET_OFF=1 hides the tool from tools/list and rejects direct calls", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
    import assert from "node:assert/strict";
    import { VerifyMixinTargetService, VERIFY_MIXIN_TARGET_OFF } from "./src/entry-tools/verify-mixin-target-service.ts";
    assert.equal(VERIFY_MIXIN_TARGET_OFF, true);
    const service = new VerifyMixinTargetService({
      resolveArtifact: async () => { throw new Error("should not be called"); },
      getSignature: async () => { throw new Error("should not be called"); }
    });
    let threw = false;
    try {
      await service.execute({
        owner: "Owner",
        member: { kind: "method", name: "tick" },
        target: { kind: "version", value: "1.21.10" }
      });
    } catch (error) {
      threw = true;
      assert.match((error).message, /VERIFY_MIXIN_TARGET_OFF/);
    }
    assert.equal(threw, true);

    // tools/list path: importing index.ts must not register verify-mixin-target.
    // Drive the real factory through the public in-process transport; the
    // specifier resolves against the subprocess cwd (repo root).
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.MCP_CACHE_DIR ??= join(tmpdir(), "verify-mixin-target-off-cache");
    const { startInProcessSession, legacyHandshake } = await import("./tests/stdio/inprocess-era-serve.ts");
    const session = await startInProcessSession();
    const handshake = await legacyHandshake(session, undefined, "c11-init");
    assert.equal(handshake.error, undefined);
    const frame = await session.request({ jsonrpc: "2.0", id: "c11-tools-list", method: "tools/list", params: {} });
    assert.equal(frame.error, undefined);
    assert.ok(Array.isArray(frame.result?.tools));
    const names = frame.result.tools.map((t) => t.name);
    assert.equal(names.includes("verify-mixin-target"), false);
    await session.close();
    console.log("OK");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, VERIFY_MIXIN_TARGET_OFF: "1" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test("C19: @Accessor setter template emits void with parameter (not zero-arg)", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "health",
          javaSignature: "private float health",
          jvmDescriptor: "F",
          accessFlags: 0x0002,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "health" },
    mixinMemberName: "setHealth"
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Accessor");
  const snippet = result.accessorAdvice?.exampleSnippet ?? "";
  assert.match(snippet, /void setHealth\(<type> value\);/, `setter must emit void with parameter; got: ${snippet}`);
  assert.doesNotMatch(snippet, /<returnType> setHealth\(\);/);
});

test("C19b: @Accessor getter template stays zero-arg with return type", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "airSupply",
          javaSignature: "private int airSupply",
          jvmDescriptor: "I",
          accessFlags: 0x0002,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "airSupply" },
    mixinMemberName: "getAirSupply"
  });
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Accessor");
  assert.match(result.accessorAdvice?.exampleSnippet ?? "", /<returnType> getAirSupply\(\);/);
});

test("C13: explicit input.mapping that differs from resolved.mappingApplied throws ERR_NAMESPACE_MISMATCH", async () => {
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.16.5",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      provenance: undefined,
      warnings: []
    }),
    getSignature: async () => {
      throw new Error("getSignature must NOT be reached when namespace mismatch is detected");
    }
  });
  await assert.rejects(
    () =>
      service.execute({
        owner: "net.minecraft.world.entity.LivingEntity",
        member: { kind: "method", name: "tick" },
        target: { kind: "version", value: "1.16.5" },
        mapping: "mojang"
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.NAMESPACE_MISMATCH);
      const details = (err as { details?: { mappingApplied?: string; requestedMapping?: string } }).details ?? {};
      assert.equal(details.requestedMapping, "mojang");
      assert.equal(details.mappingApplied, "obfuscated");
      return true;
    }
  );
});

test("C14: autoRemap translates owner+member across namespaces instead of throwing", async () => {
  const findMappingCalls: Array<{ kind: string; name: string }> = [];
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.21.10",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      version: "1.21.10",
      provenance: undefined,
      warnings: []
    }),
    findMapping: async (input) => {
      findMappingCalls.push({ kind: input.kind, name: input.name });
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { kind: "class", name: "a_obf", symbol: "a_obf" } };
      }
      return { resolved: true, resolvedSymbol: { kind: "method", name: "m_obf", owner: "a_obf", descriptor: "()V", symbol: "a_obf.m_obf" } };
    },
    getSignature: async (input) => {
      assert.equal(input.fqn, "a_obf", "getSignature must receive the translated (obfuscated) owner");
      return {
        constructors: [],
        methods: [
          { ownerFqn: "a_obf", name: "m_obf", javaSignature: "public void m_obf()", jvmDescriptor: "()V", accessFlags: 0x0001, isSynthetic: false }
        ],
        fields: [],
        warnings: []
      };
    }
  });

  const result = await service.execute({
    owner: "net.minecraft.world.entity.LivingEntity",
    member: { kind: "method", name: "tickServer", descriptor: "()V" },
    target: { kind: "version", value: "1.21.10" },
    mapping: "yarn",
    autoRemap: true
  });

  assert.equal(result.exists, true);
  assert.equal(result.resolvedOwner.className, "a_obf");
  assert.equal(result.matches.length, 1);
  assert.ok(
    result.warnings.some((w) => /autoRemap/.test(w) && /yarn/.test(w) && /obfuscated/.test(w)),
    "expected an autoRemap translation warning"
  );
  assert.deepEqual(findMappingCalls.map((c) => c.kind).sort(), ["class", "method"]);
});

test("C15: autoRemap surfaces a NAMESPACE_MISMATCH when the owner cannot be translated", async () => {
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.21.10",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      version: "1.21.10",
      provenance: undefined,
      warnings: []
    }),
    findMapping: async () => ({ resolved: false }),
    getSignature: async () => {
      throw new Error("getSignature must not be reached when translation fails");
    }
  });

  await assert.rejects(
    () =>
      service.execute({
        owner: "net.minecraft.world.entity.LivingEntity",
        member: { kind: "method", name: "tickServer" },
        target: { kind: "version", value: "1.21.10" },
        mapping: "yarn",
        autoRemap: true
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.NAMESPACE_MISMATCH);
      return true;
    }
  );
});

test("C16: autoRemap drops an untranslatable descriptor and matches by name", async () => {
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.21.10",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      version: "1.21.10",
      provenance: undefined,
      warnings: []
    }),
    findMapping: async (input) => {
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { kind: "class", name: "a_obf", symbol: "a_obf" } };
      }
      // Descriptorless mapping entry: no descriptor is returned for the member.
      return { resolved: true, resolvedSymbol: { kind: "method", name: "m_obf", owner: "a_obf" } };
    },
    getSignature: async () => ({
      constructors: [],
      methods: [
        { ownerFqn: "a_obf", name: "m_obf", javaSignature: "public void m_obf(cps)", jvmDescriptor: "(Lcps;)V", accessFlags: 0x0001, isSynthetic: false }
      ],
      fields: [],
      warnings: []
    })
  });

  const result = await service.execute({
    owner: "net.minecraft.world.entity.LivingEntity",
    // Source-namespace descriptor carries a class reference that cannot survive
    // a descriptorless translation; it must not leak into the obfuscated match.
    member: { kind: "method", name: "tick", descriptor: "(Lnet/minecraft/block/Block;)V" },
    target: { kind: "version", value: "1.21.10" },
    mapping: "yarn",
    autoRemap: true
  });

  assert.equal(result.exists, true, "member should match by name when the descriptor cannot be translated");
  assert.equal(result.matches.length, 1);
  assert.ok(
    result.warnings.some((w) => /descriptor/i.test(w) && /name only/i.test(w)),
    "expected a descriptor-not-translated, name-only warning"
  );
});

test("C17: autoRemap translates a field target", async () => {
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.21.10",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      version: "1.21.10",
      provenance: undefined,
      warnings: []
    }),
    findMapping: async (input) => {
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { kind: "class", name: "a_obf", symbol: "a_obf" } };
      }
      assert.equal(input.kind, "field");
      return { resolved: true, resolvedSymbol: { kind: "field", name: "f_obf", owner: "a_obf" } };
    },
    getSignature: async () => ({
      constructors: [],
      methods: [],
      fields: [
        { ownerFqn: "a_obf", name: "f_obf", javaSignature: "private int f_obf", jvmDescriptor: "I", accessFlags: 0x0002, isSynthetic: false }
      ],
      warnings: []
    })
  });

  const result = await service.execute({
    owner: "net.minecraft.world.entity.LivingEntity",
    member: { kind: "field", name: "airSupply" },
    target: { kind: "version", value: "1.21.10" },
    mapping: "yarn",
    autoRemap: true
  });

  assert.equal(result.exists, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]?.name, "f_obf");
});

test("C18: autoRemap throws NAMESPACE_MISMATCH when the member (not the owner) cannot be translated", async () => {
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.21.10",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      version: "1.21.10",
      provenance: undefined,
      warnings: []
    }),
    findMapping: async (input) => {
      if (input.kind === "class") {
        return { resolved: true, resolvedSymbol: { kind: "class", name: "a_obf", symbol: "a_obf" } };
      }
      // owner translates, but the member does not.
      return { resolved: false };
    },
    getSignature: async () => {
      throw new Error("getSignature must not be reached when member translation fails");
    }
  });

  await assert.rejects(
    () =>
      service.execute({
        owner: "net.minecraft.world.entity.LivingEntity",
        member: { kind: "method", name: "noSuchMethod" },
        target: { kind: "version", value: "1.21.10" },
        mapping: "yarn",
        autoRemap: true
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.NAMESPACE_MISMATCH);
      assert.match((err as { message: string }).message, /could not translate (method|field) "noSuchMethod"/);
      return true;
    }
  );
});

test("C12: exampleSnippet is deterministic for given (annotation, kind, accessFlags)", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "airSupply",
          javaSignature: "private int airSupply",
          jvmDescriptor: "I",
          accessFlags: 0x0002,
          isSynthetic: false
        }
      ]
    })
  );
  const a = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "airSupply" }
  });
  const b = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "airSupply" }
  });
  assert.equal(a.accessorAdvice?.exampleSnippet, b.accessorAdvice?.exampleSnippet);
});

test("C20: missing target throws ERR_INVALID_INPUT pointing at the target field", async () => {
  const service = new VerifyMixinTargetService(buildDeps({}));
  await assert.rejects(
    () =>
      service.execute({
        owner: "net.minecraft.world.entity.LivingEntity",
        member: { kind: "method", name: "tick" }
      } as VerifyMixinTargetInput),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.INVALID_INPUT);
      const details = (err as { details?: { fieldErrors?: Array<{ path?: string }> } }).details ?? {};
      assert.equal(details.fieldErrors?.[0]?.path, "target");
      return true;
    }
  );
});

test("C21: empty owner throws ERR_INVALID_INPUT", async () => {
  const service = new VerifyMixinTargetService(buildDeps({}));
  await assert.rejects(
    () =>
      service.execute({
        ...baseInput,
        owner: "   ",
        member: { kind: "method", name: "tick" }
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.INVALID_INPUT);
      assert.match((err as { message: string }).message, /owner must be non-empty/);
      return true;
    }
  );
});

test("C22: empty member.name throws ERR_INVALID_INPUT", async () => {
  const service = new VerifyMixinTargetService(buildDeps({}));
  await assert.rejects(
    () =>
      service.execute({
        ...baseInput,
        member: { kind: "method", name: "  " }
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.INVALID_INPUT);
      assert.match((err as { message: string }).message, /member\.name must be non-empty/);
      return true;
    }
  );
});

test("C23: resolved artifact without a binary jar throws ERR_CONTEXT_UNRESOLVED", async () => {
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-1.21.10",
      mappingApplied: "obfuscated",
      binaryJarPath: undefined,
      provenance: undefined,
      warnings: []
    }),
    getSignature: async () => {
      throw new Error("getSignature must not be reached when the binary jar is missing");
    }
  });
  await assert.rejects(
    () =>
      service.execute({
        ...baseInput,
        member: { kind: "method", name: "tick" }
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.CONTEXT_UNRESOLVED);
      const details = (err as { details?: { artifactId?: string } }).details ?? {};
      assert.equal(details.artifactId, "minecraft-1.21.10");
      return true;
    }
  );
});

test("C24: autoRemap without a findMapping translator throws ERR_NAMESPACE_MISMATCH", async () => {
  // buildDeps supplies no findMapping translator, so autoRemap cannot run.
  const service = new VerifyMixinTargetService(buildDeps({}));
  await assert.rejects(
    () =>
      service.execute({
        owner: "net.minecraft.world.entity.LivingEntity",
        member: { kind: "method", name: "tick" },
        target: { kind: "version", value: "1.21.10" },
        mapping: "yarn",
        autoRemap: true
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.NAMESPACE_MISMATCH);
      assert.match((err as { message: string }).message, /no mapping translator configured/);
      return true;
    }
  );
});

test("C25: autoRemap with no resolvable version throws ERR_INVALID_INPUT", async () => {
  // Translator present, but neither resolved.version nor a version-kind target
  // can supply a Minecraft version for find-mapping.
  const service = new VerifyMixinTargetService({
    resolveArtifact: async () => ({
      artifactId: "minecraft-workspace",
      mappingApplied: "obfuscated",
      binaryJarPath: "/tmp/fake.jar",
      version: undefined,
      provenance: undefined,
      warnings: []
    }),
    findMapping: async () => ({ resolved: false }),
    getSignature: async () => {
      throw new Error("getSignature must not be reached when the version cannot be resolved");
    }
  });
  await assert.rejects(
    () =>
      service.execute({
        owner: "net.minecraft.world.entity.LivingEntity",
        member: { kind: "method", name: "tick" },
        target: { kind: "workspace" },
        projectPath: "/workspace/demo-mod",
        mapping: "yarn",
        autoRemap: true
      }),
    (err: unknown) => {
      assert.ok(isAppError(err));
      assert.equal((err as { code: string }).code, ERROR_CODES.INVALID_INPUT);
      assert.match((err as { message: string }).message, /needs a Minecraft version/);
      return true;
    }
  );
});

test("C26: decodeAccessFlags labels static, final, abstract, and package-private members", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      methods: [
        { ownerFqn: "Owner", name: "pkg", javaSignature: "void pkg()", jvmDescriptor: "()V", accessFlags: 0x0000, isSynthetic: false },
        { ownerFqn: "Owner", name: "stat", javaSignature: "static void stat()", jvmDescriptor: "()V", accessFlags: 0x0008, isSynthetic: false },
        { ownerFqn: "Owner", name: "fin", javaSignature: "final void fin()", jvmDescriptor: "()V", accessFlags: 0x0010, isSynthetic: false },
        { ownerFqn: "Owner", name: "abs", javaSignature: "abstract void abs()", jvmDescriptor: "()V", accessFlags: 0x0400, isSynthetic: false }
      ]
    })
  );
  const expectations: Array<{ name: string; flags: string[] }> = [
    { name: "pkg", flags: ["package-private"] },
    { name: "stat", flags: ["static"] },
    { name: "fin", flags: ["final"] },
    { name: "abs", flags: ["abstract"] }
  ];
  for (const { name, flags } of expectations) {
    const result = await service.execute({
      ...baseInput,
      member: { kind: "method", name, descriptor: "()V" }
    });
    assert.equal(result.exists, true, name);
    assert.deepEqual(result.matches[0]?.accessFlags, flags, name);
  }
});

test("C27: @Shadow @Final snippet emitted for a private final field", async () => {
  const service = new VerifyMixinTargetService(
    buildDeps({
      fields: [
        {
          ownerFqn: "Owner",
          name: "MAX_HEALTH",
          javaSignature: "private final int MAX_HEALTH",
          jvmDescriptor: "I",
          accessFlags: 0x0002 | 0x0010,
          isSynthetic: false
        }
      ]
    })
  );
  const result = await service.execute({
    ...baseInput,
    member: { kind: "field", name: "MAX_HEALTH" }
  });
  assert.deepEqual(result.matches[0]?.accessFlags, ["private", "final"]);
  assert.equal(result.accessorAdvice?.suggestedAnnotation, "@Shadow");
  assert.match(result.accessorAdvice?.exampleSnippet ?? "", /@Shadow @Final\nprivate <type> MAX_HEALTH;/);
});

test("C28: getSignature errors other than CLASS_NOT_FOUND propagate unchanged", async () => {
  const boom = new Error("explorer backend exploded");
  const service = new VerifyMixinTargetService(buildDeps({ signatureError: boom }));
  await assert.rejects(
    () =>
      service.execute({
        ...baseInput,
        member: { kind: "method", name: "tick" }
      }),
    (err: unknown) => {
      // Non CLASS_NOT_FOUND failures are rethrown as-is (no find-class wrapping).
      assert.equal(err, boom);
      assert.equal(isAppError(err), false);
      return true;
    }
  );
});
