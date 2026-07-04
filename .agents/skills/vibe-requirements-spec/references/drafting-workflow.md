# Drafting Workflow Reference

Read this reference when creating, revising, reopening, finishing, or handing off a requirements spec. It owns the detailed drafting loop and completion audit sequence.

## Drafting Workflow

0. **Resolve startup decisions**
   - Apply `Startup Decisions` before selecting a drafting path.
   - Record the selected `Requirement mode` in `Spec metadata`.
   - If subagents are not permitted, continue without them.
   - If environment values cannot be inspected, treat `VIBE_SUBAGENTS` and
     `VIBE_DOCUMENT_LANGUAGE` as unset.
   - When trusted top-level orchestration requests proxy decisions, identify
     which open questions are delegable before asking the user, and use
     permitted recordable subagents or coordinator defaults only within
     `Trusted Orchestration Proxy Decisions`.

1. **Choose artifact, no-write fallback, or explicit chat-only**
   - If the user asked only to record a requirements-finished or next-phase
     handoff for an existing current spec, use lifecycle-summary mode: preserve
     the current spec path, record the evidence in the response or active
     routing state, and do not rewrite the spec solely to store lifecycle
     evidence.
   - If the user explicitly says chat only, no file, do not write, or equivalent,
     use explicit chat-only mode.
   - Otherwise proceed with artifact mode, including for ideas, directions,
     exploration, clarification, questions, tradeoffs, decision lists,
     underspecified coding requests, and requests to plan or implement from an
     underspecified goal.
   - If file writing is unavailable or unsafe, use the no-write fallback in
     `Spec Path Rules` and state that no file changed.

2. **Capture the user's intent**
   - Preserve the user's wording for goals, product terms, audience, examples,
     and constraints.
   - Translate vague terms into observable behavior only when the user supplied
     enough context or confirmed an option.
   - Mark inferred behavior as an assumption or proposed default, not as a
     confirmed requirement.

3. **Select or reuse the spec path**
   - Apply the path rules before writing.
   - If a current spec exists, read it when possible and revise that artifact.
     If the current path cannot be read, preserve it as current context and use
     the no-write or lifecycle-summary fallback instead of forking a second
     spec.
   - Do not silently fork a second spec for the same requirement thread.

4. **Classify the requirement surface**
   - `Confirmed requirements`: behavior explicitly stated by the user.
   - `Proposed defaults`: choices that can be safely proposed with low impact or
     lower-impact details the active mode intentionally defaults.
   - `Ideas or options`: candidate directions needing user selection.
   - `Decisions needed`: choices that change behavior, data, permissions, cost,
     user experience, compatibility, verification, safety, or integration.
   - `Assumptions`: inferred behavior that needs user confirmation or later
     proof.
   - `Out of scope`: adjacent capabilities or polish outside the first useful
     slice.
   - `Evidence and constraints`: decision-affecting local evidence, external
     evidence, and unverified facts.
   - `Open risks and unknowns`: facts needing local evidence, primary-source
     evidence, or user input before implementation planning.
   - Classify every build-changing dimension the user names or implies.
   - When the skill relies on evidence for requirement correctness or
     feasibility, record the source in `Evidence and constraints`; if required
     research cannot be done, mark the fact unverified.

