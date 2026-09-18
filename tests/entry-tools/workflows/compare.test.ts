import assert from "node:assert/strict";
import test from "node:test";

import { CompareMinecraftService } from "../../../src/entry-tools/compare-minecraft-service.ts";

test("CompareMinecraftService summarizes changed versions without full class lists by default", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B"],
        removed: ["c.C"],
        addedCount: 2,
        removedCount: 1,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 1,
          totalAdded: 1,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "versions",
    detail: "summary",
    subject: {
      kind: "version-pair",
      fromVersion: "1.20.4",
      toVersion: "1.21"
    }
  });

  assert.equal(result.summary.status, "changed");
  assert.equal(result.summary.counts?.addedClasses, 2);
  assert.equal(result.summary.counts?.changedRegistries, 1);
  assert.equal(Array.isArray(result.classes?.added), false);
});

test("CompareMinecraftService emits truncation metadata when summary samples are clipped", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B", "c.C", "d.D", "e.E", "f.F"],
        removed: [],
        addedCount: 6,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [
          "minecraft:damage_type",
          "minecraft:trim_pattern",
          "minecraft:trim_material",
          "minecraft:wolf_variant",
          "minecraft:jukebox_song",
          "minecraft:painting_variant"
        ],
        removedRegistries: [
          "minecraft:legacy_a",
          "minecraft:legacy_b",
          "minecraft:legacy_c",
          "minecraft:legacy_d",
          "minecraft:legacy_e",
          "minecraft:legacy_f"
        ],
        summary: {
          registriesChanged: 2,
          totalAdded: 6,
          totalRemoved: 6
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const subject = {
    kind: "version-pair" as const,
    fromVersion: "1.20.4",
    toVersion: "1.21"
  };
  const result = await service.execute({
    task: "versions",
    detail: "summary",
    subject
  });

  assert.equal(result.summary.status, "changed");
  assert.deepEqual(result.meta?.truncated, {
    didTruncate: true,
    reason: "limit",
    omittedGroups: ["classes", "registry"],
    nextActions: [
      {
        tool: "compare-minecraft",
        params: {
          task: "versions",
          detail: "standard",
          include: ["classes", "registry"],
          subject
        }
      }
    ]
  });
});

test("CompareMinecraftService keeps truncation metadata for clipped summary classes when registry is included", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B", "c.C", "d.D", "e.E", "f.F"],
        removed: [],
        addedCount: 6,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [
          "minecraft:damage_type",
          "minecraft:trim_pattern",
          "minecraft:trim_material",
          "minecraft:wolf_variant",
          "minecraft:jukebox_song",
          "minecraft:painting_variant"
        ],
        removedRegistries: [
          "minecraft:legacy_a",
          "minecraft:legacy_b",
          "minecraft:legacy_c",
          "minecraft:legacy_d",
          "minecraft:legacy_e",
          "minecraft:legacy_f"
        ],
        summary: {
          registriesChanged: 2,
          totalAdded: 6,
          totalRemoved: 6
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const subject = {
    kind: "version-pair" as const,
    fromVersion: "1.20.4",
    toVersion: "1.21"
  };
  const result = await service.execute({
    task: "versions",
    detail: "summary",
    include: ["registry"],
    subject
  });

  assert.deepEqual(result.meta?.truncated, {
    didTruncate: true,
    reason: "limit",
    omittedGroups: ["classes"],
    nextActions: [
      {
        tool: "compare-minecraft",
        params: {
          task: "versions",
          detail: "standard",
          include: ["classes", "registry"],
          subject
        }
      }
    ]
  });
});

test("CompareMinecraftService keeps truncation metadata for clipped summary registry data when classes are included", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["a.A", "b.B", "c.C", "d.D", "e.E", "f.F"],
        removed: [],
        addedCount: 6,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [
          "minecraft:damage_type",
          "minecraft:trim_pattern",
          "minecraft:trim_material",
          "minecraft:wolf_variant",
          "minecraft:jukebox_song",
          "minecraft:painting_variant"
        ],
        removedRegistries: [
          "minecraft:legacy_a",
          "minecraft:legacy_b",
          "minecraft:legacy_c",
          "minecraft:legacy_d",
          "minecraft:legacy_e",
          "minecraft:legacy_f"
        ],
        summary: {
          registriesChanged: 2,
          totalAdded: 6,
          totalRemoved: 6
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const subject = {
    kind: "version-pair" as const,
    fromVersion: "1.20.4",
    toVersion: "1.21"
  };
  const result = await service.execute({
    task: "versions",
    detail: "summary",
    include: ["classes"],
    subject
  });

  assert.deepEqual(result.meta?.truncated, {
    didTruncate: true,
    reason: "limit",
    omittedGroups: ["registry"],
    nextActions: [
      {
        tool: "compare-minecraft",
        params: {
          task: "versions",
          detail: "standard",
          include: ["classes", "registry"],
          subject
        }
      }
    ]
  });
});

