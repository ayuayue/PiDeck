# Changelog

[中文](CHANGELOG.zh-CN.md)

All notable changes to PiDeck are documented here.

## v0.6.6-beta.2 - 2026-07-22

### 🐛 Bug Fixes

- **TurnRow "Rendered fewer hooks" crash** — Moved `useMemo` before early returns
  in `TurnRow`, fixing white screen on sending messages.
- **Stop button invisible during agent response** — Extracted from
  `hasComposerContent` condition; now always shown when agent is busy.
- **Historical session not scrolling to bottom** — Added `activeMessages.length`
  to ResizeObserver deps so observer is created after messages load.
- **NoSession anonymous agent duplicate in sidebar** — Added `noSession` matching
  path to `isReplacementForPendingAgent`.
- **Agent startup status stuck on "starting"** — Fix `setAgents` in `createAgent`
  to overwrite existing entries when the API returns, preventing stale status.
- **Session loading indicator flicker** — Enforce a 200 ms minimum display duration
  to avoid a brief flash on fast API responses.
- **Git Commit Message Generation** — Replace per-call `pi -p` process with a persistent
  `pi --mode rpc` daemon, eliminating repeated cold-start overhead. Start with
  `--no-session --no-tools --no-extensions --no-skills --no-prompt-templates
  --no-context-files --no-themes --thinking off` for minimal startup cost.
- **GitService.getStagedDiff maxBuffer** — Fixed `maxBuffer` being too small (5 KB),
  causing large diffs to silently fail with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
  Changed to fixed 10 MB.
- **Dev terminal Chinese garbled** — Auto-run `chcp 65001` on Windows to set UTF-8
  code page.

### 🚀 New Features

- **Composer redesign (OpenCode style)** — Replaced the top pill-button toolbar
  with a bottom bar: mode toggle / prompt template / attachment / model name /
  thinking level (all clickable).
- **Local packaging** — `npm run compile-exe` for fast portable `.exe` (skip tsc,
  ASAR no compression). `npm run dist:win -- [format]` supports single-format
  builds (nsis / portable / zip).
- **Git Push / Pull** — Add Push and Pull buttons to the Changes pane header,
  with full IPC pipeline and error notifications.
- **Customizable Commit Message Prompt** — New Setting `gitCommitMessagePrompt`,
  a textarea in the Git section of Settings. The template supports `{diff}`
  placeholder. Default prompt includes Gitmoji mapping.
- **Git panel relative paths** — Directory group headers now show paths relative to
  project root instead of absolute file system paths.

## v0.6.6-beta.1 - 2026-07-22

### 🚀 New Features

- **Git Source Control (Major Rewrite)**
  - VS Code-style 3-tab Git panel: Changes / History / Compare
  - AI-powered commit message generation (one-click via pi model)
  - Git graph visualization with colored lanes and branch/tag labels
  - Cherry-pick, revert, soft/mixed/hard reset, and drop commit via context menu
  - Branch switching and creation directly from the Git panel
  - Worktree support: create/delete/list workspaces with session grouping
  - Floating Git entry button in the conversation outline area
  - Git init prompt for uninitialized repositories
  - File status badges (staged vs unstaged) with unified file icons
- **Session Reference (&) Quick Input**
  - Type `&` in composer to search and reference sessions from the same project
  - Select specific messages or reference full session context
  - Persistent selection across re-opened reference dialog
  - & chip rendering with accurate boundary matching
- **Multi-Tab File Editor**
  - Up to 5 concurrent editor tabs with modal/drawer dual display mode
  - Diff mode with side-by-side comparison
  - Monaco Editor with dark/light theme, markdown preview, and multi-cursor support
  - Auto-save (Ctrl+S) with dirty state indicator
- **Conversation Outline & Action Bar**
  - Floating outline panel with jump-to-message navigation
  - Quick actions: Terminal, File drawer, Git, Built-in browser, Scratch Pad, External editor
  - Draggable repositioning with height memory
  - Git entry no longer depends on active agent — always visible when a project is selected
- **Retractable Client Message Queue**
  - Queue messages while agent is busy — follow-up or steer modes
  - Retract queued messages back to input for editing before sending
  - Visual queue status: sending, failed, queued count
- **Built-in Browser**
  - Right-drawer browser panel with multi-tab support
  - Fullscreen mode and device presets (PC / Mobile / Tablet)
  - External link → internal browser navigation
