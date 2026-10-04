import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Gradle's cache layout for one coordinate: <group>/<artifact>/<version>/<hash>/<file>. */
export function gradleCacheJarPath(
  gradleUserHome: string,
  groupId: string,
  artifactId: string,
  version: string,
  fileName: string
): string {
  return join(
    gradleUserHome,
    "caches",
    "modules-2",
    "files-2.1",
    groupId,
    artifactId,
    version,
    "binary-hash",
    fileName
  );
}

/** Write a file that passes an existence check but is not a readable archive. */
export async function writeUnreadableJar(jarPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(jarPath), { recursive: true });
  await writeFile(jarPath, bytes);
}
