/**
 * Named-test set gate: policy and rendering.
 *
 * `scripts/test-name-inventory.mjs` answers WHAT happened (which frozen names were
 * proven, which were skipped, which are gone). This module answers WHAT THAT MEANS and
 * prints it. It is pure — no I/O, no process.exit — so every branch below is reachable
 * from a unit test with synthetic input, including the branches that cannot occur on a
 * machine where every runtime capability is present.
 *
 * Three categories, three policies:
 *
 *  1. MISSING — a frozen name is absent from the run entirely. A coverage regression.
 *     ALWAYS a hard failure. No environment variable can downgrade it.
 *
 *  2. UNPROVEN (attributed) — the name exists but did not execute because a guard skipped
 *     it, and the skip DECLARED which runtime capability was missing (see
 *     `tests/helpers/runtime-capabilities.ts`). The frozen contract is unverified here,
 *     which is not the same thing as broken. Hard failure BY DEFAULT — a release gate must
 *     not silently accept unproven contracts — downgradable to a loud warning by
 *     `MCP_ALLOW_UNPROVEN_NAMED_TESTS`.
 *
 *  3. UNPROVEN (un-attributed) — a TODO, or a SKIP whose reason declares no capability.
 *     ALWAYS a hard failure, escape hatch or not. The hatch is a statement about a
 *     capability-limited host; a directive that names no capability makes no such claim,
 *     so letting it through would turn the hatch into a blanket mute.
 *
 * ## MCP_ALLOW_UNPROVEN_NAMED_TESTS
 *
 * Set to `1`, `true`, `yes`, or `on` (case-insensitive) to downgrade category 2 from
 * failure to warning. Intended for a developer machine that genuinely cannot provide a
 * capability — no Java, no working child-process stdio pipes, a non-POSIX platform — where
 * the alternative is a red `npm test` on a green suite. It never suppresses the listing:
 * every unproven row and its missing capability are still printed, and the summary states
 * in words that the run did NOT prove the full frozen set. Do not set it in CI or in a
 * release pipeline: there, an unproven frozen contract is exactly what the gate is for.
 * An unrecognized value is ignored, with a warning, and the gate stays fail-closed.
 */

import {
  MISSING_REPORT_LIMIT,
  formatMissingReport,
  formatUnprovenReport
} from "./test-name-inventory.mjs";

/** Environment variable that downgrades attributed UNPROVEN rows to a warning. */
export const ALLOW_UNPROVEN_ENV = "MCP_ALLOW_UNPROVEN_NAMED_TESTS";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
 * Read the escape hatch out of an environment.
 *
 * `invalidValue` is non-null when the variable was set to something unrecognized: the
 * hatch stays OFF and the caller reports the typo rather than guessing an intent.
 */
export function readAllowUnprovenSetting(env = process.env) {
  const raw = env[ALLOW_UNPROVEN_ENV];
  if (raw === undefined) {
    return { enabled: false, raw: undefined, invalidValue: null };
  }
  const normalized = String(raw).trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) {
    return { enabled: true, raw, invalidValue: null };
  }
  if (FALSY_VALUES.has(normalized)) {
    return { enabled: false, raw, invalidValue: null };
  }
  return { enabled: false, raw, invalidValue: raw };
}

function pluralRows(count) {
  return `${count} frozen named test row(s)`;
}

/**
 * Decide and render the gate verdict.
 *
 * @param {object} input
 * @param {{ rowCount: number }} input.frozen  parsed frozen baseline
 * @param {{ pointCount: number, unterminatedYaml: boolean }} input.live  collector result
 * @param {object} input.comparison  `compareNamedTestSets` result
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {{ frozenPath?: string, tapPath?: string }} [input.context]
 * @returns {{ ok: boolean, status: "ok"|"unproven-accepted"|"failed", report: string[] }}
 */