- **WSL Environment Support**
  - Full WSL isolation: pi detection, session scanning, file access
  - WSL distro selection, user validation, connection testing
  - Windows/WSL pi source switching in Settings > Developer
- **SkillHub Integration**
  - Skill store tab for browsing and installing community skills
  - CLI registry-based skill discovery with installation management
- **Toast Notification System**
  - App-notice system replacing sonner toast dependency
  - Contextual toasts for agent ops, file actions, copy, model switch
  - Subtle dot-accent design without intrusive green borders
- **Ask Question Dialog**
  - Interactive option dialogs with select/confirm/input types
  - Button-row layout with option labels; disabled selections when answered
  - Custom input via inline text field (✎ mode)
- **Session Compaction Refinements**
  - Expandable compaction card with pre-compression message history
  - Compaction count badge on agent tab
  - Process restart tracking after auto-compaction

### ✨ UI/UX Enhancements

- **Settings Redesigned**: global save/cancel, new tab categories (General / Proxy / Web / Developer / Pet / Storage), config-btn unified style
- **Per-area Font Sizes**: independent font size for sidebar (UI), chat content, and input box; font family presets (system/sans/serif/custom); zoom factor (80%–150%)
- **Model Picker**: scroll-to-top/bottom buttons, collapse/expand all providers, max thinking level support
- **File Icons**: VS Code Seti icon set for file tree, Git status badges on file rows, 20×20 uniform icon size
- **File Diff Viewer**: inline diff chips in tool cards, tab-bar with accent top border, monospace filename
- **Project Interaction**: click to expand + load sessions with row pulse animation, inline loading spinner
- **Floating Action Buttons**: terminal, files, git, scratch pad, editors, browser all available in the outline hover zone
- **Empty State**: vertically centered with better typography and layout
- **Right-click Context Menus**: copy path for project/session/agent, viewport-clamped position
- **Chinese/Unicode Support**: full Unicode naming for prompts, skills, sessions; chip regex using `\p{L}`
- **Dark Mode**: refined colors and contrast

### 🔧 Performance & Architecture

- **RichInput Rewrite**: uncontrolled + local patch architecture, fixes cursor drift during composition
- **Monaco Editor Lazy Loading**: 17.6MB Web Worker loaded only when opening file diffs
- **App-notice system**: replaced sonner toast dependency with built-in notice mechanism
- **Archived messages**: pass through compaction layer, diagnostic logging for compaction flow
- **Package Size**: larksuiteoapi lib/ cleanup, afterPack optimization, renderer chunk splitting
- **originalContent removal**: diff now uses tool parameter changed regions instead of storing full content
- **remove-markdown**: replaced hand-written regex for Markdown-to-plain-text conversion
- **Unified tool argument parsing**: fixed `getToolNewContent` returning undefined for edit operations
- **IPC payload reduction**: stripped unnecessary fields from session messages

### 🐛 Bug Fixes

- **Git Panel**: fixed ternary expression missing closing `)}` causing build failure; fixed catch block in AI commit generation; fixed stuck loading state on commit generation
- **File Editor**: Monaco 'TextModel disposed before DiffEditorWidget model got reset'; removed `loadedPath` early return; fixed mode/content switching
- **Caret/Scroll**: auto-scroll now resets on agent tab switch; composer footer floats over textarea; message scroll jumps to end after sending
- **WSL**: apply/cancel buttons visible when switching back to Windows mode; distro detection and user validation
- **Extension Lifecycle**: disabled extensions can be re-enabled; built-in extensions recoverable
- **Ask Dialog**: select custom input delegates to Pi's ✎ stream; hide inline ask-question-card when dialog is open; confirm type button support
- **Session Reference**: & chip no longer consumes subsequent input; case-insensitive session matching; safe regex escaping for `replaceAll`; sort by name length to avoid substring false matches
- **Rendering**: fix message order (user → assistant), first-send delay, message contamination after abort; process execution folding uses `agentRunning` instead of `isStreaming`; system messages no longer split ask folded regions
- **File Tree**: font aligned with VS Code (14px/400w/22px height=line-height) with ClearType rendering; sidebar drawer state persisted per project directory
- **Large Sessions**: skip full load, read last 8 messages from JSONL tail instead
- **Package/Deps**: re-generated lockfile for CI `npm ci` sync; removed deprecated `.npmrc allow-scripts` config
- **Legacy pi**: compatibility with `--no-approve` parameter
- **Notifications**: toast not blocked by settings modal; proxy config uses two-step draft-then-save

### 🚀 New Features

- **Prompt Templates System (Major)**
  - `PromptManager` with full CRUD and IPC bridge for `~/.pi/agent/prompts/`
  - `PromptsTab` settings page with Monaco Editor (create/edit/preview/delete)
  - `/` picker in composer to insert templates with `$N` variable hints
  - Project-level prompts (create/edit/delete in ProjectResourcesModal)
  - Built-in templates: review, test, fix, refactor, doc, explain, commit, pi-system, skill-discipline
  - Frontmatter stripping on send, `description` metadata attached to prompt RPC
  - Unicode naming support (Chinese, Japanese, etc.) for prompts and skills
- **Prompt/Skill Store Integration**
  - `prompts.chat` store: search, preview, and import prompts with variable-hint conversion
  - Yao Open Prompts: 121 bundled Chinese prompts across 9 categories with category filter, search, and preview
  - New Skill Store tab for searching prompts.chat skills
- **Git Worktree Workspace Management**
  - `WorktreeService`: detect git worktrees, create/delete via IPC
  - Branch list + create dialog + remove button under worktree-enabled projects
  - Sessions grouped by worktree, main workspace header clickable to load parent sessions
  - Auto-refresh worktrees on startup
- **Multi-Select Messages & Sharing**
  - Checkbox multi-select mode with floating action bar (text/markdown/image copy)
  - Image copy via `toBlob()` fix for CSP compliance
  - Success pulse animation + toast feedback
- **Built-in Browser Preview**
  - New right-drawer browser panel with tabs, URL bar, refresh/home/back/forward controls
  - Fullscreen mode and PC/mobile/tablet viewport presets for quickly checking web pages without leaving PiDeck
  - External-link fallback opens unsupported protocols in the system browser
- **Session Manager Modal**
  - Open from project context menu: lists all project sessions with multi-select delete
  - Per-session rename, export, delete, source filter (Pi/Codex/Claude/OpenCode)
  - Unified 1300×850 modal size with backdrop click-to-close
- **External Editor Integration**
  - Project context menu: right-click → "Open with" → pick editor (VS Code / Cursor / Zed / JetBrains)
  - Editor popover position fixed (left/top) with viewport clamping, works from sidebar project context
- **Prompt Configuration Enhancement**
  - Prompt templates picker shows description + variable hints in dropdown
  - Compose: template expansion separates command from user input with `\n\n`
  - Session file summary moved from chat timeline to composer area (collapsible)
  - Prompt rename supported across global and project levels
- **Model Configuration**
  - New `xhigh` reasoning level support

### ✨ UI Polish

- **Extracted common MonacoEditor component**: CSP-compatible local workers, dark theme, unified across ConfigModal, ProjectResourcesModal, PromptsTab
- **Thinking card visual refresh**: "思考" label, border removed, duration shown, chevron right after label, lighter hover
- **Tool cards**: borders and background tints removed to match thinking card style, tertiary text for details
- **Answer text**: font-size increased to 15px, line-height 1.68
- **Turn row gap**: increased from 8px to 12px between blocks
- **Extension widgets**: redesigned as collapsible cards with dismiss (X) button
- **Unified modal sizing**: all full-screen modals use 1300×850 + `min(vw,vh) - 48px` + backdrop click-to-close
- **Uniform icon buttons**: SkillsTab, ExtensionsTab, ProjectResourcesModal — text buttons → lucide icon buttons with hover titles
  - Enable/disable toggle icons: ToggleRight (green)/ToggleLeft (default)
- **Model selection UI**: simplified and refined (288 → 124 lines)
- **Enter key**: native browser newline handling, no manual `<br>` insertion
- **Chinese prompt names**: chip regex now supports `\p{L}` Unicode (removed `[a-zA-Z]` restriction)

### 🔧 Performance

- **Session open optimization**: Parallel `get_state` + `get_messages` on agent start
- **loadMessages**: parallel `get_messages` + `get_entries` via Promise.all
- **Initial session load**: skip `get_entries` (defer to edit/delete)
- **IPC payload reduction**: strip `originalContent` from tool ChatMessage meta
- **History message counting**: by conversation turns (20 turns) instead of raw message count
- **Removed `repairAssistantUsage`**: importers already add usage fields, no need to check on every session open
- **loadMessages retry**: only on failure, not unconditionally
- **Cleaned up all `[perf]` debug logs and unused timing code**

