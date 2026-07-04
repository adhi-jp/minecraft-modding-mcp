# Requirements Contract and Lifecycle Reference

Read this reference before drafting, updating, reopening, finishing, or handing off a requirements spec. It owns core rules, path rules, the spec template, drafting modes, and lifecycle handling.

## Core Rules

- Keep the active artifact to one requirements spec unless the user explicitly
  cancels it or replaces it with a new spec effort.
- Keep the skill active for related requirement-spec work until the user gives
  an explicit requirements-finished phrase, gives a clear next-phase instruction,
  explicitly cancels the drafting effort, or explicitly replaces it.
- Before any response that could be read as requirements completion,
  no-more-questions closure, or next-phase handoff, audit unresolved blocking
  decisions, required local evidence checks, and lower-priority unknowns that
  would need explicit deferral. Build-changing decisions and required local
  evidence checks must be resolved before finish or handoff; lower-priority
  unknowns may remain only when they are explicitly listed and the user accepts
  deferring them.
- Resolving all blockers does not finish drafting by itself. The current spec
  still needs explicit requirements-finished wording or a clear current-spec
  next-phase handoff before this skill treats requirements as finished, unless
  trusted orchestration continuation provides recordable current-spec handoff
  evidence after the completion audit passes.
- Requirements-finished or handoff phrases include wording such as "end
  requirements definition", "finalize these requirements", "create an
  implementation plan", "use this spec for planning", or "implement this".
- Treat ambiguous positive replies such as "OK", "looks good", "ready",
  "continue", and "go ahead" as continued drafting unless the surrounding text
  clearly finishes requirements or asks for the next phase.
- If a later user asks whether questions remain and unresolved blocking
  decisions, required local evidence checks, or non-deferred unknowns exist,
  resume questioning instead of treating a prior pause or summary as final.
- If the user changes requirements after a requirements-finished or handoff
  signal, update the same spec by replacing superseded requirement text and
  related acceptance criteria, decisions, assumptions, defaults, and risks. The
  earlier finish or handoff evidence no longer applies to the revised spec,
  including earlier trusted orchestration evidence tied to the prior artifact
  identity or revision.
- If a later planning or execution phase reports that the current requirements
  spec is wrong, contradictory, infeasible, or missing a build-changing decision,
  treat that report as a requirements revision input, not as permission for the
  later phase to patch around the spec. Reopen the same spec path when available,
  replace superseded requirements and acceptance criteria, and require renewed
  requirements-finished or next-phase handoff evidence before planning or
  execution resumes.
- Separate confirmed requirements, proposed defaults, candidate options,
  decisions, assumptions, out-of-scope items, acceptance criteria, evidence, and
  open unknowns.
- Use brainstorming only to produce candidate options. Do not treat an idea as
  a confirmed requirement until the user chooses it or explicitly confirms it.
- Do read-only research when correctness or feasibility affects the
  requirements and the user has provided access or asked for that evidence.
  Relevant sources include local files, existing specs, official documentation,
  primary sources, and user-provided source material.
- Do not run tests, builds, migrations, destructive commands, or other
  implementation verification while this skill is active. If needed facts cannot
  be checked safely, record them as unverified in the spec.
- If the user asks for source, README, changelog, eval, test, plan, commit,
  release, or other non-spec work in the same turn as active requirements
  drafting, update only the requirements spec artifact or no-write/chat-only
  response and state that the non-spec work remains for a later phase. In a
  broader orchestration, return a clear requirements-phase stop or handoff signal
  instead of force-killing the whole orchestration. Trusted orchestration may
  consume that signal as a later separate phase only when the evidence rules
  above are satisfied.
- If the user explicitly requests chat-only or no-file operation, do not write a
  spec artifact. Keep the discussion structured enough to preserve the exact
  next action needed to create or update a spec later.

## Spec Path Rules

Choose and preserve the spec path in this order:

1. Use a user-specified path when one is provided.
2. Reuse the current spec path when it appears in the conversation or existing
   spec artifact, including historical paths under `specs/`.
3. Otherwise create `docs/specs/YYYY-MM-DD-<goal-slug>-spec.md` at the workspace
   root, using the current local date and a short lowercase slug.