export function evaluateNamedSetGate({
  frozen,
  live,
  comparison,
  env = process.env,
  context = {}
}) {
  const hatch = readAllowUnprovenSetting(env);
  const allUnproven = [...comparison.unprovenFrozen, ...comparison.unprovenAdded];
  const attributed = allUnproven.filter((row) => row.capability !== null);
  const unattributed = allUnproven.filter((row) => row.capability === null);

  const failures = [];
  const warnings = [];

  if (live.pointCount === 0 || live.unterminatedYaml) {
    failures.push(
      `MALFORMED TAP — captured TAP is unusable (points=${live.pointCount}, ` +
        `unterminatedYaml=${live.unterminatedYaml})`
    );
  }
  if (comparison.missingCount > 0) {
    failures.push(formatMissingReport(comparison));
  }
  if (unattributed.length > 0) {
    failures.push(
      `${formatUnprovenReport(
        `UNATTRIBUTED DIRECTIVE — ${unattributed.length} test point(s) were skipped or marked TODO ` +
          `without declaring a runtime capability, so ${ALLOW_UNPROVEN_ENV} cannot cover them`,
        unattributed
      )}\n` +
        `  Route capability guards through tests/helpers/runtime-capabilities.ts ` +
        `(skipWithoutCapability) so the gate can name what the host was missing.`
    );
  }
  if (attributed.length > 0) {
    const frozenAttributed = attributed.filter((row) =>
      comparison.unprovenFrozen.includes(row)
    ).length;
    const heading =
      `UNPROVEN — ${attributed.length} test point(s) exist but did not execute here ` +
      `(${frozenAttributed} of them frozen), so this run cannot prove them`;
    const body = formatUnprovenReport(heading, attributed, MISSING_REPORT_LIMIT);
    if (hatch.enabled) {
      warnings.push(body);
    } else {
      failures.push(
        `${body}\n  Set ${ALLOW_UNPROVEN_ENV}=1 to downgrade UNPROVEN to a warning on a ` +
          `capability-limited machine. MISSING rows always fail.`
      );
    }
  }

  const report = [];
  if (hatch.invalidValue !== null) {
    report.push(
      `named-test set gate: ignoring ${ALLOW_UNPROVEN_ENV}=${JSON.stringify(hatch.invalidValue)} ` +
        `(expected one of 1, true, yes, on); the gate stays fail-closed`
    );
  }

  if (failures.length > 0) {
    report.unshift("", "named-test set gate: FAILED");
    report.push(...failures);
    if (warnings.length > 0) {
      // The run is failing for another reason, but a downgraded UNPROVEN block is still
      // part of what this run did not prove. Keep it visible.
      report.push(
        `\nnamed-test set gate: WARNING — ${ALLOW_UNPROVEN_ENV} is set, UNPROVEN rows downgraded`
      );
      report.push(...warnings);
    }
    if (context.frozenPath !== undefined) {
      report.push(`\nbaseline: ${context.frozenPath} (${frozen.rowCount} rows)`);
    }
    if (context.tapPath !== undefined) {
      report.push(`captured TAP kept at: ${context.tapPath}`);
    }
    return { ok: false, status: "failed", report };
  }

  if (warnings.length > 0) {
    report.unshift(
      "",
      `named-test set gate: WARNING — ${ALLOW_UNPROVEN_ENV} is set, UNPROVEN rows downgraded`
    );
    report.push(...warnings);
    report.push(
      "",
      "named-test set gate: PASSED WITH UNPROVEN ROWS — this run did NOT prove the full frozen set",
      `  ${comparison.provenFrozenCount} of ${frozen.rowCount} frozen named rows proven; ` +
        `${pluralRows(comparison.unprovenFrozenCount)} and ${comparison.unprovenAddedCount} added ` +
        `row(s) UNPROVEN via ${ALLOW_UNPROVEN_ENV}; ${live.pointCount} live points, ` +
        `${comparison.addedCount} added`
    );
    return { ok: true, status: "unproven-accepted", report };
  }

  report.push(
    `named-test set gate: OK (all ${frozen.rowCount} frozen named rows present and proven; ` +
      `${live.pointCount} live points, ${comparison.addedCount} added)`
  );
  return { ok: true, status: "ok", report };
}
