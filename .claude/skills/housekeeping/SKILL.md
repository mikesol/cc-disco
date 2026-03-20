---
name: housekeeping
description: Periodic repo gardening — commit/push loose files, prune stale docs, surface undocumented knowledge, and sync with upstream. Run when things feel messy or when prompted to "do housekeeping".
---

# Housekeeping

This skill is repo gardening: tidy the workspace, consolidate knowledge, and leave things cleaner than you found them. Work systematically through the steps below, committing progress as you go.

---

## Step 1: Git hygiene

```bash
git status
git diff --stat
```

- **Untracked files**: decide committed vs. gitignored.
  - Default: commit unless clearly transient (tmp files, screenshots mid-session, build artifacts, secrets).
  - If unsure: commit. Git history is cheap, lost knowledge is not.
- **Staged/modified files**: commit what makes sense as a logical unit. Don't batch unrelated changes into one commit.
- **gitignore**: if anything clearly shouldn't be tracked (logs, large caches, `.env`), add it to `.gitignore`.
- **Push**: after committing, `git push`.

---

## Step 2: Upstream sync

cc-disco forks can optionally maintain a clone of the upstream repo for syncing improvements and contributing back. Check CLAUDE.md for a configured upstream clone path.

**If an upstream clone exists:**
```bash
cd <upstream-clone-path>
git fetch origin
git log HEAD..origin/main --oneline   # what's new upstream?
```

If there are upstream changes:
1. Review them — are they relevant? Do they conflict with local customizations?
2. Pull them into the live fork:
   ```bash
   cd <live-repo-path>
   git remote add upstream <upstream-url>  # if not already added
   git fetch upstream
   git merge upstream/main
   ```
3. Resolve conflicts carefully — local customizations (CLAUDE.md, skills, data/) take precedence over upstream defaults unless upstream has a clearly better approach.
4. Commit the merge and push.

Also consider: if local improvements were made during this housekeeping session that would benefit other cc-disco instances, mention them as upstream contribution candidates.

**If no upstream clone is configured:**
Ask the user: "Would you like to set up an upstream clone? It lets you pull in improvements from the cc-disco community and contribute back. I can clone it to a scratch directory and configure it in CLAUDE.md."

If they say yes, clone the upstream repo to a suitable location (e.g. `~/scratch/cc-disco-upstream`), add the path and upstream URL to CLAUDE.md, and proceed with the sync.

---

## Step 3: Recent channel review

Look at Discord messages from the past ~24 hours across all channels to spot undocumented knowledge.

Use the Discord API (bot token and guild ID from CLAUDE.md / 1Password). Fetch recent messages from each channel in the configured guild.

For each message thread or conversation, ask:
- **Is this a recurring task or workflow?** → candidate for a new skill
- **Is this a fact about the world, a person, a service, or a codebase?** → candidate for CLAUDE.md or a knowledge file in the repo
- **Did something break or get fixed?** → candidate for a gotcha note in the relevant skill

Document anything worth keeping. Update CLAUDE.md or the relevant SKILL.md. If something clearly warrants its own skill, draft it.

---

## Step 4: Organizational reflection

Step back and look at the repo as a whole. The goal is to notice where organic growth has created mess — and fix it.

- **Knowledge consolidation**: is related information scattered across multiple files or skills? If so, merge or cross-reference.
- **Skills**: are any skills redundant, overlapping, or half-finished? Could two be merged into one tighter skill? Is there a skill that used to make sense but no longer reflects how things work?
- **Structure**: does the directory layout still make sense? Are there files or folders that feel out of place?
- **Pruning**: is there anything that simply shouldn't exist anymore — dead code, abandoned ideas, outdated knowledge files? Remove it.
- **Naming**: are things named clearly and consistently?

This step is judgment-driven, not checklist-driven. The question is: if someone came to this repo fresh today, would the layout feel coherent? If not, fix what you can and flag what needs a bigger conversation.

---

## Step 5: CLAUDE.md audit

Read CLAUDE.md from top to bottom. Check for:

- **Stale references**: file paths, URLs, credential IDs, channel IDs that may have changed
- **Outdated facts**: skills or infrastructure that no longer exist or have changed
- **Bloat**: sections that have grown accretive and incoherent — rewrite them tightly
- **Missing entries**: new skills, tools, or facts that should be indexed but aren't

Edit CLAUDE.md in place. Keep it light. It is an index and orientation guide, not a full manual.

---

## Step 6: Skills audit

For each skill in `.claude/skills/`:

- **Does it still work?** Compare the SKILL.md description against what you know about the current state of the tool/service.
- **Are credentials still accurate?** Check 1Password item IDs and field names referenced.
- **Are there gotchas missing?** If a skill has caused problems, document them.
- **Is the skill redundant?** If two skills overlap heavily, consider merging them.

If a skill is clearly obsolete, remove it and update CLAUDE.md.

---

## Step 7: Working files check

Look for any non-source files in the repo — state files, caches, logs, screenshots, build artifacts, downloaded content — and make sure each is handled correctly:

- **Should it be committed?** If it's meaningful persistent state (e.g. deduplication state, config), commit it.
- **Should it be gitignored?** If it's ephemeral or large, add it to `.gitignore`.
- **Should it be deleted?** If it has no ongoing purpose, remove it.

There's no assumed directory structure here — scan the whole repo.

---

## Step 8: Final commit and report

Commit any remaining changes:

```bash
git add -A
git commit -m "Housekeeping YYYY-MM-DD"
git push
```

Post a brief summary to the configured general/status channel (see CLAUDE.md) with:
- What was tidied (files committed, docs updated, etc.)
- Any new skills or knowledge added
- Upstream sync status
- Anything flagged that needs attention (conflicts you couldn't resolve, decisions you deferred, etc.)
