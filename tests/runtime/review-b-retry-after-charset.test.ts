import assert from "node:assert/strict";
import test from "node:test";

import { resolveRetryAfterMs } from "../../src/repo-downloader.ts";

/**
 * The same cap the production code clamps a honoured pause to, pinned here so a
 * regression toward trusting the header whole fails loudly.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/** The RFC 9110 IMF-fixdate the cases below pad, 10 seconds after `now`. */
const DATE = "Thu, 01 Jan 2026 00:00:10 GMT";

test("resolveRetryAfterMs refuses an HTTP-date carrying characters no field value may hold", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);

  // Date.parse is far more forgiving than the digit guard beside it: it skips
  // leading control characters and Unicode spaces outright, so every value below
  // parses to a real instant even though no HTTP parser would accept it as a
  // field value. The digit arm already refuses this class of input; the date arm
  // repaired it into an honoured pause instead.
  assert.equal(
    resolveRetryAfterMs(`\n${DATE}`, now),
    undefined,
    "a leading newline is not OWS: the value stays malformed"
  );
  assert.equal(
    resolveRetryAfterMs(`\u00a0${DATE}`, now),
    undefined,
    "a non-breaking space is not OWS in the date arm any more than in the digit arm"
  );
  assert.equal(
    resolveRetryAfterMs(`${DATE}\r\n`, now),
    undefined,
    "a trailing CRLF is header framing that leaked into the value, not padding to strip"
  );
  assert.equal(resolveRetryAfterMs(`${DATE}\u00a0`, now), undefined);
  assert.equal(resolveRetryAfterMs(`\f${DATE}`, now), undefined);
  assert.equal(resolveRetryAfterMs(`${DATE}\u0000`, now), undefined);

  // What RFC 9110 actually permits around a field value - ASCII space and
  // horizontal tab - still buys the pause the server asked for. Refusing these
  // would trade one wrong answer for another.
  assert.equal(resolveRetryAfterMs(` ${DATE} `, now), 10_000);
  assert.equal(resolveRetryAfterMs(`\t${DATE}\t`, now), 10_000);
  assert.equal(resolveRetryAfterMs(DATE, now), 10_000);
  assert.equal(resolveRetryAfterMs("Fri, 28 Aug 2026 12:00:00 GMT", now), MAX_RETRY_AFTER_MS);
});
