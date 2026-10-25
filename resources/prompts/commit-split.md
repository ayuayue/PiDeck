---
description: Commit all changes split by feature
---

Commit all current changes, splitting them into multiple commits grouped by feature or concern. Each commit must be self-contained and serve a single purpose.

Steps:
1. Run `git status --short` and `git diff` to list every change.
2. Group the changed files into logical, independent units (one feature / fix / refactor / chore per group).
3. Commit each group separately, so no commit mixes unrelated changes.
4. Order commits sensibly: foundational or refactor work first, then features and fixes, then docs and chore last.
5. For each group: `git add` only its files, review `git diff --cached`, then commit with a conventional message.

Format: `type(scope): description`
Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert
