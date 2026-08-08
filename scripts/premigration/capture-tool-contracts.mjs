/**
 * Pre-migration baseline capture — per-tool contract snapshots.
 *
 * Run with: node --import tsx scripts/premigration/capture-tool-contracts.mjs [--validate-only]
 *
 * From the live tools/list (default flag config, legacy handshake) captures,
 * per registered tool:
 *   - the advertised tool entry (name, description, annotations) and the
 *     advertised `inputSchema` VERBATIM (wire property order preserved — the
 *     legacy byte-comparison baseline; everything else is normalized);
 *   - one envelope sample:
 *       * a SUCCESSFUL call envelope for cheap local tools (get-runtime-metrics
 *         — a listing/read tool with no arguments and no network);
 *       * otherwise an invalid-input ProblemDetails envelope produced by an
 *         input which an OFFLINE schema.safeParse proves invalid (guaranteeing
 *         validation fails before any real work).
 *
 * Fixtures: tests/fixtures/premigration/tool-contracts/<tool>.json
 */

import {
  ServerSession,
  normalizeCaptured,
  writeFixture,
  scratchPath
} from "./lib.mjs";
import { loadRegistry, guaranteedInvalidInput } from "./schema-registry.mjs";

const validateOnly = process.argv.includes("--validate-only");

// Cheap, local, deterministic no-argument tools safe to actually execute.
const SUCCESS_SAMPLE_TOOLS = new Map([
  ["get-runtime-metrics", {}]
]);

const { tools } = await loadRegistry();
const schemaByTool = new Map(tools.map((entry) => [entry.tool, entry]));

const session = new ServerSession({
  label: "tool-contracts",
  env: {},
  pidFile: scratchPath("run", "tool-contracts.pid")
}).start();

let failures = 0;
try {
  await session.handshake();

  // Capture SUCCESS samples first, before any other tools/call in this
  // session, so runtime metrics counters are in their deterministic
  // fresh-process state (rule N5 note: sample position is part of the frozen
  // harness sequence).
  const successSamples = new Map();
  for (const [name, args] of SUCCESS_SAMPLE_TOOLS) {
    const { request, reply } = session.request(
      "tools/call",
      { name, arguments: args },
      { timeoutMs: 60_000 }
    );
    const message = await reply;
    if (message.error || message.result?.isError === true) {
      failures += 1;
      console.error(`[${name}] success sample failed: ${JSON.stringify(message).slice(0, 300)}`);
      continue;
    }
    successSamples.set(name, {
      kind: "success",
      request: normalizeCaptured(request),
      reply: normalizeCaptured(message)
    });
  }

  const listReply = await session.request("tools/list", {}).reply;
  if (listReply.error) throw new Error(`tools/list failed: ${JSON.stringify(listReply.error)}`);
  const advertised = listReply.result.tools;
  const advertisedNames = advertised.map((tool) => tool.name).sort();
  const registryNames = tools.map((entry) => entry.tool).sort();
  if (JSON.stringify(advertisedNames) !== JSON.stringify(registryNames)) {
    throw new Error(
      `advertised tools != registry tools\nadvertised: ${advertisedNames}\nregistry: ${registryNames}`
    );
  }
  console.log(`tools/list advertised ${advertised.length} tools (matches registry)`);

  for (const toolEntry of [...advertised].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = toolEntry.name;
    let sampleKind;
    let sample;
    if (successSamples.has(name)) {
      sampleKind = "success";
      sample = successSamples.get(name);
    } else {
      sampleKind = "invalid-input";
      const sampleArguments = guaranteedInvalidInput(schemaByTool.get(name));
      if (sampleArguments === undefined) {
        // No offline-provable invalid input constructible: record schema only.
        sampleKind = "schema-only";
      } else {
        const { request, reply } = session.request(
          "tools/call",
          { name, arguments: sampleArguments },
          { timeoutMs: 60_000 }
        );
        const message = await reply;
        if (message.error || message.result?.isError !== true) {
          failures += 1;
          console.error(
            `[${name}] sample ${sampleKind}: expected isError=true, got ${JSON.stringify(message).slice(0, 300)}`
          );
          continue;
        }
        sample = {
          kind: sampleKind,
          request: normalizeCaptured(request),
          reply: normalizeCaptured(message)
        };
      }
    }

    console.log(`[${name}] inputSchema captured; envelope sample: ${sampleKind}`);
    if (!validateOnly) {
      writeFixture(`tool-contracts/${name}.json`, {
        description:
          "Pre-migration per-tool contract snapshot: advertised tools/list entry with VERBATIM inputSchema bytes (wire property order), plus one envelope sample. Untouched SDK v1 build; legacy handshake; default flag config.",
        harness: "scripts/premigration/capture-tool-contracts.mjs",
        env: session.recordedEnv(),
        advertised: normalizeCaptured(toolEntry, { verbatimKeys: ["inputSchema"] }),
        envelopeSample: sample ?? { kind: "schema-only" }
      });
    }
  }
} finally {
  await session.stop();
}

if (failures > 0) {
  console.error(`FAILED: ${failures} tool(s) did not produce the expected envelope sample`);
  process.exit(1);
}
console.log("tool-contracts capture: OK");
