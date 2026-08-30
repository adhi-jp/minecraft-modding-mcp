import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  collectMatchedJarEntriesAsBuffers,
  collectMatchedJarEntriesAsUtf8,
  detectFabricLikeInputNamespace,
  EntryTooLargeError,
  hasAnyJarEntry,
  iterateJavaEntriesAsUtf8,
  listJarEntries,
  listJavaEntries,
  openZipFile,
  readAllJavaEntriesAsUtf8,
  readJarEntryAsBuffer,
  readJarEntryAsUtf8,
  type ZipFile
} from "../../src/source-jar-reader.ts";
import { createCraftedJar } from "../helpers/zip-crafted.ts";
import { createJar } from "../helpers/zip.ts";

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

test("sourceJarReader can detect matching entries without materializing every match", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-any-entry-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "assets/example/lang/en_us.json": "{\"hello\": \"world\"}",
    "com/example/Main.java": "package com.example;\npublic class Main {}"
  });

  const hasJava = await hasAnyJarEntry(jarPath, (entryPath) => entryPath.endsWith(".java"));
  const hasTiny = await hasAnyJarEntry(jarPath, (entryPath) => entryPath.endsWith(".tiny"));

  assert.equal(hasJava, true);
  assert.equal(hasTiny, false);
});

test("sourceJarReader can continue collecting matched utf-8 entries after unreadable matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-collect-matches-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "mappings/bad.tiny": Buffer.from([0xff, 0xfe, 0xfd]),
    "mappings/good.tiny": "tiny\t2\t0\tobfuscated\tintermediary\nc\ta/b/C\tintermediary/pkg/InterClass",
    "README.txt": "ignore me"
  });

  const matches = await collectMatchedJarEntriesAsUtf8(
    jarPath,
    (entryPath) => entryPath.endsWith(".tiny"),
    { continueOnError: true }
  );

  assert.deepEqual(matches, [
    {
      filePath: "mappings/good.tiny",
      content: "tiny\t2\t0\tobfuscated\tintermediary\nc\ta/b/C\tintermediary/pkg/InterClass"
    }
  ]);
});

test("collectMatchedJarEntriesAsUtf8 stops after maxEntries successful matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-max-entries-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "mappings/bad.tiny": Buffer.from([0xff, 0xfe, 0xfd]),
    "mappings/first-good.tiny": "tiny\t2\t0\tobfuscated\tintermediary\nc\ta/b/C\tinter/pkg/First",
    "mappings/second-good.tiny": "tiny\t2\t0\tobfuscated\tintermediary\nc\tx/y/Z\tinter/pkg/Second"
  });

  const matches = await collectMatchedJarEntriesAsUtf8(
    jarPath,
    (entryPath) => entryPath.endsWith(".tiny"),
    { continueOnError: true, maxEntries: 1 }
  );

  assert.deepEqual(matches, [
    {
      filePath: "mappings/first-good.tiny",
      content: "tiny\t2\t0\tobfuscated\tintermediary\nc\ta/b/C\tinter/pkg/First"
    }
  ]);
});

test("collectMatchedJarEntriesAsBuffers collects raw latin1 buffers in a single jar open", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-collect-buffers-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "a/A.class": Buffer.concat([
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0xff, 0xfe]),
      Buffer.from("net/minecraft/class_1937", "latin1")
    ]),
    "a/B.class": Buffer.from("net/minecraft/class_2248", "latin1"),
    "README.txt": "ignore me"
  });

  let openCount = 0;
  const counted = (p: string) => {
    openCount += 1;
    return openZipFile(p);
  };

  const matches = await collectMatchedJarEntriesAsBuffers(
    jarPath,
    (name) => name.endsWith(".class"),
    { continueOnError: true },
    { openZipFile: counted }
  );

  assert.equal(openCount, 1);
  assert.equal(matches.length, 2);
  assert.ok(Buffer.isBuffer(matches[0]?.content));
  assert.equal(matches[0]?.filePath, "a/A.class");
  // Raw binary bytes survive (latin1 never throws on non-UTF8 input).
  assert.match(matches[0]!.content.toString("latin1"), /net\/minecraft\/class_1937/);
});

