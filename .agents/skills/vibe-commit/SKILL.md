---
version: 1.0.2
name: vibe-commit
description: Use when the user asks to commit, stage, or "save" vibe-coding changes — including vague requests like "commit this", "commit please", "コミットして", or "/commit" — and the real work is deciding which files belong in the commit, excluding unwanted or generated files, splitting unrelated changes, or fixing a commit's file set, multi-line message transport, history (amend/rebase), or authorship trailers. This skill owns commit execution, message transport, and git safety.
---

# Vibe Commit

## Overview

A vague "commit please" is a request to turn a messy working tree into one
clean, correctly scoped commit — not a request to run `git add -A && git
commit`. The instruction is underspecified on purpose: the user trusts the agent
to decide what belongs in the commit, keep junk out, and leave a message and
history a future maintainer can use.

This skill governs the *execution* of that: which files to stage, what to keep
out, how to re-verify the staged set before committing, how to transport a
multi-line message without corruption, and how to amend or repair a commit while
keeping authorship trailers intact. The guidance here is distilled from real
agent sessions where these exact steps prevented — or, when skipped, caused —
commit mistakes.

## Message content vs. commit execution

Commit work splits cleanly between message content and execution:

- The commit message content must stand on its own: an outcome-focused
  Conventional Commit subject, body only for durable context the diff cannot
  recover, durable verification references, no prompt/session/plan labels, and
  no Markdown wrappers in message bytes.
- `vibe-commit` owns the **execution**: staging, exclusion, the pre-commit
  verification gate, command safety, history mutation, message transport, and
  trailers as a transport mechanism.

Apply the compact message rules in `references/history-and-trailers.md` whenever
this skill prepares, inspects, amends, or repairs a commit message. The commit's
*bytes* — file set, message transport, trailer footer, and stored message — are
this skill's responsibility, and you verify them after committing.

## Authority and safety boundary

Committing locally is reversible; publishing is not. Stay on the reversible side
of that line unless the user says otherwise.

- **Commit when asked; do not push.** A request to commit is not a request to
  push. Do not `git push` unless the user explicitly asks.
- **Do not rewrite shared history.** Amending or rebasing an already-pushed
  commit rewrites history other clones depend on. Only amend/rebase commits that
  have not left this machine, and never force-push a shared branch without an
  explicit, informed request.
- **Honor `.gitignore` and the agreed scope.** Never `git add -f` an ignored
  path, and never stage files outside the change being committed, unless the
  user explicitly asks to include that ignored path after you have surfaced why
  it is ignored and what risk that creates. Decide scope by the user-visible
  change, not by whatever happens to be dirty.
- **No surprise side effects.** Do not bump versions, cut releases, or trigger
  hooks the repo did not ask for as a byproduct of committing.

## Core workflow: "commit please" → one clean commit

Follow this spine. Each step names the load-bearing command; the references go
deeper on the judgment calls.

1. **Discover everything.** `git status --short --branch --untracked-files=all`
   and `git status --ignored` show every modified, staged, untracked, and
   ignored path in one view. Add `git log -1 --oneline` and `git branch
   --show-current` so you know the branch and the commit you might extend.
2. **Inspect intent.** Read the actual changes — `git diff --stat`, then `git
   diff -- <file>` for specific files and `git diff -- <newfile>` (or open it)
   for untracked ones. Decide what each path *is* before deciding whether it
   belongs.
3. **Classify and select.** Sort every changed path into (a) the core
   deliverable that forms ONE logical change — implementation plus its tests and
   the docs/CHANGELOG/spec it fulfills — versus (b) out-of-scope edits or
   generated artifacts. Split unrelated concerns into separate commits. See
   `references/file-selection.md`.
4. **Exclude deliberately.** Leave generated, scratch, plan/spec, build,
   unrelated lock, agent-state (`.agents/`, `.claude/`, `.codex/`), and secret
   paths unstaged. A lockfile that records a dependency change needed by the
   selected commit is in-scope with the manifest; do not drop it just because it
   is a lockfile. When unsure whether a path is ignored, `git check-ignore -v
   <path>`. See `references/file-selection.md`.
5. **Stage explicitly.** `git add -- <path1> <path2> …` by full name. Avoid `git
   add .` / `-A` / globs in a dirty tree — they silently sweep in strays. For a
   file with mixed in-scope and out-of-scope hunks, `git add -p <file>`.
6. **Re-verify the staged set (mandatory gate).** Before committing, confirm
   what you are about to commit: `git diff --cached --name-only` (exact files),
   `git diff --cached --stat` (volume sanity), `git diff --cached` (read the
   hunks), `git diff --cached --check` (whitespace/line-ending errors). In-scope
   files present, out-of-scope/ignored files absent, diff matches intent. This
   2–3 second gate is the single highest-leverage habit; see
   `references/staging-and-recovery.md`.
7. **Decide amend vs. new.** Create a NEW commit by default. Only `--amend` to
   fix the immediately preceding, unpushed commit. See
   `references/history-and-trailers.md`.
8. **Compose the message.** Conventional Commits `type(scope): summary`
   (imperative, ≤72 chars) naming the outcome, blank line, then a body only when
   it preserves durable context the diff cannot recover. Detect
   the repo's trailer convention first: `git log -5 --format='%H%n%B'`.
9. **Transport the message safely.** For any multi-line body, use a heredoc
   (`git commit -F - <<'EOF' … EOF`, single-quoted delimiter) or `git commit -F
   <file>`. Add or repair authorship trailers with a `git commit ... --trailer
   'Key: value'` command — including `git commit --amend ... --trailer` or `git
   commit -C <ref> --trailer ...` for local rewrites — not by typing them into
   the body or a synthesized message payload. Never embed raw newlines in a
   single `-m`. See `references/history-and-trailers.md`.
