import assert from "node:assert/strict";
import test from "node:test";

import { callTool } from "../../helpers/mcp-tools-harness.ts";

test("analyze-symbol rejects api-overview requests that include owner or descriptor selectors", async () => {
  const result = await callTool("analyze-symbol", {
    task: "api-overview",
    version: "1.21.10",
    subject: {
      kind: "class",
      name: "net.minecraft.world.level.block.Blocks",
      owner: "net.minecraft.world.level.block.Blocks"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "subject.owner")
  );
});

test("find-mapping accepts short obfuscated class names", async () => {
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "class",
    name: "dhl",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
      };
      result?: {
        status?: string;
        resolvedSymbol?: {
          name?: string;
        };
      };
    };
  };

  assert.notEqual(result.isError, true);
  assert.notEqual(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.result?.status, "resolved");
  assert.equal(result.structuredContent?.result?.resolvedSymbol?.name, "dhl");
});

test("find-mapping kind=method without descriptor is accepted (default signatureMode=name-only)", async () => {
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
      };
    };
  };

  // Whatever status (resolved/not_found/ambiguous), the input itself must not be rejected as invalid.
  assert.notEqual(
    result.structuredContent?.error?.code,
    "ERR_INVALID_INPUT",
    "find-mapping must not require descriptor under the default signatureMode=name-only"
  );
  assert.equal(
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "descriptor"),
    undefined
  );
});

test("find-mapping signatureMode=exact still rejects method lookups missing a descriptor", async () => {
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "descriptor")
  );
});

test("find-mapping signatureMode=name-only still rejects malformed descriptors", async () => {
  // name-only ignores a missing descriptor, but a malformed descriptor that the caller
  // does supply must still surface as ERR_INVALID_INPUT instead of being silently dropped.
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: "not-a-valid-descriptor",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "name-only"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
});

test("find-mapping descriptor validator rejects array dimensions above the JVM limit without a stack overflow", async () => {
  // JVM §4.3.2 caps array type dimensions at 255. Pathological inputs with 20000 leading `[`
  // must surface as ERR_INVALID_INPUT (enforcing the cap) and must NOT bubble up as
  // ERR_INTERNAL from a RangeError in the validator.
  const oversizedArrayDescriptor = `(${"[".repeat(20000)}I)V`;
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: oversizedArrayDescriptor,
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
      };
    };
  };

  const errorCode = result.structuredContent?.error?.code;
  assert.notEqual(errorCode, "ERR_INTERNAL", "deep array descriptors must not crash the validator");
  assert.equal(
    errorCode,
    "ERR_INVALID_INPUT",
    "descriptors with more than 255 array dimensions must be rejected per JVM spec"
  );
});

test("find-mapping descriptor validator accepts arrays at the JVM dimension limit", async () => {
  // Exactly 255 leading `[` is the maximum valid JVM array depth. The validator must accept
  // the descriptor as syntactically valid (downstream may still return not_found because the
  // symbol does not exist); an ERR_INVALID_INPUT here would be an off-by-one rejection.
  const maxArrayDescriptor = `(${"[".repeat(255)}I)V`;
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: maxArrayDescriptor,
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: { code?: string };
    };
  };

  assert.notEqual(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.notEqual(result.structuredContent?.error?.code, "ERR_INTERNAL");
});

test("find-mapping signatureMode=exact does not resolve to a different overload when the caller's descriptor is stale", async () => {
  // When only foo(I)V exists in the mapping graph and the caller asks for foo(Z)V with
  // signatureMode="exact", the service must NOT silently resolve to the (I)V overload via
  // the owner+name descriptorless fallback. This guards against a bug where exact
  // lookups could return wrong overloads during migration-tooling workflows.
  const result = await callTool("find-mapping", {
    version: "1.21.10",
    kind: "method",
    owner: "net.minecraft.server.Main",
    name: "tick",
    descriptor: "(Z)V",
    sourceMapping: "obfuscated",
    targetMapping: "obfuscated",
    signatureMode: "exact"
  }) as {
    isError?: boolean;
    structuredContent?: {
      result?: {
        status?: string;
        resolved?: boolean;
        resolvedSymbol?: { descriptor?: string };
      };
      error?: { code?: string };
    };
  };

  // The call itself should not error on input validation (the descriptor is syntactically
  // valid). The specific graph state doesn't contain `tick(Z)V`, so we expect status=not_found
  // or mapping_unavailable — but NEVER resolved with a different descriptor.
  assert.notEqual(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  const payload = result.structuredContent?.result;
  if (payload?.resolved === true && payload.resolvedSymbol?.descriptor) {
    assert.equal(
      payload.resolvedSymbol.descriptor,
      "(Z)V",
      "exact-mode resolution must only accept descriptors equal to the requested one"
    );
  }
});

test("find-mapping descriptor validator rejects empty return type and unterminated L references", async () => {
  const invalidCases: string[] = ["()", "(I)", "(L;)V", "(Lfoo)V", "()X"];
  for (const descriptor of invalidCases) {
    const result = await callTool("find-mapping", {
      version: "1.21.10",
      kind: "method",
      owner: "net.minecraft.server.Main",
      name: "tick",
      descriptor,
      sourceMapping: "obfuscated",
      targetMapping: "obfuscated",
      signatureMode: "exact"
    }) as {
      isError?: boolean;
      structuredContent?: {
        error?: {
          code?: string;
        };
      };
    };
    assert.equal(
      result.structuredContent?.error?.code,
      "ERR_INVALID_INPUT",
      `descriptor "${descriptor}" must be rejected as ERR_INVALID_INPUT`
    );
  }
});
