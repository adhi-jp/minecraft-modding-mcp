import assert from "node:assert/strict";
import test from "node:test";

import {
  validateParsedMixin,
  type ResolvedTargetMembers
} from "../../src/mixin-validator.ts";
import {
  makeMember,
  makeTargetMembers,
  makeParsedMixin,
  makeProvenance
} from "../helpers/mixin-validator-fixtures.ts";

test("validateParsedMixin reports representative member-validation outcomes", () => {
  const cases = [
    {
      name: "target-not-found when class is missing",
      parsed: makeParsedMixin({ targets: [{ className: "NonExistentClass" }] }),
      targetMembers: new Map<string, ResolvedTargetMembers>(),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "target-not-found", target: "NonExistentClass" }
    },
    {
      name: "method-not-found for @Inject with suggestions",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tik", line: 5 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack", "jump"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", suggestionsInclude: "tick" }
    },
    {
      name: "field-not-found for @Shadow field",
      parsed: makeParsedMixin({
        shadows: [{ kind: "field", name: "healht", line: 8 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "hunger", "xp"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "field-not-found", suggestionsInclude: "health" }
    },
    {
      name: "method-not-found for @Shadow method",
      parsed: makeParsedMixin({
        shadows: [{ kind: "method", name: "tik", line: 10 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", annotation: "@Shadow" }
    },
    {
      name: "field-not-found for @Accessor target",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Accessor", name: "getSpeed", targetName: "speed", line: 12 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health", "hunger"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "field-not-found", annotation: "@Accessor" }
    },
    {
      name: "method-not-found for @Invoker target",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Invoker", name: "invokeDamage", targetName: "damage", line: 14 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", annotation: "@Invoker" }
    },
    {
      name: "@Invoker stays method-not-found when only matching field exists",
      parsed: makeParsedMixin({
        accessors: [{ annotation: "Invoker", name: "invokeDamage", targetName: "damage", line: 16 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["damage"] })]
      ]),
      expectedValid: false,
      expectedIssueCount: 1,
      expectedIssue: { kind: "method-not-found", annotation: "@Invoker" }
    },
    {
      name: "all members valid",
      parsed: makeParsedMixin({
        injections: [{ annotation: "Inject", method: "tick", line: 5 }],
        shadows: [
          { kind: "field", name: "health", line: 8 },
          { kind: "method", name: "attack", line: 10 }
        ],
        accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 12 }]
      }),
      targetMembers: new Map<string, ResolvedTargetMembers>([
        ["PlayerEntity", makeTargetMembers("PlayerEntity", {
          methods: ["tick", "attack"],
          fields: ["health", "hunger"]
        })]
      ]),
      expectedValid: true,
      expectedIssueCount: 0,
      expectedSummary: { injections: 1, shadows: 2, accessors: 1, total: 4 }
    }
  ] as const;

  for (const testCase of cases) {
    const warnings: string[] = [];
    const result = validateParsedMixin(testCase.parsed, testCase.targetMembers, warnings);

    assert.equal(result.valid, testCase.expectedValid, `${testCase.name}: valid`);
    assert.equal(result.issues.length, testCase.expectedIssueCount, `${testCase.name}: issue count`);

    if (testCase.expectedIssueCount > 0) {
      const issue = result.issues[0];
      assert.equal(issue.kind, testCase.expectedIssue?.kind, `${testCase.name}: issue kind`);
      if (testCase.expectedIssue?.target !== undefined) {
        assert.equal(issue.target, testCase.expectedIssue.target, `${testCase.name}: issue target`);
      }
      if (testCase.expectedIssue?.annotation !== undefined) {
        assert.equal(issue.annotation, testCase.expectedIssue.annotation, `${testCase.name}: issue annotation`);
      }
      if (testCase.expectedIssue?.suggestionsInclude !== undefined) {
        assert.ok(
          issue.suggestions?.includes(testCase.expectedIssue.suggestionsInclude),
          `${testCase.name}: suggestions`
        );
      }
    }

    if (testCase.expectedSummary !== undefined) {
      assert.equal(result.summary.injections, testCase.expectedSummary.injections, `${testCase.name}: injections`);
      assert.equal(result.summary.shadows, testCase.expectedSummary.shadows, `${testCase.name}: shadows`);
      assert.equal(result.summary.accessors, testCase.expectedSummary.accessors, `${testCase.name}: accessors`);
      assert.equal(result.summary.total, testCase.expectedSummary.total, `${testCase.name}: total`);
    }
  }
});

test("validateParsedMixin handles representative provenance output", async (t) => {
  const cases: Array<{
    name: string;
    run: () => void;
  }> = [
    {
      name: "includes provenance when provided",
      run: () => {
        const parsed = makeParsedMixin();
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];
        const provenance = makeProvenance();

        const result = validateParsedMixin(parsed, targetMembers, warnings, provenance);
        assert.deepEqual(result.provenance, provenance);
      }
    },
    {
      name: "omits provenance when not provided",
      run: () => {
        const parsed = makeParsedMixin();
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings);
        assert.equal(result.provenance, undefined);
      }
    },
    {
      name: "provenance reflects mapping fallback",
      run: () => {
        const parsed = makeParsedMixin();
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          makeProvenance({ requestedMapping: "yarn", mappingApplied: "obfuscated" })
        );
        assert.equal(result.provenance?.requestedMapping, "yarn");
        assert.equal(result.provenance?.mappingApplied, "obfuscated");
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      testCase.run();
    });
  }
});

