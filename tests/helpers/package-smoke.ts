import { readdir } from "node:fs/promises";
import { join } from "node:path";

type PackageIdentity = {
  name: string;
  version: string;
};

export function buildPackTarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

export async function findPackedTarball(
  packDir: string,
  packageIdentity: PackageIdentity
): Promise<string> {
  const expectedName = buildPackTarballName(packageIdentity.name, packageIdentity.version);
  const entries = (await readdir(packDir)).filter((entry) => entry.endsWith(".tgz"));

  if (entries.includes(expectedName)) {
    return join(packDir, expectedName);
  }

  if (entries.length === 1) {
    return join(packDir, entries[0]);
  }

  if (entries.length === 0) {
    throw new Error(
      `npm pack did not produce a tarball for ${packageIdentity.name}@${packageIdentity.version} in ${packDir}.`
    );
  }

  throw new Error(
    `npm pack produced multiple tarballs in ${packDir}: ${entries.join(", ")}`
  );
}
