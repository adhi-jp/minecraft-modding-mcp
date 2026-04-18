# Change Recovery Checklist

Use this file when the request involves replacing, restoring, rolling back, or rewriting existing behavior.

## Goal

Recover or replace behavior without discarding evidence that already exists in the repository history.

## Required Checks

1. Identify the target behavior.
   - What behavior is broken, missing, or undesired now?
   - What behavior should exist after the change?
2. Find the last known-good implementation.
   - Inspect `git log`, tags, release notes, related tests, and blame history.
   - Prefer the latest commit that can be linked to known-good behavior.
3. Prove that the historical state was actually good.
   - Passing tests, release tags, user confirmation, or issue history can count.
   - If there is no proof that the old state was correct, mark it `Unproven`.
4. Inspect the historical implementation directly.
   - Read the relevant code, tests, config, migrations, and assets in that commit.
   - Capture what was different and why it mattered.
5. Compare historical and current behavior.
   - Separate accidental regressions from intentional product changes.
   - Note any surrounding changes that make direct restoration unsafe.
6. Plan from verified evidence only.
   - Reuse proven behavior when possible.
   - If the historical implementation cannot be verified or no longer fits the current environment, stop and convert the gap into a proof task.
7. Perform the behavioral equivalence analysis.
   - Read `references/behavioral-equivalence-analysis.md` and classify every comparison dimension for the replacement.
   - This step applies to all replacement and restoration tasks, regardless of whether the new implementation uses a different API.

## If Git History Is Incomplete

Do not assume the recovery path is impossible just because a clean known-good commit is missing.

Check these alternatives:

1. Release tags, packaged artifacts, or deployment snapshots available locally
2. Historical tests that describe the old behavior
3. Checked-in screenshots, fixtures, contracts, or sample payloads
4. ADRs, product specs, support docs, or runbooks
5. User-provided evidence about what "correct" used to mean

If one of these alternatives proves the old behavior, continue with a restoration or replacement plan and label the evidence honestly.

If none of them can prove the old behavior:

- Do not fake a restoration plan.
- Reframe the work as either a forensic discovery phase or a net-new behavior design phase.
- State clearly that the request cannot be treated as a verified restoration yet.

## Stop Conditions

- No known-good commit can be found.
- A candidate historical commit exists but cannot be shown to have been correct.
- The historical implementation depends on removed infrastructure that has not been revalidated.
- The current request conflicts with the known-good behavior and the new desired behavior is still ambiguous.

When any stop condition is met, do not plan the replacement as if it were understood. Report the blocker and request the missing proof.

For brand-new projects or repository migrations with no meaningful historical state, skip the restoration framing and plan as new behavior after saying that no verified prior implementation exists.

## Good Output Pattern

- "Known-good behavior was verified in commit `<sha>` by the passing test `<name>`."
- "Current regression appears after commit `<sha>`."
- "Restoration is blocked because no verified known-good commit exists for the legacy flow."
- "Git history is insufficient, but release artifact `v2.3.1` and fixture `legacy-response.json` prove the old contract."

## Bad Output Pattern

- "We should probably revert to the old implementation" without identifying a commit.
- "The previous version worked better" without evidence.
- "Rewrite the module from scratch" before reading the proven historical behavior.