test("validateParsedMixin tracks representative resolvedMembers states", async (t) => {
  const cases: Array<{
    name: string;
    run: () => void;
  }> = [
    {
      name: "includes resolvedMembers for resolved injection",
      run: () => {
        const parsed = makeParsedMixin({
          injections: [{ annotation: "Inject", method: "tick", line: 5 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick", "attack"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings);
        assert.ok(result.resolvedMembers);
        assert.equal(result.resolvedMembers.length, 1);
        assert.equal(result.resolvedMembers[0].status, "resolved");
        assert.equal(result.resolvedMembers[0].resolvedTo, "PlayerEntity#tick");
      }
    },
    {
      name: "includes resolvedMembers for not-found shadow",
      run: () => {
        const parsed = makeParsedMixin({
          shadows: [{ kind: "field", name: "missing", line: 8 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings);
        assert.ok(result.resolvedMembers);
        assert.equal(result.resolvedMembers[0].status, "not-found");
        assert.equal(result.resolvedMembers[0].annotation, "@Shadow");
      }
    },
    {
      name: "resolvedMembers tracks accessors",
      run: () => {
        const parsed = makeParsedMixin({
          accessors: [{ annotation: "Accessor", name: "getHealth", targetName: "health", line: 12 }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { fields: ["health"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings);
        assert.ok(result.resolvedMembers);
        assert.equal(result.resolvedMembers[0].status, "resolved");
        assert.equal(result.resolvedMembers[0].annotation, "@Accessor");
      }
    },
    {
      name: "omits resolvedMembers when no members to validate",
      run: () => {
        const parsed = makeParsedMixin();
        const targetMembers = new Map<string, ResolvedTargetMembers>([
          ["PlayerEntity", makeTargetMembers("PlayerEntity", { methods: ["tick"] })]
        ]);
        const warnings: string[] = [];

        const result = validateParsedMixin(parsed, targetMembers, warnings);
        assert.equal(result.resolvedMembers, undefined);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      testCase.run();
    });
  }
});

test("validateParsedMixin distinguishes mapping-failed and missing targets", async (t) => {
  const cases: Array<{
    name: string;
    run: () => void;
  }> = [
    {
      name: "reports target-mapping-failed when target is in mappingFailedTargets",
      run: () => {
        const parsed = makeParsedMixin({ targets: [{ className: "SomeClass" }] });
        const targetMembers = new Map<string, ResolvedTargetMembers>();
        const warnings: string[] = [];
        const mappingFailedTargets = new Set(["SomeClass"]);

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          undefined,
          undefined,
          mappingFailedTargets
        );
        assert.equal(result.issues.length, 1);
        // Canonical assertion for every field of a target-mapping-failed issue.
        assert.equal(result.issues[0].kind, "target-mapping-failed");
        assert.equal(result.issues[0].severity, "warning");
        assert.equal(result.issues[0].confidence, "uncertain");
        assert.equal(result.issues[0].issueOrigin, "tool_issue");
        assert.equal(result.issues[0].resolutionPath, "target-mapping-failed");
        assert.equal(result.issues[0].category, "mapping");
        assert.equal(result.valid, true);
      }
    },
    {
      name: "reports target-not-found for non-mapping failures",
      run: () => {
        const parsed = makeParsedMixin({ targets: [{ className: "MissingClass" }] });
        const targetMembers = new Map<string, ResolvedTargetMembers>();
        const warnings: string[] = [];
        const mappingFailedTargets = new Set(["OtherClass"]);

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          undefined,
          undefined,
          mappingFailedTargets
        );
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].kind, "target-not-found");
        assert.equal(result.issues[0].severity, "error");
      }
    },
    {
      name: "distinguishes mapping-failed and not-found in same batch",
      run: () => {
        const parsed = makeParsedMixin({
          targets: [{ className: "MappedClass" }, { className: "GoneClass" }]
        });
        const targetMembers = new Map<string, ResolvedTargetMembers>();
        const warnings: string[] = [];
        const mappingFailedTargets = new Set(["MappedClass"]);

        const result = validateParsedMixin(
          parsed,
          targetMembers,
          warnings,
          undefined,
          undefined,
          mappingFailedTargets
        );
        assert.equal(result.issues.length, 2);
        const kinds = result.issues.map((issue) => issue.kind);
        assert.ok(kinds.includes("target-mapping-failed"));
        assert.ok(kinds.includes("target-not-found"));
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      testCase.run();
    });
  }
});

test("validateParsedMixin handles descriptor-bearing and owner-prefixed method references", () => {
  // Each available method now carries its real jvmDescriptor: a descriptor-bearing
  // reference resolves only when an overload's descriptor matches.
  const cases = [
    {
      name: "descriptor-bearing method reference",
      annotation: "Inject",
      method: "playerTouch(Lnet/minecraft/world/entity/player/Player;)V",
      availableMethods: [
        { name: "playerTouch", jvmDescriptor: "(Lnet/minecraft/world/entity/player/Player;)V" },
        { name: "tick", jvmDescriptor: "()V" }
      ],
      valid: true
    },
    {
      name: "owner-prefixed method reference",
      annotation: "Redirect",
      method: "Lnet/minecraft/SomeClass;tick(I)V",
      availableMethods: [{ name: "tick", jvmDescriptor: "(I)V" }],
      valid: true
    },
    {
      name: "method name starting with L",
      annotation: "Inject",
      method: "Load(Lfoo/Bar;)V",
      availableMethods: [{ name: "Load", jvmDescriptor: "(Lfoo/Bar;)V" }],
      valid: true
    },
    {
      name: "missing method keeps descriptor hint",
      annotation: "Inject",
      method: "missingMethod(I)V",
      availableMethods: [{ name: "tick", jvmDescriptor: "()V" }],
      valid: false,
      issueMessageIncludes: "(descriptor: (I)V)"
    }
  ] as const;

  for (const testCase of cases) {
    const parsed = makeParsedMixin({
      injections: [{ annotation: testCase.annotation, method: testCase.method, line: 10 }]
    });
    const targetMembers = new Map<string, ResolvedTargetMembers>([
      ["PlayerEntity", {
        className: "PlayerEntity",
        constructors: [],
        methods: testCase.availableMethods.map((m) =>
          makeMember({ name: m.name, ownerFqn: "PlayerEntity", jvmDescriptor: m.jvmDescriptor })
        ),
        fields: []
      }]
    ]);
    const warnings: string[] = [];

    const result = validateParsedMixin(parsed, targetMembers, warnings);

    assert.equal(result.valid, testCase.valid, testCase.name);
    if (testCase.valid) {
      assert.equal(result.issues.length, 0, testCase.name);
      continue;
    }
    assert.equal(result.issues.length, 1, testCase.name);
    assert.ok(
      result.issues[0].message.includes(testCase.issueMessageIncludes!),
      testCase.name
    );
  }
});

test("validateParsedMixin flags an @Inject whose descriptor matches no overload", () => {
  // Target exposes only tick(I)V; the injection targets tick(D)V — a real
  // wrong-signature that name-only matching used to report as RESOLVED.
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick(D)V", line: 12 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", {
      className: "PlayerEntity",
      constructors: [],
      methods: [makeMember({ name: "tick", ownerFqn: "PlayerEntity", jvmDescriptor: "(I)V" })],
      fields: []
    }]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);

  assert.equal(result.valid, false, "descriptor mismatch must not be reported as valid");
  const issue = result.issues.find((i) => i.kind === "descriptor-mismatch");
  assert.ok(issue, `expected a descriptor-mismatch issue, got ${JSON.stringify(result.issues)}`);
  assert.equal(issue!.annotation, "@Inject");
  assert.ok(issue!.message.includes("(I)V"), "should list the available descriptor as a candidate");
});

test("validateParsedMixin resolves an @Inject whose descriptor matches an overload", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "tick(I)V", line: 12 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", {
      className: "PlayerEntity",
      constructors: [],
      methods: [
        makeMember({ name: "tick", ownerFqn: "PlayerEntity", jvmDescriptor: "(I)V" }),
        makeMember({ name: "tick", ownerFqn: "PlayerEntity", jvmDescriptor: "(D)V" })
      ],
      fields: []
    }]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test("validateParsedMixin resolves quantifier method selectors by name and skips bare wildcards", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "tick*", line: 10 },
      { annotation: "Inject", method: "tick+", line: 11 },
      { annotation: "Inject", method: "tick{1,2}", line: 12 },
      { annotation: "Inject", method: "*", line: 13 }
    ]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", {
      className: "PlayerEntity",
      constructors: [],
      methods: [
        makeMember({ name: "tick", ownerFqn: "PlayerEntity", jvmDescriptor: "(I)V" }),
        makeMember({ name: "tick", ownerFqn: "PlayerEntity", jvmDescriptor: "(D)V" })
      ],
      fields: []
    }]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);

  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0, JSON.stringify(result.issues));
  const resolved = result.resolvedMembers!.filter((m) => m.status === "resolved");
  assert.equal(resolved.length, 3);
  const skipped = result.resolvedMembers!.filter((m) => m.status === "skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, "*");
});