10. **Post-verify the stored commit.** `git show -s --format=%B HEAD` confirms
    subject/body/trailer landed byte-correct and the trailer parsed as a footer;
    for newly added or repaired authorship trailers, also confirm the command
    path used `git commit ... --trailer`. For body messages, inspect the stored
    message for low-signal verification dumps and local-only proof-source
    leakage such as git-unmanaged local generated artifacts, ignored result
    files, local-only run IDs, or private tool-session records. `git show --stat
    HEAD` confirms the committed file set; `git status --short` confirms only
    intentionally-left files remain and nothing leaked.
11. **Recover reversibly if wrong.** Prefer the least-destructive fix:
    `git restore --staged <file>` to unstage, `git reset --soft HEAD~1` to undo
    a commit while keeping changes, `git commit --amend --no-edit --trailer …`
    to fix a just-made local commit. See `references/staging-and-recovery.md`.

## When the request is narrower

Not every invocation is a full "commit please." Jump to the relevant reference:

- "did I stage the right things?", "check what's staged", split a commit, drop a
  stray file → `references/staging-and-recovery.md`
- "this got committed and shouldn't have", undo/unstage, fix a wrong file set,
  recover lost work → `references/staging-and-recovery.md`
- fix the last commit, amend, reword, add/fix a `Co-Authored-By`, multi-line
  message corruption → `references/history-and-trailers.md`
- "what should I commit / leave out?", excluding generated or secret files →
  `references/file-selection.md`
- "commit the staged changes" → do not invent extra staging, but still run the
  mandatory staged-set gate before committing and the stored-commit verification
  after committing.
- "show the exact commit command" or "commit command only" → include the exact
  `git commit ...` invocation, but do not collapse the answer to that one line.
  The safe artifact is the command sequence: staged-set verification, commit
  command, then stored-message/file-set verification. Simple docs commits and
  trailer-only commits are not exempt.
- the user supplies `git status`, `git diff`, or `git log` excerpts → treat them
  as evidence, but still run or show the corresponding inspection commands in
  the sequence. Do not jump from supplied excerpts straight to staging,
  committing, amending, or splitting.
- a commit subject needs evidence → choose a concrete Conventional Commit
  subject before showing an executable `git commit`, or stop before the commit
  command. Use supplied user intent even when it is broad: a named feature, bug
  fix, module, or behavior change is enough for a conservative subject. Do not
  defer a usable broad subject to future diff output merely to make it more
  precise. If paths/status are the only evidence and no behavior or fix class is
  supplied, inspect `git diff` or `git diff --cached` first; in a response-only
  command plan, show that inspection step and omit `git commit` until a concrete
  subject can be written. A commit command block whose subject contains
  angle-bracket text, unresolved-marker words, or instructions to fill the
  subject later is still an invalid shown command even if prose says not to run
  it.
- partial staging is needed → verify both sides with file-specific diffs:
  `git diff --cached <file>` for the committed hunk and `git diff <file>` for
  the intentionally-left local hunk. Show both as explicit verification
  commands before committing; a prose note or `git status` is not a substitute.
- an amend/rebase would touch pushed history → name the concrete collaboration
  risk: other clones can diverge and collaborators may have to rebase, reset, or
  reconcile duplicated commits.
- a user-named path is absent from `git status` → check `git check-ignore -v
  <path>` before deciding. If it is ignored, especially local config or
  secret-like data, do not force-add it merely because the path was named; state
  that the requested scope cannot be fully committed without an explicit
  override after the ignore rule is known.

## Common mistakes

- `git add .` / `-A` / a glob in a dirty tree, sweeping in unrelated edits,
  generated output, lock files, or secrets.
- Committing immediately after `git add` without re-reading the staged diff.
- Force-adding or accidentally committing ignored/scratch content (eval
  workspaces, `plans/`, `.codex/`, `.env`).
- Committing a whole generated directory instead of just its durable spec
  (`evals/<name>/` vs. `evals/<name>/evals.json`).
- Multi-line message corruption from a single `-m` with embedded newlines, or a
  double-quoted heredoc that lets the shell expand `$`/backticks.
- Trailer corruption: trailers typed into the body, added through
  `git interpret-trailers --trailer` plus plumbing or a synthesized message
  file, dropped when rewording with `--amend -m` (re-add with `--trailer`),
  wrong capitalization, or a stray `Key: value` body line folding into the
  footer.
- Mixing unrelated concerns into one commit so blame, bisect, and revert get
  messy.
- Destructive recovery without a plan (`git reset --hard`, force-push) that
  loses work or rewrites shared history.

## Self-check

Before reporting the commit done:

- Does the staged set match the user-visible change, with no out-of-scope,
  generated, ignored, or secret files?
- Did you read `git diff --cached` (not just the file list) and run `--check`?
- Is the subject a Conventional Commit naming the outcome, with the body kept to
  context the diff cannot recover?
- Did you verify the **stored** commit (`git show -s --format=%B HEAD` and
  `git show --stat HEAD`), not just the command you ran?
- If a trailer was required, did it land as a parsed footer in the exact
  authorship form for the agent that wrote the commit and the repo's existing
  convention?
- If an authorship trailer was newly added or repaired, did the transport path
  use `git commit --trailer`, `git commit --amend ... --trailer`, or `git commit
  -C ... --trailer`, never a hand-edited footer, raw append, or plumbing-created
  message?
- Did anything outside the agreed scope get committed, pushed, or rewritten?
