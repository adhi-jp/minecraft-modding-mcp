import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEraConflictRejection,
  buildMethodNotFoundRejection,
  buildMissingMetaRejection,
  classifyEraSignal,
  CLIENT_CAPABILITIES_META_KEY,
  ERA_CONFLICT_LEGACY_MESSAGE,
  ERA_CONFLICT_MODERN_MESSAGE,
  ERA_SUPPORTED_PROTOCOL_VERSIONS,
  MISSING_META_MODERN_MESSAGE,
  MISSING_META_UNSELECTED_MESSAGE,
  type EraSignal
} from "../../src/era-classifier.ts";

const PV = "io.modelcontextprotocol/protocolVersion";
const CC = "io.modelcontextprotocol/clientCapabilities";

function signal(params: unknown): EraSignal {
  return classifyEraSignal(params);
}

test("classifyEraSignal: absent params, non-object params, and non-object _meta are claim-less with both keys missing", () => {
  const claimLess = { classification: "claim-less", missing: [PV, CC], invalid: [] };
  assert.deepEqual(signal(undefined), claimLess);
  assert.deepEqual(signal("params"), claimLess);
  assert.deepEqual(signal(42), claimLess);
  assert.deepEqual(signal([]), claimLess);
  assert.deepEqual(signal({}), claimLess);
  assert.deepEqual(signal({ _meta: null }), claimLess);
  assert.deepEqual(signal({ _meta: 42 }), claimLess);
  assert.deepEqual(signal({ _meta: "x" }), claimLess);
  assert.deepEqual(signal({ _meta: [] }), claimLess);
  assert.deepEqual(signal({ _meta: true }), claimLess);
});

test("classifyEraSignal: an object _meta carrying neither required key is claim-less", () => {
  assert.deepEqual(signal({ _meta: {} }), {
    classification: "claim-less",
    missing: [PV, CC],
    invalid: []
  });
  assert.deepEqual(signal({ _meta: { progressToken: "p", "io.modelcontextprotocol/clientInfo": {} } }), {
    classification: "claim-less",
    missing: [PV, CC],
    invalid: []
  });
});

test("classifyEraSignal: a lone required key is claim-shaped-invalid with the absent key missing", () => {
  assert.deepEqual(signal({ _meta: { [PV]: "2026-07-28" } }), {
    classification: "claim-shaped-invalid",
    missing: [CC],
    invalid: []
  });
  assert.deepEqual(signal({ _meta: { [CC]: {} } }), {
    classification: "claim-shaped-invalid",
    missing: [PV],
    invalid: []
  });
});

test("classifyEraSignal: present-but-wrong-shallow-type required keys are invalid", () => {
  assert.deepEqual(signal({ _meta: { [PV]: 42 } }), {
    classification: "claim-shaped-invalid",
    missing: [CC],
    invalid: [PV]
  });
  assert.deepEqual(signal({ _meta: { [PV]: "2026-07-28", [CC]: null } }), {
    classification: "claim-shaped-invalid",
    missing: [],
    invalid: [CC]
  });
  assert.deepEqual(signal({ _meta: { [PV]: "2026-07-28", [CC]: [] } }), {
    classification: "claim-shaped-invalid",
    missing: [],
    invalid: [CC]
  });
  assert.deepEqual(signal({ _meta: { [PV]: "2026-07-28", [CC]: "caps" } }), {
    classification: "claim-shaped-invalid",
    missing: [],
    invalid: [CC]
  });
  assert.deepEqual(signal({ _meta: { [PV]: 42, [CC]: [] } }), {
    classification: "claim-shaped-invalid",
    missing: [],
    invalid: [PV, CC]
  });
});

test("classifyEraSignal: a shallow-valid envelope is the modern signal (clientInfo optional; version value not checked)", () => {
  assert.deepEqual(signal({ _meta: { [PV]: "2026-07-28", [CC]: {} } }), {
    classification: "modern-signal",
    missing: [],
    invalid: []
  });
  // Deep value validation belongs to the worker: an unsupported version
  // string still classifies as the modern signal.
  assert.deepEqual(signal({ _meta: { [PV]: "2027-01-01", [CC]: { tools: {} } } }).classification, "modern-signal");
  assert.deepEqual(
    signal({
      _meta: {
        [PV]: "2026-07-28",
        [CC]: {},
        "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
        progressToken: "p",
        extension: true
      }
    }).classification,
    "modern-signal"
  );
});

test("buildEraConflictRejection shapes both directions with the frozen messages and the six-version support list", () => {
  assert.deepEqual(ERA_SUPPORTED_PROTOCOL_VERSIONS, [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
    "2026-07-28"
  ]);

  assert.deepEqual(buildEraConflictRejection(7, "modern"), {
    jsonrpc: "2.0",
    id: 7,
    error: {
      code: -32601,
      message: ERA_CONFLICT_MODERN_MESSAGE,
      data: {
        kind: "era_conflict",
        selectedEra: "modern",
        requestedEra: "legacy",
        supported: [...ERA_SUPPORTED_PROTOCOL_VERSIONS]
      }
    }
  });

  assert.deepEqual(buildEraConflictRejection("r-1", "legacy"), {
    jsonrpc: "2.0",
    id: "r-1",
    error: {
      code: -32600,
      message: ERA_CONFLICT_LEGACY_MESSAGE,
      data: {
        kind: "era_conflict",
        selectedEra: "legacy",
        requestedEra: "modern",
        supported: [...ERA_SUPPORTED_PROTOCOL_VERSIONS]
      }
    }
  });
});

test("buildMissingMetaRejection always carries missing, includes invalid only when non-empty, and picks the per-era message", () => {
  assert.deepEqual(
    buildMissingMetaRejection(1, { classification: "claim-less", missing: [PV, CC], invalid: [] }, "unselected"),
    {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: MISSING_META_UNSELECTED_MESSAGE,
        data: { kind: "missing_meta", missing: [PV, CC] }
      }
    }
  );
  const withInvalid = buildMissingMetaRejection(
    2,
    { classification: "claim-shaped-invalid", missing: [CC], invalid: [PV] },
    "modern"
  ) as { error?: { message?: string; data?: Record<string, unknown> } };
  assert.equal(withInvalid.error?.message, MISSING_META_MODERN_MESSAGE);
  assert.deepEqual(withInvalid.error?.data, { kind: "missing_meta", missing: [CC], invalid: [PV] });
  const emptyMissing = buildMissingMetaRejection(
    3,
    { classification: "claim-shaped-invalid", missing: [], invalid: [CC] },
    "modern"
  ) as { error?: { data?: Record<string, unknown> } };
  assert.deepEqual(emptyMissing.error?.data, { kind: "missing_meta", missing: [], invalid: [CC] });
});

test("buildMethodNotFoundRejection is a plain -32601 without data", () => {
  assert.deepEqual(buildMethodNotFoundRejection(9), {
    jsonrpc: "2.0",
    id: 9,
    error: { code: -32601, message: "Method not found" }
  });
});

test("CLIENT_CAPABILITIES_META_KEY and companions match the reserved io.modelcontextprotocol names", () => {
  assert.equal(CLIENT_CAPABILITIES_META_KEY, CC);
});
