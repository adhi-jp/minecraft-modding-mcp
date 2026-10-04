import { spawn } from "node:child_process";
import type { TestContext } from "node:test";

/**
 * Shared runtime capability detection for environment-guarded tests.
 * Skip reasons identify the missing capability and explain the host limitation.
 * Detection is memoized per process, so child-process probes run once per file.
 */

/** Every capability an environment-guarded test may require. */
export const RUNTIME_CAPABILITY_IDS = [
  "native-stdio-pipes",
  "posix-process-groups",
  "posix-shell-bridge",
  "java-runtime"
] as const;

export type RuntimeCapabilityId = (typeof RUNTIME_CAPABILITY_IDS)[number];

/** Leading text of a runtime capability skip reason. */
export const MISSING_CAPABILITY_REASON_PREFIX = "missing runtime capability";

type CapabilityDefinition = {
  /** Explains what is absent, in the voice of the skip message. */
  readonly missingReason: string;
  /** True when the host provides the capability. Must not throw. */
  readonly detect: () => Promise<boolean>;
};

/**
 * Probe whether this runtime really gives a spawned child a usable stdin pipe.
 *
 * Some sandboxes hand the child a pipe that closes immediately; the child then sees `end`
 * and exits 42 instead of surviving to the 150 ms timer. Anything other than a clean 0
 * means the wire-level stdio suites cannot drive a real worker here.
 */
async function probeNativeStdioPipes(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(42));setTimeout(()=>process.exit(0),150);"],
      { stdio: ["pipe", "ignore", "ignore"] }
    );
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function probeJavaRuntime(): Promise<boolean> {
  try {
    const { assertJavaAvailable } = await import("../../src/java-process.ts");
    await assertJavaAvailable();
    return true;
  } catch {
    return false;
  }
}

const CAPABILITIES: Readonly<Record<RuntimeCapabilityId, CapabilityDefinition>> = {
  "native-stdio-pipes": {
    missingReason: "native child-process stdio pipes close immediately in this runtime",
    detect: probeNativeStdioPipes
  },
  "posix-process-groups": {
    missingReason: "POSIX process groups are not available on this platform",
    detect: async () => process.platform !== "win32"
  },
  "posix-shell-bridge": {
    missingReason: "the bash FIFO bridge is only exercised on POSIX runtimes",
    detect: async () => process.platform !== "win32"
  },
  "java-runtime": {
    missingReason: "a Java runtime is not available for the real-spawn path",
    detect: probeJavaRuntime
  }
};

function definitionFor(id: RuntimeCapabilityId): CapabilityDefinition {
  const definition = CAPABILITIES[id];
  if (definition === undefined) {
    throw new Error(`unknown runtime capability: ${JSON.stringify(id)}`);
  }
  return definition;
}

/** The skip reason a capability guard emits. */
export function formatMissingCapabilityReason(id: RuntimeCapabilityId): string {
  return `${MISSING_CAPABILITY_REASON_PREFIX} [${id}]: ${definitionFor(id).missingReason}`;
}

const detectionCache = new Map<RuntimeCapabilityId, Promise<boolean>>();

/** True when this host provides the capability. Memoized for the life of the process. */
export async function hasRuntimeCapability(id: RuntimeCapabilityId): Promise<boolean> {
  definitionFor(id);
  const cached = detectionCache.get(id);
  if (cached !== undefined) {
    return cached;
  }
  const pending = definitionFor(id)
    .detect()
    .catch(() => false);
  detectionCache.set(id, pending);
  return pending;
}

/**
 * Guard a test on a declared capability.
 *
 * Returns TRUE when the test was skipped, so the caller can bail out:
 *
 *   if (await skipWithoutCapability(t, "native-stdio-pipes")) return;
 */
export async function skipWithoutCapability(
  t: TestContext,
  id: RuntimeCapabilityId
): Promise<boolean> {
  if (await hasRuntimeCapability(id)) {
    return false;
  }
  t.skip(formatMissingCapabilityReason(id));
  return true;
}
