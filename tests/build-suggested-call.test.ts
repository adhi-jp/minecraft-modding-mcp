import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MCP_CACHE_DIR ??= join(tmpdir(), "mcp-build-suggested-call-cache");

test.before(async () => {
  await mkdtemp(join(tmpdir(), "mcp-build-suggested-call-pre-"));
});

test("D5: valid params return suggestedCall with caller-supplied params (no safeParse re-emit)", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  // Omit `mode` and `compact` so the assertions below can confirm schema
  // defaults are NOT injected into the published payload.
  const callerParams = {
    className: "net.minecraft.world.entity.LivingEntity",
    target: { type: "resolve" as const, kind: "version" as const, value: "1.21.10" }
  };
  const out = buildSuggestedCall({ tool: "get-class-source", params: callerParams });
  assert.ok(out.suggestedCall, "expected suggestedCall to be present");
  assert.equal(out.suggestedCall!.tool, "get-class-source");
  assert.equal(out.suggestedCall!.params, callerParams);
  assert.equal((out.suggestedCall!.params as Record<string, unknown>).mode, undefined);
  assert.equal((out.suggestedCall!.params as Record<string, unknown>).compact, undefined);
  assert.equal(out.exampleCalls, undefined);
});

test("D6: invalid params with no examples returns no suggestedCall and no exampleCalls", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const out = buildSuggestedCall({
    tool: "get-class-members",
    params: {
      target: {
        type: "resolve",
        kind: "coordinate",
        value: "{\"type\": \"resolve\", \"kind\": \"version\", \"value\": \"1.21.10\"}"
      }
    }
  });
  assert.equal(out.suggestedCall, undefined);
  assert.equal(out.exampleCalls, undefined);
  // The internal marker tells mapErrorToProblem to add the fallback hint.
  assert.equal(out._suggestedCallPrimaryDropped, true);
});

test("D7: invalid primary + one valid example yields exampleCalls with only the valid one", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const out = buildSuggestedCall({
    tool: "get-class-source",
    params: { className: "" /* fails non-empty */ },
    examples: [
      {
        params: {
          className: "net.minecraft.world.entity.LivingEntity",
          target: { type: "resolve", kind: "version", value: "1.21.10" }
        },
        reason: "Use the resolve target to look up by Minecraft version."
      }
    ]
  });
  assert.equal(out.suggestedCall, undefined);
  assert.ok(out.exampleCalls);
  assert.equal(out.exampleCalls!.length, 1);
  assert.equal(out.exampleCalls![0]!.tool, "get-class-source");
  assert.equal(out.exampleCalls![0]!.valid, true);
  assert.equal(
    out.exampleCalls![0]!.reason,
    "Use the resolve target to look up by Minecraft version."
  );
});

test("D8: invalid primary + partially-valid examples returns only the validated subset", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const out = buildSuggestedCall({
    tool: "get-class-source",
    params: { className: "" },
    examples: [
      {
        params: { className: "" /* still invalid */ },
        reason: "Bad example — should be filtered."
      },
      {
        params: {
          className: "net.minecraft.world.level.block.Blocks",
          target: { type: "resolve", kind: "version", value: "1.21.10" }
        },
        reason: "Good example — should survive."
      }
    ]
  });
  assert.equal(out.suggestedCall, undefined);
  assert.ok(out.exampleCalls);
  assert.equal(out.exampleCalls!.length, 1);
  assert.equal(out.exampleCalls![0]!.reason, "Good example — should survive.");
});

test("invalid primary + no surviving examples returns no suggestedCall (marker present)", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const out = buildSuggestedCall({
    tool: "get-class-source",
    params: { className: "" },
    examples: [
      { params: { className: "" }, reason: "still bad" }
    ]
  });
  assert.equal(out.suggestedCall, undefined);
  assert.equal(out.exampleCalls, undefined);
  assert.equal(out._suggestedCallPrimaryDropped, true);
});

