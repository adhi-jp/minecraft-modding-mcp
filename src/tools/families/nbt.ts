import { z } from "zod";

import type { Config } from "../../types.js";
import { applyNbtJsonPatch, nbtBase64ToTypedJson, typedJsonToNbtBase64 } from "../../nbt/pipeline.js";
import { nonEmptyString } from "../schemas.js";
import type { CatalogToolSpec } from "../types.js";

/**
 * NBT family: Java Edition NBT bytes to a typed JSON document and back, and
 * RFC 6902 JSON Patch over that document. `typedJson` and the `patch`
 * operations are data documents: the NBT pipeline validates them by their own
 * format rules, so their members are not checked as control-object keys.
 */

/** The size limits the server is configured with (MCP_MAX_NBT_*). */
function nbtLimits(config: Config) {
  return {
    maxInputBytes: config.maxNbtInputBytes,
    maxInflatedBytes: config.maxNbtInflatedBytes,
    maxResponseBytes: config.maxNbtResponseBytes
  };
}

/** A small uncompressed NBT payload: compound "R" holding the int `answer` = 42. */
const EXAMPLE_NBT_BASE64 = "CgABUgMABmFuc3dlcgAAACoA";

const EXAMPLE_DOCUMENT = {
  rootName: "R",
  root: { type: "compound", value: { answer: { type: "int", value: 42 } } }
};

const TYPED_JSON_DESCRIPTION = "Typed NBT document {rootName, root}; every node is {type, value}, as nbt-decode returns.";

// ---------------------------------------------------------------------------
// nbt-decode
// ---------------------------------------------------------------------------

const nbtDecodeInput = z.strictObject({
  nbtBase64: nonEmptyString.describe("Java Edition NBT bytes as base64; whitespace is ignored."),
  compression: z
    .enum(["none", "gzip", "auto"])
    .default("auto")
    .describe("auto: gunzip when the bytes start with the gzip header.")
});

export const nbtDecodeSpec: CatalogToolSpec<z.output<typeof nbtDecodeInput>> = {
  name: "nbt-decode",
  description:
    "Decode Java Edition NBT bytes (base64, gzip or uncompressed) into a typed JSON document " +
    "{rootName, root}, where every node is {type, value} and long values are decimal strings. " +
    `Example: {"nbtBase64":"${EXAMPLE_NBT_BASE64}"}`,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: nbtDecodeInput,
  examples: [{ nbtBase64: EXAMPLE_NBT_BASE64 }, { nbtBase64: EXAMPLE_NBT_BASE64, compression: "none" }],
  statuses: ["ok"],
  primaryKey: "typedJson",
  handler: async (input, call) => {
    const output = nbtBase64ToTypedJson(
      { nbtBase64: input.nbtBase64, compression: input.compression },
      nbtLimits(call.config)
    );
    return {
      result: {
        typedJson: output.typedJson,
        compressionDetected: output.meta.compressionDetected,
        inputBytes: output.meta.inputBytes
      }
    };
  }
};

// ---------------------------------------------------------------------------
// nbt-encode
// ---------------------------------------------------------------------------

const nbtEncodeInput = z.strictObject({
  typedJson: z.unknown().describe(TYPED_JSON_DESCRIPTION),
  compression: z.enum(["none", "gzip"]).default("none").describe("gzip compresses the output.")
});

export const nbtEncodeSpec: CatalogToolSpec<z.output<typeof nbtEncodeInput>> = {
  name: "nbt-encode",
  description:
    "Encode a typed NBT JSON document, as nbt-decode returns it, into Java Edition NBT bytes as base64, " +
    "uncompressed or gzip. A malformed document fails with ERR_NBT_INVALID_TYPED_JSON naming the node. " +
    `Example: {"typedJson":${JSON.stringify(EXAMPLE_DOCUMENT)},"compression":"gzip"}`,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: nbtEncodeInput,
  examples: [{ typedJson: EXAMPLE_DOCUMENT, compression: "gzip" }],
  statuses: ["ok"],
  primaryKey: "nbtBase64",
  handler: async (input, call) => {
    const output = typedJsonToNbtBase64(
      { typedJson: input.typedJson, compression: input.compression },
      nbtLimits(call.config)
    );
    return {
      result: {
        nbtBase64: output.nbtBase64,
        outputBytes: output.meta.outputBytes,
        compressionApplied: output.meta.compressionApplied
      }
    };
  }
};

// ---------------------------------------------------------------------------
// nbt-patch
// ---------------------------------------------------------------------------

/** One RFC 6902 operation; members the operation does not use are ignored, as the RFC says. */
const patchOperation = z.looseObject({
  op: z.enum(["add", "remove", "replace", "test"]),
  path: z.string().describe('JSON Pointer into typedJson; "" is the whole document.'),
  value: z.unknown().optional()
});

const nbtPatchInput = z.strictObject({
  typedJson: z.unknown().describe(TYPED_JSON_DESCRIPTION),
  patch: z
    .array(patchOperation)
    .min(1)
    .describe("RFC 6902 operations, applied in order; add, replace and test need value.")
});

export const nbtPatchSpec: CatalogToolSpec<z.output<typeof nbtPatchInput>> = {
  name: "nbt-patch",
  description:
    "Apply RFC 6902 add, remove, replace and test operations in order to a typed NBT JSON document; returns the " +
    "new document. value is the JSON put at path: a typed node {type, value} at a node's path. Every operation " +
    "must leave valid typed NBT; a failed test fails with ERR_JSON_PATCH_CONFLICT. " +
    'Example: {"typedJson":{...},"patch":[{"op":"replace","path":"/root/value/answer/value","value":7}]}',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: nbtPatchInput,
  examples: [
    {
      typedJson: EXAMPLE_DOCUMENT,
      patch: [
        { op: "test", path: "/root/value/answer", value: { type: "int", value: 42 } },
        { op: "replace", path: "/root/value/answer/value", value: 7 }
      ]
    }
  ],
  statuses: ["ok"],
  primaryKey: "typedJson",
  handler: async (input, call) => {
    const output = applyNbtJsonPatch({ typedJson: input.typedJson, patch: input.patch }, nbtLimits(call.config));
    return {
      result: {
        typedJson: output.typedJson,
        appliedOps: output.meta.appliedOps,
        testOps: output.meta.testOps,
        changed: output.meta.changed
      }
    };
  }
};

export const NBT_TOOL_SPECS: readonly CatalogToolSpec[] = [nbtDecodeSpec, nbtEncodeSpec, nbtPatchSpec];
