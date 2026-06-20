# Changelog

[中文](CHANGELOG.zh-CN.md)

All notable changes to PiDeck are documented here.

## [Unreleased]

### 🚀 New Features

- **Built-in Goal toggle**: Goal feature now appears in the Extensions page with enable/disable switch.
  When disabled, `/goal` commands are hidden and any active goal is cleared.


## v0.6.1 - 2026-06-16

### 🚀 New Features

- **Batch delete in config**: Select and delete multiple providers/auth at once
- **Duplicate config**: One-click copy for providers and auth entries
- **Delete confirmation dialogs**: Prevent accidental deletion of config entries
- **Auth provider picker**: 29 pre-configured providers with env vars and setup links
- **Provider config guide**: Built-in API type reference, compatibility guide, and troubleshooting
- **Auth config guide**: Step-by-step guidance for setting up credentials
- **Collapsible model groups**: Model picker supports collapsing provider groups, auto-expand on search
- **API type dropdown with descriptions**: Helps users choose the right API type
- **User-Agent presets**: Added claude-cli, claude-code, Kilo-Code and more

### ✨ Improvements

- **Compact chat header**: Title and path on first row, status/secondary info on second row
- **Tree-style model picker**: Indentation, left border, and grouped headers
- **Visible scrollbars**: Session area and model picker now show thin scrollbars
- **New session sorting**: Newest agents appear at the top
- **UI copy polish**: Button labels and terminology consistently translated
- **Left-aligned form labels**: Unified label style across config forms
- **Smaller card heights**: More compact config management cards
- **Fetch models button relocated**: Moved from form area to model list header
- **Advanced fields hint redesign**: Clean sidebar style instead of blue background
- **Custom provider input clarity**: Clearer labeling for adding non-preset providers
- **Batch delete red styling**: Danger-fill buttons for batch operations

### 🐛 Fixes

- Fix agent status text wrapping in collapsed list
- Fix agent status disappearing when switching tabs
- Fix anthropic-messages test returning false 404 with max_tokens=1
- Fix horizontal scrollbar in model picker
- Fix checkbox triggering expand/collapse in batch mode
- Fix delete confirmation button text obscured by background

### 🌐 i18n

- Unified terminology: Provider → 供应商, Auth → 认证
- New translation keys for path, ctx, cache
- Thinking level labels (Off/Low/Medium/High) now use translated text
- 40+ new translation keys across all new features

## v0.6.0 - 2026-06-14

### Added
- Claude session import from the project context menu, converting local Claude JSONL sessions into PiDeck history sessions.
- Composer command history with Up/Down navigation for quickly reusing previous prompts while editing at the first or last line.
- Performance testing script and renderer helpers for validating long-session rendering improvements.

### Improved
- **Session workflow display**: Thinking, tool calls, and answer updates now appear in a compact activity flow with accurate status, timing alignment, wrapping, and copyable details.
- **Historical session performance**: Significantly reduced input lag when opening sessions with many messages (average 90.3% performance improvement).
  - Message update optimization: Added reference equality check to skip unnecessary state updates
  - Suggestion calculation optimization: Suggestions are now only computed when the dropdown is open
  - Modified files calculation optimization: Computation now only triggers when message count changes
  - Outline calculation optimization: Reduced re-computation frequency by optimizing dependencies
- **Tool-call status**: Bash command exit codes are now shown as command results instead of being treated as RPC tool failures.
- **Startup experience**: Application window now maximizes automatically on launch for better workspace utilization.
- **Composer input**: Increased default input box height from 132px to 160px for better multi-line editing and code snippet input.
- **Input responsiveness**: Typing in the composer is now more responsive, especially in long conversation sessions.

### Fixed
- Settings persistence in Windows portable mode now works correctly across restarts.
- System tray behavior is more reliable.

## v0.5.0 - 2026-06-14

### Added
- LAN web service: Settings can now start a local HTTP service so devices on the same network can open PiDeck through the host machine's IP and configured port.
- pi Extension management: the configuration modal now includes extension management alongside Models, Auth, Settings, Raw config, and Skills.
- Git branch creation: the branch selector can create a new branch from the current branch without leaving PiDeck.
- Project context action: project rows can be revealed directly in the system file manager.
- VitePress documentation site and a full UI design audit, documenting the current desktop workbench architecture and design-system direction.

### Improved
- Major desktop shell refresh: the project sidebar, chat workspace, drawer, composer, splitters, context menus, and modal surfaces now use a shared semantic token system for typography, color, spacing, radius, focus, and motion.
- Dark mode coverage is now much broader across the workspace, Settings, Config, Feedback, RPC logs, Codex import, image preview, message stream, tool calls, terminal dock, and confirmation dialogs.
- Full-screen Settings, Config, and Feedback pages now fit the custom Electron titlebar better and avoid overlapping the PiDeck titlebar/brand area.
- Sidebar workflows are clearer: recent project sessions are shown inline, left-click opens or reuses the session, right-click is reserved for management actions, and the agent-row close button was removed to reduce misclicks.
- Session and agent context menus now focus on management actions; historical sessions can be renamed, copied, exported, inspected through RPC logs, or deleted from the sidebar menu.
- Settings dropdowns now use a custom PiDeck-styled select component instead of native browser select popups.
- Header actions are grouped by branch context, session actions, and panel toggles; the model/status chips have more breathing room and no longer feel clipped by the header divider.
- Shared UI primitives now cover buttons, icon buttons, close buttons, text fields, and select fields, reducing visual drift across Settings, Config, Feedback, updates, environment checks, and import dialogs.
- PiDeck branding, fonts, logo treatment, image preview overlays, picker palettes, and terminal typography have been refined for a more consistent desktop feel.
- Localization coverage is much broader across workspace flows, configuration, settings, window controls, feedback, update prompts, RPC logs, model/thinking pickers, and low-frequency toasts.
- Terminal Pi Soft now adapts to dark mode with a dedicated xterm palette.

### Fixed
- Composer arrow keys no longer accidentally trigger history navigation while editing text.
- Windows pi shim startup keeps the expected Node runtime alignment.
- Configuration modal crash boundaries and white-screen recovery were improved for unsupported or complex config shapes.
- Codex-imported sessions now preserve their original timestamp for both created and updated times, keeping imported session ordering stable.
- Settings and Config pages no longer overlap the custom titlebar PiDeck label when opened in the custom titlebar layout.

## v0.4.17 - 2026-06-11

### Added
- Global Skill management: the configuration modal now has a standalone Skills page for listing skills from `~/.pi/agent/skills` and `~/.agents/skills`.
- Skill actions: create a Skill template, enable or disable model invocation, delete a Skill with an in-app confirmation dialog, and open Skill folders from the desktop UI.
- Manual pi path fallback: users can enter a custom pi path when automatic detection fails, and the Settings page now shows the active pi path inline.

### Fixed
- Windows pi command validation now supports `.cmd` shim paths containing spaces by preserving the hand-built `cmd.exe /c` command line.
- Manual pi path validation now normalizes quoted paths, doubled backslashes, and extension-less paths before saving the usable command.
- Windows detection no longer relies on PowerShell `pi.ps1` shims, reducing quoting and execution-policy failures.

### Improved
- Skill rows now use the same compact card style as the session history list.
- pi environment detection failures now show inline details in Settings, while startup detection still uses the environment dialog.

## v0.4.16 - 2026-06-11

### Added
- Anonymous usage statistics: packaged builds now send at most one `app_heartbeat` per day to understand version distribution, platform compatibility, and active installations.
- Privacy control: Settings now includes an opt-out switch for anonymous usage statistics.

### Improved
- Privacy documentation now explains what the heartbeat collects, what it does not collect, and that the third-party analytics service receives request metadata.
- Telemetry coverage now includes tests for opt-out, unpackaged builds, missing project keys, daily throttling, and PostHog person property sync.

