# Edge Cases and Accepted Risk Reference

Read this reference when the requested mechanism is impossible, the plan depends on an unproven assumption, or the user explicitly accepts a scoped risk.

## Handling Incorrect or Impossible Requests

When the user's requested mechanism is wrong or impossible:

1. Restate the user's likely underlying goal.
2. Cite the verified source or local evidence that blocks the literal request.
3. Explain the risk in practical terms.
4. Offer the closest viable alternative.
5. Ask for a decision only if the alternatives change product behavior, cost,
   timeline, data handling, security posture, or user experience.

Do not bury impossibility inside a generic risk list. Put it near the decision
it affects.

## Accepted-Risk Branch

If the user explicitly chooses to continue with an unproven assumption:

- Record the exact assumption.
- Record the user's acceptance and rationale.
- Record the impact area: feasibility, behavior, data, integration, performance,
  security, UX, cost, or schedule.
- Keep the evidence label as `Accepted risk`.
- Record `Phase relevance` so the risk is tied to a current conditional step,
  future deferred decision, or non-implementation follow-up.
- Include the fastest proof path and revisit trigger.
- Make implementation steps conditional where the unproven assumption could
  invalidate the plan.
- When an `Accepted risk` can invalidate a named local identifier, mapping,
  file-backed fact, or external contract before implementation, put the
  re-check in the first dependent implementation or discovery step with the
  concrete source names to re-read. A generic handoff reminder to "re-check
  local facts" is not enough for that conditional step.

Never use accepted risk for irreversible, destructive, unsafe, illegal, or
credential-exposing actions. Those require proof or a safer alternative.
For destructive, auth/session, credential, permission, billing, or data-migration
plans, acceptance criteria and tests/proof must cover auditability or
traceability sufficient to identify what changed, who or what was affected, and
how rollback or recovery can be verified. Do not invent an audit-log UI or
retention feature unless the user requested it.
