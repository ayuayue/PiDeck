# Contributing

Thanks for your interest in contributing to PiDeck.

## Development Setup

Node 24.x with **npm 11.x**. `.npmrc` sets `engine-strict=true` because the npm major version
changes how the lock file is written, and other versions silently rewrite `package-lock.json`.

The failure on npm 12 is misleading: it claims `npm ci` is out of sync with the lock file and
reports `Missing: @emnapi/runtime@1.11.3 from lock file`. The lock file is fine — that is npm 12
resolving optional peers differently. Use the versions above.

```bash
npm install
npm run make-icon
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm run build
```

## Guidelines

- Keep pi itself responsible for agent behavior, tools, sessions, model calls, and context management.
- Prefer RPC integration over reimplementing pi internals.
- Avoid directly mutating pi session JSONL files.
- Keep Electron IPC narrow and typed through `src/shared`.
- Add comments for non-obvious business logic, boundary cases, and process/session state transitions.

## Commit Style

Use clear, conventional-style commits where possible:

```txt
feat: add session status bar
fix: restore active agent when switching projects
chore: update docs
```
