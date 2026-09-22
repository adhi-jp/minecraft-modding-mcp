import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * Regression: the "intermediary/yarn need a version" refusal offered a recovery
 * call of `target: { kind: "version", value }` built from the CALLER's target
 * value. For the only target kind that reaches it — `kind: "jar"` — that value
 * is a file path, so the suggestion told the caller to resolve a jar path as a
 * Minecraft version and could never succeed.
 */

async function rejectionDetails(input: {
  rootPrefix: string;
  mapping: "intermediary" | "yarn";
  scope?: "vanilla" | "merged" | "loader";
}): Promise<{ jarPath: string; details: Record<string, unknown> }> {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
  const jarPath = join(root, "no-version-sources.jar");
  await createJar(jarPath, {
    "com/example/NoVersion.java": "package com.example;\npublic class NoVersion {}"
  });

  const service = new SourceService(buildTestConfig(root));
  let captured: Record<string, unknown> | undefined;
  await assert.rejects(
    () =>
      service.resolveArtifact({
        target: { kind: "jar", value: jarPath },
        mapping: input.mapping,
        ...(input.scope ? { scope: input.scope } : {})
      } as never),
    (error: Error & { code?: string; details?: Record<string, unknown> }) => {
      assert.equal(error.code, ERROR_CODES.MAPPING_NOT_APPLIED);
      captured = error.details ?? {};
      return true;
    }
  );
  return { jarPath, details: captured ?? {} };
}

test("a jar target's mapping refusal offers a version template, never the jar path as a version", async () => {
  const { jarPath, details } = await rejectionDetails({
    rootPrefix: "mapping-suggestion-",
    mapping: "intermediary"
  });

  // A `suggestedCall` is replayed verbatim, so this branch — which by
  // definition knows no version — must not produce one.
  assert.equal(details.suggestedCall, undefined);

  const examples = details.exampleCalls as Array<{
    tool: string;
    params: { target?: { kind?: string; value?: string } };
    reason: string;
  }>;
  assert.equal(examples?.length, 1);
  assert.equal(examples[0]?.tool, "resolve-artifact");
  assert.deepEqual(examples[0]?.params.target, { kind: "version", value: "<your-mc-version>" });
  assert.match(String(examples[0]?.reason), /your-mc-version/);

  // The jar path must not survive anywhere in the recovery advice.
  assert.equal(
    JSON.stringify({ suggestedCall: details.suggestedCall, exampleCalls: details.exampleCalls }).includes(
      jarPath
    ),
    false
  );
});

test("the version template keeps the scope the caller asked for", async () => {
  const { details } = await rejectionDetails({
    rootPrefix: "mapping-suggestion-scope-",
    mapping: "yarn",
    scope: "merged"
  });

  const examples = details.exampleCalls as Array<{ params: Record<string, unknown> }>;
  assert.equal(examples?.length, 1);
  assert.equal(examples[0]?.params.scope, "merged");
});