### 🐛 Bug Fixes

- **Windows crash fix**: globally disable Chromium sandbox (`--no-sandbox`), resolves `0x80000003` breakpoint crash on startup
- **Pi auto-compaction process restart**:
  - New tracking sets: `compactingAgents`, `userInitiatedStop`, `autoRestartAttempted`
  - Process exit handler: three-tier check (user-stop / compacting / clean restart)
  - `reattachProcess()`: preserves agentId + messages, replaces PiProcess + RPC client on restart
  - Manual compaction RPC failure → auto `reattachProcess()` (compaction already written to file)
  - Stop/stopAll marks user-initiated stop, skips auto-reconnect
- **onCompact event pollution**: MouseEvent passed to IPC → structured clone failure; wrapped with `() => compactAgent()`
- **Extension RPC lifecycle**:
  - Extension commands now cleared after session output (not before)
  - Non-dialog UI requests rendered as cards, no popup
  - Extension UI request lifecycle: pending cleared on agent_end
- **Message rendering**:
  - TurnRow renders by `run.items` original chronological order, restoring interleaved thinking/tool/answer display
  - `showThinking` dynamically read from pi agent config, takes effect on agent switch
  - Fragmented `content[].text` blocks from Anthropic-compatible providers are concatenated without synthetic newlines, fixing vertical-looking assistant replies
  - `<button>` nesting fixed: ExtensionWidgetCard close uses `<span role=button>`
- **Worktree**: refined project handling, session loading under worktree projects fixed
- **Share & widget UI**: visual polish and layout correction
- **Prompt frontmatter**: `description` no longer duplicated into message body
- **Translated built-in prompt descriptions**: auto-switch between zh-CN/en-US based on app language

### 🛠 Refactor

- Split non-component exports from `AppParts.tsx` into `AppUtils.ts` (fixes Vite Fast Refresh warning)
- RPC extension command idle check clarified

## v0.6.4 - 2026-07-05

### 🚀 New Features

- **Plan Mode**: New mode picker in the composer toolbar, supporting seamless
  switching between Plan Mode and Normal Mode. In Plan Mode the agent first
  generates a plan, executes step by step with confirmation, and returns to
  the menu on cancel.
- **ask_question Extension Enhancement**:
  - Batch question support: send multiple questions at once with structured results
  - Option selection with highlight and confirmation feedback
  - Collapsed tool card subtitle shows the question text
  - Results persisted to `meta._askCard`, correctly rendered after session restore
  - Enhanced promptGuidelines for rule-oriented instructions
- **Message Edit/Delete**:
  - Copy, edit, and delete AI responses
  - Edit/delete user messages with backfill to composer
  - Fix delete failures, flashback, and sync issues
  - New plan mode cancel functionality
- **ScratchPad Overlay**: Brand new scratch pad overlay with content preview,
  selection mapping, entry migration, right-aligned animation, and theme-aware
  semantic color tokens.
- **pi-deck-todo Built-in Extension**: New todo list extension for task
  management; widget rendering by widget key (no flatMap merging), with
  truncation and scrolling for long text.
- **Content Width Restriction**: New draggable content width slider (default
  unlimited, drag left to narrow, minimum 800 px).
- **Thinking Block Rework & Status Indicator**:
  - Thinking rendered as ThinkingBlock cards, AssistantText reverted to plain text
  - Thinking blocks rendered in-place by `<thinking>` tags, preserving original
    alternating order in content array (no merging or repositioning)
  - ThinkingBlock default expanded after streaming; manually collapsible
  - ThinkingBlock trigger with content preview subtitle, font matching tool-card
  - Toolbar "running" dot replaced by three-dot animated indicator at message
    list bottom: supports "Thinking", "Executing {tool}", and waiting states;
    auto-hides when model starts responding
  - Optimized waiting indicator spacing (16 px above)
  - Flat timeline rendering + unified message spacing + inline thinking segments
- **Extension Management Enhancement**:
  - Disable/enable built-in extensions with animated button
  - Project-level skill/extension management, distinguishing global vs project config
  - Fix extension_ui_request field read path (pi RPC at top-level, not params)
  - getToolKind distinguishes MCP-direct from underscore-prefixed extension tools
