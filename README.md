# pi-desktop

[中文文档](README.zh-CN.md) · [LinuxDO 友链](https://linux.do)

**A desktop workbench for managing multiple [pi](https://pi.dev) coding-agent sessions across project folders.**

![Status](https://img.shields.io/badge/status-experimental-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Electron](https://img.shields.io/badge/Electron-38-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![Version](https://img.shields.io/badge/version-0.3.0-green)

`pi-desktop` is **not** a fork of pi. It is a lightweight Electron shell that orchestrates multiple `pi --mode rpc` processes, providing a native desktop UI for projects, sessions, conversations, configuration, and tool orchestration — all powered by pi's native agent capabilities.

---

## Key Features

| Feature | Description |
|---|---|
| **Multi-Project Workspace** | Add, search, and switch between local project folders. Run multiple pi agents simultaneously with per-project isolation. |
| **Configuration Management** | Visual editors for pi's `models.json`, `auth.json`, and `settings.json` — manage providers, API keys, and model settings without touching JSON files manually. |
| **Slash Commands & `!` Shell** | Built-in slash command suggestions (`/reload`, `/compact`, `/session`, …) and `!command` / `!!command` for inline shell execution directly in the chat composer. |
| **Session Management** | Create new sessions, restore historical ones, rename sessions inline, export to HTML, and close agents — all from the sidebar or context menu. |
| **Git Integration** | Real-time branch display with local + remote branch selector, branch count badge, and switching support. |
| **Tool Call Visualization** | Grouped tool-call cards with summary and expandable details, clear status indicators for running/completed/failed calls. |
| **Context-Aware Input** | `@` file suggestions from project tree, `!` shell execution, `/` slash commands — all from a single composer. |
| **System Tray** | Close to tray by default, tray context menu, double-click to restore. |

---

## Screenshots

### Workspace & Conversation

![Workspace overview](docs/images/overview.png)

Markdown rendering with streaming text, tool-call details, model/thinking/context/cache status bar, git branch selector, and action controls (New Session · Stop · Reload · Restart).

### Configuration Management

![Configuration management](docs/images/config.png)

Visual editors for Models (provider cards + model grid), Auth (API key management), Settings (type-aware key-value), and raw JSON source file editing — with save-and-reload to hot-apply changes to running agents.

### Slash Commands & Session History

![Slash commands and session history](docs/images/slash-commands.png)

Built-in slash command suggestions panel with descriptions, alongside the session history drawer for browsing and restoring past conversations.

### File Tree & Session Actions

![File tree and session actions](docs/images/files.png)

Project file tree with Git status indicators, `@` file reference suggestions in the composer, and session context menu (Open · Export HTML · Close Agent).

---

## Architecture

```txt
pi-desktop
├─ Electron Main Process
│  ├─ Project record management
│  ├─ Spawns pi --mode rpc processes
│  ├─ Bridges file / session / git operations
│  └─ Exposes safe IPC APIs
│
├─ Electron Preload
│  └─ Exposes window.piDesktop to renderer
│
├─ React Renderer
│  ├─ Project & agent list
│  ├─ Chat timeline with streaming
│  ├─ File / history drawers
│  ├─ Configuration modal (Models / Auth / Settings / Source)
│  ├─ Model & context status bar
│  └─ Settings UI
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

👉 **[GitHub Releases](https://github.com/ayuayue/pi-desktop/releases)**

> pi-desktop requires the `pi` CLI to be installed separately and available in your system `PATH`.

---

## Quick Start (from Source)

```bash
git clone https://github.com/ayuayue/pi-desktop.git
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
│  └─ index.ts            # Electron main entry
│
├─ preload/
│  └─ index.ts            # Safe IPC bridge
│
├─ renderer/
│  └─ src/
│     ├─ App.tsx          # Main UI
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

## Security

This app starts local `pi` processes and exposes limited file operations through Electron IPC. Only run from trusted source code. The app sends no telemetry and uploads no files — all model/provider network behavior is handled by pi and your configured providers.

## License

MIT