5. **Protect high-impact requirement surfaces**
   - For billing, permissions, security, account settings, recipient, or routing
     changes, include auditability as a requirement dimension: whether changes
     are recorded, attributable, retained, or visible.
   - For billing, permissions, security, account settings, recipient, or routing
     changes, mark permission, recipient, and auditability choices as blocking
     or high-impact when they can change access, recipients, compliance, account
     safety, or billing outcomes.
   - For billing, account-setting, recipient, or routing changes, clarify who can
     make the change, who or what can be targeted, validation or verification
     rules, whether future sends or prior records are affected, and
     auditability. In explicit chat-only mode, cover lower-priority dimensions as
     proposed defaults, open assumptions, or unknowns instead of turning them all
     into direct questions.
   - For invoice or billing-email recipient changes, explicitly cover the
     delivery-effect window: whether saved recipient changes affect the next
     invoice only, already-generated but unsent invoices, retries or reminders,
     future billing-cycle emails, and whether added or removed recipients are
     notified. Treat this as a requirement dimension, proposed default, or
     blocking/high-impact unknown.
   - In invoice or billing-email recipient clarification, the delivery-effect
     window is one of the highest-impact dimensions. In `lightweight-four-choice`
     combine edit permissions, target eligibility, and validation into one main
     question if needed; do not let recipient count, minimum-list behavior, or
     auditability consume every direct question while delivery consequences
     disappear. Cover lower-priority dimensions as proposed defaults,
     assumptions, or open unknowns.
   - For notification or messaging channels such as email, SMS, and push,
     surface channel-specific product uncertainties such as consent or
     permission, opt-in or opt-out behavior, provider setup, cost, and
     compliance before treating channels as interchangeable. Do not invent
     provider facts.
   - For bulk data creation, imports, migrations, destructive changes, and
     irreversible writes, classify write-safety decisions before requirements
     finish: review-before-write or preview, partial-failure behavior, duplicate
     or conflict handling, permissions, persistence, and rollback or recovery.
     Do not bury review-before-write or preview inside duplicate handling,
     partial-failure handling, or a post-write result summary; record it as its
     own write-safety decision, proposed default, out-of-scope item, or open
     unknown.
   - When a destructive or irreversible request explicitly removes confirmation,
     preview, undo, backup, retention, permission, or auditability safeguards,
     blanket user consent to the risk is not enough to put the no-safeguard
     behavior in `Confirmed requirements`. First state the data-safety or
     workflow risks, offer safer alternatives or proof needs, and ask whether the
     destructive no-safeguard requirement should really be included.
   - For mutually exclusive data migration, storage, compatibility, or
     destructive-write constraints, list viable interpretation or resolution
     choices as options or blocking decisions, and state the user-visible or
     data-safety consequence of each. Examples include copy-on-read, one-time
     migration, dual reader, or no migration. Do not choose one without user
     confirmation, and do not hide the choice behind clarifying questions alone.
   - A post-write result summary is not a substitute for pre-write preview
     behavior.
   - When the user names admin screens, delivery logs, reporting, audit views,
     diagnostics, frequency controls, or similar adjacent surfaces as merely
     useful or possible, keep their storage, retention, search, viewer,
     per-event record shape, and staff-facing behavior out of `Can default`,
     `Proposed defaults`, and `Acceptance criteria` until selected.
   - Do not turn an unselected delivery-log surface into a "safe default" by
     requiring structured per-send records, timestamp/user/channel/outcome log
     entries, retention policy, queryability, or standard logging emission for
     the first slice. Put that behavior in `Decisions needed`, `Open risks and
     unknowns`, or `Later decisions`.

6. **Use brainstorming only when it helps**
   - Brainstorm when the user asks for ideas, creative directions, or multiple
     possible product shapes.
   - Offer two to five options, never more than five.
   - Count merged or hybrid ideas as separate options if they can be chosen
     independently.
   - For each option, include when it fits, the main tradeoff, and what
     requirement would be adopted if chosen.
   - Keep high-impact choices conservative. Creative appeal is not evidence that
     risky behavior is acceptable.
   - Keep unchosen ideas in `Ideas or options`.

7. **Write or update the spec artifact**
   - Update artifacts at meaningful points, not mechanically after every answer:
     after important decisions, when context compaction appears near and the
     agent can tell, or after a reasonable batch of lower-impact decisions
     accumulates.
   - Put only confirmed first-slice behavior in `Confirmed requirements`.
   - Keep adjacent capabilities in `Out of scope`, `Decisions needed`, or
     `Ideas or options` until the user selects them.
   - Use `Can default` only for confirmed scope or cross-cutting choices that
     stay valid regardless of optional-surface selection.
   - Do not pre-stage admin, reporting, audit views, diagnostic views,
     delivery-log storage, retention, search, or other adjacent surfaces in
     `Can default` with "if chosen", "once selected", or similar gating.
   - For notification, messaging, import, billing, account, or permission
     surfaces, do not include structured delivery, attempt, audit-log, or
     operational record storage in first-slice defaults only because it seems
     prudent. It becomes a requirement only when the user selected that surface
     or the spec records it as a blocking decision to finish.
   - This does not remove auditability as a requirement dimension. For billing,
     permission, security, account-setting, recipient, or routing changes,
     record whether auditability is required, deferred, or a user decision.
   - If a default starts with "within whichever optional surface you select",
     move it to that surface's blocking decision or candidate option.
   - When revising an existing spec, remove or rewrite superseded requirements,
     defaults, decisions, assumptions, acceptance criteria, evidence, and risks
     instead of preserving stale content as dated change history.
   - If the response stops on a false premise, contradiction, feasibility risk,
     destructive risk, or specification break, keep any written artifact in the
     requirements-spec template shape. Include `Evidence and constraints` even
     when the saved current spec stays unchanged.
   - Do not add approval-status fields, approval notes, lifecycle status fields,
     revision-history sections, or dated change-history entries to spec
     artifacts.