## v0.4.15 - 2026-06-09

### Added
- Built-in Chat workspace: a fixed Chat entry now appears at the top of the project list for general conversations that do not need a code project.
- Project drag sorting: regular project rows can now be reordered by drag and drop, with the custom order persisted across restarts.

### Fixed
- Terminal scrollback restore: switching away from an agent and back now restores terminal output and scrollbar state.
- Agent startup focus: a newly created agent no longer steals focus if you switch to another agent while it is still starting.
- Composer drafts: each agent now keeps its own unsent text and image attachments instead of sharing one global composer draft.
- Provider connection tests now use smaller probe requests and clearer timeout guidance, reducing false failures with slow reasoning models or queued upstream providers.

### Improved
- Refreshed the app icon, boot logo, and built-in Chat entry with the new `#14b814` brand green while keeping regular project avatars more neutral.

## v0.4.14 - 2026-06-09

### Improved
- Release package size: build-time and renderer-only libraries are no longer listed as production dependencies, reducing the packaged app payload and download size across Windows, macOS, and Linux releases.

## v0.4.13 - 2026-06-09

### Fixed
- Windows pi path handling: install checks and RPC agent startup now handle npm shim paths that contain spaces.
- Long assistant answers now stay within the conversation area, including historical sessions, thinking blocks, code blocks, and tables.

## v0.4.12 - 2026-06-09

### Added
- Running-session prompt delivery modes: while an agent is streaming, messages can now be sent as `steer` to affect the next LLM call or as `followUp` to queue until the agent stops.
- Delivery badges on user messages now show whether a running-session message will apply before the next call or after the current run finishes.

### Improved
- Short user messages now shrink to their actual content width even when delivery badges are visible.

## v0.4.11 - 2026-06-08

### Added
- Project history quick action: each project row now includes a dedicated history button, so historical sessions can be opened without relying on the context menu.
- Per-answer file-change summary: each completed agent answer now shows a compact list of modified file names and changed line counts directly below that answer, while the Files panel keeps the session-wide overview.
- In-app update check: PiDeck now periodically checks the latest GitHub Release and shows release notes plus browser download links when a newer version is available.
- Update failure guidance: manual update checks now explain GitHub connectivity issues, suggest configuring the desktop proxy, and provide a direct Release-page fallback.

### Fixed
- Agent terminal isolation: switching projects or agents no longer reuses another agent's open terminal state.
- Terminal initialization: opening the terminal no longer creates duplicate tabs automatically in development/runtime race conditions.
- macOS app icon packaging: release builds now generate a real `.icns` file instead of a mislabeled PNG, improving Dock icon rendering.
- Composer wrapping and resizing: the prompt input now wraps and scrolls more reliably for long content, can be shrunk again after being dragged to maximum height, and the window no longer shrinks below the layout's safe range.
- Update-check toast cleanup: manual update result hints now disappear automatically instead of staying pinned at the bottom of the window.
- Project history refresh feedback: the history modal now shows loading feedback when refreshing sessions.

### Improved
- Model defaults: newly added models now start with `contextWindow=1000000`, `maxTokens=128000`, and reasoning enabled by default.

## v0.4.10 - 2026-06-08

### Added
- Project history quick action: each project row now includes a dedicated history button, so historical sessions can be opened without relying on the context menu.

### Fixed
- Agent terminal isolation: switching projects or agents no longer reuses another agent's open terminal state.
- Terminal initialization: opening the terminal no longer creates duplicate tabs automatically in development/runtime race conditions.
- macOS app icon packaging: release builds now generate a real `.icns` file instead of a mislabeled PNG, improving Dock icon rendering.
- Composer wrapping: the prompt input now wraps and scrolls more reliably for long content, and the window no longer shrinks below the layout's safe range.

### Improved
- Model defaults: newly added models now start with `contextWindow=1000000`, `maxTokens=128000`, and reasoning enabled by default.

## v0.4.9 - 2026-06-08

### Added
- Project history modal: open historical sessions from the project context menu and rename sessions with an inline action.
- Terminal selection copy: right-click selected terminal text to copy it, with a lightweight confirmation hint.

### Fixed
- Codex-imported sessions now include compatible assistant usage metadata, preventing `totalTokens` errors when continuing imported conversations.

### Improved
- Codex session import now starts with no sessions selected by default, avoiding accidental bulk overwrite/import.
- Historical session rows now use a compact Codex-style list layout with lighter rename controls.

## v0.4.8 - 2026-06-07

### Added
- pi agent proxy settings: inject proxy environment variables into newly started pi agent processes, with an OpenAI API connectivity check.
- Desktop proxy settings: route model discovery and provider connection tests through Electron's desktop network proxy.

### Improved
- Reorganized the settings modal into Basic Settings, Proxy Settings, and Developer Settings tabs with clearer save feedback.
- New providers no longer write a default User-Agent header; leaving the field empty preserves the pi / SDK runtime default.

## v0.4.7 - 2026-06-07

### Added
- Embedded terminal dock: open an agent-scoped terminal between the chat timeline and composer without leaving the session.
- Terminal tabs: create, switch, close individual tabs, or close all tabs with an in-app confirmation.
- Terminal themes: switch between Pi Soft, Solarized Light, Solarized Dark, One Dark, and Monokai.

### Improved
- Refactored the large config modal into focused tabs and shared helpers, making provider, auth, settings, and raw JSON editing easier to maintain.
- Split the main renderer display components out of `App.tsx`, reducing the main UI entry point and preparing the app for future panel work.
- Windows packaging now uses the `node-pty` prebuilds instead of forcing a native rebuild, avoiding Visual Studio Spectre library requirements during `electron-builder`.

## v0.4.6 - 2026-06-07

### Added
- Provider model discovery: fetch available models directly from configured provider endpoints.
- Provider connection test: send a minimal request to verify Base URL, API key, model ID, custom headers, latency, and token usage before starting an agent.
- Provider management improvements: rename providers in the Models tab and configure request headers/User-Agent visually.

### Improved
- API type compatibility: removed the non-pi `openai-chat-completions` preset, migrate the legacy alias to `openai-completions`, and align provider tests with pi's official Chat Completions provider name.
- Slash command and file suggestions now support keyboard selection for a smoother composer workflow.
- Added OpenAI Responses compatibility handling, including SDK-like User-Agent fallback for providers that validate client headers.
- Updated config preview mocks and IPC contracts for the new provider model fetch and testing flows.

## v0.4.5 - 2026-06-05

### Added
- Config export/import: package models.json, auth.json, and settings.json
  into a single JSON file for backup and migration.
- Provider compat settings: visual editor for supportsDeveloperRole and
  supportsReasoningEffort options, no manual JSON editing required.
- Image preview in composer: click thumbnail images to view full-size
  preview in modal.
- Modified files list in file drawer: shows files changed by the current
  session's agent at the top of the file drawer.
- Right-click context menu on modified files: open file, reveal in folder,
  or reference in composer.
- Session duration display: total elapsed time shown in the status bar
  after session ends (e.g., 3.2s / 1m23s).
- Reload/Restart button loading state: buttons show loading text and
  become disabled during agent restart.

