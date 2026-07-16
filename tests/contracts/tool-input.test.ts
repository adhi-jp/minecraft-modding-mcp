import assert from "node:assert/strict";
import test from "node:test";

import { prepareToolInput } from "../../src/tool-input.ts";

test("prepareToolInput coerces only documented top-level numeric string fields", () => {
  const rawInput = {
    limit: "25",
    typedJson: {
      limit: "07",
      nested: {
        maxLines: "11"
      }
    },
    patch: [
      {
        op: "replace",
        path: "/meta",
        value: {
          maxChars: "15"
        }
      }
    ]
  };

  const prepared = prepareToolInput(rawInput);

  assert.deepEqual(prepared.normalizedInput, {
    limit: 25,
    typedJson: {
      limit: "07",
      nested: {
        maxLines: "11"
      }
    },
    patch: [
      {
        op: "replace",
        path: "/meta",
        value: {
          maxChars: "15"
        }
      }
    ]
  });
  assert.deepEqual(rawInput, {
    limit: "25",
    typedJson: {
      limit: "07",
      nested: {
        maxLines: "11"
      }
    },
    patch: [
      {
        op: "replace",
        path: "/meta",
        value: {
          maxChars: "15"
        }
      }
    ]
  });
});

test("prepareToolInput only reports removed official mapping namespace on tool fields", () => {
  const prepared = prepareToolInput({
    mapping: "official",
    typedJson: {
      mapping: "official"
    },
    patch: [
      {
        op: "add",
        path: "/mapping",
        value: {
          sourceMapping: "official"
        }
      }
    ]
  });

  assert.deepEqual(prepared.removedOfficialPaths, ["mapping"]);
});

const POSITIVE_INT_FIELD_NAMES = [
  "limit",
  "startLine",
  "endLine",
  "maxLines",
  "maxChars",
  "maxMembers",
  "maxBytes",
  "maxVersions",
  "maxClassResults"
] as const;

const MAPPING_FIELD_NAMES = ["mapping", "sourceMapping", "targetMapping", "classNameMapping"] as const;

test("prepareToolInput coerces every POSITIVE_INT_FIELD_NAMES entry from a numeric string to a number", () => {
  for (const field of POSITIVE_INT_FIELD_NAMES) {
    const prepared = prepareToolInput({ [field]: "42" });
    const normalized = prepared.normalizedInput as Record<string, unknown>;
    assert.equal(normalized[field], 42, `expected ${field} to be coerced from "42" to 42`);
  }
});

test("prepareToolInput leaves non-numeric values, leading-zero-only and signed numerics unchanged", () => {
  for (const field of POSITIVE_INT_FIELD_NAMES) {
    const prepared = prepareToolInput({ [field]: "abc" });
    const normalized = prepared.normalizedInput as Record<string, unknown>;
    assert.equal(normalized[field], "abc", `expected ${field} to remain string when not numeric`);
  }
  const signed = prepareToolInput({ limit: "-5" }).normalizedInput as Record<string, unknown>;
  assert.equal(signed.limit, "-5", "negative numeric strings must remain strings");
  // The regex /^\d+$/ only matches non-negative integers; everything else passes through unchanged.
});

test("prepareToolInput reports every MAPPING_FIELD_NAMES entry that holds the removed 'official' namespace", () => {
  for (const field of MAPPING_FIELD_NAMES) {
    const prepared = prepareToolInput({ [field]: "official" });
    assert.deepEqual(prepared.removedOfficialPaths, [field]);
    assert.ok(prepared.suggestedReplacementInput, "suggestedReplacementInput must be present when official is rejected");
    assert.equal(
      (prepared.suggestedReplacementInput as Record<string, unknown>)[field],
      "obfuscated",
      `expected ${field} to be rewritten to "obfuscated"`
    );
  }
});

test("prepareToolInput trims whitespace around 'official' before flagging it", () => {
  for (const field of MAPPING_FIELD_NAMES) {
    const prepared = prepareToolInput({ [field]: "  official  " });
    assert.deepEqual(prepared.removedOfficialPaths, [field], `expected ${field} to be flagged after trim`);
  }
});

test("prepareToolInput leaves valid mapping namespaces alone", () => {
  for (const value of ["mojang", "yarn", "intermediary", "obfuscated"]) {
    const prepared = prepareToolInput({ mapping: value });
    assert.deepEqual(prepared.removedOfficialPaths, []);
    assert.equal(prepared.suggestedReplacementInput, undefined);
  }
});

test("prepareToolInput coercion does not descend into nested objects or arrays", () => {
  const prepared = prepareToolInput({
    nested: { limit: "9" },
    arr: [{ limit: "9" }]
  });
  const normalized = prepared.normalizedInput as Record<string, any>;
  assert.equal(normalized.nested.limit, "9", "nested.limit must stay a string");
  assert.equal(normalized.arr[0].limit, "9", "arr[*].limit must stay a string");
});

test("prepareToolInput returns suggestedReplacementInput only when at least one official mapping was found", () => {
  const noOfficial = prepareToolInput({ mapping: "mojang" });
  assert.equal(noOfficial.suggestedReplacementInput, undefined);
  const withOfficial = prepareToolInput({ mapping: "official", classNameMapping: "yarn" });
  assert.deepEqual(withOfficial.removedOfficialPaths, ["mapping"]);
  const replacement = withOfficial.suggestedReplacementInput as Record<string, unknown>;
  assert.equal(replacement.mapping, "obfuscated");
  assert.equal(replacement.classNameMapping, "yarn");
});

test("prepareToolInput passes through non-object inputs unchanged", () => {
  assert.equal(prepareToolInput(undefined).normalizedInput, undefined);
  assert.equal(prepareToolInput(null).normalizedInput, null);
  assert.equal(prepareToolInput("string").normalizedInput, "string");
  assert.deepEqual(prepareToolInput([1, 2, 3]).normalizedInput, [1, 2, 3]);
});
