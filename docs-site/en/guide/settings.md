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
