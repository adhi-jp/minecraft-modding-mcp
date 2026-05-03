---
version: 1.1.0
name: writing-style-guide
description: Use when generating or editing user-facing prose, including docs, comments, READMEs, changelogs, commit messages, PR descriptions, and chat replies.
---

# Writing Style Guide

## Overview

Words that ship — documentation, commits, PRs, changelogs, and chat replies — are part of the deliverable. This skill sets writing principles, not a procedure: apply judgment, preserve contracts, and make every word earn its place.

## Scope

Apply when producing or editing:

- Comments, docstrings, README, CHANGELOG, and narrative docs
- Commit messages, PR descriptions, release notes, and chat replies

Skip when text is internal, verbatim tool/log output, transient progress text, or a bare acknowledgment is the whole reply.

If output must match an exact format, that format wins. JSON, protocol payloads, parser-sensitive templates, and other machine-readable shapes must keep their required structure and receive no extra prose or Markdown fences. Human-readable comments/docstrings remain in scope.

## Core Principles

### Be concise

Write the shortest version that still carries the idea. Remove ornament, hollow transitions, and decorative structure. Concision is not a license to drop facts, warnings, or user-requested depth.

### Preserve meaning

Editing changes wording, not the contract. Unless the user asks for a semantic change, preserve:

- Facts, scope, audience, terminology, and order that matters
- Conditions, exceptions, warnings, limitations, and required actions
- Modality: `must`, `should`, `may`, `can`, `required`, `optional`, and `recommended` are different obligations

A cleaner sentence that changes who must do what, when a rule applies, what is allowed, or what happens on failure is wrong.

Explicit absence is information. Preserve supplied statuses such as "tests not run", "not measured", "no rollout plan supplied", or "not provided". In Testing sections, write the supplied status (`Not run`, `Not measured`) instead of `Not provided`. Use placeholders like `Not provided` only when the source truly gives no status.

Risk and evidence sections often combine bounded evidence with missing proof: "parser change only", "no production incidents supplied", "no benchmarks", "no rollout plan". Render the evidence available. `Not provided` does not mean "no detailed assessment" or "no positive proof".

### Do not invent context

Do not add unsupported reasons, goals, outcomes, roadmap claims, audience assumptions, business value, implementation rationale, causality, tests, risk reduction, or user impact. Avoid marketing claims like "designed to", "helps teams", "future-ready", "seamlessly", and "makes it easy to scale" unless the artifact proves them.

Obvious-sounding explanations still need support. Do not add safety/security rationales such as "so your account stays safe", "to protect your data", or "to prevent unauthorized access" unless the source says that is the reason.

When asked to make policy, support, or README copy warmer, create warmth by making the existing facts easier to read. Do not add reassurance claims, service-volume promises, availability hints, new support-channel instructions, or causal bridges. "We read every ticket", "our team is here for you", and "so please keep urgent issues in a ticket" are new facts unless the source says them.

If the source is incomplete, leave the gap visible or ask when the missing input blocks the task. Do not smooth uncertainty into a confident story.

### Choose language by artifact

Use this precedence:

1. Explicit user instruction, including translation/localization requests
2. Existing artifact language
3. Filename locale marker such as `README.ja.md` or `docs/de_de/guide.md`
4. Project convention
5. English

Artifact-level translation or localization contracts override chat language. Preserve file paths, commands, identifiers, and canonical strings unless the user explicitly asks to translate them. Chat replies follow the user's active conversational language.

### Open with substance

Drop preambles like `Sure!`, `Absolutely.`, and `Great question.`. The action or answer shows agreement.

### Make artifacts stand alone

Do not leak prompt scaffolding into artifacts: `per plan1.md`, `the provided text`, `above`, `as discussed`, or similar references rot outside the conversation.

Durable traceability is different. Issue IDs, RFCs, incident tickets, commit SHAs, ADR slugs, and audit references belong when requested, required, or useful for rollback/audit. If the reference survives a local file rename, it is a citation, not a prompt leak.

### Match the reader

Write for the actual reader and omit the rest.

- End-user README: what it is and how to start using it
- Contributor docs: setup and submission
- Code comments: why the signature, names, and types do not already explain the code

House style and real project needs win over generic rules. A library whose users build from source may need build steps in its README.

## Anti-Patterns

Remove these on sight:

- Name-echoing comments: `// parse the user` on `fn parse_user()`
- Marketing vocabulary: `seamlessly`, `effortlessly`, `powerful`, `leverage`, `robust`, `enterprise-grade`
- Groundless future claims: `future extensibility`, `easy to scale later`
- Meaning drift: cleaner wording that changes obligations or failure behavior
- Invented context: unsupported motivation, intent, rationale, impact, or benefit
- Template-shaped answers: automatic `Summary / Testing / Notes`, padded three-part structures, broad comparison sections
- Over-normalization: replacing useful local terms, order, tone, or examples with generic textbook wording
- Safety theater: generic warnings that do not change what the reader should do; real safety/security/data-loss/compliance warnings stay
- Unrequested additions: disclaimers, alternatives, roadmap notes, caveats, or "things to consider" outside the ask
- Hollow transitions: `It's worth noting that`, `In conclusion`, `Ultimately`
- Excess punctuation habits, including repeated em dashes in the same paragraph

## Artifact Notes

### Source-code documentation

Public APIs need intent, contracts, invariants, and non-obvious usage. Internal code needs only what orients the next maintainer. Explain workarounds, performance tricks, and subtle contracts. Do not write doc comments that only paraphrase the signature.

### README

Lead with what it is and how to start. Keep the existing audience, prerequisites, terminology, and setup order unless wrong or explicitly changed. Cut sections the intended reader does not need.

### CHANGELOG

Follow the project's style. Each entry answers "what changed for me, the reader". Internal refactors without user-visible impact usually belong in commit history. Do not inflate an internal crash path into a broad reliability claim.

### Commit messages

Match the repo convention. The subject says what the commit achieves, not what the author did. The body explains only the why, tradeoffs, and review context supported by the diff, issue, or supplied material. Do not claim tests, impact, or risk reduction without evidence.

### Chat replies

Lead with the answer. Keep progress updates to a sentence or two. End summaries should be brief when needed and absent when not. Give depth when the user asks for rationale, verification, limitations, recovery, or comparison. Do not add ritual closing offers or generic next steps when a short answer resolves the request.

## Coexistence

This guide is for prose quality, not workflow control. When active instructions or project conventions define a specific template, release process, staging rule, or PR format, follow that procedure and apply this guide to the words inside it.

## Self-Check

Before returning prose, check:

- Can any word, heading, list, caveat, or wrap-up sentence disappear without loss?
- Did facts, scope, modality, conditions, exceptions, warnings, and required actions survive?
- Did unsupported reasons, outcomes, roadmap claims, audience assumptions, benefits, or safety rationales sneak in?
- Did the artifact leak prompt context instead of standing alone?
- Did exact-format output remain exact?

The goal is not austerity. The goal is that every word earns its place.
