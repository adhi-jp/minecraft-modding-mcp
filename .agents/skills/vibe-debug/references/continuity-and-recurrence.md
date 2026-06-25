# Continuity and Recurrence

Use this reference after interruptions and before finishing repeated bug classes.

## Continuity Gate

After resume, context compaction, interruption, handoff, or a "continue"
request:

1. Re-read the latest user request.
2. Reconstruct or read the current debug ledger.
3. List every unresolved symptom and closure status.
4. Identify the next proof/action for each unresolved item.
5. Check whether any user wording changed the target behavior, environment,
   priority, or accepted risk.

Only then continue implementation. A completed subtask is not the same thing as
closing the user's reported issue set.

## Recurrence Gate

If the same class of issue appears at least twice, run a short neighboring-case
scan before finishing:

- Restate the repeated class path-neutrally.
- List adjacent surfaces that share the same contract, not just the same file.
- Pick the neighboring case most likely to have been missed.
- Add one disconfirming or negative check for that case, or explain why it is
  out of current scope.

Examples:

- A parser failed for one encoded value: check another representation boundary.
- A visual update failed in one direction: check reverse direction and cleanup.
- A tool wrapper silently passed with no tests executed: check zero-match and
  ignored-test cases.
- A permission bug appeared in one role: check the neighboring role or token
  scope that shares the same boundary.

Examples are pressure cases, not required branches. Always map them back to the
abstract contract before acting.
