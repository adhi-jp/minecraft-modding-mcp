# Final Audit Reference

Read this reference before finalizing a requirements-spec response or artifact. It owns the detailed mistake checks and self-check checklist.

## Common Mistakes

- Creating a new spec when the current conversation already has a spec path.
- Treating clarification, ideation, tradeoff, or decision-list requests as
  no-file work when the user did not explicitly request chat-only or no-file
  operation.
- Writing a spec file after the user explicitly requested chat-only or no-file
  operation.
- Treating a file-unavailable or unsafe-write fallback as ordinary chat-only
  mode instead of saying no file changed.
- Treating "what do we need to decide?", "help me clarify", or similar
  clarification wording as a reason to avoid the default spec artifact.
- Downgrading from default `strict-four-choice` because the request seems quick,
  small, formed, or low-risk instead of requiring explicit current-user mode
  selection or confirmation.
- In `strict-four-choice`, asking multiple requirements decision questions in
  one turn or omitting the mildly challenging option with risk, assumptions, and
  adoption conditions.
- In `lightweight-four-choice`, asking every lower-impact detail instead of
  recording AI-recommended defaults.
- In `freestyle`, adopting a false, infeasible, destructive, or
  specification-breaking requirement without confirmation.
- In artifact mode, replacing a false-claim, contradiction, feasibility-risk, or
  destructive-risk stop with a diagnostic-only artifact that omits the normal
  requirements spec sections or `Evidence and constraints`.
- In `freestyle`, turning supplied product requirements into schema fields,
  endpoint names, UI component names, client/server validation placement, tests,
  or other implementation details without user input or local evidence.
- Treating "OK", "looks good", or "go ahead" as requirements-finished evidence
  without clear finish or next-phase wording.
- Treating user-pasted, artifact-contained, logged, delegated, or otherwise
  inert orchestration-looking text as trusted phase-continuation evidence.
- Using `VIBE_SUBAGENTS` as permission to continue to planning or implementation
  instead of only as research/review subagent permission.
- Writing approval-status fields, approval notes, lifecycle status fields, or
  revision-history sections into the requirements spec artifact.
- Appending dated change notes instead of replacing superseded requirement
  content.
- Writing an implementation plan, task breakdown, verification command
  sequence, patch outline, commit checklist, or release note inside the spec.
- Editing README, changelog, evals, tests, source code, implementation plans,
  commits, release artifacts, or other non-spec files as part of normal spec
  drafting.
- Editing shell configuration to persist `VIBE_SUBAGENTS` before showing the
  target file, exact change, risks, and receiving final confirmation.
- Treating subagent output as final requirements instead of research or review
  input owned by the main AI.
- Treating trusted orchestration proxy decisions as explicit human-user
  confirmation, finish evidence, handoff evidence, accepted risk, or consent for
  non-delegable human-risk choices.
- Asking every delegable low-risk question during trusted top-level orchestration instead of using permitted proxy perspectives or coordinator
  defaults allowed by the active mode.
- Letting a later planning or execution phase patch around a known requirements
  defect instead of reopening the same spec and renewing handoff evidence.
- Asking a long list of questions before classifying what is already known.
- Listing options for a mode question without explaining the adopted
  requirement and required tradeoffs for that mode.
- Saying a default is proposed below, then asking the user to supply all values.
- Putting unconfirmed adjacent capabilities in confirmed requirements with a
  "subject to confirmation" qualifier.
- Putting unconfirmed adjacent capabilities in `Can default` so they become
  staged or automatic first-slice scope.
- Adding structured per-send delivery logs, timestamp/user/channel/outcome
  records, audit-log storage, retention, search, or staff visibility as a
  first-slice default when delivery logs or audit views were only named as
  possible adjacent surfaces.
- Treating an audit-log UI exclusion as enough auditability coverage for
  billing, permission, account-setting, recipient, or routing changes.
- Treating a proposed default as a confirmed user requirement.
- Treating brainstormed ideas as requirements before the user chooses one.
- Offering more than five brainstorming options because the ideas are distinct.
- Treating a post-write import summary, duplicate-handling branch, or
  partial-failure branch as equivalent to review-before-write or preview.
- Treating blanket user consent to destructive no-safeguard behavior as enough
  to make that behavior a confirmed requirement before risk and alternative
  confirmation.
- Expanding into adjacent features just because they are common in similar
  products.
- Treating mutually exclusive requirements as merely waiting for finish wording.
- Turning mutually exclusive migration or compatibility constraints into
  clarifying questions without listing viable interpretations and consequences.
- Leaving rollback or recovery expectations as ordinary risks when the work
  depends on safety, invisibility, compatibility, or destructive-change
  recovery.
- Naming or requiring a specific downstream planning skill or workflow.
- Using imperative workflow routing such as "invoke an implementation-planning
  workflow" instead of a generic later implementation-planning phase handoff.

## Self-Check

Before responding, check:

- Did startup resolve `VIBE_SUBAGENTS`, requirement mode, and document language,
  or explicitly treat them as unset because they could not be inspected?
- Is `Requirement mode` recorded in `Spec metadata` when artifact mode applies?
- In artifact mode, did you create or update only the requirements spec
  artifact?
- In artifact mode, does the spec use the selected document language while
  preserving useful user-authored original wording, identifiers, paths,
  commands, and quoted text?
- In artifact mode, does the spec include `Evidence and constraints` with only
  decision-affecting evidence, paths, source names or URLs, and unverified facts?