### Fixed
- Error detection logic: prevented normal tool outputs (e.g., "Successfully
  replaced") from being displayed as error messages.
- Image preview area overlapping with textarea: adjusted grid layout so
  image preview occupies its own row.
- Agent error handling: error messages are now written into the session
  when agent ends abnormally (API errors, etc.), preventing blank responses.
- agent_end error extraction: iterates through messages array to find
  error messages instead of relying on fixed position.
- Modified files list readability: increased font size and color contrast.
- Git branch selector: now shows only local branches, removed remote
  branches from dropdown.

### Improved
- Config modal UI: width increased to 900px, export/import buttons
  match save button style, provider expand area has more spacing,
  delete button icons unified.
- Close button color darkened for better visibility.
- Removed Reload button: `/reload` cannot be correctly executed via RPC
  prompt, unified to use Restart button for all reload scenarios.

## v0.4.4 - 2026-06-05

### Added
- Input history navigation: press Up/Down arrow in the composer to cycle
  through previously sent messages (CLI-like workflow).
- Edit button on user messages: click to copy the text back into the composer
  for editing and re-sending.
- API type dropdown in Models tab: preset options (openai-completions,
  openai-chat-completions, openai-responses, anthropic, google-generative-ai)
  with custom value fallback for unknown types.

### Improved
- Config modal UI overhaul: softer card styling, blurred input styles,
  consistent borders, model list panel layout, and refined spacing across
  Models/Auth expanded sections.
- Agent startup no longer blocks switching to other agents: replaced global
  `agentLoading` overlay with per-agent `status === "starting"` check.
- Saving config no longer auto-reloads the active agent; use the Restart
  button for manual reload instead.
- Model switch and thinking level toggle are now disabled while the agent
  is actively responding (prevents mid-stream config changes).
- Tool call group status now correctly reflects completion: checks the last
  tool message status instead of any message, so groups no longer show
  "in progress" after all tools finish.
- Thinking bubble rendering position restored to the bottom of the message
  list for natural chronological stacking during streaming.

## v0.4.3 - 2026-06-04

### Added
- Real-time thinking process display: shows model reasoning during streaming
  with collapsible content block, so users know the model is working instead of
  appearing stuck. Thinking content is persisted in messages for both current
  and historical sessions.
- RPC log panel: accessible via right-click context menu on agent tabs, shows
  detailed request/response/event flow with expandable JSON data view.
- DevTools toggle button in Settings for easier debugging.

### Improved
- Settings modal width increased from 420px to 640px for better readability.
- ANSI escape codes stripped from thinking content (terminal color sequences
  like `\x1b[38;2;...m` are now cleaned).

## v0.4.2 - 2026-06-04

### Added
- Message queuing when agent is busy: sending while agent is running
  automatically queues messages locally, flushed with steer semantics
  when agent becomes idle (aligned with pi CLI behavior).
- Cancel button on queued message bubbles to remove pending items.
- Queue UI: semi-transparent dashed bubble, spinning indicator,
  "Queue Send" button with pulse animation.

### Improved
- Queued messages isolated by agentId when switching agents,
  preventing cross-agent message delivery.
- Failed sends fall back to queue with toast notification instead of
  permanent loss.
- Restart now auto-resolves sessionPath and retries loadMessages
  on failure for better history restoration.

### Fixed
- Flush not triggering after agent completes (now pushes runtimeState
  with isStreaming reset on agent_end).
- Blank screen after agent restart when history session fails to load.
- get_commands timeout errors polluting console on startup.

## v0.4.1 - 2026-06-03

### Improved
- User messages now display as plain text instead of Markdown, preventing special characters from being misinterpreted.
- Notifications are now only sent when the session ends, not during tool calls.
- Thinking bubble animation continues to display during tool execution.
- Hidden the collapse/expand arrow icon in the project list for a cleaner look.
- Reduced left-side whitespace in the project list for a more compact layout.
- Adjusted the close button position on agent rows to avoid overlapping with the border.

## v0.4.0 - 2026-06-02

### Added
- Image support: paste images from clipboard (Ctrl+V) or drag and drop into chat composer.
- Image preview in user messages with click-to-zoom fullscreen viewer.
- History session image restoration: images from previous sessions now display correctly when reopening.
- Session end notification: system notification when agent finishes responding (configurable in settings).
- Large image auto-compression: images are resized to 2000px max edge to reduce context usage.
- Error feedback when sending images to unsupported models.

### Improved
- Optimized image transmission by auto-converting PNG/WebP to JPEG for smaller payload size.
- Send button now enabled for image-only messages without text.
- History session loading now extracts and displays images from pi session files.

### Fixed
- Fixed history sessions showing thinking/reasoning content instead of actual responses.
- Fixed image sending failure with no error feedback (now shows error in chat).
- Fixed ANSI escape codes appearing in message summaries.

## v0.3.0 - 2026-06-02

### Added
- Configuration management modal: click the sliders icon in the sidebar to view and edit pi's global config files (`models.json`, `auth.json`, `settings.json`).
- Models tab: visual editor with provider cards, model list in grid layout, add/delete providers and models, inline editing for id, name, contextWindow, maxTokens, reasoning.
- Auth tab: view and edit API keys per provider, add/delete auth entries, show/hide toggle and copy-to-clipboard for keys.
- Settings tab: key-value editor with type-aware inputs (boolean checkboxes, number fields, JSON for complex values).
- Raw tab: direct JSON editor for each config file with file selector switcher.
- Auto-reload after saving config changes (triggers `agents.reload` on the active agent).
- `!command` and `!!command` bash execution in the chat composer, matching pi terminal behavior: `!` runs and sends output to LLM, `!!` runs silently.
- Git branch selector now fetches both local and remote branches, with branch count badge and empty-state hint.

### Improved
- Replaced all emoji icons with lucide-react professional icons (Search, ChevronLeft/Right/Down, Play, Check, GitBranch, Eye/EyeOff, Trash2, Settings, Sliders).
- Sidebar icons (config management + settings) use distinct lucide-react icons with hover highlight.
- Auth and provider form layouts use horizontal label+input grid for better alignment.
- API key inputs support show/hide toggle and one-click copy across both Models and Auth tabs.
- Branch dropdown z-index and overflow fixes for reliable display inside the chat header.

### Fixed
- Fixed Reload button in chat header: was sending `/reload` as a prompt message instead of calling the dedicated `agents.reload` IPC handler.
- Fixed source file tab in config modal: switching files now reloads the correct content instead of always showing `settings.json`.
- Fixed git branch dropdown being empty due to `overflow: hidden` on parent containers clipping the dropdown.
- Fixed stray tab character in BranchSelector JSX that could cause rendering issues.

## v0.2.2 - 2026-06-02

### Fixed
- Fixed tray icon not showing in packaged apps by using electron-vite's `?asset` suffix for correct path resolution.
- Fixed settings modal overflowing viewport on smaller screens by adding max-height constraint and scrollable content area.

## v0.2.1 - 2026-06-01

### Fixed
- Stripped ANSI terminal escape codes from pi output in chat messages, tool details, and conversation outline.
- Conversation outline now shows last 15 items by default with a "show all" button to expand the full list; panel is scrollable with max-height 70vh.
- Increased outline summary truncation from 34 to 48 characters for better readability.

## v0.2.0 - 2026-06-01

### Added
- Session rename: right-click a session card in the history drawer to rename inline (Enter confirms, Esc cancels). Persists via sessionName metadata in the JSONL file.
- Built-in slash command suggestions: type `/` to see 12 pi built-in commands (session, tree, clone, compact, copy, export, share, settings, reload, hotkeys, login, logout) alongside extension-registered commands.

### Improved
- Filtered redundant built-in commands (/new, /model, /resume, /fork) that already have dedicated desktop UI.
- Removed /name command in favor of the new session rename UI.

## v0.1.9 - 2026-06-01

### Added
- System tray support: closing the window now hides to the system tray by default; added a "close to tray" toggle in settings.
- Tray context menu with "Show Window" and "Exit" actions; double-click tray icon to restore (Windows).
- Restart button for agents: stops the pi RPC process and re-spawns with the same session, picking up new provider/API key configuration changes that `/reload` cannot apply.
- Manual context compaction button in the composer toolbar, visible when context usage exceeds 30%; shows live percentage and loading state.
- Custom branch dropdown replacing the native `<select>`, with hover highlights, active branch indicator, and open/close animation.

### Improved
- Refined chat header layout: tighter spacing, gradient "New Session" button, polished action group styling with transitions.
- Branch selector, session actions, and composer are hidden during agent loading to avoid showing stale UI.
- History drawer closes immediately when clicking a session instead of waiting for agent creation to finish.
- Switched to official pi wordmark logo from pi.dev for app icon, sidebar, agent avatars, boot screen, and empty state.
- Context compaction button uses yellow highlight during compaction and is disabled while streaming.

## v0.1.8 - 2026-06-01

### Improved
- Chat links now open in the system default browser instead of navigating inside the Electron window.
- All projects show their agent lists by default when switching projects; added per-project collapse/expand toggle.

## v0.1.7 - 2026-06-01

### Improved
- Reduced the default project list width to leave more room for the conversation area.
- Refined the project search bar and add button layout so the add button stays visible when the window is narrowed.

## v0.1.6 - 2026-06-01

### Improved
- Improved Markdown table rendering in chat messages with clearer borders, spacing, header styling, and safe horizontal scrolling for wide tables.
- Replaced the hard-to-discover native textarea resize handle with a visible top-edge composer resize grip.
- Composer resizing now keeps bounded heights so expanding the input area does not take over the conversation timeline.

## v0.1.5 - 2026-06-01

### Fixed
- Refined the chat header layout so long project paths and session controls fit more reliably in narrow windows.

## v0.1.4 - 2026-05-31

### Added
- Added Stop / abort controls for running agents, backed by pi RPC `abort`.
- Added an assistant waiting animation before the first streamed token arrives.
- Added grouped tool-call cards so one user question no longer floods the timeline with many tool messages.
- Tool-call groups now show a short summary by default and can be expanded for full details.

### Improved
- Tool-call details are collapsed by default and scroll independently when large.
- Running and failed tool calls now have clearer visual states.

## v0.1.3 - 2026-05-31

### Added
- Added startup pi CLI environment checks with a visible status dialog.
- Added a reusable pi command locator for packaged Electron environments.
- Added manual environment checking in Settings.
- Added app version display and a “Check for updates” action that opens GitHub Releases.
- Added a static startup screen to avoid a blank white window while the renderer loads.

### Improved
- Packaged app startup now shows the window only after it is ready to display.
- Project loading is deferred so the main UI can render sooner.
- The pi CLI detector searches common PATH, npm, pnpm, Yarn, Volta, mise, nvm, asdf, bun, deno, and local bin locations.
- Windows `.cmd` pi shims are checked through a shell to avoid false “not installed” results.
- Missing pi CLI guidance now links to the official installation guide.
- Historical sessions started from a parent folder can now appear under the matching child project when the session content references that project.

## v0.1.2 - 2026-05-31

### Fixed
- Fixed project avatars for hidden folders such as `.pi` and `.pi-desktop` by ignoring leading dots and whitespace.
- Added `downloads/` to `.gitignore` so local downloaded artifacts are not included in releases.

## v0.1.1 - 2026-05-31

### Added
- Added Electron Builder packaging configuration for Windows, macOS, and Linux targets.
- Added packaging scripts for directory builds and platform-specific distribution builds.
- Added application icon resources for packaged apps.

### Improved
- Added Linux package maintainer metadata.

## v0.1.0 - 2026-05-31

### Added
- Initial PiDeck workbench.
- Multi-project desktop workspace for managing local folders.
- Multiple pi RPC agents running side by side.
- Session history drawer and historical session restore.
- File drawer with collapsible directories and file actions.
- Markdown conversation timeline with streaming assistant text.
- Tool-call detail display.
- Model, thinking level, context, and cache status display.
- Git branch display and branch switching.
- Configurable send shortcut and desktop-focused three-pane layout.

### Fixed
- Configured packaged application icons.