// A quantifier counts matches of an EXACT name (Mixin has no prefix glob), so render*/render+
// against a target with only renderItem/renderBlock are reported as method-not-found.
test("validateParsedMixin rejects a quantifier selector whose exact name matches no member", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "render*", line: 10 },
      { annotation: "Inject", method: "render+", line: 11 }
    ]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", {
      className: "PlayerEntity",
      constructors: [],
      methods: [
        makeMember({ name: "renderItem", ownerFqn: "PlayerEntity", jvmDescriptor: "()V" }),
        makeMember({ name: "renderBlock", ownerFqn: "PlayerEntity", jvmDescriptor: "()V" })
      ],
      fields: []
    }]
  ]);
  const warnings: string[] = [];

  const result = validateParsedMixin(parsed, targetMembers, warnings);

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map((issue) => ({ kind: issue.kind, line: issue.line })),
    [
      { kind: "method-not-found", line: 10 },
      { kind: "method-not-found", line: 11 }
    ],
    JSON.stringify(result.issues)
  );
  assert.ok(result.issues[0].message.includes('"render"'), result.issues[0].message);
});

function tickOverloads(...descriptors: string[]): Map<string, ResolvedTargetMembers> {
  return new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", {
      className: "PlayerEntity",
      constructors: [],
      methods: descriptors.map((jvmDescriptor) =>
        makeMember({ name: "tick", ownerFqn: "PlayerEntity", jvmDescriptor })
      ),
      fields: []
    }]
  ]);
}