If a host, harness, or runner provides an output-capture path for recording the
artifact, treat that path as write transport only unless the user explicitly
selected it as the spec path. Write to the required capture path when necessary,
but keep `Current spec path` and the chat summary path selected by the rules
above.

This change is forward-looking. Existing files under `specs/` remain in place
as historical artifacts and must not be migrated only because this skill now
defaults new requirements specs to `docs/specs/`.

Before writing, read an existing target path when possible. If the path contains
the current spec, update it in place. If it contains unrelated content, do not
overwrite it; ask for a different path or explicit replacement instruction. If
the user asks for a new spec and the default path would collide, choose a clear
non-conflicting suffix such as `-2` only when the old file is unrelated and the
new path is shown in the summary.

If the conversation identifies a current spec path but the file is missing,
unreadable, or unavailable in the active workspace, preserve that path as the
current spec context. State when the saved spec could not be inspected or
changed, continue with the appropriate no-write or lifecycle-summary fallback,
and do not replace, drop, or fork the current spec path solely because the file
is unavailable.

When the user provides new information for an existing spec, update the same
file instead of creating a new unrelated spec. Replace stale requirements,
defaults, decisions, assumptions, acceptance criteria, evidence, and risks with
the new decided content. Do not append dated revision history inside the spec
artifact.

If file writing is unavailable, unsafe, or declined, do not simulate a file
write. If the user requested a spec artifact, return the complete spec in chat,
state the intended path or path-selection blocker, and say no file was changed.
If the user explicitly requested chat-only exploration, return options or
decisions in chat without assigning a new spec path.

## Spec Template

Use the template below as authoritative. Use stable English section headings and
English generated prose unless the user or `VIBE_DOCUMENT_LANGUAGE` selects a
different artifact language. Preserve user-authored requirement wording,
product names, domain terms, paths, API names, commands, identifiers, and quoted
text in the original language where useful, with the artifact language's
operational wording alongside them when needed.

Use `## Spec metadata` only for current artifact metadata. Put requirements-
finished evidence, missing finish actions, next-phase handoff evidence, and
revision context in the chat summary or workflow state, not in the spec file.

```markdown
# [Goal or Feature Name] Requirements Spec

## Spec metadata
- Current spec path: [path]
- Last updated: YYYY-MM-DD
- Requirement mode: strict-four-choice|lightweight-four-choice|freestyle

## User goal

## Evidence and constraints

### Local evidence

### External evidence

### Unverified facts

## Current requirements

### Confirmed requirements

### Proposed defaults

### Ideas or options

### Decisions needed

### Assumptions

### Out of scope

## Acceptance criteria

## Open risks and unknowns
```

`Evidence and constraints` records only evidence that affects requirement
decisions. For local evidence, include paths. For external evidence, include
source names or URLs. For unknowns, mark the fact unverified instead of
adopting it as confirmed.

For broad unclear requests, use a grouped confirmation checklist inside
`Decisions needed`:

```markdown
### Decisions needed

#### Blocking decisions
- [ ] Decisions that change the first buildable scope.

#### Can default
- [ ] Defaults for confirmed scope or cross-cutting choices that stay valid
      regardless of optional-surface selection.

#### Later decisions
- [ ] Items that can wait because they do not affect the first useful slice.
```

## Drafting Modes

### `strict-four-choice`

Use `strict-four-choice` whenever no explicit current-user mode selection is
present, and for vague, high-risk, contradictory, destructive, or
recognition-alignment-heavy requests. Ask one visible requirements decision
question per turn and continue for as many turns as needed to protect the
requirement contract and completion gate. Startup permission questions, such as
subagent permission, do not count as the requirements decision question, but
keep them separate and brief.

In trusted orchestration proxy mode, the one-question cadence describes what
would be asked in a manual session. A proxy pass may resolve multiple delegable
strict questions in one phase response when the spec records the selected
choices as proxy-backed defaults or assumptions and preserves any non-delegable
question as a human blocker.

Each question presents three or four labeled options. Use four options when four
natural, high-quality choices exist; use three when a fourth would be filler.
Each option states the requirement that would be adopted, benefits, drawbacks,
and risks or assumptions. Include one mildly challenging option by default, and
state its risk, assumptions, and adoption conditions.

