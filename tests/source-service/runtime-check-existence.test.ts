import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, createError } from "../../src/errors.ts";
import { checkSymbolExistsInUnobfuscatedRuntime } from "../../src/source/lifecycle/runtime-check.ts";
import type { SignatureMember } from "../../src/minecraft-explorer-service.ts";
import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  SourceService
} from "../../src/source-service.ts";

function method(name: string, descriptor: string): SignatureMember {
  return {
    ownerFqn: "net.minecraft.world.level.block.Block",
    name,
    javaSignature: `public void ${name}()`,
    jvmDescriptor: descriptor,
    accessFlags: 0x0001,
    isSynthetic: false
  } as SignatureMember;
}

type GetSignatureInput = { fqn: string; jarPath: string; access?: string; includeInherited?: boolean };

function buildSvc(opts: {
  constructors?: SignatureMember[];
  methods?: SignatureMember[];
  fields?: SignatureMember[];
  throwError?: unknown;
  capture?: (input: GetSignatureInput) => void;
}): SourceService {
  return {
    versionService: {
      resolveVersionJar: async (_version: string) => ({ jarPath: "/fake/26.2.jar" })
    },
    explorerService: {
      getSignature: async (input: GetSignatureInput) => {
        opts.capture?.(input);
        if (opts.throwError) {
          throw opts.throwError;
        }
        return {
          constructors: opts.constructors ?? [],
          methods: opts.methods ?? [],
          fields: opts.fields ?? [],
          warnings: [],
          context: {}
        };
      }
    }
  } as unknown as SourceService;
}

const baseInput = (over: Partial<CheckSymbolExistsInput>): CheckSymbolExistsInput =>
  ({
    version: "26.2",
    kind: "method",
    name: "animateTick",
    owner: "net.minecraft.world.level.block.Block",
    sourceMapping: "mojang",
    signatureMode: "name-only",
    ...over
  } as unknown as CheckSymbolExistsInput);

const fallbackBase = { warnings: [] } as unknown as CheckSymbolExistsOutput;

test("name-only method with MULTIPLE overloads resolves (exists), not ambiguous", async () => {
  const svc = buildSvc({
    methods: [method("animateTick", "()V"), method("animateTick", "(I)V")]
  });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(svc, baseInput({}), fallbackBase);
  assert.ok(out);
  assert.equal(out!.status, "resolved");
  assert.equal(out!.resolved, true);
});

test("exact method whose overridden copy is inherited resolves, not ambiguous", async () => {
  // includeInherited surfaces both the owner's own copy and the supertype's copy of an
  // overridden method: same name + descriptor, different owner. That is one logical
  // method, so an exact-descriptor existence check must resolve, not report ambiguous.
  const svc = buildSvc({
    methods: [
      { ...method("getShape", "()V"), ownerFqn: "net.minecraft.world.level.block.StairBlock" },
      method("getShape", "()V")
    ]
  });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(
    svc,
    baseInput({ name: "getShape", signatureMode: "exact", descriptor: "()V" } as Partial<CheckSymbolExistsInput>),
    fallbackBase
  );
  assert.ok(out);
  assert.equal(out!.status, "resolved");
  assert.equal(out!.resolved, true);
});

test("exact method with no descriptor match is not_found", async () => {
  const svc = buildSvc({ methods: [method("animateTick", "()V")] });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(
    svc,
    baseInput({ signatureMode: "exact", descriptor: "(I)V" } as Partial<CheckSymbolExistsInput>),
    fallbackBase
  );
  assert.ok(out);
  assert.equal(out!.status, "not_found");
  assert.equal(out!.resolved, false);
});

test("name-only method with no match is not_found", async () => {
  const svc = buildSvc({ methods: [method("somethingElse", "()V")] });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(svc, baseInput({}), fallbackBase);
  assert.ok(out);
  assert.equal(out!.status, "not_found");
  assert.equal(out!.resolved, false);
});

