import assert from "node:assert/strict";
import test from "node:test";

import { createResolvedSearchFixture } from "../helpers/source-service-search-fixtures.ts";

const SOURCE_ENTRIES = {
  "net/minecraft/util/BooleanOpHolder.java": [
    "package net.minecraft.util;",
    "public class BooleanOpHolder {",
    "  int mask = BooleanOp.AND.apply(left, right);",
    "}"
  ].join("\n"),
  "net/minecraft/util/NotHolder.java": [
    "package net.minecraft.util;",
    "public class NotHolder {",
    "  String doc = \"a NOT b\";",
    "}"
  ].join("\n"),
  "net/minecraft/util/Plain.java": [
    "package net.minecraft.util;",
    "public class Plain {",
    "  String token = \"ordinaryNeedle\";",
    "}"
  ].join("\n")
};

test("SourceService text search finds a query whose token is an FTS5 operator keyword", async () => {
  const { service, resolved } = await createResolvedSearchFixture({
    rootPrefix: "service-fts-operator-",
    jarBaseName: "server-fts-operator",
    mapping: "obfuscated",
    sourceEntries: SOURCE_ENTRIES
  });

  const andSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "BooleanOp.AND",
    intent: "text",
    limit: 10
  });
  assert.deepEqual(
    andSearch.hits.map((hit) => hit.filePath),
    ["net/minecraft/util/BooleanOpHolder.java"]
  );

  const notSearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "a NOT b",
    intent: "text",
    match: "contains",
    limit: 10
  });
  assert.deepEqual(
    notSearch.hits.map((hit) => hit.filePath),
    ["net/minecraft/util/NotHolder.java"]
  );

  const ordinarySearch = await service.searchClassSource({
    artifactId: resolved.artifactId,
    query: "ordinaryNeedle",
    intent: "text",
    match: "contains",
    limit: 10
  });
  assert.deepEqual(
    ordinarySearch.hits.map((hit) => hit.filePath),
    ["net/minecraft/util/Plain.java"]
  );
});
