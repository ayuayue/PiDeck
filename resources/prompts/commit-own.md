---
description: Commit only the files you modified yourself
---

Commit only the files and code that I modified myself. Do not stage or commit unrelated changes (e.g. files changed by others, pre-existing edits, generated files, lockfiles you did not touch).

Steps:
1. Run `git status --short` and `git diff` to inspect all changes.
2. Identify which changes belong to my own work.
3. Stage only those specific paths (`git add <file>...`), never a blanket `git add -A`.
4. Review the staged diff (`git diff --cached`) and confirm it matches my changes.
5. Write a conventional commit message and commit.

Format: `type(scope): description`
Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert
