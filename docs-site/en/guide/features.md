# Features

PiDeck brings together project management, session management, Git operations, and terminal access in a single desktop application.

## Multi-Project Workspace

Manage multiple local project directories in one window. Add, search, reorder, and switch between projects with ease. Each project gets its own isolated pi agent session.

## Session History & Restore

Never lose context. PiDeck saves every session, including:

- Full conversation history
- Tool calls and agent responses
- File changes made during the session
- Timestamps for every interaction

You can restore any previous session and continue where you left off. PiDeck also supports importing sessions from Claude Code and OpenAI Codex.

## Git Integration

The built-in Git panel provides a visual interface for common Git operations:

- **Branch display and switching** — See all branches at a glance.
- **File status** — Changes, staged files, and untracked files in a tree view.
- **Three-panel diff** — VS Code-style side-by-side comparison.
- **AI commit messages** — Generate meaningful commit messages automatically.
- **Branch graph** — Visualize your branch structure.
- **Cherry-pick / Revert / Reset / Drop** — Advanced Git operations with confidence.
- **Worktree support** — Manage multiple worktrees from the panel.

## File Editor

Edit files without leaving PiDeck:

- Up to 5 concurrent file tabs
- Monaco Editor (same engine as VS Code)
- Modal and drawer display modes
- Diff comparison with side-by-side view
- Markdown preview with live rendering
- Syntax highlighting for 50+ languages

## Built-in Browser

A full-featured browser embedded in the right drawer:

- Multi-tab browsing
- Fullscreen mode
- Device presets (PC / Mobile / Tablet)
- URL navigation bar

## Terminal Dock

Each agent gets its own terminal tab:

- **Agent-scoped** — The terminal is automatically in your project directory.
- **Multiple tabs** — Open terminals for different purposes.
- **Shell fallback** — PowerShell, cmd, or sh as available.
- **Theme switching** — Light and dark terminal themes.
- **Resizable** — Drag to resize the terminal height.
- **Right-click copy** — Quick copy from the terminal.

## Configuration Management

Visual editors for all settings:

- **Models** — Configure API endpoints, models, and parameters.
- **Auth** — Manage API keys and authentication.
- **Settings** — Global and project-level preferences.
- **Skills** — Enable, disable, and configure agent Skills.
- **Extensions** — Manage pi extensions visually.

## Slash Commands & Templates

Quick access to common actions:

- `/commit` — Generate a commit message from staged changes.
- `/explain` — Explain the selected code.
- `/test` — Generate tests for the selected code.
- `/review` — Review changes before commit.

## Cross-Platform

PiDeck runs on all major platforms:

- **Windows** — NSIS installer or portable zip
- **macOS** — DMG for Apple Silicon and Intel
- **Linux** — AppImage and deb packages
