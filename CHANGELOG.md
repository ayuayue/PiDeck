# Changelog

[中文](CHANGELOG.zh-CN.md)

All notable changes to pi-desktop are documented here.

## v0.4.6 - 2026-06-07

### Added
- Provider model discovery: fetch available models directly from configured provider endpoints.
- Provider connection test: send a minimal request to verify Base URL, API key, model ID, custom headers, latency, and token usage before starting an agent.
- Provider management improvements: rename providers in the Models tab and configure request headers/User-Agent visually.

### Improved
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
- Initial pi-desktop workbench.
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