- **Trust Confirmation System**: Trust confirmation intercepted by desktop UI;
  untrusted projects can still be opened; projects with running agents cannot
  be deleted.
- **DiagnosticMessageCard**: New error/system message card with tone-coded styling.
- **Settings Page Enhancements**:
  - defaultProvider/defaultModel dropdowns with cascading and auto-discovery
  - enabledModels multi-select UI with model favorites pinned to top
  - Use lucide Star icon instead of Unicode ★
  - Agent restart no longer auto-switches selection; removed misleading retry option
- **Session UX Enhancements**:
  - Session compaction event display + clickable session file path
  - One-click New Agent button on project rows
  - External editor entry + session outline visible by default
  - Empty session outline grayed with persistent hover state
- **Feishu Bridge Enhancements**:
  - Optimized model switch card, fixed rich table rendering
  - Fixed file send false triggers and duplicate sends
  - Streamlined Feishu bridge code

### ✨ UI Polish

- **Thinking Card Breathing Animation**: Streaming thinking card now has pulsing
  border glow and subtle background pulse, so you can tell the system is still
  active even when text stalls.
- **Thinking Card Background**: Matches the tool-running card style with a subtle
  accent-tinted background.
- **Web Search Card Subtitle**: Collapsed `web_search` / `fetch_content` tool cards
  now show the search query or URL as a subtitle.
- **Content Width Slider**: Minimum value raised from 50 to 800 px to prevent
  overly narrow composition area.
- **Waiting Indicator Spacing**: Three-dot indicator now has 16 px margin above.
- **Composer Optimization**: Default height reduced by 25 px, forced reset after
  sending; composer moved down 10 px for more bottom breathing room.
- **Terminal Toggle Animation**: Changed to smooth slide-in from below the input
  area instead of a jarring pop.
- **Right Drawer Animation**: Grid layout transition animation improved, reverted
  to 0.18s ease version for fluidity.
- **ScratchPad UX**: Preview selection, entry migration, animation, right-aligned
  layout; file list collapsed by default.
- **Chat Area Background**: Unified to `#fcfcfc` in light mode, `#fbfaf7` in warm mode.
- **Tool Card Fixes**: JSON string parameter parsing, removed elapsed-time threshold,
  summary moved after timestamp; restored tool-call elapsed time display.
- **Slash Command Labels** now in Chinese, matching the dropdown display.
- **Branch-dropdown** centered positioning + unified New Agent background color.
- **ConfigModal**: User-Agent field layout fix, compat options description added.
- **Compatibility Settings**: Explicitly writes `false` when unchecked, simplified desc.

### 🐛 Bug Fixes

- **Dark Mode White Backgrounds**: Fixed hardcoded `#fcfcfc` in `.chat-pane`,
  `.composer`, `.composer-box`, and loading overlay — now properly adapts to
  dark mode via `--color-bg-panel`.
- **RichInput Newline Fix**: Fixed multi-line paste newline loss in contentEditable.
- **Message Rendering Fixes**:
  - Increased global message spacing specificity to override component margins
  - Removed `.thinking-card.streaming` margin-top:0, restored global 16px spacing
  - extension-widget-stack and composer-footer now respect content width limit
  - AssistantText supports message.thinking fallback rendering
  - Thinking/tool rendered in chronological order; fixed auto-scroll and cache hit rate
- **Plan Mode Fixes**: Cross-session deadlock, inability to exit within session,
  slash command breakage; cancel returns to menu; dialog options improved.
- **ask_question Fixes**: Three bug fixes, extension integration restored
  (was overwritten by scratchpad changes).
- **Message Edit/Delete Fixes**: Role detection error, reload state out of sync,
  delete failure/flashback.
- **Linux Wayland Fixes**: Desktop pet drag fix and dev startup improvements.
- **Feishu Fixes**: Rich table rendering, file send false triggers and duplicates,
  session file sending.
- **Codex Subagent Session Import**: Display fix, grouped under parent session.
- **Pending Agent**: No longer loads terminal; closed terminals silently ignore resize.
- **Regenerated package-lock.json** to fix npm ci failures.
- **Restored ask_question extension integration** (overwritten by scratchpad changes).

## v0.6.3 - 2026-06-28

### 🚀 New Features

