import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * One entry of a hand-crafted jar. Unlike {@link createJar} in ./zip.ts, which
 * only writes STORED entries with honest sizes, this builder can deflate an
 * entry and can write a declared uncompressed size that does not match the
 * payload — the two things a size-limit test needs:
 *
 *  - `method: "deflate"` gives an entry that is tiny on disk and large when
 *    expanded, so a test can exercise an expansion guard without writing a real
 *    zip bomb;
 *  - `declaredUncompressedSize` lets a test declare a huge entry that costs a
 *    few hundred bytes on disk, so a guard that reads the DECLARED size can be
 *    proven to refuse it before any byte is inflated.
 */
export type CraftedJarEntry = {
  name: string;
  data: Buffer | string;
  /** Compression method to write. Defaults to "store" (method 0). */
  method?: "store" | "deflate";
  /**
   * Uncompressed size written into the headers, overriding the payload's real
   * length. Only meaningful with `method: "deflate"` — yauzl rejects a STORED
   * entry whose compressed and uncompressed sizes disagree.
   */
  declaredUncompressedSize?: number;
};

/** Writes a zip whose per-entry compression and declared sizes the caller controls. */
export async function createCraftedJar(
  outputPath: string,
  entries: CraftedJarEntry[]
): Promise<void> {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const rawContent =
      typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const deflated = entry.method === "deflate";
    const storedContent = deflated ? deflateRawSync(rawContent) : rawContent;
    const checksum = crc32(rawContent);
    const uncompressedSize = entry.declaredUncompressedSize ?? rawContent.length;
    const compressedSize = storedContent.length;
    const method = deflated ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localRecord = Buffer.concat([localHeader, nameBuffer, storedContent]);
    localChunks.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralChunks.push(Buffer.concat([centralHeader, nameBuffer]));

    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(centralChunks.length, 8);
  endOfCentralDirectory.writeUInt16LE(centralChunks.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    Buffer.concat([...localChunks, centralDirectory, endOfCentralDirectory])
  );
}
