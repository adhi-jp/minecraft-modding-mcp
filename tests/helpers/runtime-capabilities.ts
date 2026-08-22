import { spawn } from "node:child_process";
import type { TestContext } from "node:test";

/**
 * Declared runtime capabilities for environment-guarded tests.
 *
 * Some suites can only run where the host provides something the test itself cannot
 * create: working native child-process stdio pipes, POSIX process groups, a Java
 * runtime. Guarding those with an ad-hoc `t.skip("some prose")` loses the one fact the
 * post-suite named-test set gate needs — WHICH capability was missing — so the gate can
 * only report an opaque "N tests were skipped".
 *
 * Every guard therefore DECLARES its capability here, and the skip reason is rendered in
 * a machine-readable form:
 *
 *   missing runtime capability [native-stdio-pipes]: <human explanation>
 *
 * `scripts/test-name-inventory.mjs` parses that token back out of the TAP directive, so
 * `npm test` can attribute each unproven frozen row to a named capability instead of
 * guessing. A skip that does NOT carry a declared capability is treated by the gate as an
 * un-attributed directive and always fails — the escape hatch cannot cover it.
 *
 * Detection is memoized per process (node's test runner gives each file its own process),
 * so a probe that spawns a child runs once per file instead of once per test.
 *
 * `MCP_TEST_FORCE_MISSING_CAPABILITIES` forces a comma-separated list of capability ids to
 * report as missing. It exists so the UNPROVEN path can be exercised deliberately on a
 * machine where every capability is present; without it that path is unreachable here and
 * a green run would prove nothing about it. Test-harness only — no production code reads it.
 */

/** Every capability an environment-guarded test may require. */
export const RUNTIME_CAPABILITY_IDS = [
  "native-stdio-pipes",
  "posix-process-groups",
  "posix-shell-bridge",
  "java-runtime"
] as const;

export type RuntimeCapabilityId = (typeof RUNTIME_CAPABILITY_IDS)[number];

/** Env var that forces capabilities to report as missing. See the module comment. */
export const FORCE_MISSING_CAPABILITIES_ENV = "MCP_TEST_FORCE_MISSING_CAPABILITIES";

/** Leading token of a declared skip reason; the gate keys its attribution on this. */
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

/**
 * Ids forced missing through the environment.
 *
 * An unrecognized id throws: a typo must fail loudly rather than quietly forcing nothing.
 */
export function forcedMissingCapabilities(
  env: NodeJS.ProcessEnv = process.env
): Set<RuntimeCapabilityId> {
  const raw = env[FORCE_MISSING_CAPABILITIES_ENV];
  const forced = new Set<RuntimeCapabilityId>();
  if (raw === undefined || raw.trim() === "") {
    return forced;
  }
  for (const entry of raw.split(",")) {
    const id = entry.trim();
    if (id === "") {
      continue;
    }
    if (!(RUNTIME_CAPABILITY_IDS as readonly string[]).includes(id)) {
      throw new Error(
        `${FORCE_MISSING_CAPABILITIES_ENV} names an unknown capability ${JSON.stringify(id)}; ` +
          `known ids: ${RUNTIME_CAPABILITY_IDS.join(", ")}`
      );
    }
    forced.add(id as RuntimeCapabilityId);
  }
  return forced;
}

/** The exact skip reason a guard emits, in the form the named-set gate parses. */
export function formatMissingCapabilityReason(id: RuntimeCapabilityId): string {
  return `${MISSING_CAPABILITY_REASON_PREFIX} [${id}]: ${definitionFor(id).missingReason}`;
}

const detectionCache = new Map<RuntimeCapabilityId, Promise<boolean>>();

/** True when this host provides the capability. Memoized for the life of the process. */
export async function hasRuntimeCapability(id: RuntimeCapabilityId): Promise<boolean> {
  definitionFor(id);
  if (forcedMissingCapabilities().has(id)) {
    return false;
  }
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