test("CompareMinecraftService forwards sourcePriority for class diffs", async () => {
  const seenInputs: Array<{
    className: string;
    fromVersion: string;
    toVersion: string;
    mapping?: "obfuscated" | "mojang" | "intermediary" | "yarn";
    sourcePriority?: "loom-first" | "maven-first";
    includeFullDiff?: boolean;
  }> = [];
  const service = new CompareMinecraftService({
    compareVersions: async () => {
      throw new Error("not used");
    },
    diffClassSignatures: async (input) => {
      seenInputs.push(input);
      return {
        query: { className: input.className, mapping: input.mapping },
        range: { fromVersion: input.fromVersion, toVersion: input.toVersion },
        classChange: "modified",
        summary: {
          total: {
            added: 0,
            removed: 0,
            modified: 1
          }
        },
        constructors: { added: [], removed: [], modified: [] },
        methods: { added: [], removed: [], modified: [] },
        fields: { added: [], removed: [], modified: [] },
        warnings: []
      };
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "class-diff",
    detail: "summary",
    subject: {
      kind: "class",
      className: "net.minecraft.server.MinecraftServer",
      fromVersion: "1.21.3",
      toVersion: "1.21.4",
      mapping: "mojang",
      sourcePriority: "maven-first"
    }
  });

  assert.equal(result.summary.status, "changed");
  assert.deepEqual(seenInputs, [
    {
      className: "net.minecraft.server.MinecraftServer",
      fromVersion: "1.21.3",
      toVersion: "1.21.4",
      mapping: "mojang",
      sourcePriority: "maven-first",
      includeFullDiff: undefined
    }
  ]);
});

test("CompareMinecraftService returns partial registry-diff results when one side detail fetch fails", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.21.3",
      toVersion: "1.21.4",
      warnings: [],
      registry: {
        added: { "minecraft:item": ["minecraft:test"] },
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 1,
          totalAdded: 1,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async ({ version }) => {
      if (version === "1.21.3") {
        throw new Error('Failed to read registries.json for version "1.21.3".');
      }
      return {
        version,
        registries: {
          "minecraft:item": {
            entries: {
              "minecraft:test": {}
            }
          }
        },
        registryEntryCounts: {
          "minecraft:item": 1
        },
        returnedEntryCount: 1,
        dataTruncated: false,
        warnings: []
      };
    }
  });

  const result = await service.execute({
    task: "registry-diff",
    detail: "full",
    include: ["registry"],
    subject: {
      kind: "registry",
      registry: "minecraft:item",
      fromVersion: "1.21.3",
      toVersion: "1.21.4"
    }
  });

  assert.equal(result.summary.status, "partial");
  assert.equal(result.registry?.entries?.from, undefined);
  assert.equal(result.registry?.entries?.to?.version, "1.21.4");
  assert.ok(result.warnings?.some((warning) => warning.includes('1.21.3')));
});

test("CompareMinecraftService promotes migration follow-up into summary.nextActions with summary.subject", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: ["net.minecraft.world.item.BundleContents"],
        removed: [],
        addedCount: 1,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: {},
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 0,
          totalAdded: 0,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "migration-overview",
    detail: "summary",
    subject: {
      kind: "version-pair",
      fromVersion: "1.20.4",
      toVersion: "1.21"
    }
  });

  assert.deepEqual(result.summary.subject, {
    task: "migration-overview",
    kind: "version-pair",
    fromVersion: "1.20.4",
    toVersion: "1.21"
  });
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "compare-minecraft",
      params: {
        task: "class-diff",
        subject: {
          kind: "class",
          className: "net.minecraft.world.item.BundleContents",
          fromVersion: "1.20.4",
          toVersion: "1.21"
        }
      }
    }
  ]);
});

test("CompareMinecraftService falls back to artifact follow-up when migration overview has class counts without representative class names", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "1.20.4",
      toVersion: "1.21",
      warnings: [],
      classes: {
        added: [],
        removed: [],
        addedCount: 2,
        removedCount: 1,
        unchanged: 10
      },
      registry: {
        added: {},
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 0,
          totalAdded: 0,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "migration-overview",
    detail: "summary",
    subject: {
      kind: "version-pair",
      fromVersion: "1.20.4",
      toVersion: "1.21"
    }
  });

  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "inspect-minecraft",
      params: {
        task: "artifact",
        subject: {
          kind: "version",
          version: "1.21"
        }
      }
    }
  ]);
});

test("CompareMinecraftService adds a libraries diff block to migration-overview revealing a library swap", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "26.2",
      toVersion: "26.3",
      warnings: [],
      classes: {
        added: [],
        removed: [],
        addedCount: 0,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: {},
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 0,
          totalAdded: 0,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    },
    getVersionLibraries: async ({ version }) => {
      if (version === "26.2") {
        return [
          "org.lwjgl:lwjgl-glfw:3.4.1",
          "org.lwjgl:lwjgl-glfw:3.4.1:natives-linux",
          "at.yawk.lz4:lz4-java:1.10.0"
        ];
      }
      return ["org.libsdl:sdl3:3.2.0", "at.yawk.lz4:lz4-java:1.10.1"];
    }
  });

  const result = await service.execute({
    task: "migration-overview",
    detail: "standard",
    subject: {
      kind: "version-pair",
      fromVersion: "26.2",
      toVersion: "26.3"
    }
  });

  assert.deepEqual(result.migration?.libraries, {
    added: ["org.libsdl:sdl3:3.2.0"],
    removed: ["org.lwjgl:lwjgl-glfw:3.4.1"],
    addedCount: 1,
    removedCount: 1,
    versionChangedCount: 1
  });
  assert.equal(result.summary.counts?.librariesAdded, 1);
  assert.equal(result.summary.counts?.librariesRemoved, 1);
});