test("validateParsedMixin keeps the descriptor check for a quantified selector", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "tick*(D)V", line: 10 },
      { annotation: "Inject", method: "tick+(I)V", line: 11 }
    ]
  });

  const result = validateParsedMixin(parsed, tickOverloads("(I)V"), []);

  assert.deepEqual(
    result.issues.map((issue) => ({ kind: issue.kind, line: issue.line })),
    [{ kind: "descriptor-mismatch", line: 10 }],
    JSON.stringify(result.issues)
  );
  const resolved = result.resolvedMembers!.filter((m) => m.status === "resolved");
  assert.deepEqual(resolved.map((m) => m.line), [11]);
});

test("validateParsedMixin flags a counted quantifier shortfall as an uncertain warning", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "tick{2}", line: 10 },
      { annotation: "Inject", method: "tick{2,}", line: 11 },
      { annotation: "Inject", method: "tick{1,3}", line: 12 },
      { annotation: "Inject", method: "tick+", line: 13 }
    ]
  });

  const result = validateParsedMixin(parsed, tickOverloads("(I)V"), []);

  assert.deepEqual(
    result.issues.map((issue) => ({
      kind: issue.kind,
      severity: issue.severity,
      confidence: issue.confidence,
      line: issue.line
    })),
    [
      { kind: "method-not-found", severity: "warning", confidence: "uncertain", line: 10 },
      { kind: "method-not-found", severity: "warning", confidence: "uncertain", line: 11 }
    ],
    JSON.stringify(result.issues)
  );
  assert.match(result.issues[0].message, /at least 2/);
  assert.match(result.issues[0].message, /bridge/);
  assert.equal(result.valid, true, "an uncertain shortfall must not invalidate the mixin");
  const resolved = result.resolvedMembers!.filter((m) => m.status === "resolved");
  assert.deepEqual(resolved.map((m) => m.line), [12, 13]);
});

