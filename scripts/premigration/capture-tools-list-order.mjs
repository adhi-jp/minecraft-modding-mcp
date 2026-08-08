/**
 * Pre-migration baseline capture — raw tools/list order per flag config.
 *
 * Run with: node --import tsx scripts/premigration/capture-tools-list-order.mjs [--validate-only]
 *
 * For each flag configuration (default, VERIFY_MIXIN_TARGET_OFF=1,
 * BATCH_TOOLS_OFF=1, both-off):
 *   1. Spawns the production server, performs the legacy 2025-11-25 handshake,
 *      captures the RAW tools/list name sequence (no sorting) — twice, in two
 *      fresh server processes.
 *   2. Validates: run A order === run B order (byte-identical sequence), and
 *      the sorted form equals the sorted EXPECTED_TOOLS set adjusted for the
 *      flag config's membership (mirror of
 *      tests/integration/mcp-tools/contracts.test.ts, which sorts before
 *      comparing — this harness pins the raw order the test does not).
 *   3. Writes tests/fixtures/premigration/tools-list-order.<config>.json
 *      (skipped with --validate-only).
 *
 * Normalization: the fixture stores tool names only (already deterministic);
 * env per rule N5.
 */

import {
  ServerSession,
  FLAG_CONFIGS,
  expectedToolsForConfig,
  writeFixture,
  scratchPath
} from "./lib.mjs";
import { EXPECTED_TOOLS } from "../../tests/helpers/expected-tools.ts";

const validateOnly = process.argv.includes("--validate-only");

async function captureRun(config, runLabel) {
  const session = new ServerSession({
    label: `tools-list-${config.name}-${runLabel}`,
    env: config.env,
    pidFile: scratchPath("run", `tools-list-${config.name}-${runLabel}.pid`)
  }).start();
  try {
    await session.handshake();
    const { reply } = session.request("tools/list", {});
    const message = await reply;
    if (message.error) {
      throw new Error(`tools/list failed: ${JSON.stringify(message.error)}`);
    }
    return {
      names: message.result.tools.map((tool) => tool.name),
      env: session.recordedEnv()
    };
  } finally {
    await session.stop();
  }
}

let failures = 0;

for (const config of FLAG_CONFIGS) {
  const runA = await captureRun(config, "a");
  const runB = await captureRun(config, "b");

  const identical = JSON.stringify(runA.names) === JSON.stringify(runB.names);
  const expectedSorted = [...expectedToolsForConfig(EXPECTED_TOOLS, config.env)].sort();
  const sortedMatches = JSON.stringify([...runA.names].sort()) === JSON.stringify(expectedSorted);

  console.log(`[${config.name}] tools=${runA.names.length} twoRunIdentical=${identical} sortedMatchesExpectedTools=${sortedMatches}`);
  if (!identical || !sortedMatches) {
    failures += 1;
    console.error(`[${config.name}] run A order: ${JSON.stringify(runA.names)}`);
    if (!identical) console.error(`[${config.name}] run B order: ${JSON.stringify(runB.names)}`);
    if (!sortedMatches) console.error(`[${config.name}] expected sorted: ${JSON.stringify(expectedSorted)}`);
    continue;
  }

  if (!validateOnly) {
    const target = writeFixture(`tools-list-order.${config.name}.json`, {
      description:
        "Pre-migration RAW legacy tools/list order (registration order; legacy golden). Captured against the untouched SDK v1 build.",
      harness: "scripts/premigration/capture-tools-list-order.mjs",
      env: runA.env,
      flagConfig: config.name,
      toolCount: runA.names.length,
      toolNames: runA.names
    });
    console.log(`[${config.name}] fixture written: ${target}`);
  }
}

if (failures > 0) {
  console.error(`FAILED: ${failures} flag config(s) did not validate`);
  process.exit(1);
}
console.log("tools/list order capture: OK");