### `lightweight-four-choice`

Use `lightweight-four-choice` only after explicit current-user selection or
confirmation to leave strict mode. Ask one visible question per turn for the
main requirement dimensions, normally for up to roughly three main questions.
Record lower-impact details as AI-recommended defaults, assumptions, or open
unknowns instead of turning every detail into a question.

In trusted orchestration proxy mode, prefer proxy-backed defaults for those main
dimensions when they are delegable, and ask the human user only for unresolved
non-delegable or high-impact choices.

Each question presents three or four labeled options when option selection helps
the user decide. Each option states the requirement that would be adopted, the
main benefit, and the main drawback.

### `freestyle`

Use `freestyle` only after explicit current-user selection or confirmation to
leave strict mode. Organize sufficiently formed free-form requirements into the
spec with minimal follow-up questions. Stop before adopting a requirement when
the user's input contains a factual error, feasibility risk, destructive-change
risk, or a significant break from an existing specification, API, data contract,
workflow, safety property, or skill integration.

When stopping for risk or false facts, clearly say what is wrong or risky, cite
the evidence or mark it unverified, explain the requirement impact, and propose
alternatives close to the user's goal. If the only requested change depends on a
false or contradicted premise, leave the current spec unchanged unless there is
confirmed unaffected content to update, and state that the saved spec was not
changed while waiting for user confirmation.

In artifact mode, this stop still produces a requirements spec artifact. Keep
the normal template sections, record the deciding evidence and unverified
premise under `Evidence and constraints`, and capture the unresolved choice or
risk in the relevant requirements sections instead of replacing the artifact
with only a diagnostic note.

Do not convert supplied product requirements into implementation details such as
schema fields, API endpoints, UI component names, storage representation,
client/server validation placement, test cases, or framework choices unless the
user supplied them or local evidence proves they are existing constraints.
Record such details as open implementation evidence needs, assumptions, or leave
them out of the requirements spec.

### Free-Form Answers

If the user answers freely instead of selecting a numbered option, respect the
free-form answer. Map it to the nearest option only when useful, preserve the
user's difference from that option, and ask one follow-up question only when
needed.

## Drafting Workflow

Before creating, revising, reopening, finishing, or handing off a requirements spec, read `references/drafting-workflow.md`. That reference owns the detailed drafting loop and completion audit sequence.
## Requirements Lifecycle

This skill remains active across related turns until the completion audit has no
unresolved build-changing decisions or required local evidence checks, any
lower-priority unknowns have been explicitly accepted for deferral, and one of
these happens:

- The user gives an explicit requirements-finished phrase for the current spec.
- The user gives an unambiguous instruction to create or use an implementation
  plan from the current spec.
- The user gives an unambiguous instruction to implement from the current spec.
- Trusted orchestration continuation provides recordable current-spec finish or
  next-phase handoff evidence after the completion audit passes.
- The user explicitly cancels the spec drafting effort.
- The user explicitly replaces it with a different spec effort.

No amount of internal confidence, absence of open questions, completed
checklists, or ambiguous positive wording ends requirements drafting by itself.
If the next user turn adds requirements, edits decisions, changes scope, or
responds ambiguously, keep updating the same spec and require explicit
requirements-finished or next-phase handoff evidence before later implementation
planning.

If the next user turn asks whether questions remain, rerun the completion audit.
When unresolved blocking decisions, required local evidence checks, or
non-deferred unknowns remain, ask the next active-mode question and name the
remaining items instead of confirming that requirements are complete.

Requirements with finish or next-phase handoff evidence after the completion
audit are stable input to a later implementation-planning phase. Trusted
orchestration evidence must stay tied to the current spec artifact identity or
revision and is invalidated when the requirement contract changes. Finish or
handoff evidence does not authorize same-turn implementation planning, code
edits, tests, verification commands, commits, release work, changelog edits, or
unrelated file edits while this skill is active. Mixed same-turn non-spec
requests receive a requirements-phase stop or handoff signal and remain for a
later phase.

When a later implementation-planning or plan-execution phase finds a verified
requirements defect, the current spec's earlier finish or handoff evidence is
invalid for the affected contract. Update or block the same requirements spec
before any downstream plan or code path proceeds from the changed behavior.
