import assert from "node:assert/strict";
import test from "node:test";

import { prepareToolInput } from "../src/tool-input.ts";

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
