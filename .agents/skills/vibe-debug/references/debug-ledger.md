# Debug Ledger

Use this ledger for every current-scope symptom. Keep it compact, but keep the
fields explicit so a later resume cannot silently lose the issue.

| Field | Purpose |
| --- | --- |
| Reported symptom | Preserve the user's wording, including "still broken" or "feels wrong". |
| Expected behavior and source | State the intended behavior and cite user requirement, product spec, official docs, local code, tests, logs, or accepted residual. |
| Observed behavior and source | State what was observed and where: local reproduction, user screenshot, log, test failure, runtime trace, or prompt report. |
| Prior attempts | List each prior fix or hypothesis and why it failed, remains unproven, or did not reach the tested artifact. |
| Suspected causes | Hypotheses still under investigation. Do not treat these as facts. |
| Probe or instrumentation plan/result | For stalled source-only debugging, state the temporary log, trace, assertion, dump, artifact inspection, or runtime observation that distinguishes hypotheses and its observed signature. |
| Proven cause | The cause backed by reproduction, source trace, primary source, or targeted negative check. |
| Affected state-space dimensions | The dimensions that can change the symptom or regress nearby behavior. |
| Verification path | Automated test, manual observation, source trace, artifact-freshness proof, or user retest contract. |
| Closure status | `fixed`, `not-reproduced`, `deferred`, `accepted-residual`, or `blocked`. |

## Status Meanings

- `fixed`: The symptom is closed by proof that observes the behavior, and the
  tested artifact includes the change when runtime artifacts are involved.
- `not-reproduced`: The symptom was actively checked in the relevant state-space
  and not observed. Include the checked dimensions and residual risk.
- `deferred`: The user or plan moved the item out of current scope. Include the
  revisit trigger.
- `accepted-residual`: The user accepted a known remaining risk or unproven
  dimension. Include impact and what would reopen the item.
- `blocked`: The item cannot close because an expected-behavior source,
  reproducible symptom, artifact, permission, environment, or proof path is
  missing.

## Failed-Attempt Rules

On repeated reports, add or update a prior-attempt row before proposing another
fix:

- What changed.
- What proof was claimed.
- What the user or local evidence still observed.
- Why the proof did not cover the failing state-space, runtime artifact, source
  of truth, or expected behavior.
- What new proof will distinguish the next attempt from another guess.

If the answer is "unknown", the next step is proof gathering, not another fix.
When the missing proof is live runtime state, prefer a focused diagnostic probe
or equivalent trace over another source-only patch.
