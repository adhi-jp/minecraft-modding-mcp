import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  composeArtifactId,
  contentDigestSignature,
  DECOMPILE_SIGNATURE_QUALIFIER
} from "../../src/artifact-identity.ts";
import { probeMinecraftArtifact } from "../../src/source/artifact-resolver.ts";
import type { SourceService } from "../../src/source-service.ts";
import { resolveSourceTarget } from "../../src/source-resolver.ts";
import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

/**
 * `validate-project` publishes the probe's artifactId as
 * `tasks["minecraft.artifact.resolved"].artifactId`, and a following
 * `resolve-artifact` on the same runtime jar has to answer with the same id or
 * the two tools are describing different artifacts to the caller.
 *
 * They used to disagree: the probe read the signature from the symlink-resolved
 * path but composed the id from the path as given, while `resolveSourceTarget`
 * normalized the path first. A jar reached through a symlinked directory was
 * therefore two artifacts. Both now go through `jarArtifactIdentity`, which
 * normalizes before it composes.
 */

/** A minimal service stub: the probe's obfuscated leg reads only this. */
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

test("the artifact probe and a jar resolve agree on the id of a jar reached through a symlinked directory", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "probe-resolve-symlink-")));
  const realStore = join(root, "real-store");
  await mkdir(realStore, { recursive: true });
  const jarName = "minecraft-1.21.10-client.jar";
  const realJarPath = join(realStore, jarName);
  await createJar(realJarPath, {
    "net/minecraft/Marker.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const linkedStore = join(root, "linked-store");
  await symlink(realStore, linkedStore, "dir");
  const jarThroughLink = join(linkedStore, jarName);

  const probe = await probeMinecraftArtifact(stubServiceResolvingVersionJar(jarThroughLink), {
    target: { kind: "version", value: "1.21.10" }
  });

  const config = buildTestConfig(root);
  const resolvedThroughLink = await resolveSourceTarget(
    { kind: "jar", value: jarThroughLink },
    { allowDecompile: true },
    config
  );
  const resolvedThroughRealPath = await resolveSourceTarget(
    { kind: "jar", value: realJarPath },
    { allowDecompile: true },
    config
  );

  assert.equal(resolvedThroughLink.origin, "decompiled");
  assert.equal(
    resolvedThroughLink.artifactId,
    resolvedThroughRealPath.artifactId,
    "one jar under two names is one artifact"
  );
  assert.equal(
    probe.artifactId,
    resolvedThroughLink.artifactId,
    "the probe must publish the id a resolve would mint for the same jar"
  );

  // Which side moved: the id is no longer composed from the path as handed in.
  // Everything else here is what the probe itself used - the same content
  // digest, the same qualifier - so the symlinked path is the only difference.
  const jarDigest = createHash("sha256").update(await readFile(realJarPath)).digest("hex");
  const idFromUnnormalizedPath = composeArtifactId({
    space: "jar",
    jarPath: jarThroughLink,
    signature: contentDigestSignature(jarDigest),
    signatureQualifier: DECOMPILE_SIGNATURE_QUALIFIER
  });
  assert.notEqual(
    probe.artifactId,
    idFromUnnormalizedPath,
    "the symlinked path must not reach the hash"
  );
});

test("a target.kind=version probe keeps its artifactId when the runtime jar is touched", async () => {
  // `resolveArtifactTarget` rewrites a version target into a jar target on the
  // resolved runtime jar, and the probe reaches the same derivation directly, so
  // a Minecraft version is identified by the jar route. That used to mean the
  // whole runtime re-keyed - a fresh decompile of the client jar and a full
  // re-index - whenever the launcher or a Gradle task moved the jar's mtime.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "probe-version-touch-")));
  const jarPath = join(root, "minecraft-1.21.10-client.jar");
  await createJar(jarPath, {
    "net/minecraft/Marker.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });

  const svc = stubServiceResolvingVersionJar(jarPath);
  const target = { kind: "version", value: "1.21.10" } as const;

  const first = await probeMinecraftArtifact(svc, { target });
  const bytesBeforeTouch = createHash("sha256").update(await readFile(jarPath)).digest("hex");
  const bumped = new Date(Date.now() + 60_000);
  await utimes(jarPath, bumped, bumped);
  const second = await probeMinecraftArtifact(svc, { target });

  assert.equal(
    createHash("sha256").update(await readFile(jarPath)).digest("hex"),
    bytesBeforeTouch,
    "the touch must leave every byte in place, or this proves nothing"
  );
  assert.equal(second.artifactId, first.artifactId);
});
