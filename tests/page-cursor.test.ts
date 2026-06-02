import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPageContextKey,
  decodeOffsetCursor,
  encodeOffsetCursor,
  resolveCursorOffset
} from "../src/page-cursor.ts";

test("encodeOffsetCursor round-trips through decodeOffsetCursor", () => {
  const key = buildPageContextKey(["artifact-1", "net.Foo", "obfuscated", 0, false]);
  const cursor = encodeOffsetCursor(20, key);
  const decoded = decodeOffsetCursor(cursor);
  assert.deepEqual(decoded, { offset: 20, contextKey: key });
});

test("decodeOffsetCursor rejects malformed and negative/non-integer cursors", () => {
  assert.equal(decodeOffsetCursor(undefined), undefined);
  assert.equal(decodeOffsetCursor("not-base64-json"), undefined);
  assert.equal(decodeOffsetCursor(Buffer.from('{"offset":-1,"contextKey":"k"}').toString("base64")), undefined);
  assert.equal(decodeOffsetCursor(Buffer.from('{"offset":1.5,"contextKey":"k"}').toString("base64")), undefined);
  assert.equal(decodeOffsetCursor(Buffer.from('{"offset":1}').toString("base64")), undefined);
});

test("resolveCursorOffset starts at 0 with no cursor and flags context mismatch", () => {
  const key = buildPageContextKey(["a", "b"]);
  assert.deepEqual(resolveCursorOffset(undefined, key), { offset: 0, cursorIgnored: false });
  assert.deepEqual(resolveCursorOffset(encodeOffsetCursor(5, key), key), { offset: 5, cursorIgnored: false });

  const foreign = encodeOffsetCursor(5, buildPageContextKey(["x", "y"]));
  assert.deepEqual(resolveCursorOffset(foreign, key), { offset: 0, cursorIgnored: true });
  assert.deepEqual(resolveCursorOffset("garbage", key), { offset: 0, cursorIgnored: true });
});
