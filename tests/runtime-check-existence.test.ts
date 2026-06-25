import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES, createError } from "../src/errors.ts";
import { checkSymbolExistsInUnobfuscatedRuntime } from "../src/source/lifecycle/runtime-check.ts";
import type { SignatureMember } from "../src/minecraft-explorer-service.ts";
import type {
  CheckSymbolExistsInput,
  CheckSymbolExistsOutput,
  SourceService
} from "../src/source-service.ts";

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
    signatureMode: "name-only"
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

test("a class missing from the runtime jar yields a clear 'not found' warning (B4)", async () => {
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
