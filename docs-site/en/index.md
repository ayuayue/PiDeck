---
layout: home

hero:
  name: PiDeck
  text: Desktop Workbench for pi AI Coding Agents
  tagline: Manage local pi coding assistant sessions, configs, Git, and terminal in a unified desktop workspace for Windows, macOS, and Linux.
  actions:
    - theme: brand
      text: Download Latest
      link: https://github.com/ayuayue/PiDeck/releases
    - theme: alt
      text: Get Started
      link: /en/guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/ayuayue/PiDeck

features:
  - title: Multi-Project Workspace
    details: Add, search, drag-sort, and switch local project folders. Run multiple pi agents simultaneously with per-project isolation.
  - title: Session History & Restore
    details: Restore previous conversations, browse tool calls and answers by timeline, and review file changes in past sessions. Import Codex and Claude sessions.
  - title: Git Integration
    details: Real-time branch display, VS Code-style 3-panel view (Changes/History/Compare), AI commit summaries, branch graph, cherry-pick/revert/reset/drop, and worktree support.
  - title: Session Reference (&)
    details: Type & in composer to search and reference past sessions across the same project. Inject full context or select specific messages.
  - title: Message Queue
    details: Queue prompts while agent is busy. Retract queued messages back to input for editing. Follow-up and steer modes.
  - title: Multi-Tab File Editor
    details: Up to 5 concurrent file tabs with Monaco Editor. Modal/drawer dual display mode. Diff comparison with side-by-side view.
  - title: Built-in Browser
    details: Multi-tab right-drawer browser with fullscreen mode, device presets (PC/Mobile/Tablet), and URL navigation.
  - title: Built-in Terminal Dock
    details: Agent-scoped terminal tabs with PowerShell/cmd/sh fallback, multiple tabs, theme switching, height resizing, and right-click copy.
  - title: Cross-Platform
    details: Windows, macOS, and Linux installers via GitHub Releases. Source install supported via npm.
---

<figure class="home-showcase">
  <img src="/images/overview.png" alt="PiDeck workspace and conversation UI">
  <figcaption>Workspace, sessions, file drawer, Git branches, and tool calls — all in one desktop window.</figcaption>
</figure>

## A Desktop Console for Local Development

`PiDeck` is not a fork of pi. It is a lightweight Electron shell that launches multiple `pi --mode rpc` processes, then unifies project management, session management, config management, and desktop interaction. Agent capability still comes from native pi.

<div class="info-strip">
  <div>
    <strong>One Agent Tab</strong>
    One independent pi RPC process, so projects and conversations do not pollute each other.
  </div>
  <div>
    <strong>One Workbench</strong>
    Chat, files, history, config, terminal, and Git info live in the same desktop layout.
  </div>
  <div>
    <strong>One Download Entry</strong>
    Prebuilt packages are published on GitHub Releases, with in-app update prompts.
  </div>
</div>

## Screenshots

<div class="screenshot-grid">
  <div class="screenshot-card">
    <img src="/images/config.png" alt="Config management UI">
    <strong>Config Management</strong>
    <span>Visually edit models, auth, settings, and Skills.</span>
  </div>
  <div class="screenshot-card">
    <img src="/images/slash-commands.png" alt="Slash commands and session history">
    <strong>Commands & History</strong>
    <span>Built-in slash command suggestions and fast session restore.</span>
  </div>
  <div class="screenshot-card">
    <img src="/images/files.png" alt="File tree and session actions">
    <strong>File Drawer</strong>
    <span>Browse project files, Git status, and session changes.</span>
  </div>
  <div class="screenshot-card">
    <img src="/images/terminal.png" alt="Terminal dock UI">
    <strong>Terminal Dock</strong>
    <span>Keep independent terminal tabs for the current agent.</span>
  </div>
</div>

## Community

Join the PiDeck QQ group for discussion and feedback:

**1026218644**

---

## Next Steps

- Ready to use: go to [Download & Install](/en/guide/getting-started#download--install).
- Prefer source: see [Run from Source](/en/guide/getting-started#run-from-source).
- Explore capabilities: see [Features](/en/guide/features).
