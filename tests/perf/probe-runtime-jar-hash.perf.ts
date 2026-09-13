import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probeMinecraftArtifact } from "../../src/source/artifact-resolver.ts";
import type { SourceService } from "../../src/source-service.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * `probeMinecraftArtifact`'s jar route (src/source/artifact-resolver.ts, the
 * "lightweight" probe branch) derives the artifactId from `jarArtifactIdentity`
 * (src/artifact-identity.ts), which streams the runtime jar through sha256 on a
 * cache miss. The digest is memoized by resolved path plus stat
 * (`contentSignatureCache`), so only the FIRST probe of a given jar in a process
 * pays for the hash - every later probe of the same, untouched jar is a map
 * lookup. This budget covers that first-call cost: it must stay bounded for a
 * runtime-jar-sized file, and the memoized second call must be dramatically
 * cheaper, or the memoization this module documents has regressed.
 */

const RUNTIME_JAR_SIZE_BYTES = 20 * 1024 * 1024; // in the ballpark of a real client jar
const COLD_HASH_BUDGET_MS = 5_000;
const WARM_SPEEDUP_FACTOR = 5;

function stubServiceResolvingVersionJar(jarPath: string): SourceService {
  return {
    versionService: {
      resolveVersionJar: async (version: string) => ({
        version,
        jarPath,
        source: "downloaded" as const,
        clientJarUrl: "cache:index"
      })
    }
  } as unknown as SourceService;
}

test("artifact probe hashes a cold runtime jar within budget and reuses the digest on the next call", async () => {
  const root = await mkdtemp(join(tmpdir(), "probe-runtime-jar-hash-perf-"));

  // A throwaway probe of an UNRELATED small jar first, so V8/Node warmup (module
  // resolution, first JIT pass, first crypto/fs calls) is not charged to the
  // measurement below. `contentSignatureCache` is keyed by resolved path, so this
  // does nothing to warm the entry for the jar under test.
  const warmupJarPath = join(root, "warmup.jar");
  await createJar(warmupJarPath, { "warmup.txt": Buffer.from("warmup") });
  await probeMinecraftArtifact(stubServiceResolvingVersionJar(warmupJarPath), {
    target: { kind: "version", value: "1.0.0" }
  });

  const jarPath = join(root, "minecraft-1.21.10-client.jar");
  await createJar(jarPath, {
    "net/minecraft/Marker.class": Buffer.alloc(RUNTIME_JAR_SIZE_BYTES, 0xab)
  });

  const svc = stubServiceResolvingVersionJar(jarPath);
  const target = { kind: "version", value: "1.21.10" } as const;

  const coldStart = performance.now();
  const first = await probeMinecraftArtifact(svc, { target });
  const coldMs = performance.now() - coldStart;

  const warmStart = performance.now();
  const second = await probeMinecraftArtifact(svc, { target });
  const warmMs = performance.now() - warmStart;

  console.info(
    JSON.stringify({
      event: "perf.probe.runtime_jar_hash",
      jarBytes: RUNTIME_JAR_SIZE_BYTES,
      coldMs,
      warmMs
    })
  );

  assert.equal(second.artifactId, first.artifactId, "the memoized digest must not change the id");

  assert.ok(
    coldMs <= COLD_HASH_BUDGET_MS,
    `Expected the probe's first-call hash of a ${RUNTIME_JAR_SIZE_BYTES}-byte runtime jar to finish within ${COLD_HASH_BUDGET_MS}ms, took ${coldMs}ms`
  );

  assert.ok(
    warmMs * WARM_SPEEDUP_FACTOR <= Math.max(coldMs, 1),
    `Expected the memoized second probe call (${warmMs}ms) to be at least ${WARM_SPEEDUP_FACTOR}x faster than the cold hash (${coldMs}ms)`
  );
});