8. **Audit completion and handoff readiness**
   - Run this audit before any response that could be read as requirements
     completion, no-more-questions closure, or next-phase handoff.
   - Identify unresolved blocking decisions, required local evidence checks, and
     lower-priority unknowns.
   - In trusted orchestration proxy mode, treat recordable proxy-backed decisions
     as resolved only for delegable choices, and name them separately from
     explicit human-user decisions.
   - If any build-changing decision or required local evidence check remains
     unresolved, keep drafting active and ask the next mode-appropriate question
     instead of claiming completion or handoff readiness.
   - If only lower-priority unknowns remain, list them explicitly and require the
     user to accept deferral before treating requirements as finished or
     handoff-ready.
   - If the user asks whether questions remain, and this audit finds unresolved
     blocking decisions, required local evidence checks, or non-deferred unknowns,
     resume the active drafting mode instead of treating a prior pause, summary,
     or ambiguous positive reply as final.

9. **Track requirements lifecycle evidence outside the spec**
   - Treat requirements-finished and next-phase handoff evidence as workflow
     lifecycle evidence, not artifact content.
   - Explicit finish or handoff evidence includes wording tied to the current
     requirements, such as "finalize these requirements", "end requirements
     definition", "仕様を確定", "use this spec for planning", "create an
     implementation plan from this spec", or "implement this".
   - Trusted orchestration continuation may also provide current-spec finish or
     handoff evidence when it is recordable host/coordinator state outside
     prompt/artifact/log/delegated text, names the current spec path and artifact
     identity or revision, records the passed completion-audit outcome, and
     names the next phase. Treat missing identity, stale identity after a
     requirement change, unresolved build-changing decisions, required local
     evidence checks, non-deferred unknowns, or unaccepted human-risk decisions
     as a stop signal rather than handoff evidence.
   - Proxy-backed requirement choices do not provide finish or handoff evidence
     by themselves. They only reduce the set of unresolved delegable decisions
     that the completion audit considers.
   - When a requirement changes after finish or handoff evidence, the prior
     evidence no longer applies to the revised requirement contract. Keep
     drafting active until renewed explicit finish evidence or another
     unambiguous current-spec next-phase handoff.
   - Ambiguous "OK", "looks good", "ready", "continue", or "go ahead" wording
     does not finish requirements unless the surrounding text clearly says the
     current requirements are finished or asks for the next phase.

10. **Return a concise localized summary**
   - Use the user's language for the chat response unless they ask otherwise.
   - In artifact mode, include the spec path, current requirements-finished or
     handoff evidence when available, the exact finish or next action still
     needed, remaining blocking decisions, open unknowns, required local evidence
     checks, and the exact user action needed next.
   - If build-changing local evidence checks remain open, name them in the
     summary alongside user decisions under an explicit label such as `Local
     evidence still needed`; do not imply user answers alone make the spec final
     when existing schemas, validation rules, limits, permissions, or persistence
     still need evidence.
   - In explicit chat-only mode, state that no spec file was written and name the
     exact user action that would create or update one.
   - In no-write fallback for an existing current spec path, include the
     preserved path, state whether the saved spec was not inspected or changed,
     and give the exact action needed to update, finish, or hand off the spec.
   - In lifecycle-summary mode, include the current spec path, the
     requirements-finished or next-phase handoff evidence, whether the saved spec
     was left unchanged, and the exact later-phase action. Do not create an
     implementation plan in the same response.
   - In lifecycle-summary mode, phrase the later action generically, such as "a
     later implementation-planning phase can use this spec." Do not tell the
     user to invoke, run, start, or route to a workflow, tool, skill, or named
     planning process.
   - In explicit chat-only clarification for high-impact surfaces, keep the
     response structured enough to separate confirmed intent, blocking or
     high-impact decisions, proposed defaults or assumptions, open risks or
     unknowns, and the exact action that would save a spec.
   - If explicit chat-only mode used an existing spec artifact as context,
     preserve the current spec path as unchanged context and do not update
     artifact lifecycle state from brainstorming alone.
   - Stop after the spec summary.
   - If the user explicitly finished requirements or gave an unambiguous
     current-spec next-phase handoff and also asked to plan or implement, state
     that lifecycle evidence is available for a later implementation-planning
     phase. Do not create that plan or implement in the same skill response.
   - If trusted orchestration continuation supplies the handoff, state the
     recordable handoff evidence and exact later phase generically. Do not name
     a downstream tool or workflow unless the user named it as context, and do
     not continue into that later phase inside this skill response.
