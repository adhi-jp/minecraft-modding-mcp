# Message Transport, History Edits, and Trailers

This reference covers getting the message into git intact, choosing between a new
commit and an amend, and keeping authorship trailers correct. The message
*wording* belongs to a dedicated writing skill when one is available; this is
about the bytes git stores and the history operations around them.

## Amend vs. new commit

Default to a **new** commit. Reach for `--amend` only to fix the immediately
preceding commit that has not been pushed:

- New commit — the normal case, and the only option when HEAD has not moved past
  the branch base (nothing of yours exists to amend).
- `git commit --amend` — fold a fix into the last commit, reword its subject, or
  repair its trailer, **when that commit is unpushed**. Amending a pushed commit
  rewrites shared history; add a follow-up commit instead.

Check the amend-vs-new signal with
`git rev-list --left-right --count <base>...HEAD` — it prints two numbers,
`<behind>  <ahead>`; the second (right) number, your commits past base, is the
ahead count, and 0 ahead means amend is not applicable.

## Transport the message without corruption

Multi-line messages are where shell quoting silently mangles commits. Pick a
transport that preserves bytes:

```sh
# Heredoc — preferred for multi-line bodies.
# The SINGLE-QUOTED delimiter blocks $-expansion and backticks.
git commit -F - <<'EOF'
feat(scope): summary in imperative mood

Body paragraph explaining why the change exists and what it affects.
EOF

# Message file — equivalent, handy when the body is generated elsewhere.
git commit -F /tmp/commit_msg.txt

# Multiple -m — only for a few distinct SHORT paragraphs (each -m = one paragraph).
git commit -m 'fix(scope): summary' -m 'One-paragraph body.'
```

Pitfalls seen repeatedly:

- A single `-m` with embedded `\n` or raw newlines truncates or mangles the
  message. Use `-F`/heredoc for anything multi-line.
- Repeated `-m` flags for a bullet list split each bullet into its own
  paragraph, inserting blank lines between them. Keep bullets in one body block
  via `-F`/heredoc.
- A double-quoted heredoc delimiter (`<<EOF`) lets the shell expand `$VAR` and
  backticks inside the message. Single-quote it: `<<'EOF'`.
- Markdown code fences pasted into the message become literal bytes and
  contaminate the subject/body. Write the raw message; no fences.

Tooling tendency (from the data): Codex sessions leaned on multiple `-m` plus
`--trailer`; Claude Code sessions favored heredoc/`-F -` for the message body.
Both are fine for body transport. When the workflow adds or repairs an
authorship trailer, `--trailer` remains the required trailer transport, and the
stored message still gets verified afterward.

## Trailers: keep them a real footer

A trailer (`Co-Authored-By`, `Signed-off-by`) is only useful if git parses it as
a footer, not as body prose. For an agent-added or repaired authorship trailer,
the required transport is a `git commit ... --trailer` command:

```sh
git commit -m 'feat(scope): summary' --trailer 'Co-Authored-By: Name <email>'
git commit --amend --no-edit --trailer 'Co-Authored-By: Name <email>'
git commit -C "$old_commit" --trailer 'Co-Authored-By: Name <email>'
```

`--trailer` makes git place and format the footer correctly and is part of the
execution contract for authorship-trailer addition or repair. A footer block in
a heredoc, message file, or copied message text describes the stored message
shape; it is not a substitute transport when the workflow is adding or repairing
an authorship trailer.

Use `git interpret-trailers --parse` to verify stored messages. Do not use
`git interpret-trailers --trailer` to manufacture message text and then feed
that text into `git commit-tree -F`, a raw footer append, or a synthesized
message file. Those paths can produce a parseable footer while bypassing the
required `git commit --trailer` transport.

When you are inspecting or preserving an existing stored footer, the footer
shape still matters: a blank line after the prose, each trailer on its own
`Key: value` line, all last in the message.

Rules that prevent the common corruptions:

- **Exact token form.** It is `Co-Authored-By` (capital C/A/B, hyphenated) with
  the value `Name <email>` including angle brackets. `Co-authored` or a missing
  `<…>` is not recognized by git, `git blame`, or hosting platforms.
- **No stray `Key: value` ending the body.** A final single line like
  `Verification: passed` right before the trailers gets folded into the trailer
  block and corrupts parsing. End the body with bullets/prose and a blank line,
  then the trailers. If you have a verification section, make it a labeled block
  with bullets, not a one-liner:

  ```text
  Verification:
  - `pytest -q` passed.

  Co-Authored-By: Name <email>
  ```