- **Desktop Pet System (MVP-2)**: Global transparent floating pet window with
  Canvas animation engine, idle/patrol/review/tease interactions, notification
  bubbles, and graceful fallback on Linux/Wayland
- **Built-in Pets**: 5 pets — clawd, cache-capy, duo, octohack, fangjia;
  selector with Canvas animation preview
- **ContentEditable Chip Input System (#24)**: `@path` and `/command` rendered
  as visual interactive inline chips with click-to-open for file chips;
  cursor-aware suggestion triggering; IME-safe composition handling
- **Centered Modal Dialogs**: Settings, Config, Feedback converted to centered
  overlay modals with backdrop click-to-close and unified sizing
- **Enhanced Message Rendering**: New light-background theme option
- **Batch Model Selection**: Select multiple fetched models at once
- **OpenCode Session Import**: Import local OpenCode sessions
- **Session Source Badges**: Codex/Claude/OpenCode source badges with filtering
- **RPC Timeout Raised**: Minimum timeout increased to 600s
- **Pi/Extensions Update UI**: Trust management tab, platform filter

### ✨ UI Polish

- Session stats: token/cache chips in SessionStatus bar
- Model picker: search result groups now collapsible
- Header badge font: unified typography
- Extensions loading: added loading animation
- Scroll-to-bottom: ResizeObserver-based auto scroll, stays above composer

### 🐛 Bug Fixes

- **macOS Terminal**: Fixed node-pty spawn-helper permission & path corruption
- **Pet IPC timing**: Fixed pet toggle loss, wrong pet flash on startup
- **Terminal z-index**: Fixed click-through; hide terminal when modal is open
- **RichInput newline loss**: Fixed `\n` swallowed by `<br>` in contentEditable
- **Compact slah command**: Fixed `/compact` command handling
- **Pet drag→idle**: Instant idle transition; hidden until first agent
- **Extension state**: Fixed install status and input reference recognition
- **Session stats & TS errors**: Fixed 4 type errors, persistent filter
- **Build scripts restored**: Restored 4 accidentally deleted tool scripts
- **History session**: Optimized loading, scroll-to-bottom, auto trust.json
- **Agent statusError i18n**: Added missing translations
- **Context menu duplicate**: Fixed RPC log toggle showing duplicate text

### 🔧 Performance

- **Streaming stutter**: memo-wrapped AssistantText, dynamic mermaid `import()`
- **Pet code reduction**: 41% reduction (10 files, −1096 lines)

### 📦 Chore

- Revert package files to upstream
- Add @1900EasonJin to contributors

### 📖 Documentation

- Add pet-only PR description document
- Add QQ community group info to READMEs and docs-site

### 🔁 CI

- Switch macOS x64 runner from macos-13 to macos-latest

### 🤝 Contributors

Thanks to @ayuayue, @1900EasonJin, @zx3022448 for their contributions!

## v0.6.2 - 2026-06-22

### 🚀 New Features

- **Unified project child list**: Agents and history sessions now share a single,
  time-sorted list under each project (max 5 items by default)
- **External Editor Management**: New UI in Settings to detect, enable/disable,
  and configure external editors (VS Code, Cursor, Zed, JetBrains IDEs)
- **Windows Registry editor detection**: Detect installed editors via registry
  for more accurate auto-discovery
- **Fork/switch session improvements**: File viewer and diff tools enhanced
  with Git workspace change tracking
- **Feishu streaming card v4**: Real-time activity feed, lightning confirmation,
  and parallel startup for session mirrors
- **Feishu remote control**: Bridge-based remote agent control via Feishu bot
- **Feishu maintenance guide**: Architecture, implementation and operation docs

### ✨ UI Polish

- **Header action buttons**: "New Session", "Files" and "Terminal" now share
  consistent height, padding, font weight and baseline
- **Logs page**: Added log level filter and time range filter
- **Homepage link**: Added PiDeck website button in bottom-left sidebar

### 🐛 Bug Fixes

- **History session duplicate**: Fixed agent/history session duplicate display
  caused by path case/separator mismatch; added path normalization
- **History session blank content**: Removed warmPool process reuse (parked process
  could serve stale session state)
- **Session order promotion**: Clicking on a history session without sending a
  message no longer pushes it to the top of the list
- **Rapid double-click on history**: Main-process lock prevents concurrent
  agent creation for the same session file
- **Feishu streaming card rendering**: Fixed results not displaying in Feishu
  streaming card messages

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
