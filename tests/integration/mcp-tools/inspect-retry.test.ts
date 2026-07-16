import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { inspectMinecraftSchema } from "../../../src/entry-tools/inspect-minecraft-service.ts";
import { callTool } from "../../helpers/mcp-tools-harness.ts";

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

test("inspect-minecraft string workspace focus returns validated class/search/file recovery examples", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-source",
    subject: {
      kind: "workspace",
      projectPath: "/tmp/example",
      mapping: "mojang",
      preferProjectVersion: true,
      focus: "net.minecraft.world.level.block.entity.HopperBlockEntity"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          reason?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              projectPath?: string;
              mapping?: string;
              preferProjectVersion?: boolean;
              focus?: { kind?: string };
            };
          };
        }>;
      };
    };
  };

  const error = result.structuredContent?.error;
  assert.equal(result.isError, true);
  assert.equal(error?.code, "ERR_INVALID_INPUT");
  assert.ok(error?.fieldErrors?.some((entry) => entry.path === "subject.focus"));
  assert.ok(error?.hints?.some((hint) => /focus.*object.*not.*string/i.test(hint)));
  assert.equal(error?.suggestedCall, undefined, "an ambiguous string focus must never be coerced");

  const examples = error?.exampleCalls ?? [];
  assert.equal(examples.length, 3);
  assert.deepEqual(
    examples.map((example) => example.params?.subject?.focus?.kind).sort(),
    ["class", "file", "search"]
  );
  for (const example of examples) {
    assert.equal(example.tool, "inspect-minecraft");
    assert.equal(example.params?.subject?.kind, "workspace");
    assert.equal(example.params?.subject?.projectPath, "/tmp/example");
    assert.equal(example.params?.subject?.mapping, "mojang");
    assert.equal(example.params?.subject?.preferProjectVersion, true);
    assert.equal(inspectMinecraftSchema.safeParse(example.params).success, true);
  }

  const byKind = new Map(examples.map((example) => [example.params?.subject?.focus?.kind, example]));
  assert.equal(byKind.get("class")?.params?.task, "class-source");
  assert.equal(byKind.get("search")?.params?.task, "auto");
  assert.equal(byKind.get("file")?.params?.task, "auto");
});

test("inspect-minecraft preserves focus recovery examples when preflight also rejects official mapping", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "class-source",
    mapping: "official",
    subject: {
      kind: "workspace",
      projectPath: "/tmp/example",
      mapping: "mojang",
      strictVersion: false,
      focus: "Item"
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: unknown;
        exampleCalls?: Array<{
          tool?: string;
          params?: {
            task?: string;
            subject?: {
              kind?: string;
              projectPath?: string;
              mapping?: string;
              strictVersion?: boolean;
              focus?: { kind?: string };
            };
          };
        }>;
      };
    };
  };

  const error = result.structuredContent?.error;
  assert.equal(result.isError, true);
  assert.equal(error?.code, "ERR_INVALID_INPUT");
  assert.ok(error?.fieldErrors?.some((entry) => entry.path === "mapping"));
  assert.ok(error?.hints?.some((hint) => /official.*obfuscated/i.test(hint)));
  assert.ok(error?.hints?.some((hint) => /focus.*object.*not.*string/i.test(hint)));
  assert.equal(error?.suggestedCall, undefined, "an ambiguous string focus must never be coerced");

  const examples = error?.exampleCalls ?? [];
  assert.equal(examples.length, 3);
  assert.deepEqual(
    examples.map((example) => example.params?.subject?.focus?.kind).sort(),
    ["class", "file", "search"]
  );
  for (const example of examples) {
    assert.equal(example.tool, "inspect-minecraft");
    assert.equal(example.params?.subject?.kind, "workspace");
    assert.equal(example.params?.subject?.projectPath, "/tmp/example");
    assert.equal(example.params?.subject?.mapping, "mojang");
    assert.equal(example.params?.subject?.strictVersion, false);
    assert.equal(inspectMinecraftSchema.safeParse(example.params).success, true);
  }

  const byKind = new Map(examples.map((example) => [example.params?.subject?.focus?.kind, example]));
  assert.equal(byKind.get("class")?.params?.task, "class-source");
  assert.equal(byKind.get("search")?.params?.task, "auto");
  assert.equal(byKind.get("file")?.params?.task, "auto");
});

test("inspect-minecraft rollback mode suppresses invalid suggestedCall when focus recovery applies", () => {
  const subprocess = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        const { callTool } = await import("./tests/helpers/mcp-tools-harness.ts");
        const result = await callTool("inspect-minecraft", {
          task: "class-source",
          mapping: "official",
          subject: {
            kind: "workspace",
            projectPath: "/tmp/example",
            mapping: "mojang",
            focus: "Item"
          }
        });
        process.stdout.write(JSON.stringify(result.structuredContent?.error));
      `
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, SUGGESTED_CALL_VALIDATE_OFF: "1" },
      encoding: "utf8"
    }
  );

  assert.equal(subprocess.status, 0, `subprocess failed: ${subprocess.stderr}`);
  const error = JSON.parse(subprocess.stdout) as {
    code?: string;
    hints?: string[];
    suggestedCall?: unknown;
    exampleCalls?: Array<{
      params?: {
        subject?: { focus?: { kind?: string } };
      };
    }>;
  };

  assert.equal(error.code, "ERR_INVALID_INPUT");
  assert.equal(error.suggestedCall, undefined, "focus guidance must suppress the invalid primary call");
  assert.ok(error.hints?.some((hint) => /focus.*object.*not.*string/i.test(hint)));
  assert.equal(
    error.hints?.some((hint) => /suggested call payload failed schema validation/i.test(hint)),
    false,
    "rollback mode must not claim that schema validation dropped the primary call"
  );

  const examples = error.exampleCalls ?? [];
  assert.equal(examples.length, 3);
  assert.deepEqual(
    examples.map((example) => example.params?.subject?.focus?.kind).sort(),
    ["class", "file", "search"]
  );
  for (const example of examples) {
    assert.equal(inspectMinecraftSchema.safeParse(example.params).success, true);
  }
});

test("inspect-minecraft focus recovery preserves only valid workspace fields", async () => {
  const result = await callTool("inspect-minecraft", {
    task: "describe-this",
    subject: {
      kind: "workspace",
      projectPath: "/tmp/example",
      mapping: "named",
      scope: "everything",
      gradleUserHome: "/tmp/gradle-home",
      preferProjectVersion: "yes",
      strictVersion: false,
      focus: "Item"
    }
  }) as {
    structuredContent?: {
      error?: {
        exampleCalls?: Array<{
          params?: {
            task?: string;
            subject?: Record<string, unknown>;
          };
        }>;
      };
    };
  };

  const examples = result.structuredContent?.error?.exampleCalls ?? [];
  assert.equal(examples.length, 3);
  for (const example of examples) {
    assert.equal(example.params?.task, "auto");
    assert.equal(example.params?.subject?.gradleUserHome, "/tmp/gradle-home");
    assert.equal(example.params?.subject?.strictVersion, false);
    assert.equal(example.params?.subject?.mapping, undefined);
    assert.equal(example.params?.subject?.scope, undefined);
    assert.equal(example.params?.subject?.preferProjectVersion, undefined);
    assert.equal(inspectMinecraftSchema.safeParse(example.params).success, true);
  }
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