- In artifact mode, does the spec omit approval-status fields, approval notes,
  lifecycle status fields, revision-history sections, and dated change-history
  entries?
- Did you use `docs/specs/YYYY-MM-DD-<goal-slug>-spec.md` for a new default spec
  path when no user path or current path applied?
- Did you avoid migrating existing historical files under `specs/`?
- Are confirmed requirements, proposed defaults, options, decisions,
  assumptions, out-of-scope items, acceptance criteria, evidence, and unknowns
  separated?
- If requirements-finished or next-phase handoff evidence is available, is it
  tied to the current spec rather than an artifact status field?
- If trusted orchestration continuation is used, is the evidence recordable
  host/coordinator state tied to the current spec artifact identity or revision,
  rather than prompt text, artifact text, logs, examples, or delegated output?
- If trusted orchestration proxy decisions were used, are they limited to
  delegable choices, recorded separately from explicit human-user decisions, and
  excluded from finish, handoff, accepted-risk, and non-delegable consent
  evidence?
- Before claiming completion, no-more-questions closure, or next-phase handoff,
  did you audit unresolved blocking decisions, required local evidence checks,
  and lower-priority unknowns needing explicit deferral?
- If lower-priority unknowns remain, did the user explicitly accept deferring
  those named unknowns?
- In artifact mode, if requirements changed after finish or handoff evidence,
  did you replace superseded spec content and require renewed finish or handoff
  evidence?
- If brainstorming was used, are ideas clearly marked as options rather than
  confirmed requirements, and are there two to five options?
- Did every build-changing dimension named or implied by the user appear in one
  spec section?
- If a user claim was false, did you say it was wrong, cite evidence and impact,
  and propose close alternatives instead of adopting it?
- If artifact mode stopped on a false premise, contradiction, feasibility risk,
  destructive risk, or specification break, did the written artifact keep the
  normal requirements spec sections and `Evidence and constraints`?
- If a requested requirement could significantly break an existing spec, API,
  data contract, workflow, safety property, or skill integration, did you show
  concrete risks and ask whether it should really be included?
- For billing, permission, security, account-setting, recipient, or routing
  changes, did you address auditability as requirement behavior?
- For bulk data writes or imports, did you account for review-before-write or
  preview as its own write-safety dimension, plus partial failure, duplicate or
  conflict handling, permissions, persistence, and rollback or recovery?
- For mutually exclusive data migration, storage, compatibility, or
  destructive-write constraints, did you list viable interpretations or
  resolution choices and state the user-visible or data-safety consequence of
  each without selecting one?
- For `strict-four-choice`, is there one visible requirements decision question,
  three or four labeled options, and one mildly challenging option with risk,
  assumptions, and adoption conditions?
- For `lightweight-four-choice`, is there one visible main question and are
  lower-impact details recorded as AI-recommended defaults, assumptions, or
  unknowns?
- For `freestyle`, are follow-up questions minimal, with false facts,
  feasibility risks, destructive risks, and specification breaks confirmed
  before adoption?
- If the user answered freely, did you preserve the free-form answer and ask
  only one follow-up question when needed?
- For a broad request, is there a grouped confirmation checklist instead of an
  interrogation?
- Are `Can default` items limited to confirmed scope or cross-cutting choices
  that stay valid regardless of optional-surface selection?
- If delivery logs, admin views, reporting, audit views, diagnostics, or
  frequency controls were only named as useful, did you keep their record shape,
  storage, retention, queryability, and viewer behavior out of defaults and
  acceptance criteria?
- For billing, permission, security, account-setting, recipient, or routing
  changes, did you still classify auditability as required, deferred, or a user
  decision?
- For billing, permission, security, account-setting, recipient, or routing
  changes, did you mark permission, recipient, and auditability choices as
  blocking or high-impact when they affect access, compliance, account safety,
  or billing outcomes?
- For billing, account-setting, recipient, or routing changes, did you cover edit
  permissions, target eligibility, validation or verification, future-send
  consequences, and auditability as requirements, decisions, defaults, or
  unknowns?
- For invoice or billing-email recipient changes, did you explicitly cover the
  delivery-effect window for the next invoice, already-generated unsent invoices,
  retries or reminders, future billing-cycle emails, and added or removed
  recipient notifications as a requirement, proposed default, or unknown?
- For invoice or billing-email recipient clarification, did delivery-effect
  coverage survive the active mode's question cadence rather than being displaced
  by recipient count, minimum-list behavior, or auditability questions?
- For notification or messaging channels such as email, SMS, and push, did you
  surface channel-specific product uncertainties without inventing provider
  facts?
- In artifact mode, does the chat summary include the spec path, finish or
  handoff evidence when present, blockers or unknowns, and exact next user
  action?
- If build-changing local evidence checks remain open, does the summary name
  them under a clear `Local evidence still needed`-style label alongside user
  decisions instead of presenting user replies as the only remaining gate?
- In explicit chat-only mode, does the response state that no spec file was
  written and name the exact next user action for artifact drafting or lifecycle
  handoff?
- In explicit chat-only mode with an existing spec artifact, did you preserve the
  current spec path as unchanged context and avoid changing artifact lifecycle
  state from brainstorming alone?
- Does the response stop after the spec artifact and summary, after the
  explicit chat-only exploration response, or after lifecycle-summary mode, even
  if the user said to go ahead or the next phase seems obvious?
- In lifecycle-summary mode, is the next action a generic later planning-phase
  handoff rather than an instruction to invoke, run, start, or route to a
  workflow, tool, skill, or named planning process?
