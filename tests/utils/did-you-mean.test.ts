import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createError, ERROR_CODES } from "../../src/errors.ts";
import { SourceService } from "../../src/source-service.ts";
import { seedIndexedArtifact } from "../helpers/seed-artifact.ts";
import { buildTestConfig } from "../helpers/test-config.ts";

type DidYouMeanCandidate = { className: string; matchReason: string };

async function makeService(prefix: string): Promise<SourceService> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return new SourceService(buildTestConfig(root));
}

function seedClasses(
  service: SourceService,
  artifactId: string,
  classes: Array<{ fqn: string; simpleName: string }>
): void {
  seedIndexedArtifact(service, {
    artifactId,
    origin: "local-jar",
    requestedMapping: "obfuscated",
    mappingApplied: "obfuscated",
    qualityFlags: [],
    files: classes.map(({ fqn }) => ({
      filePath: `${fqn.replaceAll(".", "/")}.java`,
      content: `public class ${fqn.split(".").at(-1)} {}`
    })),
    symbols: classes.map(({ fqn, simpleName }) => ({
      filePath: `${fqn.replaceAll(".", "/")}.java`,
      symbolKind: "class",
      symbolName: simpleName,
      qualifiedName: fqn,
      line: 1
    }))
  });
}

test("a stale FQN lookup returns didYouMean naming the moved class with exact-simple-name reason", async () => {
  const service = await makeService("dym-stale-fqn-");
  seedClasses(service, "dym-artifact-1", [
    { fqn: "com.mojang.math.NewHome", simpleName: "NewHome" },
    { fqn: "net.minecraft.client.renderer.block.model.ItemTransform", simpleName: "ItemTransform" }
  ]);

  await assert.rejects(
    () =>
      service.getClassSource({
        className: "com.mojang.math.ItemTransform",
        artifactId: "dym-artifact-1",
        mapping: "obfuscated",
        mode: "full"
      }),
    (error: Error & { code?: string; details?: { didYouMean?: DidYouMeanCandidate[] } }) => {
      assert.equal(error.code, "ERR_CLASS_NOT_FOUND");
      assert.deepEqual(error.details?.didYouMean, [
        {
          className: "net.minecraft.client.renderer.block.model.ItemTransform",
          matchReason: "exact-simple-name"
        }
      ]);
      return true;
    }
  );
});

test("didYouMean ranks exact-simple-name candidates before edit-distance candidates", async () => {
  const service = await makeService("dym-ranking-");
  seedClasses(service, "dym-artifact-2", [
    { fqn: "com.example.typo.ItemTransfrm", simpleName: "ItemTransfrm" },
    { fqn: "com.example.moved.ItemTransform", simpleName: "ItemTransform" }
  ]);

  await assert.rejects(
    () =>
      service.getClassSource({
        className: "com.example.old.ItemTransform",
        artifactId: "dym-artifact-2",
        mapping: "obfuscated",
        mode: "full"
      }),
    (error: Error & { details?: { didYouMean?: DidYouMeanCandidate[] } }) => {
      const candidates = error.details?.didYouMean ?? [];
      assert.deepEqual(candidates[0], {
        className: "com.example.moved.ItemTransform",
        matchReason: "exact-simple-name"
      });
      assert.deepEqual(candidates[1], {
        className: "com.example.typo.ItemTransfrm",
        matchReason: "edit-distance:1"
      });
      return true;
    }
  );
});

test("didYouMean reports case-insensitive matches with their own reason", async () => {
  const service = await makeService("dym-case-");
  // The case variant lives in a different package: a same-package case
  // variant already resolves through the case-insensitive file-path lookup.
  seedClasses(service, "dym-artifact-3", [
    { fqn: "com.example.a.Itemtransform", simpleName: "Itemtransform" }
  ]);

  await assert.rejects(
    () =>
      service.getClassSource({
        className: "com.example.other.ItemTransform",
        artifactId: "dym-artifact-3",
        mapping: "obfuscated",
        mode: "full"
      }),
    (error: Error & { details?: { didYouMean?: DidYouMeanCandidate[] } }) => {
      assert.deepEqual(error.details?.didYouMean, [
        { className: "com.example.a.Itemtransform", matchReason: "case-insensitive" }
      ]);
      return true;
    }
  );
});

test("didYouMean enumerates every same-simple-name FQN instead of collapsing them", async () => {
  const service = await makeService("dym-enumerate-");
  seedClasses(service, "dym-artifact-4", [
    { fqn: "com.example.a.Widget", simpleName: "Widget" },
    { fqn: "com.example.b.Widget", simpleName: "Widget" }
  ]);

  await assert.rejects(
    () =>
      service.getClassSource({
        className: "com.example.missing.Widget",
        artifactId: "dym-artifact-4",
        mapping: "obfuscated",
        mode: "full"
      }),
    (error: Error & { details?: { didYouMean?: DidYouMeanCandidate[] } }) => {
      const fqns = (error.details?.didYouMean ?? []).map((candidate) => candidate.className).sort();
      assert.deepEqual(fqns, ["com.example.a.Widget", "com.example.b.Widget"]);
      return true;
    }
  );
});

test("an artifact without symbol candidates returns an empty didYouMean array", async () => {
  const service = await makeService("dym-empty-");
  seedClasses(service, "dym-artifact-5", [
    { fqn: "com.example.unrelated.Alpha", simpleName: "Alpha" }
  ]);

  await assert.rejects(
    () =>
      service.getClassSource({
        className: "org.zzz.CompletelyDifferent",
        artifactId: "dym-artifact-5",
        mapping: "obfuscated",
        mode: "full"
      }),
    (error: Error & { details?: { didYouMean?: DidYouMeanCandidate[] } }) => {
      assert.deepEqual(error.details?.didYouMean, []);
      return true;
    }
  );
});
