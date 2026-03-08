import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  iterateJavaEntriesAsUtf8,
  listJarEntries,
  listJavaEntries,
  readAllJavaEntriesAsUtf8,
  readJarEntryAsUtf8
} from "../src/source-jar-reader.ts";
import { createJar } from "./helpers/zip.ts";

test("sourceJarReader lists entries and filters java sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-list-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "com/example/Main.java": "package com.example;\npublic class Main {}",
    "assets/example/lang/en_us.json": "{\"hello\": \"world\"}",
    "com/example/World.java": "package com.example;\npublic class World {}"
  });

  const entries = await listJarEntries(jarPath);
  assert.deepEqual(entries, [
    "com/example/Main.java",
    "assets/example/lang/en_us.json",
    "com/example/World.java"
  ]);

  const javaEntries = await listJavaEntries(jarPath);
  assert.deepEqual(javaEntries, ["com/example/Main.java", "com/example/World.java"]);
});

test("sourceJarReader reads a single entry as utf-8", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-read-"));
  const jarPath = join(root, "sample.jar");
  const source = "package com.example;\npublic class Main { void run() {} }\n";
  await createJar(jarPath, {
    "com/example/Main.java": source
  });

  const content = await readJarEntryAsUtf8(jarPath, "com/example/Main.java");
  assert.equal(content, source);
});

test("sourceJarReader throws clear error for missing entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-missing-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "com/example/Main.java": "package com.example;\npublic class Main {}"
  });

  await assert.rejects(
    () => readJarEntryAsUtf8(jarPath, "com/example/Missing.java"),
    /Entry "com\/example\/Missing\.java" was not found/
  );
});

test("sourceJarReader rejects non-utf8 content", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-utf8-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "com/example/Main.java": Buffer.from([0xff, 0xfe, 0xfd])
  });

  await assert.rejects(
    () => readJarEntryAsUtf8(jarPath, "com/example/Main.java"),
    /is not valid UTF-8/
  );
});

test("sourceJarReader rejects jars that contain unsafe traversal entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-secure-"));
  const jarPath = join(root, "unsafe.jar");
  await createJar(jarPath, {
    "../evil/Injected.java": "public class Injected {}",
    "safe/Ok.java": "public class Ok {}"
  });

  await assert.rejects(
    () => listJavaEntries(jarPath),
    /invalid relative path/i
  );
});

test("sourceJarReader can read all java entries in one call", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-all-java-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "com/example/Main.java": "package com.example;\npublic class Main {}",
    "assets/example/lang/en_us.json": "{\"hello\": \"world\"}",
    "com/example/World.java": "package com.example;\npublic class World {}"
  });

  const entries = await readAllJavaEntriesAsUtf8(jarPath);
  assert.deepEqual(
    entries.map((entry) => entry.filePath),
    ["com/example/Main.java", "com/example/World.java"]
  );
  assert.match(entries[0]?.content ?? "", /class Main/);
  assert.match(entries[1]?.content ?? "", /class World/);
});

test("sourceJarReader can iterate java entries without materializing upfront", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-iterate-java-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "com/example/A.java": "package com.example;\npublic class A {}",
    "README.txt": "ignore me",
    "com/example/B.java": "package com.example;\npublic class B {}"
  });

  const filePaths: string[] = [];
  const contents: string[] = [];
  for await (const entry of iterateJavaEntriesAsUtf8(jarPath)) {
    filePaths.push(entry.filePath);
    contents.push(entry.content);
  }

  assert.deepEqual(filePaths, ["com/example/A.java", "com/example/B.java"]);
  assert.match(contents[0] ?? "", /class A/);
  assert.match(contents[1] ?? "", /class B/);
});

test("iterateJavaEntriesAsUtf8 skips entries exceeding maxBytes limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-maxbytes-"));
  const jarPath = join(root, "sample.jar");

  const smallContent = "package com.example;\npublic class Small {}";
  // Generate content larger than the 500-byte limit
  const largeContent = `package com.example;\npublic class Large { String data = "${"x".repeat(600)}"; }`;

  await createJar(jarPath, {
    "com/example/Small.java": smallContent,
    "com/example/Large.java": largeContent
  });

  const collected: string[] = [];
  for await (const entry of iterateJavaEntriesAsUtf8(jarPath, 500)) {
    collected.push(entry.filePath);
  }

  assert.deepEqual(collected, ["com/example/Small.java"]);
});

test("sourceJarReader checks .java suffix without lowercasing every entry name", async () => {
  const source = await readFile("src/source-jar-reader.ts", "utf8");

  assert.match(source, /function hasJavaSourceExtension\(/);
  assert.doesNotMatch(source, /toLowerCase\(\)\.endsWith\("\.java"\)/);
});
