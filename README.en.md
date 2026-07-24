# PiDeck

[中文文档](README.md) · [English](README.en.md) · [LinuxDO 友链](https://linux.do)

**A desktop workbench for managing multiple [pi](https://pi.dev) coding-agent sessions across project folders.**

![Status](https://img.shields.io/badge/status-experimental-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Electron](https://img.shields.io/badge/Electron-38-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![Version](https://img.shields.io/badge/version-0.6.6--beta.2-yellow)

**PiDeck** is an open-source pi desktop workbench for managing pi Agent sessions across local project folders, with import support for local Codex and Claude sessions so you can browse and restore them in one place. Built with Electron + TypeScript, it provides multi-project workspace management, AI session history, Git integration, built-in terminal, visual config management, and plugin extensions—so local AI coding assistants stay consistent, traceable, and configurable across projects.

**Who it's for:** Developers who want to manage multiple local-project AI coding assistant sessions from a desktop app, review session history and Git status in one place, and configure pi through visual editors instead of raw JSON files.

`PiDeck` is **not** a fork of pi. It is a lightweight Electron shell that orchestrates multiple `pi --mode rpc` processes, providing a native desktop UI for projects, sessions, conversations, configuration, and tool orchestration — all powered by pi's native agent capabilities.

---

## 📋 Changelog

> **Latest: v0.6.6-beta.1** (2026-07-22)

### v0.6.5 Updates
- 🚀 **Prompt Templates System**: Full template management, built-in templates,
  `/` picker with variable hints
- 🚀 **Prompt/Skill Store**: Search, preview, import from prompts.chat
  and Yao Open Prompts (121 Chinese prompts)
- 🚀 **Git Worktree Workspace**: Branch management, session grouping by worktree
- 🚀 **Multi-Select Messages**: Select, share, copy messages in batch
- 🚀 **Built-in Browser Preview**: Browse in the right drawer with tabs, fullscreen, and mobile viewport presets
- 🚀 **Session Manager**: Modal with multi-select delete, source filter
- 🚀 **External Editor Integration**: Right-click project → "Open with" → pick editor
- 🚀 **xhigh reasoning level** support
- ✨ Common MonacoEditor component, unified icon buttons, unified modal sizing
- 🐛 Windows startup crash fix (0x80000003)
- 🐛 Pi compaction restart disconnect fix, Extension RPC lifecycle fix
- 🐛 Interleaved thinking/tool/answer rendering, fragmented text rendering, dynamic showThinking
- 🔧 Session open performance optimization, IPC payload reduction, cleanup

[View Full Changelog →](CHANGELOG.md)

---

## Key Features

| Feature | Description |
|---|---|
| **Multi-Project Workspace** | Add, search, drag-sort, and switch between local project folders. Run multiple pi agents simultaneously with per-project isolation. |
| **Built-in Chat Workspace** | A fixed Chat entry at the top of the project list writes to the app user-data directory for general conversations that do not need a code project. |
| **Plan Mode** | Switch to Plan Mode from the composer toolbar — the agent generates a plan, executes step by step with confirmation, and returns to the menu on cancel. |
| **Message Edit/Delete** | Copy, edit, and delete AI responses and user messages; edited text is backfilled to the composer for re-sending. |
| **ScratchPad** | Overlay-style scratch pad with content preview, selection mapping, and theme-aware semantic colors. |
| **Content Width Restriction** | Draggable content width slider (unlimited by default, drag left to narrow) for long code lines or compact layouts. |
| **Configuration, Skill & Extension Management** | Visual editors for pi's `models.json`, `auth.json`, and `settings.json`, plus global Skill and Extension management. |
| **Extension Enable/Disable** | Disable/enable built-in extensions, project-level skill/extension management, distinguishing global vs project config. |
| **Trust Confirmation System** | Desktop-intercepted trust confirmation; untrusted projects can still be opened; projects with running agents cannot be deleted. |
| **Proxy Settings** | Manage pi agent process proxy and desktop proxy separately; model discovery and connection tests can use the desktop proxy. |
| **Slash Commands & `!` Shell** | Built-in slash command suggestions (`/reload`, `/compact`, `/session`, …) and `!command` / `!!command` for inline shell execution directly in the chat composer. |
| **Embedded Terminal Dock** | Agent-scoped terminal tabs with PowerShell/cmd/sh fallback, multiple tabs, theme switching, height resizing, right-click selection copy, and close-all confirmation. |
| **Session Management** | Create sessions, browse inline project history, restore historical sessions, rename, copy, export HTML, delete history, and close agents from the sidebar or context menus. |
| **Session Import** | Import local Codex and Claude sessions from the project context menu, then browse or restore them as PiDeck history sessions. |
| **Git Integration** | Real-time branch display with local + remote branch selector, branch count badge, switching support, and branch creation. |
| **LAN Web Service** | Start a local web service from Settings so devices on the same network can open PiDeck through the host IP and port. |
| **Session Activity View** | Thinking notes, tool calls, and answer updates are grouped into a compact flow with expandable/copyable details and clear status or exit-code labels. |
| **Built-in Browser Preview** | Right-drawer browser with tabs, URL bar, fullscreen mode, and PC/mobile/tablet viewport presets for checking web pages alongside the conversation. |
| **Session File Summary** | Completed agent runs show a compact list of modified file names and changed line counts; more than three files can be expanded. |
| **Context-Aware Input** | `@` file suggestions from project tree, `!` shell execution, `/` slash commands, and command history — all from a single composer. |
| **Update Prompt** | Periodically checks GitHub Releases and shows release notes plus recommended download links opened in the system browser. |
| **System Tray** | Close to tray by default, tray context menu, double-click to restore. |

---

## Screenshots

### Workspace & Conversation

![Workspace overview](docs/images/overview.png)

Markdown rendering with streaming text, activity flow, tool-call details, session file-change summary, model/thinking/context/cache status bar, git branch selector, and action controls (New Session · Stop · Restart · Files · History · Terminal).

### Configuration Management

![Configuration management](docs/images/config.png)

Visual editors for Models (provider cards + model grid), Auth (API key management), Settings (type-aware key-value), and raw JSON source file editing — with save-and-reload to hot-apply changes to running agents.

### Slash Commands & Session History

![Slash commands and session history](docs/images/slash-commands.png)

Built-in slash command suggestions panel with descriptions, alongside the session history drawer for browsing and restoring past conversations.

### File Tree & Session Actions

![File tree and session actions](docs/images/files.png)

Project file tree with Git status indicators, `@` file reference suggestions in the composer, current-session modified file list in the Files panel, and session context menu actions (Rename · Copy · Export HTML · Delete · Close Agent).

---

## Architecture

```txt
PiDeck
├─ Electron Main Process
│  ├─ Project record management
│  ├─ Spawns pi --mode rpc processes
│  ├─ Manages agent-scoped local pty terminals
│  ├─ Bridges file / session / git operations
│  ├─ Checks GitHub Releases for updates
│  └─ Exposes safe IPC APIs
│
├─ Electron Preload
│  └─ Exposes window.piDesktop to renderer
│
├─ React Renderer
│  ├─ Project & agent list
│  ├─ Chat timeline with streaming
│  ├─ File / history drawers
│  ├─ Configuration and Skill modal (Configuration / Skills)
│  ├─ Agent-scoped Terminal Dock
│  ├─ Model & context status bar
│  ├─ Session file-change summary and update prompt modal
│  └─ Settings UI (Basic / Proxy / Developer tabs)
│
└─ Pi Runtime
   ├─ One pi RPC process per agent tab
   ├─ Per-project cwd isolation
   └─ Native pi sessions / tools / models / context
```

Core design principle: **one agent tab = one pi RPC process**, keeping sessions isolated and letting pi own its native behavior.

---

## Requirements

- Node.js 20+
- npm
- `pi` command available in system `PATH`
- pi authentication configured (via `pi` / `/login` or API keys)

Verify pi is available:

```bash
pi --version
pi --mode rpc
```

---

## Download

Prebuilt packages for **Windows**, **macOS**, and **Linux** are published from tagged releases:

👉 **[GitHub Releases](https://github.com/ayuayue/PiDeck/releases)**

> PiDeck requires the `pi` CLI to be installed separately and available in your system `PATH`.

---

## Quick Start (from Source)

```bash
git clone https://github.com/ayuayue/PiDeck.git
cd pi-desktop
npm install
npm run make-icon
npm run dev
```

---

## Development

| Command | Description |
|---|---|
| `npm run dev` | Start dev mode |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run build` | Build renderer + main bundles |
| `npm run dist` | Package for current platform |
| `npm run dist:win` | Package for Windows (NSIS + portable + zip) |
| `npm run dist:mac` | Package for macOS (DMG + zip) |
| `npm run dist:linux` | Package for Linux (AppImage + deb + tar.gz) |
| `npm run make-icon` | Generate icon assets to `build/icon.svg` |

### Browser Preview Mode

Open `http://localhost:5173/` directly in a browser for layout and responsive checks. The renderer falls back to mock data when `window.piDesktop` is unavailable — useful for CSS/UI work without Electron. Real IPC features (agents, sessions, file ops) require the Electron app.

---

## Project Structure

```txt
src/
├─ main/
│  ├─ fs/                 # File tree service
│  ├─ git/                # Git branch service
│  ├─ pi/                 # Pi process & RPC manager
│  ├─ projects/           # Project persistence
│  ├─ sessions/           # Pi session scanning
│  ├─ settings/           # App settings persistence
│  ├─ terminal/           # Agent-scoped pty terminal sessions
│  └─ index.ts            # Electron main entry
│
├─ preload/
│  └─ index.ts            # Safe IPC bridge
│
├─ renderer/
│  └─ src/
│     ├─ App.tsx          # Main UI
│     ├─ components/      # Split UI components
│     ├─ config/          # Config modal tabs and helpers
│     ├─ previewApi.ts    # Browser preview fallback
│     ├─ styles.css       # App styling
│     └─ main.tsx         # React entry
│
└─ shared/
   ├─ ipc.ts              # IPC channel names
   └─ types.ts            # Shared DTOs
```

---

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) (English) or [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Chinese) for detailed version history.

---

## Contributors

Thank you to everyone who has contributed to PiDeck! See the full list in [CONTRIBUTORS.en.md](CONTRIBUTORS.en.md).

---

## QQ Community

Join the PiDeck QQ group for discussion and feedback:

**1026218644**

---

## Security

This app starts local `pi` processes and exposes limited file operations through Electron IPC. Only run from trusted source code. The app sends an anonymous, low-frequency `app_heartbeat` by default to understand version distribution, platform compatibility, and active installations; it can be disabled in Settings. It does not collect project paths, code, message content, session content, or file names, and it does not upload files. The third-party analytics service receives request metadata. pi agent process proxy and desktop model fetch/test proxy can be configured separately; external links opened in the system browser still follow the browser/system network settings.

## License

MIT