test("method existence requests inherited members (includeInherited: true)", async () => {
  let captured: GetSignatureInput | undefined;
  const svc = buildSvc({
    methods: [method("animateTick", "()V")],
    capture: (input) => {
      captured = input;
    }
  });
  await checkSymbolExistsInUnobfuscatedRuntime(svc, baseInput({}), fallbackBase);
  assert.equal(captured?.includeInherited, true);
});

test("a class missing from the runtime jar yields a clear 'not found' warning", async () => {
  const svc = buildSvc({
    throwError: createError({
      code: ERROR_CODES.CLASS_NOT_FOUND,
      message: "Class not found."
    })
  });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(svc, baseInput({}), fallbackBase);
  assert.ok(out);
  assert.ok(
    out!.warnings.some((w) => /was not found in the Minecraft .* runtime jar/.test(w)),
    `expected a clear class-missing warning, got: ${JSON.stringify(out!.warnings)}`
  );
});

// The bytecode reader lists constructors under `constructors`, never under `methods`,
// so a "<init>" query answered from `methods` alone reported every constructor missing.
const BLOCK_CONSTRUCTOR = method("<init>", "(Lnet/minecraft/world/level/block/state/BlockBehaviour$Properties;)V");

test("exact <init> query with an existing constructor descriptor resolves", async () => {
  const svc = buildSvc({ constructors: [BLOCK_CONSTRUCTOR], methods: [method("animateTick", "()V")] });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(
    svc,
    baseInput({
      name: "<init>",
      signatureMode: "exact",
      descriptor: "(Lnet/minecraft/world/level/block/state/BlockBehaviour$Properties;)V"
    } as Partial<CheckSymbolExistsInput>),
    fallbackBase
  );
  assert.equal(out?.status, "resolved");
  assert.equal(out?.resolved, true);
  assert.equal(
    out?.resolvedSymbol?.descriptor,
    "(Lnet/minecraft/world/level/block/state/BlockBehaviour$Properties;)V"
  );
});

test("exact <init> query whose descriptor matches no constructor is not_found", async () => {
  const svc = buildSvc({ constructors: [BLOCK_CONSTRUCTOR] });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(
    svc,
    baseInput({ name: "<init>", signatureMode: "exact", descriptor: "()V" } as Partial<CheckSymbolExistsInput>),
    fallbackBase
  );
  assert.equal(out?.status, "not_found");
  assert.equal(out?.resolved, false);
});

test("name-only <init> query resolves when the class declares a constructor", async () => {
  const svc = buildSvc({ constructors: [BLOCK_CONSTRUCTOR] });
  const out = await checkSymbolExistsInUnobfuscatedRuntime(svc, baseInput({ name: "<init>" }), fallbackBase);
  assert.equal(out?.status, "resolved");
  assert.equal(out?.resolved, true);
});

test("an unverifiable runtime lookup keeps check-symbol-exists's own status and adds the reason", async () => {
  // check-symbol-exists hands in the mapping service's own result as the base; when the
  // runtime check cannot answer, that status is what the tool keeps reporting.
  const notFoundBase = { status: "not_found", resolved: false, warnings: ["graph miss"] } as unknown as CheckSymbolExistsOutput;
  const shortName = await checkSymbolExistsInUnobfuscatedRuntime(
    buildSvc({}),
    baseInput({ kind: "class", name: "Block", owner: undefined }),
    notFoundBase
  );
  const unreadable = await checkSymbolExistsInUnobfuscatedRuntime(
    buildSvc({ throwError: Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }) }),
    baseInput({}),
    notFoundBase
  );

  for (const out of [shortName, unreadable]) {
    assert.equal(out?.status, "not_found");
    assert.equal(out?.resolved, false);
    assert.equal(out?.warnings[0], "graph miss");
    assert.equal(out?.warnings.length, 2);
  }
  assert.match(shortName?.warnings[1] ?? "", /short class name "Block" could not be checked/);
  assert.match(unreadable?.warnings[1] ?? "", /runtime bytecode lookup could not load class/);
});
