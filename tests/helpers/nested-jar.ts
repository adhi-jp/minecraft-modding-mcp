import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJar } from "./zip.ts";

/** Builds a jar in a temp dir and returns its raw bytes for embedding. */
export async function buildInnerJarBytes(
  entries: Record<string, string | Buffer>
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "inner-jar-"));
  const path = join(dir, "inner.jar");
  await createJar(path, entries);
  return readFile(path);
}

/**
 * Builds a Fabric Jar-in-Jar shell: near-zero own classes, nested jars under
 * META-INF/jars, and a fabric.mod.json declaring them (unless declareJars is
 * false — the META-INF/jars scan signal still applies then).
 */
export async function createShellJar(
  outputPath: string,
  nested: Record<string, Buffer>,
  opts?: {
    modId?: string;
    declareJars?: boolean;
    extraEntries?: Record<string, string | Buffer>;
  }
): Promise<void> {
  const names = Object.keys(nested);
  await createJar(outputPath, {
    "fabric.mod.json": JSON.stringify({
      schemaVersion: 1,
      id: opts?.modId ?? "shell-mod",
      version: "1.0.0",
      ...(opts?.declareJars === false ? {} : { jars: names.map((file) => ({ file })) })
    }),
    ...nested,
    ...(opts?.extraEntries ?? {})
  });
}
