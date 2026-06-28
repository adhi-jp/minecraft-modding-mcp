import type { InspectMinecraftDeps } from "../../src/entry-tools/inspect-minecraft/internal.ts";

/**
 * Build a complete {@link InspectMinecraftDeps} stub whose ten methods all throw
 * `"not used"` unless overridden. Each test passes only the dependencies its
 * code path exercises; any accidental call into an un-stubbed dependency fails
 * loudly instead of silently returning a placeholder.
 */
export function buildInspectDeps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overrides: { [K in keyof InspectMinecraftDeps]?: (...args: any[]) => unknown } = {}
): InspectMinecraftDeps {
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    listVersions: notUsed,
    resolveArtifact: notUsed,
    findClass: notUsed,
    checkSymbolExists: notUsed,
    getClassSource: notUsed,
    getClassMembers: notUsed,
    searchClassSource: notUsed,
    getArtifactFile: notUsed,
    listArtifactFiles: notUsed,
    detectProjectMinecraftVersion: notUsed,
    ...overrides
  } as unknown as InspectMinecraftDeps;
}
