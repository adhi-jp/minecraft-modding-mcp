import assert from "node:assert/strict";
import test from "node:test";

import { callTool } from "./helpers/mcp-tools-harness.ts";

test("inspect-minecraft search without artifact context returns retryable suggestedCall", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "search",
    subject: {
      kind: "search",
      query: "CreativeModeTab"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string };
              };
            };
          };
        }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  // No detectable version: the recovery is a fill-in template (exampleCalls),
  // not a non-executable placeholder suggestedCall.
  assert.equal(result.structuredContent?.error?.suggestedCall, undefined);
  const example = result.structuredContent?.error?.exampleCalls?.[0];
  assert.equal(example?.tool, "inspect-minecraft");
  assert.equal(example?.params?.task, "search");
  assert.equal(example?.params?.subject?.kind, "search");
  assert.equal(example?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(example?.params?.subject?.artifact?.target?.kind, "version");
});

test("inspect-minecraft class-source without artifact context returns retryable suggestedCall", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-source",
    subject: {
      kind: "class",
      className: "net.minecraft.world.item.Item"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string };
              };
            };
          };
        }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall, undefined);
  const example = result.structuredContent?.error?.exampleCalls?.[0];
  assert.equal(example?.tool, "inspect-minecraft");
  assert.equal(example?.params?.task, "class-source");
  assert.equal(example?.params?.subject?.kind, "class");
  assert.equal(example?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(example?.params?.subject?.artifact?.target?.kind, "version");
});

test("inspect-minecraft class-members without artifact context preserves the requested task in suggestedCall", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-members",
    subject: {
      kind: "class",
      className: "net.minecraft.world.item.Item"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string };
              };
            };
          };
        }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall, undefined);
  const example = result.structuredContent?.error?.exampleCalls?.[0];
  assert.equal(example?.tool, "inspect-minecraft");
  assert.equal(example?.params?.task, "class-members");
  assert.equal(example?.params?.subject?.kind, "class");
  assert.equal(example?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(example?.params?.subject?.artifact?.target?.kind, "version");
});

test("inspect-minecraft class-source with version subject returns concrete retry guidance", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-source",
    subject: {
      kind: "version",
      version: "1.21.10"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              artifact?: {
                type?: string;
                target?: { kind?: string; value?: string };
              };
            };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "inspect-minecraft");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.task, "class-source");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.kind, "class");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.type, "resolve-target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.target?.kind, "version");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.artifact?.target?.value, "1.21.10");
});

test("inspect-minecraft class-members with version subject returns retry guidance instead of a dead-end error", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-members",
    subject: {
      kind: "version",
      version: "1.21.10"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              version?: string;
            };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "inspect-minecraft");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.task, "artifact");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.kind, "version");
  assert.equal(result.structuredContent?.error?.suggestedCall?.params?.subject?.version, "1.21.10");
});

test("resolve-artifact invalid string target returns retryable object target suggestedCall", async () => {
  const result = await callTool("resolve-artifact", {
    target: "1.21.10",
    allowDecompile: true,
    preferProjectVersion: false,
    strictVersion: false
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        suggestedCall?: {
          tool?: string;
          params?: { target?: { kind?: string; value?: string } };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.fieldErrors?.[0]?.path, "target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "resolve-artifact");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    target: {
      kind: "version",
      value: "1.21.10"
    }
  });
});

test("get-class-source invalid string target returns resolve-target suggestedCall", async () => {
  const result = await callTool("get-class-source", {
    className: "net.minecraft.server.Main",
    target: "1.21.10",
    mode: "metadata",
    allowDecompile: true,
    preferProjectVersion: false,
    strictVersion: false
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        suggestedCall?: {
          tool?: string;
          params?: {
            className?: string;
            target?: { type?: string; kind?: string; value?: string };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.fieldErrors?.[0]?.path, "target");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "get-class-source");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    className: "net.minecraft.server.Main",
    target: {
      kind: "version",
      value: "1.21.10"
    }
  });
});

test("get-class-members invalid string target suggestedCall preserves valid fields only", async () => {
  const result = await callTool("get-class-members", {
    className: "net.minecraft.server.Main",
    target: "1.21.10",
    access: "all",
    memberPattern: "tick",
    mode: "full",
    outputFile: "/tmp/ignored.java",
    startLine: 10
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: Record<string, unknown>;
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "get-class-members");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    className: "net.minecraft.server.Main",
    target: {
      kind: "version",
      value: "1.21.10"
    },
    access: "all",
    memberPattern: "tick"
  });
});