test("collectMatchedJarEntriesAsBuffers stops after maxEntries matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-buffers-max-entries-"));
  const jarPath = join(root, "sample.jar");
  await createJar(jarPath, {
    "a/A.class": Buffer.from("net/minecraft/class_1937", "latin1"),
    "a/B.class": Buffer.from("net/minecraft/class_2248", "latin1")
  });

  const matches = await collectMatchedJarEntriesAsBuffers(
    jarPath,
    (name) => name.endsWith(".class"),
    { maxEntries: 1 }
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.filePath, "a/A.class");
});

test("detectFabricLikeInputNamespace opens the jar once for the sampled classes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-detect-open-count-"));
  const jarPath = join(root, "intermediary.jar");
  const entries: Record<string, Buffer> = {};
  for (let i = 0; i < 5; i += 1) {
    entries[`net/minecraft/class_${1000 + i}.class`] = Buffer.from(
      "net/minecraft/class_1937 method_5678 field_1234",
      "latin1"
    );
  }
  await createJar(jarPath, entries);

  let openCount = 0;
  const counted = (p: string) => {
    openCount += 1;
    return openZipFile(p);
  };

  const result = await detectFabricLikeInputNamespace(jarPath, { openZipFile: counted });

  assert.equal(result.fromNamespace, "intermediary");
  // The collector opens exactly once; the per-class reads must add ZERO further opens.
  assert.equal(openCount, 1);
});

test("sourceJarReader: readJarEntryAsUtf8 rejects caller-supplied traversal entry names with INVALID_INPUT", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-zipslip-read-"));
  const jarPath = join(root, "safe.jar");
  await createJar(jarPath, {
    "com/example/Safe.java": "package com.example;\npublic class Safe {}"
  });

  for (const traversal of [
    "../escape.java",
    "..\\evil.java",
    "a/../../etc/passwd.java",
    "META-INF/../shadow.java"
  ]) {
    await assert.rejects(
      () => readJarEntryAsUtf8(jarPath, traversal),
      (err: any) => err.code === "ERR_INVALID_INPUT" && /not allowed/.test(err.message ?? ""),
      `expected zip-slip rejection on caller input "${traversal}"`
    );
  }
});

test("sourceJarReader: readJarEntryAsUtf8 still resolves safe entries from the same jar", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-zipslip-positive-"));
  const jarPath = join(root, "safe.jar");
  await createJar(jarPath, {
    "com/example/Safe.java": "package com.example;\npublic class Safe {}"
  });
  const text = await readJarEntryAsUtf8(jarPath, "com/example/Safe.java");
  assert.match(text, /class Safe/);
});

test("sourceJarReader: readJarEntryAsBuffer refuses an entry whose DECLARED size exceeds maxBytes without reading its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-declared-cap-"));
  const jarPath = join(root, "over-declared.jar");
  // 1 KiB of payload, headers declaring 100 MiB. The declared size is available
  // from the central directory before openReadStream is reached, so a guard that
  // consults it costs zero bytes read.
  await createCraftedJar(jarPath, [
    {
      name: "META-INF/jars/over-declared.jar",
      data: Buffer.alloc(1024, 0x41),
      method: "deflate",
      declaredUncompressedSize: 100 * 1024 * 1024
    }
  ]);

  const rejection = await readJarEntryAsBuffer(
    jarPath,
    "META-INF/jars/over-declared.jar",
    1024 * 1024
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  assert.ok(
    rejection instanceof EntryTooLargeError,
    `expected EntryTooLargeError, got ${String(rejection)}`
  );
  assert.deepEqual(rejection.size, { bytes: 100 * 1024 * 1024, source: "declared" });
  assert.match(rejection.message, /exceeds size limit of 1048576 bytes/);

  // The bytes really were never streamed: reading the same entry with no budget
  // does run the stream, and fails yauzl's end-of-stream size assertion instead.
  await assert.rejects(
    () => readJarEntryAsBuffer(jarPath, "META-INF/jars/over-declared.jar"),
    /not enough bytes in the stream/
  );
});

test("sourceJarReader: readJarEntryAsBuffer refuses a compressible entry that is tiny on disk but expands past maxBytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-expansion-cap-"));
  const jarPath = join(root, "compressible.jar");
  const expandedBytes = 4 * 1024 * 1024;
  await createCraftedJar(jarPath, [
    { name: "META-INF/jars/zeros.jar", data: Buffer.alloc(expandedBytes), method: "deflate" }
  ]);
  const onDiskBytes = (await stat(jarPath)).size;
  assert.ok(
    onDiskBytes < 64 * 1024,
    `a compression-ratio attack is cheap on disk; got ${onDiskBytes} bytes`
  );

  const rejection = await readJarEntryAsBuffer(jarPath, "META-INF/jars/zeros.jar", 64 * 1024).then(
    () => undefined,
    (error: unknown) => error
  );
  assert.ok(
    rejection instanceof EntryTooLargeError,
    `expected EntryTooLargeError, got ${String(rejection)}`
  );
  assert.deepEqual(rejection.size, { bytes: expandedBytes, source: "declared" });

  // Same entry, no budget: the full expansion lands in memory. That is the
  // behavior the cap exists to prevent, so it is pinned rather than assumed.
  const unbounded = await readJarEntryAsBuffer(jarPath, "META-INF/jars/zeros.jar");
  assert.equal(unbounded.length, expandedBytes);
});

test("sourceJarReader: readJarEntryAsBuffer's streaming counter stops an entry that outruns its declared size", async () => {
  // yauzl rejects an entry that over-runs its declared size, so this lie cannot
  // be written into a real archive — the injected zip file stands in for any
  // source whose declared size is not trustworthy. It proves the budget is
  // forwarded into the stream instead of resting on the declared-size check.
  const entry = { fileName: "META-INF/jars/lying.jar", uncompressedSize: 8 };
  const chunkBytes = 16 * 1024;
  const maxChunks = 64;
  let servedChunks = 0;
  let streamDestroyed = false;
  const emitter = new EventEmitter();
  let served = false;

  const fakeZipFile = {
    readEntry(): void {
      if (served) {
        emitter.emit("end");
        return;
      }
      served = true;
      emitter.emit("entry", entry);
    },
    close(): void {},
    once(event: string, listener: (...args: unknown[]) => void) {
      emitter.once(event, listener);
      return this;
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      emitter.removeListener(event, listener);
      return this;
    },
    openReadStream(
      _entry: unknown,
      callback: (error: Error | null, stream: Readable | null) => void
    ): void {
      const stream = new Readable({
        read(): void {
          if (servedChunks >= maxChunks) {
            this.push(null);
            return;
          }
          servedChunks += 1;
          this.push(Buffer.alloc(chunkBytes, 0x42));
        }
      });
      stream.once("close", () => {
        streamDestroyed = stream.destroyed;
      });
      callback(null, stream);
    }
  } as unknown as ZipFile;

  const rejection = await readJarEntryAsBuffer(
    "/synthetic/lying.jar",
    "META-INF/jars/lying.jar",
    64 * 1024,
    { openZipFile: async () => fakeZipFile }
  ).then(
    () => undefined,
    (error: unknown) => error
  );

  assert.ok(
    rejection instanceof EntryTooLargeError,
    `expected EntryTooLargeError, got ${String(rejection)}`
  );
  assert.equal(rejection.size?.source, "observed");
  assert.ok(
    (rejection.size?.bytes ?? 0) > 64 * 1024,
    "the counter must report the running total that broke the budget"
  );
  assert.ok(streamDestroyed, "the oversized stream must be destroyed, not drained");
  assert.ok(
    servedChunks < maxChunks,
    `the read must stop early; served ${servedChunks} of ${maxChunks} chunks`
  );
});