test("placeholder primary is not emitted as an executable suggestedCall", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const params = {
    className: "<fully-qualified-class-name>",
    target: { type: "resolve" as const, kind: "version" as const, value: "1.21.10" }
  };
  const out = buildSuggestedCall({ tool: "get-class-source", params });
  assert.equal(out.suggestedCall, undefined, "placeholder params must not become an executable suggestedCall");
  assert.equal(out._suggestedCallPrimaryDropped, true);
});

test("placeholder primary surfaces as an exampleCalls template when supplied as an example", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const params = {
    className: "<fully-qualified-class-name>",
    target: { type: "resolve" as const, kind: "version" as const, value: "1.21.10" }
  };
  const out = buildSuggestedCall({
    tool: "get-class-source",
    params,
    examples: [{ params, reason: "Replace <fully-qualified-class-name> with the real FQCN." }]
  });
  assert.equal(out.suggestedCall, undefined);
  assert.ok(out.exampleCalls);
  assert.equal(out.exampleCalls!.length, 1);
  assert.match(out.exampleCalls![0]!.params.className as string, /fully-qualified/);
});

test("constructor pseudo-name <init> is not treated as a placeholder", async () => {
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const out = buildSuggestedCall({
    tool: "find-mapping",
    params: {
      version: "1.21.10",
      kind: "method" as const,
      owner: "net/minecraft/world/item/Item",
      name: "<init>",
      descriptor: "()V",
      sourceMapping: "obfuscated" as const,
      targetMapping: "mojang" as const
    }
  });
  assert.ok(out.suggestedCall, "<init> is a valid JVM method name, not a placeholder");
  assert.equal(out.suggestedCall!.params.name, "<init>");
});

test("unknown tool name fails open: passes the caller payload through (registry-not-populated case)", async () => {
  // Service-level tests that do not boot src/index.ts run with an empty
  // registry; the gate falls open and passes the payload through. Callers
  // that synthesize the tool name from runtime data (e.g. an `?? "unknown"`
  // fallback) MUST skip the gate themselves so a non-callable payload
  // cannot escape via this branch.
  await import("../src/index.ts");
  const { buildSuggestedCall } = await import("../src/build-suggested-call.ts");
  const out = buildSuggestedCall({
    tool: "definitely-not-a-real-tool",
    params: { foo: "bar" },
    examples: [{ params: { foo: "bar" }, reason: "no schema to validate against" }]
  });
  assert.ok(out.suggestedCall);
  assert.equal(out.suggestedCall!.tool, "definitely-not-a-real-tool");
  assert.deepEqual(out.suggestedCall!.params, { foo: "bar" });
  assert.equal(out._suggestedCallPrimaryDropped, undefined);
});

test("D11: SUGGESTED_CALL_VALIDATE_OFF=1 bypasses validation (subprocess; module-load read)", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `
        const { buildSuggestedCall } = await import("./src/build-suggested-call.ts");
        const buggyParams = {
          target: {
            type: "resolve",
            kind: "coordinate",
            value: "{\\\"type\\\": \\\"resolve\\\", \\\"kind\\\": \\\"version\\\", \\\"value\\\": \\\"1.21.10\\\"}"
          }
        };
        const out = buildSuggestedCall({ tool: "get-class-members", params: buggyParams });
        process.stdout.write(JSON.stringify(out));
      `
    ],
    {
      env: { ...process.env, SUGGESTED_CALL_VALIDATE_OFF: "1" },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, `subprocess failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.ok(parsed.suggestedCall, "expected suggestedCall under bypass");
  const suggested = parsed.suggestedCall as { tool: string; params: Record<string, unknown> };
  assert.equal(suggested.tool, "get-class-members");
  // Bug-shaped payload emerges unchanged: target.value still holds the JSON string.
  const target = suggested.params.target as { value: unknown };
  assert.match(String(target.value), /^\{/);
  assert.equal(parsed.exampleCalls, undefined);
});