- **Carry trailers forward when rewording.** `git commit --amend -m '…'`
  replaces the entire message, so it drops trailers already on the commit unless
  you re-add them. Use `--trailer` in the same command for any authorship
  trailer you are adding or repairing.
  `git commit --amend --no-edit` instead reuses the full stored message, trailers
  included, so they survive (and `--trailer` then only adds one):

  ```sh
  git commit --amend -m 'feat(scope): reworded summary' \
    --trailer 'Co-Authored-By: Name <email>'
  ```

- **Add trailers only when true.** Use `Co-Authored-By` for genuinely
  agent-authored or collaborative work; use `Signed-off-by` only when policy
  (e.g. DCO) requires it. Do not attach trailers reflexively to a trivial solo
  edit unless repo policy mandates it.

## Authorship trailer by agent and repo convention

Detect the repo's existing convention before committing and replicate it
exactly:

```sh
git log -5 --format='%H%n%B'   # see the precise trailer style already in history
```

Use the authorship trailer that matches the agent which actually authored the
commit, in that agent's exact form, and matching the repo's prior agent commits.
Two forms observed across sessions:

- Claude Code: `Co-Authored-By: Claude Opus 4.x (1M context) <noreply@anthropic.com>`
  — note the model name and the `(1M context)` qualifier and the anthropic.com
  no-reply address. Match the exact model string your environment specifies.
- Codex: `Co-Authored-By: Codex <noreply@openai.com>` — plain `Codex` and the
  openai.com no-reply address.

Pick the one for the agent that wrote the commit; do not invent a format, and do
not attribute the commit to an agent that did not write it.

## Repair an unpushed range without plumbing

Use this only for a simple, unpushed linear range. Do not rewrite pushed/shared
history, do not add duplicate trailers, and stop if a merge commit, conflict, or
metadata-preservation gap appears.

```sh
git status -sb
if ! git diff --quiet || ! git diff --cached --quiet ||
   test -n "$(git ls-files --others --exclude-standard)"; then
  echo "range repair requires a clean worktree, clean index, and no untracked files" >&2
  exit 1
fi

current_branch=$(git branch --show-current)
git for-each-ref --format='%(upstream:short)' "refs/heads/$current_branch"
```

If no upstream is configured, do not rely on `@{upstream}`. Use a concrete base
the user or repository state supplies, such as `origin/main`, and verify it is
an ancestor before listing the range:

```sh
base=origin/main
old_head=$(git rev-parse HEAD)
if ! git merge-base --is-ancestor "$base" "$old_head"; then
  echo "base is not an ancestor of the old head: $base" >&2
  exit 1
fi
git rev-list --reverse "$base".."$old_head"
```

Inspect existing parsed trailers before deciding which commits need the new
authorship trailer:

```sh
for old_commit in $(git rev-list --reverse "$base".."$old_head"); do
  printf '%s\n' "$old_commit"
  git show -s --format=%B "$old_commit" | git interpret-trailers --parse
done
```

When the requested rule is "add `Co-Authored-By: Codex <noreply@openai.com>` to
commits without any trailer", leave commits with any parsed trailer unchanged.
Do not add a second Codex trailer to a commit that already has one.

Replay on a repair branch with porcelain commands, then replace the original
unpushed branch only after verification:

```sh
git switch -c trailer-repair "$base"

for old_commit in $(git rev-list --reverse "$base".."$old_head"); do
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "replay state is dirty before $old_commit" >&2
    exit 1
  fi

  if git rev-list --parents -n 1 "$old_commit" | grep -q ' .* '; then
    echo "merge commit requires a separate plan: $old_commit" >&2
    exit 1
  fi

  trailers=$(git show -s --format=%B "$old_commit" | git interpret-trailers --parse)
  author_name=$(git show -s --format=%an "$old_commit")
  author_email=$(git show -s --format=%ae "$old_commit")
  author_date=$(git show -s --format=%aI "$old_commit")
  committer_name=$(git show -s --format=%cn "$old_commit")
  committer_email=$(git show -s --format=%ce "$old_commit")
  committer_date=$(git show -s --format=%cI "$old_commit")

  if ! git cherry-pick --no-commit "$old_commit"; then
    echo "cherry-pick failed; resolve through a separate plan: $old_commit" >&2
    exit 1
  fi
  git diff --cached --stat
  git diff --cached --check

  if test -z "$trailers"; then
    if ! GIT_COMMITTER_NAME="$committer_name" \
         GIT_COMMITTER_EMAIL="$committer_email" \
         GIT_COMMITTER_DATE="$committer_date" \
           git commit -C "$old_commit" \
             --author="$author_name <$author_email>" \
             --date="$author_date" \
             --trailer 'Co-Authored-By: Codex <noreply@openai.com>'; then
      echo "commit replay failed while adding trailer: $old_commit" >&2
      exit 1
    fi
  else
    if ! GIT_COMMITTER_NAME="$committer_name" \
         GIT_COMMITTER_EMAIL="$committer_email" \
         GIT_COMMITTER_DATE="$committer_date" \
           git commit -C "$old_commit" \
             --author="$author_name <$author_email>" \
             --date="$author_date"; then
      echo "commit replay failed while preserving existing trailer state: $old_commit" >&2
      exit 1
    fi
  fi
done
```