test("validateParsedMixin does not call a quantifier shortfall definite when a bridge may fill it", () => {
  // Comparable<Foo>.compareTo(LFoo;)I plus its synthetic bridge compareTo(Ljava/lang/Object;)I
  // satisfies "compareTo{2}" in Mixin, but the member listing omits the bridge.
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "compareTo{2}", line: 10 }]
  });
  const targetMembers = new Map<string, ResolvedTargetMembers>([
    ["PlayerEntity", {
      className: "PlayerEntity",
      constructors: [],
      methods: [makeMember({ name: "compareTo", ownerFqn: "PlayerEntity", jvmDescriptor: "(LFoo;)I" })],
      fields: []
    }]
  ]);

  const result = validateParsedMixin(parsed, targetMembers, []);

  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].confidence, "uncertain");
  assert.match(result.issues[0].message, /synthetic\/bridge/);
});

test("validateParsedMixin ignores whitespace inside a quantifier and warns on a malformed one", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "tick{1, 3}", line: 10 },
      { annotation: "Inject", method: "tick{ 2 , }", line: 11 },
      { annotation: "Inject", method: "tick{}", line: 12 },
      { annotation: "Inject", method: "tick{0}", line: 13 }
    ]
  });

  const result = validateParsedMixin(parsed, tickOverloads("(I)V", "(D)V"), []);

  const resolved = result.resolvedMembers!.filter((m) => m.status === "resolved");
  assert.deepEqual(resolved.map((m) => m.line), [10, 11]);
  assert.deepEqual(
    result.issues.map((issue) => ({ severity: issue.severity, line: issue.line })),
    [
      { severity: "warning", line: 12 },
      { severity: "warning", line: 13 }
    ],
    JSON.stringify(result.issues)
  );
  for (const issue of result.issues) {
    assert.match(issue.message, /malformed quantifier/);
  }
});

test("validateParsedMixin treats a quantifier whose max is below its min as requiring the min", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "tick{3,1}", line: 10 },
      { annotation: "Inject", method: "tick{2,1}", line: 11 }
    ]
  });

  const result = validateParsedMixin(parsed, tickOverloads("(I)V", "(D)V"), []);

  const resolved = result.resolvedMembers!.filter((m) => m.status === "resolved");
  assert.deepEqual(resolved.map((m) => m.line), [11]);
  assert.deepEqual(
    result.issues.map((issue) => ({ kind: issue.kind, severity: issue.severity, line: issue.line })),
    [{ kind: "method-not-found", severity: "warning", line: 10 }],
    JSON.stringify(result.issues)
  );
  assert.match(result.issues[0].message, /at least 3/);
  assert.doesNotMatch(result.issues[0].message, /malformed/);
});

test("validateParsedMixin applies the descriptor and count of an empty-name quantified selector", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "*(D)V", line: 10 },
      { annotation: "Inject", method: "*(I)V", line: 11 },
      { annotation: "Inject", method: "{2}", line: 12 },
      { annotation: "Inject", method: "+", line: 13 },
      { annotation: "Inject", method: "*", line: 14 }
    ]
  });

  const result = validateParsedMixin(parsed, tickOverloads("(I)V"), []);

  assert.deepEqual(
    result.issues.map((issue) => ({
      kind: issue.kind,
      severity: issue.severity,
      confidence: issue.confidence,
      line: issue.line
    })),
    [
      { kind: "descriptor-mismatch", severity: "error", confidence: "definite", line: 10 },
      { kind: "method-not-found", severity: "warning", confidence: "uncertain", line: 12 }
    ],
    JSON.stringify(result.issues)
  );
  assert.match(result.issues[1].message, /bridge/);
  const byStatus = (status: string) =>
    result.resolvedMembers!.filter((m) => m.status === status).map((m) => m.line);
  assert.deepEqual(byStatus("resolved"), [11, 13]);
  assert.deepEqual(byStatus("skipped"), [14]);
});

test("validateParsedMixin flags a bare + selector against a class with no methods as uncertain", () => {
  const parsed = makeParsedMixin({
    injections: [{ annotation: "Inject", method: "+", line: 10 }]
  });

  const result = validateParsedMixin(parsed, tickOverloads(), []);

  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].severity, "warning");
  assert.equal(result.issues[0].confidence, "uncertain");
});

test("validateParsedMixin skips regex target selectors as unverifiable", () => {
  const parsed = makeParsedMixin({
    injections: [
      { annotation: "Inject", method: "/^render.*$/", line: 10 },
      { annotation: "Inject", method: "name=/render/ desc=/\\(\\)V/", line: 11 }
    ]
  });

  const result = validateParsedMixin(parsed, tickOverloads("()V"), []);

  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0, JSON.stringify(result.issues));
  const skipped = result.resolvedMembers!.filter((m) => m.status === "skipped");
  assert.deepEqual(skipped.map((m) => m.line), [10, 11]);
});
