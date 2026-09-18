# Agent Instructions

These instructions apply to every AI agent (GitHub Copilot CLI, Claude Code, Codex CLI, etc.)
working in this repository. Read this file before making any changes.

## Worktree layout

- All git worktrees for this repo live under `jevRouter.worktrees/` (sibling of this checkout).
- `jevRouter.worktrees/jevRouter-master` always tracks the latest `origin/master`.
- **Never modify or work in `jevRouter-master`.** It exists only as a clean, up-to-date
  reference checkout (e.g. to diff against, or for the user to manually verify a feature).

## Starting feature work

1. Update the master reference first: `git -C <path-to-jevRouter-master> pull --ff-only`.
2. Create a new worktree with a new branch spun out of the latest `origin/master`:
   ```
   git worktree add ../jevRouter.worktrees/jevRouter-<feature> -b <you>/<feature> origin/master
   ```
3. Do all work for that feature inside that new worktree only. Never make changes directly
   in `jevRouter-master` or in another feature's worktree.

## Git operations

- Use **WSL only** for git commands (clone, fetch, pull, push, worktree, commit, etc.).
  Do not run git from PowerShell/cmd — WSL holds the correct git credentials.
  Windows-native paths (`C:\...`) still work for editing files; just run `git` itself from WSL,
  e.g. `wsl git status` or a WSL shell, using the `/mnt/c/...` path to the worktree.

## Before writing code

- First write a short plan covering the change, the tests you'll run/add, and the edge cases
  you'll verify. Do this before editing files.

## After making a change

- Run the tests and every edge case listed in the plan. Don't consider the work done until
  they pass.

## Cross-platform / cross-CLI support

- Feature work must keep working for both **Claude Code CLI** and **Codex CLI**, and on
  both **Windows** and **macOS**. Avoid platform- or CLI-specific assumptions unless the
  feature is explicitly scoped to one.

## When a feature is done

- Output a manual test command/procedure for the user, stating exactly what to run and what
  to check in both `jevRouter-master` and `jevRouter-<feature>` so the user can compare and
  verify the difference themselves.