This preserves the tree changes through `git cherry-pick --no-commit`, reuses
the original message with `git commit -C`, preserves author and committer
metadata explicitly, and adds new Codex authorship trailers only through
`git commit ... --trailer`. If exact preservation and `--trailer` transport
conflict, stop and explain the conflict instead of falling back to
`git commit-tree`, `git interpret-trailers --trailer`, or raw footer editing.

Verify before moving the original branch name:

```sh
git range-diff "$base".."$old_head" "$base"..HEAD
for new_commit in $(git rev-list --reverse "$base"..HEAD); do
  git show -s --format='%H%n%an <%ae> %aI%n%cn <%ce> %cI%n%B' "$new_commit"
  git show -s --format=%B "$new_commit" | git interpret-trailers --parse
done

if test "$(git rev-parse "$current_branch")" != "$old_head"; then
  echo "original branch moved; stop before repointing: $current_branch" >&2
  exit 1
fi
git branch -f "$current_branch" HEAD
git switch "$current_branch"
```

If the original branch moved, the range was not fully unpushed, or verification
shows duplicate trailers or metadata drift, stop before repointing the branch.

## Always verify the stored message

The command you ran is not proof of what git stored. Confirm the actual artifact:

```sh
git show -s --format=%B HEAD        # full stored subject + body + footer
git log -1 --format=full           # author, committer, and message
git interpret-trailers --parse <<<"$(git show -s --format=%B HEAD)"  # did trailers parse?
git show --stat HEAD               # committed file set
```

If the stored message is wrong — trailer in the body, dropped footer, mangled
newlines — fix it with `git commit --amend` (re-including trailers) while the
commit is still local, then verify again.

## Compact message rules (fallback when no writing skill is available)

When no dedicated writing skill is available, keep the message usable with
these minimums (an available writing skill's commit-message guidance is the
fuller authority):

- Subject: `type(scope): outcome`, imperative, ≤72 chars, naming the behavior or
  contract that changed — not the editing act.
- No placeholder commit commands. A `git commit` command is allowed only when
  every subject byte is final. Use supplied semantic intent even when it is
  broad; broad and concrete is better than a template. Paths and status output
  can identify type, scope, and file set, but they do not by themselves name the
  outcome. If no behavior or fix class is supplied, read the diff first or stop
  before `git commit`; in response-only command plans, show the
  `git diff -- <path>` or `git diff --cached <path>` inspection step and omit the
  commit command until a concrete subject can be written. A command block or
  heredoc whose subject contains angle-bracket text, unresolved-marker words, or
  instructions to fill the subject later is a shown placeholder command even if
  surrounding prose says not to execute it.
- Body only when it adds durable value the diff cannot recover: the triggering
  failure or review finding, the public/CLI/schema contract, a rejected
  alternative, an accepted risk or non-goal, or verification that changes review
  confidence. Skip file-by-file inventories.
- Verification lines are selected proof, not a session command transcript. Keep
  exact commands when they are useful rerun or audit anchors such as tests,
  builds, type/lint checks, schema or metadata validation, migration dry runs,
  security/privacy/data-loss checks, release/package checks, or checks tied to a
  changed public contract. Summarize long ad hoc predicates or groups of
  equivalent probes when their durable meaning is clearer than the exact bytes.
  Omit search/string-presence probes, file-list checks, and metadata checks that
  only restate diff-visible changes unless they prove a non-obvious cross-file,
  generated, packaging, release, or registration contract.
- Small/mechanical changes (lock bumps, generated syncs) are often
  subject-only.
- Keep durable references (issue IDs, error codes, commands, committed paths,
  SHAs); drop local-only provenance (private branch names, temp paths, session
  labels). Git-unmanaged local generated artifacts, ignored result files,
  temporary run output, local-only run IDs, and private tool-session records are
  not durable proof. Translate them into a stable command, durable outcome, or
  explicit absence status such as `raw local report not committed`, `benchmark
  not durably recorded`, or `not measured`.
