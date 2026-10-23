import assert from "node:assert/strict";
import fs, { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as yauzl from "yauzl";

import {
  collectMatchedJarEntriesAsBuffers,
  createJarEntryReader,
  iterateJavaEntriesAsUtf8,
  listJarEntries,
  openZipFile,
  readJarEntryAsBuffer,
  scanJarForJavaSources
} from "../../src/source-jar-reader.ts";
import { createCraftedJar, type CraftedJarEntry } from "../helpers/zip-crafted.ts";

type PlainEntry = { name: string; bytes: Buffer };

/** Reads every entry with yauzl directly, bypassing the module under test. */
function readWithPlainYauzl(jarPath: string): Promise<PlainEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true, autoClose: false }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError);
        return;
      }
      const entries: PlainEntry[] = [];
      const fail = (error: Error): void => {
        zipFile.close();
        reject(error);
      };
      zipFile.on("error", fail);
      zipFile.on("end", () => {
        zipFile.close();
        resolve(entries);
      });
      zipFile.on("entry", (entry: yauzl.Entry) => {
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error("no stream"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", fail);
          stream.once("end", () => {
            entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) });
            zipFile.readEntry();
          });
        });
      });
      zipFile.readEntry();
    });
  });
}

/** The error message a plain yauzl walk of `jarPath` ends with. */
async function plainYauzlErrorMessage(jarPath: string): Promise<string> {
  try {
    await readWithPlainYauzl(jarPath);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected a plain yauzl read of "${jarPath}" to fail`);
}

/** Deterministic, poorly compressible bytes so a deflated entry is not trivially small. */
function pseudoRandomBytes(length: number, seed: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

/** A stored entry, a deflated entry, an empty entry, a directory, and enough filler to span many reads. */
function mixedEntries(): CraftedJarEntry[] {
  const entries: CraftedJarEntry[] = [
    { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\n\r\n" },
    { name: "com/example/Stored.java", data: "package com.example;\npublic class Stored {}\n" },
    {
      name: "com/example/Deflated.class",
      data: Buffer.concat([pseudoRandomBytes(4096, 7), Buffer.alloc(4096, 0x2a)]),
      method: "deflate"
    },
    { name: "com/example/Empty.txt", data: "" },
    { name: "assets/example/", data: "" }
  ];
  for (let index = 0; index < 300; index += 1) {
    entries.push({
      name: `com/example/filler/Filler${index}.class`,
      data: pseudoRandomBytes(64 + (index % 97), index),
      method: index % 2 === 0 ? "deflate" : "store"
    });
  }
  return entries;
}

/** Rewrites a jar's end records into zip64 form, so only the zip64 record locates the central directory. */
async function convertToZip64(jarPath: string): Promise<void> {
  const bytes = await readFile(jarPath);
  const eocdOffset = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(eocdOffset), 0x06054b50, "expected a comment-free jar");
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const zip64RecordOffset = centralDirectoryOffset + centralDirectorySize;

  const zip64Record = Buffer.alloc(56);
  zip64Record.writeUInt32LE(0x06064b50, 0);
  zip64Record.writeBigUInt64LE(44n, 4);
  zip64Record.writeUInt16LE(45, 12);
  zip64Record.writeUInt16LE(45, 14);
  zip64Record.writeBigUInt64LE(BigInt(entryCount), 24);
  zip64Record.writeBigUInt64LE(BigInt(entryCount), 32);
  zip64Record.writeBigUInt64LE(BigInt(centralDirectorySize), 40);
  zip64Record.writeBigUInt64LE(BigInt(centralDirectoryOffset), 48);

  const zip64Locator = Buffer.alloc(20);
  zip64Locator.writeUInt32LE(0x07064b50, 0);
  zip64Locator.writeBigUInt64LE(BigInt(zip64RecordOffset), 8);
  zip64Locator.writeUInt32LE(1, 16);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0xffff, 8);
  endRecord.writeUInt16LE(0xffff, 10);
  endRecord.writeUInt32LE(0xffffffff, 12);
  endRecord.writeUInt32LE(0xffffffff, 16);

  await writeFile(
    jarPath,
    Buffer.concat([bytes.subarray(0, zip64RecordOffset), zip64Record, zip64Locator, endRecord])
  );
}

/** Asserts every exported walk returns what a plain yauzl read of the same jar returns. */
async function assertMatchesPlainYauzl(jarPath: string): Promise<void> {
  const plain = await readWithPlainYauzl(jarPath);
  assert.ok(plain.length > 300, `fixture should have many entries; got ${plain.length}`);

  assert.deepEqual(await listJarEntries(jarPath), plain.map((entry) => entry.name));

  const collected = await collectMatchedJarEntriesAsBuffers(jarPath, () => true);
  assert.deepEqual(
    collected.map(({ filePath, content }) => ({ name: filePath, bytes: content })),
    plain
  );

  for (const name of ["com/example/Stored.java", "com/example/Deflated.class", "com/example/Empty.txt"]) {
    const expected = plain.find((entry) => entry.name === name)!.bytes;
    assert.deepEqual(await readJarEntryAsBuffer(jarPath, name), expected, name);
  }
  const last = plain.at(-1)!;
  assert.deepEqual(await readJarEntryAsBuffer(jarPath, last.name), last.bytes, last.name);

  const reader = await createJarEntryReader(jarPath);
  try {
    for (const entry of [...plain].reverse()) {
      assert.deepEqual(await reader.getEntryBuffer(entry.name), entry.bytes, entry.name);
    }
  } finally {
    reader.close();
  }
}

test("sourceJarReader: walks return the same entries, order and bytes as a plain yauzl read", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-cd-equal-"));
  const jarPath = join(root, "mixed.jar");
  await createCraftedJar(jarPath, mixedEntries(), { comment: "archive comment after the end record" });

  await assertMatchesPlainYauzl(jarPath);
});

test("sourceJarReader: walks a zip64-form jar the same as a plain yauzl read", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-cd-zip64-"));
  const jarPath = join(root, "zip64.jar");
  await createCraftedJar(jarPath, mixedEntries());
  await convertToZip64(jarPath);

  await assertMatchesPlainYauzl(jarPath);
});

test("sourceJarReader: walking a jar reads its central directory in one pass, not once per entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-cd-reads-"));
  const jarPath = join(root, "many.jar");
  const entries = mixedEntries();
  await createCraftedJar(jarPath, entries);

  const originalRead = fs.read;
  let reads = 0;
  (fs as { read: unknown }).read = (...args: unknown[]): unknown => {
    reads += 1;
    return (originalRead as (...readArgs: unknown[]) => unknown)(...args);
  };
  let listed: string[];
  try {
    listed = await listJarEntries(jarPath);
  } finally {
    fs.read = originalRead;
  }

  assert.equal(listed.length, entries.length);
  // yauzl's lazy walk alone issues two reads per entry (over 600 here).
  assert.ok(reads <= 4, `expected a bounded number of file reads for ${entries.length} entries; got ${reads}`);
});

test("sourceJarReader: entry reads on an open jar keep working after an earlier entry stream was destroyed", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-cd-destroyed-"));
  const jarPath = join(root, "destroyed.jar");
  const oversized = pseudoRandomBytes(256 * 1024, 3);
  await createCraftedJar(jarPath, [
    { name: "com/example/A.java", data: "class A {}" },
    { name: "com/example/Big.java", data: oversized },
    { name: "com/example/C.java", data: "class C {}", method: "deflate" },
    { name: "com/example/D.java", data: "class D {}" }
  ]);

  // The oversized entry's stream is destroyed mid-read; the same open jar must
  // still serve every entry after it.
  const collected = await collectMatchedJarEntriesAsBuffers(jarPath, () => true, {
    maxBytes: 1024,
    continueOnError: true
  });
  assert.deepEqual(
    collected.map(({ filePath, content }) => [filePath, content.toString("utf8")]),
    [
      ["com/example/A.java", "class A {}"],
      ["com/example/C.java", "class C {}"],
      ["com/example/D.java", "class D {}"]
    ]
  );

  const iterated: string[] = [];
  for await (const entry of iterateJavaEntriesAsUtf8(jarPath, 1024)) {
    iterated.push(`${entry.filePath}:${entry.content}`);
  }
  assert.deepEqual(iterated, [
    "com/example/A.java:class A {}",
    "com/example/C.java:class C {}",
    "com/example/D.java:class D {}"
  ]);

  const reader = await createJarEntryReader(jarPath);
  try {
    for (const name of ["com/example/C.java", "com/example/A.java", "com/example/C.java", "com/example/D.java"]) {
      assert.equal((await reader.getEntryBuffer(name)).toString("utf8"), `class ${name.at(-6)} {}`);
    }
    assert.deepEqual(await reader.getEntryBuffer("com/example/Big.java"), oversized);
    assert.equal((await reader.getEntryBuffer("com/example/D.java")).toString("utf8"), "class D {}");
  } finally {
    reader.close();
  }
});

const FD_DIR = "/proc/self/fd";

function openFdCount(): number {
  return readdirSync(FD_DIR).length;
}

async function waitForFdCount(expected: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  let count = openFdCount();
  while (count !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    count = openFdCount();
  }
  return count;
}

test(
  "sourceJarReader: closing a jar releases its file descriptor, including after a failed open",
  { skip: existsSync(FD_DIR) ? false : "needs /proc/self/fd" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "reader-cd-fds-"));
    const jarPath = join(root, "fds.jar");
    const notZipPath = join(root, "not-a-zip.jar");
    await createCraftedJar(jarPath, mixedEntries(), { comment: "fd accounting" });
    await writeFile(notZipPath, "this file is not a zip archive");

    const baseline = await waitForFdCount(openFdCount());

    const zipFile = await openZipFile(jarPath);
    assert.ok(openFdCount() > baseline, "an open jar should hold a file descriptor");
    zipFile.close();
    assert.equal(await waitForFdCount(baseline), baseline, "close() must release the descriptor");

    for (let cycle = 0; cycle < 25; cycle += 1) {
      await listJarEntries(jarPath);
      await scanJarForJavaSources(jarPath);
      await readJarEntryAsBuffer(jarPath, "com/example/Deflated.class");
      await collectMatchedJarEntriesAsBuffers(jarPath, (name) => name.endsWith("0.class"), {
        maxBytes: 100,
        continueOnError: true
      });
      const reader = await createJarEntryReader(jarPath);
      await reader.getEntryBuffer("com/example/Stored.java");
      reader.close();
      await assert.rejects(() => listJarEntries(notZipPath));
    }
    assert.equal(await waitForFdCount(baseline), baseline, "every open, read and failed open must release its descriptor");
  }
);

test("sourceJarReader: a non-zip file still fails with the wrapped open error", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-cd-notzip-"));
  const notZipPath = join(root, "not-a-zip.jar");
  await writeFile(notZipPath, "this file is not a zip archive");
  const expected = {
    message:
      `Failed to read jar "${notZipPath}": End of central directory record signature not found. ` +
      "Either not a zip file, or file is truncated."
  };

  await assert.rejects(() => listJarEntries(notZipPath), expected);
  await assert.rejects(() => readJarEntryAsBuffer(notZipPath, "a.txt"), expected);
  await assert.rejects(() => createJarEntryReader(notZipPath), expected);
});

test("sourceJarReader: a jar with a damaged central directory fails the walk exactly as plain yauzl does", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-cd-damaged-"));

  const badSignaturePath = join(root, "bad-signature.jar");
  await createCraftedJar(badSignaturePath, mixedEntries());
  const badSignature = await readFile(badSignaturePath);
  const centralDirectoryOffset = badSignature.readUInt32LE(badSignature.length - 22 + 16);
  // Damage the header of the third central directory record so the walk fails partway.
  let recordOffset = centralDirectoryOffset;
  for (let record = 0; record < 2; record += 1) {
    recordOffset +=
      46 +
      badSignature.readUInt16LE(recordOffset + 28) +
      badSignature.readUInt16LE(recordOffset + 30) +
      badSignature.readUInt16LE(recordOffset + 32);
  }
  badSignature.writeUInt32LE(0x0badf00d, recordOffset);
  await writeFile(badSignaturePath, badSignature);

  const pastEndPath = join(root, "offset-past-end.jar");
  await createCraftedJar(pastEndPath, mixedEntries());
  const pastEnd = await readFile(pastEndPath);
  pastEnd.writeUInt32LE(pastEnd.length + 100, pastEnd.length - 22 + 16);
  await writeFile(pastEndPath, pastEnd);

  // The last record claims a name longer than the bytes left in the file, so
  // its read starts inside the central directory and runs past the end.
  const longNamePath = join(root, "name-past-end.jar");
  const longNameEntries = mixedEntries();
  await createCraftedJar(longNamePath, longNameEntries);
  const longName = await readFile(longNamePath);
  const lastName = Buffer.from(longNameEntries.at(-1)!.name, "utf8");
  const lastRecordOffset = longName.length - 22 - (46 + lastName.length);
  assert.equal(longName.readUInt32LE(lastRecordOffset), 0x02014b50);
  longName.writeUInt16LE(0xffff, lastRecordOffset + 28);
  await writeFile(longNamePath, longName);

  for (const jarPath of [badSignaturePath, pastEndPath, longNamePath]) {
    const plainMessage = await plainYauzlErrorMessage(jarPath);
    await assert.rejects(() => listJarEntries(jarPath), { message: plainMessage }, jarPath);
    await assert.rejects(
      () => readJarEntryAsBuffer(jarPath, "com/example/filler/Filler299.class"),
      { message: plainMessage },
      jarPath
    );
    await assert.rejects(() => createJarEntryReader(jarPath), { message: plainMessage }, jarPath);
  }
  assert.match(await plainYauzlErrorMessage(badSignaturePath), /invalid central directory file header signature: 0xbadf00d/);
  assert.equal(await plainYauzlErrorMessage(longNamePath), "unexpected EOF");
});
