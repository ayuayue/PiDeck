# Usage Guide

This guide walks through the main features of PiDeck step by step.

## Workspace

The **left sidebar** is your project workspace. Here you can:

- **Add a project** — Click the + button or drag a folder into the panel.
- **Switch projects** — Click on a project to switch its session view. Each project maintains its own agent session.
- **Reorder projects** — Drag to reorder your project list.
- **Search projects** — Use the search bar to quickly filter projects.

## Session

The **center panel** is where you interact with the pi agent. Each project has its own session timeline.

### Composing a Message

The composer at the bottom supports several input modes:

| Feature | Example | Description |
|---------|---------|-------------|
| Text | Type your prompt | Normal chat |
| `@` reference | `@file src/index.ts` | Reference project files |
| `&` session | `&session-name` | Reference past session context |
| `!` shell | `!npm test` | Execute shell command |
| `/` slash | `/commit` | Quick actions |

### Message Queue

When the agent is generating a response, you can queue additional messages. They will be sent automatically once the agent is ready.

### Session History

Click the session button in the toolbar to open the session timeline. Here you can:

- Browse past conversations by date
- Restore a previous session
- Review tool calls and file changes

## File Drawer

The **right drawer** contains your project files. Toggle it with the file icon in the toolbar.

- Browse the project file tree
- See Git status indicators on files
- Open files in the built-in editor
- View session-scoped file changes

## Agent Tab

Each project gets its own pi RPC agent process. This means:

- **Isolation** — Work on one project doesn't affect another.
- **Parallel agents** — You can have multiple agents running simultaneously for different projects.
- **Independent context** — Each session maintains its own conversation history.
