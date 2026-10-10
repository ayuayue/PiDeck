---
title: Settings & Skills | Visual pi configuration in PiDeck
description: "Configure pi visually in PiDeck: models.json / auth.json editors, provider and model management, skills and extensions, proxy settings — no more hand-editing JSON in your pi desktop."
---

# Settings & Skills

PiDeck provides visual configuration management for all its settings.

## Opening Settings

Click the gear icon in the toolbar to open the settings panel. Settings are organized into tabs:

### Models

Configure the AI models available to your agents:

- **Provider** — Select from supported providers (OpenAI, Anthropic, etc.).
- **Model** — Choose the specific model version.
- **Endpoint** — Custom API endpoint URL (for proxies or self-hosted models).
- **Parameters** — Temperature, max tokens, top-p, and other model parameters.

### Auth

Manage authentication credentials:

- **API Keys** — Add, remove, and test API keys for each provider.
- **Environment Variables** — Some keys can be set via environment variables for security.

### General Settings

- **Language** — Interface language.
- **Theme** — Light, dark, or system theme.
- **Font Size** — Adjust the editor and terminal font size.
- **Auto-save** — Configure session auto-save intervals.

## Prompt Enhancement

The composer's **✦** button rewrites the current draft without sending a session message or running tools. Configure it under **Settings → General → Prompt Enhancement**:

- **Model**: Follow the session model (default) or select a fixed enhancement model. Changes save automatically, and the button tooltip shows the actual enhancement model. The next enhancement uses the new selection without reopening the session; an active enhancement keeps its original settings.
- **Include conversation context**: Off by default. When enabled, sends only recent loaded user/assistant text from the current session, up to **12 messages and 16,000 characters**. Recent content takes priority; older text may be truncated. Thinking, tool results and images are excluded; no additional history or attachment files are read. Context is sent to the selected enhancement model and may increase usage.
- **Implementation and DSH compatibility**: PiDeck supplies the UI and helper process; completion calls, the model catalog and credentials come from the **pi SDK**, not DSH. DSH sessions can use enhancement, but the chosen model must be available and authenticated in pi. DSH-only models cannot be used directly; pin an available pi model instead. Missing models produce instructions for changing this setting, never a silent fallback.
- **Configuration refresh**: Each enhancement reloads pi's local model configuration without network model discovery. Missing/unlaunchable pi or a WSL pi installation produces an enhancement error without affecting the session itself.

## Web Service and LAN Access

Enable the service from the Web settings page to access PiDeck from another device's browser. The service is off by default. New configurations listen on `0.0.0.0` (all IPv4 interfaces); an explicitly configured address is preserved.

- **Access tokens are enabled by default**: API requests require a token even through localhost. The page provides a read-only link containing the token, link copying, and QR codes.
- **Disabling authentication**: Any device that can reach the listening address can use the service directly. Disable it only on a trusted network; never expose an unauthenticated service to the public Internet.
- **Addresses and restarts**: Only interface addresses covered by the running listener are selectable. The default `0.0.0.0` listener supports IPv4; to use IPv6, bind to `::` or a specific IPv6 address. IPv6 URLs are bracketed automatically. Each start or restart creates a new token, so copy the link or scan the QR code again afterward.

## Skills

Skills extend the agent's capabilities. PiDeck supports two levels:

### Global Skills

Skills that apply to all projects. Managed in the main settings panel:

- Enable or disable built-in skills
- Configure skill-specific settings
- Install new skills from the skill store

### Project-Level Skills

Skills that apply only to a specific project. Accessible from the project context menu:

- Override global skill settings per project
- Enable project-specific skills
- Configure skill parameters for the project context

## Extensions

Extensions add new functionality to PiDeck itself (not the agent). Manage them in the Extensions tab:

- **Installed Extensions** — View and manage installed extensions.
- **Extension Store** — Browse and install community extensions.
- **Custom Extensions** — Load your own extensions from local files.

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Toggle sidebar | `Ctrl+B` |
| Toggle file drawer | `Ctrl+Shift+E` |
| Toggle terminal | `` Ctrl+` `` |
| Open settings | `Ctrl+,` |
| New session | `Ctrl+N` |
| Search files | `Ctrl+P` |
| Command palette | `Ctrl+Shift+P` |
