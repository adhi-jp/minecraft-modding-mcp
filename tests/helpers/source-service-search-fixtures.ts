/**
 * Shared search fixtures factored out of tests/source-service.search.test.ts.
 * `createResolvedSearchFixture` builds a SourceService over a freshly written
 * jar/sources pair and resolves it; the derived `SearchFixture` /
 * `SearchClassSourceCase*` types describe its searchClassSource surface.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/types.ts";
import { buildTestConfig } from "./test-config.ts";
import { createJar } from "./zip.ts";

export async function createResolvedSearchFixture(input: {
  rootPrefix: string;
  jarBaseName: string;
  sourceEntries: Record<string, string>;
  binaryEntries?: Record<string, Buffer>;
  configOverrides?: Partial<Config>;
  mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
}): Promise<{
  service: InstanceType<(typeof import("../../src/source-service.ts"))["SourceService"]>;
  resolved: Awaited<ReturnType<InstanceType<(typeof import("../../src/source-service.ts"))["SourceService"]>["resolveArtifact"]>>;
}> {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), input.rootPrefix));
  const binaryJarPath = join(root, `${input.jarBaseName}.jar`);
  const sourcesJarPath = join(root, `${input.jarBaseName}-sources.jar`);

  await createJar(
    binaryJarPath,
    input.binaryEntries ?? {
      "net/minecraft/server/Main.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    }
  );
  await createJar(sourcesJarPath, input.sourceEntries);

  const service = new SourceService(buildTestConfig(root, input.configOverrides));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    ...(input.mapping === undefined ? {} : { mapping: input.mapping })
  });

  return { service, resolved };
}

export type SearchFixture = Awaited<ReturnType<typeof createResolvedSearchFixture>>;
export type SearchClassSourceCaseInput = Omit<
  Parameters<SearchFixture["service"]["searchClassSource"]>[0],
  "artifactId"
>;
export type SearchClassSourceCaseResult = Awaited<
  ReturnType<SearchFixture["service"]["searchClassSource"]>
>;
