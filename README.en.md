# PiDeck

[中文文档](README.md) · [English](README.en.md) · [LinuxDO 友链](https://linux.do)

**An open-source desktop workbench for managing multiple [Pi](https://pi.dev) and [DSH](https://github.com/deepseek-ai/deepseek-harness) coding-agent sessions.**

![Status](https://img.shields.io/badge/status-experimental-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Electron](https://img.shields.io/badge/Electron-38-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![Version](https://img.shields.io/badge/version-0.7.3-blue)

<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg">
  <img alt="Star history" src="assets/star-history/star-history-light.svg">
</picture>
<!-- star-history:end -->

![PiDeck workspace overview](docs/images/readme/hero.png)
![PiDeck workspace settings](docs/images/readme/setting.png)

---

## What is PiDeck

**PiDeck** is an open-source desktop workbench for pi and DSH that manages pi Agent sessions across local project folders, with import support for local Codex and Claude sessions so you can browse and restore them in one place. Built with Electron + TypeScript, it provides multi-project workspace management, AI session history, Git integration, built-in terminal, visual config management, and plugin extensions — so local AI coding assistants stay consistent, traceable, and configurable across projects.

**Who it's for:** Developers who want to manage multiple local-project AI coding assistant sessions from a desktop app, review session history and Git status in one place, and configure pi through visual editors instead of raw JSON files.

`PiDeck` is **not** a fork of pi. It is a lightweight Electron shell that orchestrates multiple `pi --mode rpc` processes, providing a native desktop UI for projects, sessions, conversations, configuration, and tool orchestration — all powered by pi's native agent capabilities, with session files read and written natively by pi. Beyond pi, PiDeck also deeply integrates the **DSH (DeepSeek Harness)** backend — see [DSH Backend](#-dsh-backend).

---

## 📑 Table of Contents

- [PiDeck](#pideck)
  - [What is PiDeck](#what-is-pideck)
  - [📑 Table of Contents](#-table-of-contents)
  - [✨ Highlights](#-highlights)
  - [📋 Changelog](#-changelog)
    - [v0.7.3 Release Highlights](#v073-release-highlights)
  - [🧩 Features](#-features)
    - [Workspace & Projects](#workspace--projects)
    - [Sessions & Conversation](#sessions--conversation)
    - [Files · Git · Terminal](#files--git--terminal)
    - [Models & Configuration](#models--configuration)
    - [Extensions & Ecosystem](#extensions--ecosystem)
    - [Desktop & System Integration](#desktop--system-integration)
  - [🐳 DSH Backend](#-dsh-backend)
  - [🏗️ How It Works](#-how-it-works)
  - [📦 Download](#-download)
  - [🧰 Quick Start (from Source)](#-quick-start-from-source)
  - [❓ FAQ](#-faq)
  - [🧑‍💻 Development](#-development)
    - [Browser Preview Mode](#browser-preview-mode)
    - [Project Structure](#project-structure)
  - [🤝 Contributing](#-contributing)
  - [💬 Community](#-community)
  - [🔒 Security & Privacy](#-security--privacy)
  - [☕ Sponsor](#-sponsor)
  - [License](#license)

---

## ✨ Highlights

- 🖥️ **Multi-project, multi-session in parallel** — manage every agent session across your local projects from one window, fully isolated per project.
- 🔌 **Three session backends** — pi, DSH (DeepSeek Harness), and Image Generation side by side, freely switchable within the same project.
- 🧠 **Context-aware composer** — `@` file references, `/` slash commands, and `!` shell execution, all in one input box.
- 🗂️ **Sessions as assets** — browse and restore history, import Codex / Claude sessions, one-click HTML export.
- 🛠️ **Visual configuration** — edit pi's `models.json` / `auth.json` / `settings.json` without hand-writing JSON, with one-click connection tests.
- 📊 **Usage at a glance** — provider balance/quota queries plus local session usage stats (heatmap, daily/model/project breakdowns).
- 🧰 **The full workbench** — file tree, Git panel, built-in terminal, built-in browser, scratchpad — no window juggling.
- 🐾 **Delightful desktop integration** — desktop pet, theme switching, system tray, Feishu bot, LAN web access.

---

## 📋 Changelog

> **Latest: v0.7.3** (2026-09-03)

### v0.7.3 Release Highlights
- 🚀 **Chat session archives**
- 🚀 **Active tab always in view**
- 🚀 **Refined default-model priority**
- 🚀 **DSH runtime: dev uses project deps, packs stay lean**
- 🚀 **Rewind checkpoints**
- 🚀 **Import DSH runtime from a folder**
- 🚀 **Automatic session titles**
- 🚀 **Idle agent auto-release**
- 🚀 **Usage rows stay put, model cards get denser**
- 🚀 **Feedback reports include project context**
- 🚀 **Ask notifications jump to the session**
- 🚀 **Deep links into config backends**
- ✨ **Refresh stale projects**
- ✨ **Selected-state backgrounds restored**
- ✨ **Dev no longer prompts to download DSH runtime**
- ✨ **DSH runtime install no longer blocks the main process**

[View Full Changelog →](CHANGELOG.md)

---

## 🧩 Features

### Workspace & Projects

| Feature | Description |
|---|---|
| **Multi-Project Workspace** | Add, search, drag-sort, and switch between local project folders. Run multiple pi agents simultaneously with per-project isolation. |
| **Built-in Chat** | A fixed Chat entry at the top of the project list writes to the app user-data directory for general conversations that do not need a code project. |
| **Session Bootstrap Page** | Preselect model and thinking level when creating a session, with `@` file references — ready to chat out of the box. |
| **Trust Confirmation System** | Desktop-intercepted trust confirmation; untrusted projects can still be opened; projects with running agents cannot be deleted. |

### Sessions & Conversation

| Feature | Description |
|---|---|
| **Dual Agent Backends (pi / DSH)** | Create pi or DSH sessions under the same project and switch between them freely — see [DSH Backend](#-dsh-backend) below. |
| **Image Generation Mode** | A standalone image-generation backend (OpenAI-compatible `/images/generations`; OpenAI / Volcengine / SiliconFlow, etc.), switchable inside a session. |
| **Plan Mode** | Switch to Plan Mode from the composer toolbar — the agent generates a plan, executes step by step with confirmation, and returns to the menu on cancel. |
| **Ask Parallel Queries** | Spin up standalone background query sessions that run in parallel, optionally carrying the main-session context, with one-click quoting back into the main composer. |
| **Session Activity View** | Thinking notes, tool calls, and answer updates are grouped into a compact flow with expandable/copyable details and clear status or exit-code labels. |
| **Answer-level File Summary** | Each completed answer lists the files modified in that turn with changed line counts; the Files panel keeps the whole-session overview. |
| **Todo Bar** | A persistent agent task list above the composer — pending / in-progress / done at a glance. |
| **Message Edit/Delete** | Copy, edit, and delete AI responses and user messages; edited text is backfilled to the composer for re-sending. |
| **Session Management** | Create, rename, copy, export HTML, delete history, restart & reload, close agents — from the sidebar or context menus. |
| **Session Import** | Import local Codex and Claude sessions from the project context menu, then browse or restore them as PiDeck history sessions. |
| **Ruler Rail** | A right-edge ruler maps timeline positions so you can jump to any message in long sessions. |
| **Content Width Restriction** | Draggable content width slider (unlimited by default) for long code lines or compact layouts. |

### Files · Git · Terminal

| Feature | Description |
|---|---|
| **File Drawer** | Project file tree with Git status indicators and a built-in file editor; the Files panel keeps the current-session modified file list. |
| **External Editor Integration** | "Open in Editor / Reveal in File Manager" auto-detects the system file manager and scans JetBrains IDE directories. |
| **Git Integration** | Real-time branch display with local + remote branch selector, branch count badge, switching, and branch creation. |
| **Embedded Terminal Dock** | Agent-scoped terminal tabs with PowerShell/cmd/sh fallback, multiple tabs, theme switching, height resizing, right-click selection copy, and close confirmation. |

### Models & Configuration

| Feature | Description |
|---|---|
| **Visual Config Management** | Visual editors for pi's `models.json`, `auth.json`, and `settings.json`: provider cards + model grid + type-aware key-value editing + raw JSON source editing, with save-and-restart to apply changes. |
| **Connection Tests** | One-click provider connection tests; model validation no longer misreports config fallback as success. |
| **Model Capability Auto-adaptation** | Compatible with pi 0.84.3: context window / maxTokens / thinking levels adapt to endpoint-reported values, with manual model catalog refresh so new models are never invisible. |
| **Usage Queries** | Provider balance/quota queries (built-in templates for OpenRouter, Moonshot-Kimi, and generic OpenAI-compatible gateways; multi-account and per-provider endpoints supported), shown on cards with custom probe configs. |
| **Usage Statistics** | Local statistics powered by the usage-stats plugin: cumulative overview, activity heatmap, daily usage, and model/project breakdowns. |
| **Proxy Settings** | Separate proxies for the pi agent process and the desktop app; model discovery and connection tests can use the desktop proxy. |

### Extensions & Ecosystem

| Feature | Description |
|---|---|
| **Config, Skill & Extension Management** | Visual management for global skills and extensions, enable/disable built-in extensions, global vs project-level config. |
| **Prompt & Skill Store** | prompts.chat store + skills.sh community skill store — search online, view details, install with one click. |
| **Chinese Prompt Library** | Built-in XuePrompt database (4000+ Chinese prompts) with categories, search, pagination, and one-click import to local templates. |
| **Built-in Extensions** | Batteries included: `pi-deck-retry-no-body` (auto-retry on empty responses), an image-generation skill template, and more. |
| **Vision Bridge** | Give non-vision models eyes: images are first converted to text descriptions by a vision model; model/endpoint/key are configurable in Settings. |

### Desktop & System Integration

| Feature | Description |
|---|---|
| **System Tray** | Closing the window minimizes to tray by default; tray context menu; double-click to restore. |
| **Desktop Pet** | Turn multi-agent status into a little companion on your desktop: aggregated states, always-on-top, scaling, petdex community pets. |
| **Themes & Appearance** | One-click cycle through light / dark / follow-system (sidebar footer); semantic design tokens with natural dark-mode support. |
| **Notifications** | Global notifications as card toasts; a dedicated Ask system-notification toggle keeps background queries silent. |
| **Proactive Update Prompt** | The app and Pi CLI check for updates every 2 hours in the background; new versions show a badge dot + update dialog (once per version, skippable), with current → latest shown in Settings. |
| **Feishu Bot** | Bind a session to a Feishu bot to sync messages and status into a Feishu group. |
| **LAN Web Service** | Start a local web service from Settings and open the web edition from any device on the LAN, with dual-backend session browsing and the DSH tool panel. |
| **Process Monitor / Log Management** | Built-in process monitoring and cache/log management in Settings — no more digging through directories. |

---

## 🐳 DSH Backend

Beyond pi, PiDeck deeply integrates **DSH (DeepSeek Harness, DeepSeek's official Agent Harness)**: pi and DSH sessions coexist under the same project and can be browsed side by side, with pi / DSH badges on session rows and headers.

- **Zero-port deep fusion** — the DSH host runs embedded in a utilityProcess: no `dsh web`, no listening ports, no background HTTP; lazy startup never slows app launch.
- **Full session capabilities** — paginated history, fork (branch from an anchor with the fork-point text backfilled into the composer), `/compact` context compression; sessions restore automatically after an app restart.
- **Approval & question bridge** — DSH approval requests and questions are answered through the desktop Ask dialog, matching the pi session experience.
- **DSH configuration page** — the DSH tab in Settings: schema-driven visual editors for settings/credentials, host-level model catalog, host status & restart.
- **Skill catalog & command completion** — the session tool panel lists invokable DSH skills (call them with `/name`), and the composer `/` menu enumerates host-registered commands in real time (including user/plugin ones).
- **Usage queries & export** — the same provider usage display as the pi side, with credentials read from DSH's official credential store; history sessions export to self-contained HTML.

**To enable:** finish configuration in the DSH tab of Settings, then choose the DSH backend when creating a session.

---

## 🏗️ How It Works

```txt
PiDeck
├─ Electron Main Process
│  ├─ Manages project records
│  ├─ Spawns one pi --mode rpc process per agent session
│  ├─ Embeds the DSH host (utilityProcess — no ports, no background HTTP)
│  ├─ Manages agent-scoped local pty terminals
│  ├─ Bridges file / session / git operations
│  ├─ Checks for app and Pi CLI updates
│  └─ Exposes minimal, validated, safe IPC APIs
│
├─ Electron Preload
│  └─ Exposes window.piDesktop to the renderer via contextBridge
│
├─ React Renderer
│  ├─ Project / session lists and the streaming chat timeline
│  ├─ File / history / Git / browser drawers
│  ├─ Config management / skill store / prompt library
│  ├─ Agent-scoped Terminal Dock
│  ├─ Model & context status bar
│  └─ Settings UI (General / Appearance / Proxy / Web Service / Desktop Pet / Vision Bridge / Image Gen, etc.)
│
└─ Pi Runtime
   ├─ One independent pi RPC process per agent session
   ├─ Per-project cwd isolation
   └─ Native pi sessions / tools / models / context
```

Core design principle: **one agent session = one pi RPC process**, keeping sessions isolated and letting pi own its native behavior; PiDeck and pi communicate only over stdio JSON-RPC. The DSH backend runs embedded in a utilityProcess and likewise introduces no extra network ports.

---

## 📦 Download

Prebuilt packages for **Windows**, **macOS**, and **Linux** are published on GitHub Releases:

👉 **[GitHub Releases](https://github.com/ayuayue/PiDeck/releases)**

> PiDeck requires the `pi` CLI to be installed separately and available in your system `PATH`.

Requirements:

- `pi` command available in system `PATH`
- pi authentication configured (Provider / login / API keys)

Verify pi is available:

```bash
pi --version
pi --mode rpc
```

---

## 🧰 Quick Start (from Source)

```bash
git clone https://github.com/ayuayue/PiDeck.git
cd PiDeck
npm install
npm run make-icon
npm run dev
```

Requirements: Node.js 20+, npm.

---

## ❓ FAQ

**Q: What is the relationship between PiDeck and pi? Does PiDeck modify my session files?**

A: PiDeck is a desktop shell for pi (not a fork): agent behavior, tool calls, session I/O, and model calls are all handled natively by pi, while PiDeck takes care of the "framework" layer — window management, process lifecycle, session browsing, the Git panel, terminal, and settings — communicating over stdio JSON-RPC only. pi / DSH sessions are still read and written natively by their own backends, and PiDeck never changes the original session format. Imported Codex / Claude sessions become PiDeck history copies and leave the original files untouched.

**Q: PiDeck says it cannot find pi on startup?**

A: PiDeck relies on the `pi` command being available in your system `PATH`. Run `pi --version` in a terminal first; if it is not available, install the pi CLI and configure a provider / API key before starting PiDeck.

**Q: Which models are supported? Where do I configure them?**

A: Model capabilities are entirely determined by pi's configuration. PiDeck ships visual editors for `models.json` / `auth.json` / `settings.json` with connection tests; the DSH backend uses DeepSeek models, and Image Generation mode uses separately configured image providers (OpenAI / Volcengine / SiliconFlow, etc.).

**Q: What is DSH? How do I enable it?**

A: DSH (DeepSeek Harness) is DeepSeek's official Agent Harness, deeply integrated by PiDeck — see the [DSH Backend](#-dsh-backend) section for the capability list. Finish configuration in the DSH tab of Settings, then choose the DSH backend when creating a session.

**Q: Does it collect my data?**

A: The app sends an anonymous, low-frequency `app_heartbeat` usage statistic by default (can be disabled in Settings) to understand version distribution and platform compatibility. It never collects project paths, code, message content, session content, or file names, and never uploads files.

**Q: How do I report issues?**

A: Join the QQ group at the bottom of this page, or file an issue on [GitHub Issues](https://github.com/ayuayue/PiDeck/issues); you can export logs from Settings when troubleshooting.

---

## 🧑‍💻 Development

| Command | Description |
|---|---|
| `npm run dev` | Start dev mode |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run test` | Run the full unit test suite (node --test) |
| `npm run build` | Build renderer + main bundles |
| `npm run pack` | Quick package (--dir, for verification) |
| `npm run dist` | Package for the current platform |
| `npm run dist:win` | Package for Windows (NSIS + portable + zip) |
| `npm run dist:mac` | Package for macOS (DMG + zip) |
| `npm run dist:linux` | Package for Linux (AppImage + deb + tar.gz) |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run docs:dev` | Preview the docs-site locally |
| `npm run make-icon` | Generate icon assets to `build/icon.svg` |

### Browser Preview Mode

Open `http://localhost:5173/` directly in a browser for layout and responsive checks. The renderer falls back to mock data when `window.piDesktop` is unavailable — useful for CSS/UI work without Electron. Real IPC features (agents, sessions, file ops) require the Electron app.

### Project Structure

```txt
src/
├─ main/              # Electron main process (the only layer with Node access)
│  ├─ pi/             # pi RPC process management & message parsing
│  ├─ sessions/       # Session scanning, import, SessionRuntimeCoordinator
│  ├─ git/            # GitService (status/diff/commit, etc.)
│  ├─ prompts/        # Local templates + XuePrompt Chinese prompt library
│  ├─ skills/         # SkillManager
│  ├─ extensions/     # ExtensionManager
│  ├─ settings/       # SettingsStore + DesktopProxy
│  ├─ terminal/       # node-pty terminal sessions
│  ├─ pet/            # Desktop pet
│  ├─ feishu/         # Feishu integration
│  ├─ web/            # LAN web service
│  ├─ ipc/            # Per-domain IPC handler registration
│  └─ index.ts        # Main process entry (assembly only)
│
├─ preload/           # Restricted IPC API via contextBridge
│
├─ renderer/
│  └─ src/
│     ├─ atoms/          # Jotai state (session-first)
│     ├─ components/     # session / sidebar / workspace / ui-shadcn, etc.
│     ├─ hooks/          # Renderer hooks
│     ├─ i18n/           # Copy (zh-CN / en-US)
│     └─ styles/         # Domain-split styles + semantic tokens
│
└─ shared/            # Shared types & IPC channel definitions
```

See [AGENTS.md](AGENTS.md) for architecture conventions, and read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

---

## 🤝 Contributing

All kinds of contributions are welcome: bug reports, feature ideas, documentation improvements, and code PRs.

- Please search for existing issues before filing a new one;
- Code PRs should follow the repo's architecture conventions and commit guidelines — see [CONTRIBUTING.md](CONTRIBUTING.md).

Thank you to everyone who has contributed to PiDeck! See the full list in [CONTRIBUTORS.en.md](CONTRIBUTORS.en.md).

---

## 💬 Community

Join the PiDeck QQ group for discussion and feedback:

**1026218644**

---

## 🔒 Security & Privacy

This app starts local `pi` processes and exposes limited file operations through Electron IPC. Only run from trusted source code. The app sends an anonymous, low-frequency `app_heartbeat` by default to understand version distribution, platform compatibility, and active installations; it can be disabled in Settings. It does not collect project paths, code, message content, session content, or file names, and it does not upload files. The third-party analytics service receives request metadata. pi agent process proxy and desktop model fetch/test proxy can be configured separately; external links opened in the system browser still follow the browser/system network settings.

---

## ☕ Sponsor

If PiDeck is useful to you, you can buy the author a coffee. Scan the WeChat Pay QR code below to tip. Thank you.

<p align="center">
  <img src="docs/images/wechat_pay.png" alt="WeChat Pay tip QR code" width="280" />
</p>

## License

MIT