test("CompareMinecraftService warns and keeps migration-overview intact when library details fail to fetch", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "26.2",
      toVersion: "26.3",
      warnings: [],
      classes: {
        added: ["net.minecraft.Foo"],
        removed: [],
        addedCount: 1,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: {},
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 0,
          totalAdded: 0,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    },
    getVersionLibraries: async () => {
      throw new Error("offline");
    }
  });

  const result = await service.execute({
    task: "migration-overview",
    detail: "standard",
    subject: {
      kind: "version-pair",
      fromVersion: "26.2",
      toVersion: "26.3"
    }
  });

  assert.equal(result.migration?.libraries, undefined);
  assert.equal(result.summary.counts?.librariesAdded, undefined);
  assert.equal(result.summary.status, "changed");
  assert.ok(
    result.warnings?.some((warning: string) => warning.includes("libraries") && warning.includes("offline")),
    `expected a library-fetch warning, got: ${JSON.stringify(result.warnings)}`
  );
});

test("CompareMinecraftService omits the libraries block on migration-overview when the dependency is not wired", async () => {
  const service = new CompareMinecraftService({
    compareVersions: async () => ({
      fromVersion: "26.2",
      toVersion: "26.3",
      warnings: [],
      classes: {
        added: [],
        removed: [],
        addedCount: 0,
        removedCount: 0,
        unchanged: 10
      },
      registry: {
        added: {},
        removed: {},
        newRegistries: [],
        removedRegistries: [],
        summary: {
          registriesChanged: 0,
          totalAdded: 0,
          totalRemoved: 0
        }
      }
    }),
    diffClassSignatures: async () => {
      throw new Error("not used");
    },
    getRegistryData: async () => {
      throw new Error("not used");
    }
  });

  const result = await service.execute({
    task: "migration-overview",
    detail: "standard",
    subject: {
      kind: "version-pair",
      fromVersion: "26.2",
      toVersion: "26.3"
    }
  });

  assert.equal(result.migration?.libraries, undefined);
  assert.deepEqual(result.warnings, []);
});

test("CompareMinecraftService times out library enrichment on migration-overview instead of hanging on an unreachable network", async () => {
  const service = new CompareMinecraftService(
    {
      compareVersions: async () => ({
        fromVersion: "26.2",
        toVersion: "26.3",
        warnings: [],
        classes: {
          added: ["net.minecraft.Foo"],
          removed: [],
          addedCount: 1,
          removedCount: 0,
          unchanged: 10
        },
        registry: {
          added: {},
          removed: {},
          newRegistries: [],
          removedRegistries: [],
          summary: {
            registriesChanged: 0,
            totalAdded: 0,
            totalRemoved: 0
          }
        }
      }),
      diffClassSignatures: async () => {
        throw new Error("not used");
      },
      getRegistryData: async () => {
        throw new Error("not used");
      },
      // Never resolves, simulating an unreachable network after a restart
      // with cached jars. Without a deadline of its own, this would hang
      // the whole migration-overview call for the full fetch timeout.
      getVersionLibraries: () => new Promise(() => {})
    },
    { libraryDiffDeadlineMs: 20 }
  );

  // The deadline timer is unref'd on purpose (it must never keep the server
  // alive), and the stubbed fetch holds no handle either, so nothing else keeps
  // this test's event loop alive while it waits: Node 22 drains the loop and
  // cancels the still-pending test. Hold the loop with a bounded, referenced
  // timer; if the deadline ever stopped firing, the loop drains after 5 s and
  // the test fails instead of hanging.
  const keepAlive = setTimeout(() => undefined, 5_000);
  const start = Date.now();
  let result;
  try {
    result = await service.execute({
      task: "migration-overview",
      detail: "standard",
      subject: {
        kind: "version-pair",
        fromVersion: "26.2",
        toVersion: "26.3"
      }
    });
  } finally {
    clearTimeout(keepAlive);
  }
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 2000, `expected the call to complete quickly, took ${elapsedMs}ms`);
  assert.equal(result.migration?.libraries, undefined);
  assert.equal(result.summary.counts?.librariesAdded, undefined);
  // The rest of the result must remain intact even though libraries timed out.
  assert.equal(result.summary.status, "changed");
  assert.ok(
    result.warnings?.some((warning: string) => /librar/i.test(warning) && /timed out/i.test(warning)),
    `expected a library timeout warning, got: ${JSON.stringify(result.warnings)}`
  );
});
