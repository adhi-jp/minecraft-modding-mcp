import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTestConfig } from "../helpers/test-config.ts";
import { createJar } from "../helpers/zip.ts";

// findClass's qualified branch (className contains ".") never set nested /
// enclosingClass on an inner-class match, even though the FindClassMatch type
// documents both ("Set when the match is a type declared INSIDE another
// type." / "The enclosing top-level type, present only on a nested match.")
// and the UNQUALIFIED branch already emits them for the identical kind of
// match. This mirrors the fixture used by the existing
// "SourceService findClass resolves a qualified inner-class name to its
// outer file" test, adding the nested/enclosingClass assertions that test
// does not cover.
test("findClass qualified inner-class lookup reports nested:true and enclosingClass", async () => {
  const { SourceService } = await import("../../src/source-service.ts");
  const root = await mkdtemp(join(tmpdir(), "findclass-qualified-nested-"));
  const binaryJarPath = join(root, "inner.jar");
  const sourcesJarPath = join(root, "inner-sources.jar");

  await createJar(binaryJarPath, {
    "a/b/Outer.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    "a/b/Outer$Inner.class": Buffer.from([0xca, 0xfe, 0xba, 0xbe])
  });
  await createJar(sourcesJarPath, {
    "a/b/Outer.java": [
      "package a.b;",
      "public class Outer {",
      "  public static class Inner {",
      "    void marker() {}",
      "  }",
      "}"
    ].join("\n")
  });

  const service = new SourceService(buildTestConfig(root));
  const resolved = await service.resolveArtifact({
    target: { kind: "jar", value: binaryJarPath },
    mapping: "obfuscated"
  });

  const inner = service.findClass({ className: "a.b.Outer.Inner", artifactId: resolved.artifactId });
  assert.equal(inner.total, 1, `inner-class lookup should resolve, got ${JSON.stringify(inner.matches)}`);
  assert.equal(inner.matches[0]?.qualifiedName, "a.b.Outer.Inner");
  assert.equal(inner.matches[0]?.nested, true, "qualified inner-class match must report nested:true");
  assert.equal(
    inner.matches[0]?.enclosingClass,
    "a.b.Outer",
    "qualified inner-class match must report its enclosingClass"
  );

  // A top-level (non-nested) qualified lookup must NOT gain a spurious nested flag.
  const outer = service.findClass({ className: "a.b.Outer", artifactId: resolved.artifactId });
  assert.equal(outer.matches[0]?.qualifiedName, "a.b.Outer");
  assert.equal(outer.matches[0]?.nested, undefined);
  assert.equal(outer.matches[0]?.enclosingClass, undefined);
});
