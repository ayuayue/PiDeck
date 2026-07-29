# Frequently Asked Questions

## General

### What is PiDeck?

PiDeck is an open-source desktop workbench for managing multiple pi AI coding agents across local project folders. It provides a unified interface for sessions, Git, terminal, and configuration management.

### Is PiDeck a fork of pi?

No. PiDeck is a lightweight Electron shell that launches `pi --mode rpc` processes. The agent capabilities are provided by pi itself — PiDeck manages the project and session layer on top.

### Which platforms are supported?

Windows, macOS, and Linux. Pre-built packages are available on GitHub Releases.

## Usage

### Can I run multiple agents at the same time?

Yes. Each project gets its own independent pi RPC process, so you can have multiple agents running simultaneously for different projects.

### How do I recover a previous session?

Open the session timeline from the toolbar. You can browse past conversations by date and restore any session with full context.

### Can I import sessions from other tools?

Yes. PiDeck supports importing sessions from Claude Code and OpenAI Codex.

### How does the session reference (&) work?

Type `&` in the composer to search and reference past sessions from the same project. You can inject full session context or select specific messages.

## Technical

### What's the minimum Node.js version?

Node.js 20 or higher is required to run from source.

### Can I use PiDeck with self-hosted models?

Yes. In the Models settings, you can configure custom API endpoints for any compatible provider.

### Does PiDeck collect telemetry?

No. PiDeck does not collect any usage data or telemetry. All data stays on your machine.

### How do I update PiDeck?

When a new version is released on GitHub, PiDeck will show an in-app notification. You can download the latest version from the notification or from the GitHub Releases page.

## Troubleshooting

### The agent is not responding

1. Check that your API keys are configured correctly in Settings > Auth.
2. Verify network connectivity to your model provider.
3. Try restarting the session.

### Git panel shows no changes

Make sure you have initialized a Git repository in your project folder. If the project is a Git worktree, the panel should detect it automatically.

### Terminal is not working

PiDeck tries PowerShell, cmd, and sh in order. If none are available, the terminal will show an error. Install a supported shell and restart PiDeck.

### The app won't start

- Check the log file in the app's data directory.
- Make sure no other instance is already running.
- On Linux, ensure FUSE is installed for AppImage.
