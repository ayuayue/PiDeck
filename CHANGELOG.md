## v0.7.3 - 2026-09-03

### 🚀 New Features
- **Chat session archives** — Sessions can be archived out of the workspace, with bulk delete on the archive screen so old chats stop crowding the sidebar.
- **Active tab always in view** — When tabs overflow, the active session tab auto-scrolls to the visible center, so you always see which session you're on.
- **Refined default-model priority** — Draft defaults now follow: explicit default > enabledModels > welcome preference > last used > none; the welcome preference is validated against the catalog before use, and thinking level always comes from the default setting.
- **DSH runtime: dev uses project deps, packs stay lean** — Dev mode uses the repo's @deepseek-ai dependencies directly (no download); packaged builds ship without the runtime and offer on-demand install, so users who don't use DSH aren't charged the download.
- **Rewind checkpoints** — Full checkpoint flow: dialog, drawer, timeline restore, auto snapshots, and session-fork restore; the checkpoint list is paginated so long sessions stay usable.
- **Import DSH runtime from a folder** — Install a DSH runtime from an already-extracted directory instead of downloading it every time.
- **Automatic session titles** — New sessions get an auto-generated title, including after an agent interrupt, so the sidebar is no longer a wall of “New session”.
- **Idle agent auto-release** — Background sweep reclaims idle runtimes to cut memory use when many sessions stay open; checkpoint loading is faster too.
- **Usage rows stay put, model cards get denser** — Built-in usage templates hide the config entry once recognized and keep the usage row visible; the Pi Models tab now puts model count and usage on the card header instead of an extra footer strip.
- **Feedback reports include project context** — The feedback page attaches project environment and log stats, so diagnosis no longer needs a hand-assembled dump.
- **Ask notifications jump to the session** — Background Ask completion toasts can “Go to session” in one click.
- **Deep links into config backends** — Deep links open the Pi or DSH page inside Config Management directly.
- **beUI rolled out across the app** — UI switches over to beUI components; the sidebar marks sessions that are currently running.
- **Subagents and session widget cards** — Built-in pi-subagents extension reads child-agent records and detects failures; todos, subagents, and file changes share one segmented card, and historical sessions can still show todo snapshots.
- **pi-tui rename sync** — Renaming a session in pi-tui now shows up in the PiDeck sidebar after a project refresh or session restart, instead of sticking to the old title.
- **ask_question multi-select** — Question cards support multi-select with a single submit.
- **On-demand fast packing** — `dist:fast` can target portable / zip / nsis so local installers are quicker to verify.
- **DSH runtime version detection & worktree fade-out** — Built-in DSH runtimes show the detected version; deleting a worktree fades out instead of vanishing abruptly.
- **Model catalog updater** — The settings page can pull the latest model catalog from GitHub to override the bundled copy, with one-click restore and graceful fallback; probes skip auto-attaching a Bearer when a custom auth header is configured.
- **Turn-based memory management for long sessions** — History browsing now uses a unified turn protocol: turns are counted per speaking turn (consecutive user messages merge into one), with disk pagination prefetch, execution details unloaded when a historical turn folds, and the timeline compact-summary card retired; context usage is no longer capped at 100%, matching the pi CLI semantics. Long sessions browse more smoothly.
- **Session tabs regrouped by project** — New sessions land at the tail of their project's group (instead of the global end), with separators between project groups.
- **Project display-name rename** — Projects can have a display name (label only, disk directory untouched) for a more readable sidebar.
- **Fork session marker** — Forked sessions carry a `(fork)` marker physically written into the session name, so it no longer reappears after rename/delete; the old session is confirmed to have no leftover runtime state after a fork.
- **Open-file action in the session files list** — The session's modified-files list gains an “open file” action entry.
- **Explicit proxy-policy override for model fetching & connection tests** — Model listing and connection tests can explicitly pick a proxy policy instead of being bound to the global config.

### 🐛 Fixes
- **Refresh stale projects** — Refresh handles vanished projects, and file-delete failures surface instead of failing silently.
- **Selected-state backgrounds restored** — The @theme token self-reference was overriding foundation :root values, blanking bg-accent / bg-bg-active; switching to @theme inline reference fixes active tab, sidebar selection and related backgrounds across themes.
- **Dev no longer prompts to download DSH runtime** — The install / reinstall buttons are hidden in dev mode; only packaged builds show the on-demand install flow.
- **DSH runtime install no longer blocks the main process** — Install / uninstall use async fs, uninstall shows progress; multi_select allowlists and markdown layout are tightened along the way.
- **Model connection-test timeouts** — Tests send stdin EOF and degrade on older pi, so the spinner no longer runs forever.
- **Reading history no longer jumps to the latest turn** — Window-growth compensation uses restoreAt, keeping the viewport on the turn you were reading.
- **Shared DSH tool-card details** — Expanded DSH tool cards reuse the same cleaned-up detail copy as PI.
- **Composer no longer squashes the todo bar** — The input column uses intrinsic height so the todo bar stays readable after window resize.
- **API key action buttons aligned** — Auth-page key actions line up instead of sitting askew.
- **Generic transient-error retries** — The built-in extension covers empty-body / transient errors that pi’s retry list missed, so fewer sessions die on a blip.
- **Session outline rail keeps up** — Cheaper updates, scroll following, and per-pane isolation, without hitching during streaming.
- **Stable proxy model selection** — Picking a model through a proxy no longer snaps to the wrong item.
- **Model probes and DSH runtime errors** — Probe timeouts are looser; DSH runtime install progress and failures are spelled out.
- **Git push / pull no longer freeze** — Push and pull buttons recover instead of sticking in a busy state.
- **History-session indicator height** — The sidebar history indicator no longer crowds the title.
- **Sidebar worktree title overlap** — Worktree titles and action buttons no longer stack on top of each other.
- **Pi CLI update notice anchored** — The update notice sits on the controls instead of floating elsewhere.
- **DSH default model catalog restored** — `settings.describe` `base` is forwarded across layers so default models list again via base → schema default.
- **Linux packages keep DSH sharp** — Linux builds no longer strip sharp / libvips, so DSH-related features can start.
- **Spinner animation unified** — Loading states share one animation utility so spinners don’t freeze.
- **Subagent records survive restart and fork** — Start anchors persist (killed-by-restart agents are marked stopped); a full entry-table scan keeps fork side-branch records.
- **Tool results can open files** — Tool output is tighter, and results can open the matching file in the workspace.
- **Extension-provided models selectable in pickers** — The model selector, connection test, and Git commit-message generation load extensions by default (falling back to no-extension mode on failure), so models registered by extensions in the CLI are also selectable in PiDeck.
- **Checkpoint lists no longer show "No checkpoints yet" forever** — Reading switched to a single `git cat-file --batch` (SHAs via stdin, no command-line length limit), fixing the list coming back empty once a repository accumulated hundreds of refs; the checkpoints panel also gained a manual refresh button.
- **No more flashing CMD windows** — Pi child processes are spawned hidden on Windows, so launching a session no longer pops a console window.
- **Usage probe failures are diagnosable** — Every failed attempt (URL/method/status/redacted response summary) is recorded and shown when all probes miss; New API-style management endpoints no longer get a redundant `/v1` attempt, and failures are grouped into actionable hints.
- **Open-file inside Git diff fixed** — Clicking the inline “open file” button on a diff line no longer does nothing after the diff updates; it opens the snapshot path in the scoped preview.
- **Auto session titles no longer hard-truncated** — Title generation avoids cutting words in the middle; weak fallback no longer overwrites a real existing title.
- **Vision models mis-flagged as text-only fixed** — Some vision models are no longer treated as text-only; the page scroll position no longer jumps after a connection test.
- **Git summary generation honors the model proxy list** — The commit-summary subprocess follows the model proxy list and rebuilds when proxy config changes.
- **Git history graph excludes rewind checkpoints** — Checkpoints no longer show up as commits; image-generation mode hides security-level and context controls.
- **DSH session delete moves to recycle bin** — Deleting a DSH session also moves its `~/.dsh/sessions` directory into the system recycle bin.
- **Project-row action overlap fixed** — Hover action buttons no longer cover the project name at medium sidebar widths.
- **Timeline state kept across session switches** — Execution expand/collapse state survives switching sessions; interrupted turns fold automatically when reading history, and a new turn unfolds on start.

### 🙏 Thanks

Special thanks to **微时佬友** for providing the Grok model service used in our
community testing environment 🎉

Thanks to all group members who submitted suggestions and bug reports! 🙏

## v0.7.2 - 2026-08-30

### 🚀 New Features
- **Usage query rebuild (aligned with cc-switch)** — Unified usage display across Models / Auth / DSH (amount or percentage at the bottom-right of the card + bar-chart icon entry in the header); per-provider enable switch + built-in template auto-detection + generic / New API declarative templates + timeout / auto-query interval (default 5 min, 0 = manual only); no automatic probing when disabled or unsupported.
- **Multi-segment usage badges** — Usage now renders multi-window segments (5h / weekly / MCP, three-tier percentages): cards show all segments dot-separated, model-selector rows show the most severe segment for alerting; segment labels share one table with the detail panel, and custom probe window names are shown as-is.
- **DSH usage query pipeline** — Same usage display and probe configuration on the DSH model config page: config stored at `$DSH_HOME/.pideck/usage-probes.json`, credentials read from the DSH credential store (`.credentials.yaml`); identical to the pi side and fully isolated.
- **Usage query AI assist** — The usage dialog gains an AI-assist button that drops a prepared prompt (driving the usage-probe skill) into the main session composer to look up unsupported providers; without an active session it copies the prompt to the clipboard instead.
- **PiDeck-specific files consolidated** — Session archives / host mutex lock / usage config under DSH_HOME now live in `~/.dsh/.pideck/` (one-time migration; the migration logic will be removed in the next release once the legacy layout is confirmed gone).
- **Proactive update notifications (quota-free)** — PiDeck and Pi CLI now auto-check for updates every 2h in the background (first check 30s after launch). When a new version is found, a dot badge appears on the Settings gear and the update dialog opens automatically (once per version, with "Skip this version" support). The check source switched from the GitHub REST API to the `releases/latest` redirect + `latest.yml` (aligned with electron-updater's strategy): no more 60/hour/IP quota limit and no authentication required.
- **Release pipeline now ships latest.yml** — electron-builder gains `publish` (provider: github); `dist:win` prints the asset list to upload with the Release. Channel metadata is platform-specific (Windows: `latest.yml` / macOS: `latest-mac.yml` / Linux: `latest-linux.yml`) and each client reads its own platform file; when missing, the client falls back to the atom/API path automatically.
- **Check timeout protection** — Every GitHub check request has a 10s timeout: with a broken local network, manual "Check for Updates" spins at most 10s then shows an error and can be retried; background checks keep scheduling the next round after failure (eliminating the historical "infinite spinner, manual update blocked" issue).
- **Pi CLI background check** — Pi CLI version is checked every 2h alongside the app; a toast notifies about new versions and the "Version & Updates" settings section shows current → latest.
- **Manual check no longer swallowed** — Clicking "Check for Updates" while an auto-check is in flight now shares the same in-flight request instead of being gated away (the historical root cause of "new version but no prompt").
- **Session ruler rail completions** — The session right-edge ruler rail now covers all loaded messages (the 15-item cap is gone), tick spacing auto-shrinks as messages grow, ticks are evenly thinned out when space is tight (first/last always kept), and the rail yields bottom space when the terminal dock is open.
- **Ruler rail offsets for split view** — When a file/diff workspace pane is open, the right-edge ruler rail shifts right to hug the message area's right edge; it returns to the window edge in solo/maximized views.

### 🐛 Fixes
- **Update check fallback path** — When a Release lacks latest.yml, the check now degrades to the atom feed + REST fallback instead of failing outright.
- **Update check pipeline hardening** — Repo coordinates unified into PiDeck constants (no longer relying on GitHub rename redirects); recommended download assets get a HEAD availability check with automatic naming-variant correction on 404 (falling back to opening the release page in a browser when all variants fail); version comparison now honors semver pre-release semantics (beta < same-number stable, so beta clients get notified about stable releases); a pre/post-release end-to-end self-check script was added.
- **DSH usage query provider normalization** — `deepseek-official` / `llm-deepseek` are now normalized to `deepseek` on both main process and renderer, fixing usage/balance missing in the model selector and the orb panel while the DSH card row still showed it (all three now share one cache key, so refreshing one refreshes all).
- **File manager open & terminal ownership fixes** — Windows now launches explorer.exe via absolute path and uses `shell.openPath` to open directories (macOS too), so the window properly activates to the foreground; the terminal button falls back to the current session's project when `activeProjectId` isn't synced, so cross-project sessions keep showing "Open terminal".
- **Session panel terminal fold height sync** — The fold/expand height sync was reworked to read the composer's steady-state size before `setLayout`, fixing the fold-then-height-not-released and floating-input issues.
- **Composer stability** — The send button stays visible when the input has content during busy state; composer height stays stable after switching history; image-gen composer controls keep a single row.
- **Thinking picker no longer blocked by capability probes** — Opening the thinking-level picker no longer waits on capability probes.
- **Usage display polish** — Empty provider usage rows are hidden and spacing above the usage toggle is adjusted.

### 🚀 New Features

- **Model capability auto-adaptation & thinking-effort pipeline** — Compatible
  with pi 0.84.3: endpoint-reported `contextWindow` / `maxTokens` / thinking
  levels drive model adaptation, and the capability cache is invalidated per
  runtime generation; `get_available_thinking_levels` is cached through the
  runtime IPC keyed by `sessionId + agentId + generation + provider + modelId`
  (DSH keeps its own reasoningEfforts); models unmatched by the endpoint
  default to open thinking levels instead of guessing.
- **Manual model catalog refresh** — The model selector now has a manual
  refresh that force-pulls the model catalog (instead of relying on cache),
  so newly added models show up.
- **Usage query expanded** — Built-in usage/balance queries for OpenRouter,
  Moonshot-Kimi and generic OpenAI-compatible gateways, one-click
  usage-probes config generation, a new `usage-probe` skill and
  `/skill:usage-probe` entry point for custom providers; probe cards now also
  show balance / Boost points.
- **Session restart & reload** — The session context menu and tab bar now
  expose "Restart" and "Reload", fixing terminal-state agents that could no
  longer issue runtime commands.
- **DSH session-header agent mode pill** — The DSH session header shows an
  agent-mode pill: selectable during draft, read-only once activated
  (agentPresetLocked).
- **Built-in pi-deck-retry-no-body extension** — Empty-response errors now
  reuse pi's retry mechanism, reducing session interruption from occasional
  empty bodies.
- **Ask queries carry main-session context** — Parallel Ask queries read the
  main conversation context and bring answers back to the main thread
  (quote-into-composer), so background questions stay in sync with the
  conversation.
- **Sidebar Chats / projects segmentation** — The sidebar splits Chats and
  projects, adds a New-session menu and session search for faster navigation.
- **Session right-edge ruler rail** — A beUI PreviewRail on the session right
  edge maps timeline positions for quick jump-to-message navigation.
- **Theme cycling from the sidebar footer** — Light → dark → follow-system
  cycling with a beUI dock in the footer.
- **Global notifications as card toasts** — System notice delivery upgraded to
  custom card toasts.
- **JetBrains editor scan & system file-manager detection** — Deeper
  JetBrains editor directory scanning and automatic system file-manager
  detection for "open in editor / reveal in explorer" actions.
- **Bundled image-gen skill template** — One-click install of the built-in
  image generation skill template.
- **Markdown file-link line jumps** — Explicit file links jump to the target
  line (`path:line`); bare drive-letter hrefs are no longer stripped by the
  URL filter, and clickable links keep working outside capsules.
- **DSH official todo bridged** — DSH's native todo feeds the existing todo
  bar.
- **Ask panel notification toggle** — New standalone notification switch for
  Ask (parallel-query) responses, so background questions can stay silent.
- **Guide page @-file reference & default picks** — The onboarding guide now
  supports `@` file references and pre-selects the default model / thinking
  level for new sessions.
- **Usage probe multi-account & standalone endpoints** — Provider usage
  probing supports multi-account / multi-role balances (e.g. Zhipu) and
  per-provider standalone endpoint configuration.

- **DSH dual agent backend** — pi / DSH (DeepSeek Harness) sessions coexist in the
  same project and can be freely created, switched and browsed; DSH is deeply
  embedded (utilityProcess boot, no `dsh web`, no port, no background HTTP),
  lazily started so app startup stays fast.
- **DSH session capabilities** — history paging (`session.history` event-stream
  pages with seq cursors), fork (`session.fork` anchored at a seq, forked text
  prefilled into the composer), compact (`/compact` command), and an
  approval/question bridge (`approval/requested` + `question/requested` →
  desktop Ask dialog → `respond` receipt).
- **DSH session persistence** — a `dshSessionId` mapping is written to the
  catalog; after restart, old sessions are re-attached with a history-tail
  replay; fork/restart keep the mapping in sync.
- **DSH config management page** — a DSH pane in Settings: schema-driven
  settings/credentials forms, host-level model catalog, host status and restart.
- **v2 transport** — the DSH host moved from an in-process embed into a
  utilityProcess (MessagePort fetch bridge over the same `AbstractApiClient`
  contract); native ABI and crash surface no longer touch the main process;
  the hostEntry is a dedicated build output and is asarUnpacked.
- **Backend identity & capability sets** — sessions carry a `backend` marker
  (defaults to `pi`, zero migration for old data); UI hides entry points by
  declared capability (DSH hides edit/delete of history messages, keeps
  resend/fork; compact is always visible).
- **DSH command completion from the host registry** — A new
  `pideck-command-bridge` (in-process host bridge) feeds the Composer `/` menu
  from `ctx.commands` in real time (including user/plugin-registered commands),
  falling back to the static suggestion set while a session is not active.
- **DSH session HTML export** — Projection-based export: pages the full host
  history and renders a self-contained HTML file (static inline styles in the
  dsh-web visual language), returning a file path with the same protocol as
  pi's `export_html`; live sessions export from memory, history sessions are
  collected with a runaway guard.
- **DSH skill catalog presentation** — `skill.list` wired into the session
  tools panel ("Skills" tab): name/description/when-to-use plus `/name`
  slash-invocation hints (user-only skills get a badge).
- **Current-plan Todo extension** — The bundled Todo extension now supports explicit
  plan replacement and restoration, branch-scoped persistence, and retains stale
  tasks until the agent explicitly clears them.
- **Model spec autofill from listing + pi-ai** — Fetching models now keeps
  `contextWindow` / `maxTokens` when the endpoint returns them. Missing fields
  match `@earendil-works/pi-ai` builtins (same catalog DSH uses). Unmatched
  models stay empty instead of guessing 128k/8k. The OpenRouter/models.dev
  SQLite table (`model-specs.db`) is gone.
- **DSH provider retry count** — DSH has no global retry setting. Custom settings
  on each DeepSeek / OpenAI-compatible provider now expose `retryPolicy.maxRetries`
  (default 5, transient errors only).
- **DSH 0.1.0-rc.8** — Bump `@deepseek-ai/dsh*` to the current harness release.
  Keep the local `dsh-tool-pwsh-persistent` plugin: official persistent PowerShell
  still uses `ctx.terminals`, registers as `pwsh` (collides with the one-shot
  sandboxed tool), and is not mounted by default presets.
- **DSH 0.1.0-rc.7** — Bump `@deepseek-ai/dsh*` to the current harness release
  (plugin settings cards, Job Panel for Codex/Claude Code subagents, durable
  MCP/ACP image attachments, large-history pagination fix, max-token session
  recovery). English built-in `Code mode` label follows upstream as `PTC mode`.
  `dsh-bill` is 0.13.1.
- **Web UI restyled in the dsh-web design language** — The built-in web
  service follows the official dsh-web design tokens: semantic palette
  (background layers, border levels, label hierarchy, state colors) and font
  stacks taken from the official dist, near-black layered dark theme; sidebar /
  header / timeline / composer refinements (frosted header, focus ring on the
  composer, content column width, slim scrollbars).
- **Web DSH tools panel** — A "DSH tools" entry in the session header for dsh
  sessions: Goals (read-only), Subagents (directory + expandable transcript),
  Skills, and Plugins tabs, all over REST (same main-process sources as the
  desktop IPC).
- **Web DSH plugin management** — Dynamic Cordis plugin inventory + install
  form + run / stop / two-step uninstall (G13 semantics: in-process temporary,
  session-owned, panel gestures without approval), plus the read-only static
  loader list.
- **Dual-backend badges on the Web** — Sidebar session rows and the session
  header show pi/dsh backend badges (same source as the desktop
  SessionBackendMark), so both backends are instantly distinguishable.

### ✨ UX Improvements

- **History runtime-operation overlay** — Running operations on history
  sessions shows a loading overlay over the message area, preventing
  double-clicks and misclicks.
- **Tab-bar loading state** — Fixed the loading display and session-reload
  logic for tab-bar operations for more accurate feedback.
- **Model capability explainer card removed** — The capability explainer card
  is gone; adapted results go straight into the composer, one less step.
- **Settings grouping** — Cache and log settings moved into the "Developer
  settings" group for clearer categorization.
- **Tab-bar run controls converge into a ⋯ menu** — Run controls moved into a
  grouped ⋯ menu, decluttering the session tab bar.
- **Scratch-pad panel re-layout & editor picker redesign** — The scratch-pad
  panel is re-arranged and the external-editor picker dialog rebuilt.
- **Timeline process-layer text dimming** — Process-layer text uses the dimmer
  `text-faint` token with tool-card polish.
- **Startup auto-update check removed** — The app no longer pings the update
  endpoint on startup, keeping startup snappier.
- **Persistent PowerShell terminal hardening** — The persistent `pwsh` tool
  keeps multi-line command line breaks (ConPTY LF fix), resolves PowerShell
  installs via winget / WindowsApps, and injects git/npx environment variables
  to prevent interactive prompts.
- **Sidebar expanded-session collapse control** — Expanded project sessions in
  the sidebar can now be collapsed / expanded individually via a control.
- **Model default-collapse derived state** — The model directory default
  collapse is derived state now, so collapsed groups survive async catalog
  loads instead of flashing open.

- **DSH session export entry enabled** — Sidebar/drawer "Export HTML" now works
  for dsh sessions instead of reporting "not supported yet".

### 🔧 Performance

- **Terminal-session runtime memory released** — Terminal-state sessions now
  free their runtime state memory.
- **Export runaway guard** — History export is page-capped and oversized images
  are skipped to avoid hundred-megabyte HTML files.

### 🐛 Bug Fixes

- **Unstarted-session editing & bundled skill auto-install** — Fixed editing
  for unstarted sessions and the bundled-skill auto-install flow.
- **Vision-bridge misconfig image handling** — No more uncaught exceptions
  when the vision bridge is misconfigured; also fixed Git operation timeouts.
- **Official provider new-model false alarm** — Selecting a newly added model
  on an official provider no longer falsely reports "not configured".
- **Approval card text selection** — Fixed text in approval cards being
  unselectable.
- **Session error-state logging** — Completed applog records for abnormal
  session states to aid troubleshooting.
- **Always-on-top button state sync** — The button now mirrors the main
  process's real always-on-top state.
- **Docs fullscreen toggle crash** — Fixed the composer panel
  `Group not found` crash when toggling docs fullscreen.
- **DSH host warmup & `/new` command** — Improved DSH host warmup strategy and
  fixed `/new` commands being wrongly intercepted.
- **App background wallpaper token injection** — Wallpaper token injection no
  longer makes light/dark themes override each other.
- **File-manager open action & navigation** — Fixed file-manager open modes
  and related navigation defects.
- **PreviewRail jump on partially loaded messages** — Ruler jumps are now
  reachable while messages are still loading.
- **Pet state desync under concurrent tasks** — Pet failed/review transitions
  re-aggregate by business state; patrol and business states are mutually
  exclusive.
- **Model save validation** — Saving a model no longer treats config-fallback
  as a false green light.
- **Failed-message diagnostic cards** — Failed messages render diagnostic
  cards; retry progress only pops a toast.
- **RPC log toggle silent failure** — The log toggle no longer fails silently.
- **DSH archive name loss & cross-project archive view** — Archive names
  survive and the archive view no longer over-collects across projects.
- **Local packages built before pack/start** — Packaging/startup builds local
  packages first, fixing the DSH host crash from a missing `lib/index.js`.
- **Settings modal scrolling & child-session parent backfill** — The settings
  modal scrolls properly and flat subagent parents are backfilled to avoid
  orphaned tiles.
- **DSH live image rendering** — Streaming DSH images render again (hydrated
  bytes kept during live streaming).
- **False MCP badges on ordinary tools** — Ordinary tools no longer get MCP
  badges.
- **Markdown `~` path split by strikethrough** — `~`-prefixed file links no
  longer get split by the single-tilde strikethrough, and unresolvable links
  show a hint instead of silently opening an empty file.
- **DSH plugin config input** — Plugin config inputs are no longer interrupted
  mid-typing; plugin-area layout and config-page position are remembered.
- **pi→DSH provider migration no longer requires pre-seeded DSH entries** —
  Migrating a built-in provider to DSH works even when the DSH side has no
  same-name entry yet.
- **Markdown file-link existence check** — Message links to files now verify
  the target; stale paths degrade to plain text instead of dead links.
- **Unsaved-close confirm lists all changes** — The settings/config close
  dialog now enumerates every unsaved item, and dirty marks clear
  automatically when a field is reverted to its original value.
- **Panel widths preserved across zoom changes** — Splitter widths no longer
  jump when the window zoom factor changes.
- **Pi model field editing restored** — Model fields on the pi configuration
  page can be edited again.
- **Runtime switch & turn history alignment** — Switching runtimes keeps turn
  history display in sync.
- **Session delete/archive cleanup** — Deleting or archiving a session no
  longer leaves stray child sessions behind.

- **DSH injected context no longer projected as user messages** — AGENTS.md /
  runtime context / skills injected into DSH sessions are filtered by
  `source.kind`; the timeline keeps only real conversation.
- **Files drawer scroll container ownership** — Scrolling is scoped to the
  drawer container (synced with the dev-baseline fix); `files-panel` no longer
  scrolls itself vertically.
- **Removed the ineffective "Expand changed files by default" setting** — The
  changed-file list now lives above the composer and always starts collapsed,
  so the old toggle that auto-expanded each turn's list had stopped doing
  anything; the setting and its leftover dead code were removed.
- **Packaged terminal could not load pty.node (#154)** — afterPack now keeps
  asar unpacked metadata when it repacks, and `node-pty` is listed in
  `asarUnpack`, so `terminal:ensure` can load the native module in the
  installed app.

### 🙏 Thanks

- **@bfzha** — Persistent PowerShell terminal hardening, pet-state fixes, DSH
  archive / live-image / plugin-input fixes, markdown link line-jumps &
  clickability, build/startup packaging fixes, plus the earlier round: DSH
  config management/migration layering, CodeMirror config source-file page,
  full appearance theme redraw (Classic / Forest Green / Graphite Gray /
  Seafoam Blue / Warm Sun), selection-to-quote chips, and cross-session scroll
  anchor preservation (#163).
- **@ayuayue** — Usage-probe enhancements with balance/Boost, Ask
  main-context, sidebar segmentation & search, PreviewRail ruler, theme
  cycling, card toasts, editor/file-manager detection, image-gen skill
  template, tab-bar & timeline polish, plus the model capability pipeline,
  usage query, restart/reload, agent-mode pill, retry-no-body, the DSH
  dual-backend core, dedicated imagegen backend, dsh-web restyle and 40+
  fixes.

Special thanks to **微时佬友** for providing the Grok model service used in our
community testing environment 🎉

## v0.7.1 - 2026-08-15

### 🚀 New Features

- **Session trajectory in the right drawer + process ledger** — The thinking
  trajectory moves from the center session column into its own right-drawer
  tab (reusing the session message cache). JSONL process events, the first-round
  initial prompt, and `pi-system` references now land in the ledger; durations
  show only measured or within-round inferred ranges instead of fake 0ms.
- **Markdown incremental rendering** — Long streaming messages render
  incrementally (IncrementalMarkdownFrontier / frozen chunks) instead of
  re-parsing the whole document every frame; full rendering (syntax
  highlighting / mermaid / element tree) is deferred until idle.
- **Reading surfaces unified into split view** — The right-drawer editor panel
  is removed; file reading now happens in the center split view
  (SessionTabsBar + WorkbenchContent) on a unified surface.
- **macOS native traffic lights on the custom title bar** — The custom title
  bar uses the system window buttons (hiddenInset + trafficLightPosition),
  with the sidebar collapse and session tabs making room for the lights.
- **Empty-workspace onboarding** — When no workspace projects exist, the
  sidebar renders an empty-state card with an add-directory button.
- **Web ask request cards** — The local web service gained a `/api/ui-response`
  endpoint; `ask` requests render as cards with a request snapshot, and the
  SSE tool-loop wrap-up is fixed.
- **Onboarding is now a compose page** — The empty workspace renders the
  centered composer directly as a renderer-only virtual session (no catalog
  record, no pi process, no tab). The project name under the logo becomes a
  dropdown covering all projects (including the built-in Chat), and the
  selected model/thinking level shows live. The real session is created on
  first send with the composer state and typed messages moved over in one
  step — Chat projects now also get a normal saveable draft session. Startup
  no longer auto-creates a draft session.
- **Turn file-change list: manual collapse only** — The per-turn modified-file
  list is collapsed/expanded by a persistent toggle on its title row; the
  count-threshold auto-collapse is removed.
- **Home quick actions removed** — The home composer drops the quick-action
  buttons and settles the input height at 150px.

### ✨ UX Improvements

- **Desktop pet at native sprite size** — The pet renders each sprite cell at
  its original size with high-quality interpolation and stays in sync with
  zoom/font-size changes (no more blurry 160×176 compression).
- **Streaming conversations expand intermediate steps by default** — Thinking
  and tool-execution steps are expanded during streaming by default; the
  process safety gate ships enabled but zero-touch, so read-only users are
  never interrupted.
- **Unified dsh-web look** — Session todo bar, merged model/thinking selector,
  and context ring with unified status details now match between desktop and
  web.
- **System notification jumps to its session** — Clicking a notification
  prioritizes the session `record.id` and switches to that session instead of
  landing on the current one.
- **Thinking blocks & collapsible cards touch-friendly** — The whole thinking
  row toggles open/closed with hover/active feedback and a rotating chevron;
  expanded content gets a collapse button at the bottom; collapsed previews
  use a monospace font. The Web timeline gets the same interaction polish.
- **Tool cards stop spinning while running** — The running state drops the
  spinner animation (the label stays), still driven by tool execution events.
- **Centered home composer** — The ComposerArea on the empty home page is
  uniformly centered at the same width as the guide page, no longer offset by
  leftover layout.
- **DevTools shortcuts consolidated** — Shortcuts are consolidated in
  `devTools.ts`; F12 inside a webview now opens the main window's DevTools
  instead of being swallowed by the embedded page.

### 🔧 Performance

- **Streaming render optimizations** — Frozen chunk references stay stable
  (no per-frame plugin rebuild), prefix strings are cached to avoid slicing
  large strings every frame, and settle-time full rendering is deferred to
  `requestIdleCallback`.
- **Settings page opens instantly** — The settings modal is split with per-tab
  lazy loading (first-open chunk 441KB → 25KB); the pet spritesheet switched
  to the `pideck-pet://` protocol (manifest no longer embeds a 7.4MB base64
  image) with mtime/size fingerprint caching; app-log reads are line-cached
  with zero re-reads of history files.
- **Wider streaming push window** — text/thinking push batching window widened
  from 50ms to 100ms, cutting render frequency further on top of incremental
  rendering.
- **Streaming event flood no longer leaks memory** — Streaming rendering is
  O(n) per-frame scans and full IPC events are handled on demand; RAM no
  longer climbs to GB-scale without dropping back under event floods.
- **Plain-text fallback for unfreezable messages** — Long messages that cannot
  be frozen render as plain text during streaming, settle-time full rendering
  is capped, and the typewriter stops idling frames.

### 🐛 Bug Fixes

- **pi custom path fallback** — When `customPiPath` becomes invalid, detection
  falls back to auto-detection instead of getting stuck.
- **Update check is manual-only** — Updates are only triggered from the
  settings page; with updates disabled, no auto checks or spinner states.
- **Drawer tab width breathing** — Unified `scrollbar-gutter: stable` on
  scrolling containers stops the drawer width oscillating on tab switches.
- **Floating session menu follows resize** — The session-position floating
  menu tracks window zoom/resize (ResizeObserver writes back panel pixels);
  sidebar width syncing fixed too.
- **Project path tooltip flicker** — Hovering no longer toggles the tooltip
  open/closed, and the trigger area covers the whole row.
- **Git panel collapse header** — The collapse button aligns with the real
  32px header height instead of sitting 6px low and clipped.
- **Pet window session isolation** — Partition constants are unified so the
  sprite protocol attaches to its own dedicated session.
- **Streaming scroll-follow never yanks history readers back** — While
  streaming, a slight scroll up (touchpad inertia / accidental input) no
  longer escapes the bottom-follow (growth guard band), so the reply keeps
  scrolling into view. After the user has genuinely scrolled away to read
  history, content growth no longer drags them back to the bottom — follow
  re-locks only when they scroll back down near the bottom, so no manual
  scroll-to-bottom button is needed.
- **Context ring popover re-anchors instead of closing** — The context-meter
  popover re-anchors to its trigger on scroll/resize (rAF-merged, no re-render
  when the position is unchanged) instead of auto-closing while the stream
  scrolls; outside click / Escape remain the only ways to dismiss it.
- **Thinking-collapse trailing whitespace** — A thinking step collapsed to a
  single line no longer leaves trailing whitespace in its end state.
- **Add-project no longer hijacked by chat (#149)** — The add-project entry
  point is no longer taken over by the session chat area and stays reachable
  from the sidebar.

## v0.7.0 - 2026-08-13

### 🚀 New Features

- **Session-first architecture (#113)** — Sessions are now the first-class
  citizen: runtime bindings, streaming state, composer, and runtime UI are
  scoped per session; the global agent-centric state was migrated to Jotai atoms
  keyed by sessionId.
- **Session tab bar** — Pin tabs, drag-to-reorder with insertion indicator,
  preview mode with auto-pin on send, status badges, and a unified tab dropdown
  (new-session entry moved into the project dropdown).
- **Split view rework** — Focus-driven view switching, per-panel exit from split,
  and split-group capsules with custom names/colors.
- **Session branch navigation** — A message-branch pager (AI Elements style) to
  navigate between forked conversation branches.
- **Streaming rendering overhaul** — Typewriter reveal (useSmoothStream) on a
  dedicated live stream channel; thinking steps stream in as Markdown; the
  execution process folds into a Chain-of-Thought step timeline; intermediate
  replies stay inside the fold; scroll position survives session switches.
- **Session file change summary** — After a session completes, the files
  written/edited in this round are summarized at the end for review.
- **Theme system** — Skin presets, custom background images, switchable accent
  colors (warm-white palette), and wallpaper transparency for panels/dialogs;
  content max width is now a percentage of the session panel (legacy px values
  migrated, cap raised to 1800).
- **Editor: CodeMirror 6** — Replaced Monaco (bundle 72MB → 39MB); default edit
  mode, auto-save, right-click selection reference, image/PDF preview; the editor
  became a first-class drawer panel.
- **Markdown: Streamdown as the single engine** — Code / mermaid / math all
  render via Streamdown official plugins; react-markdown removed.
- **Git inline operations** — Inline add / rollback / open-file in the Changes
  list (VS Code semantics); push/pull status badges; delete via context menu
  (goes to recycle bin); commit-message generation with progress / timeout /
  debounce; diff rendering via @pierre/diffs.
- **RPC log viewer & audit** — Real-time RPC log dialog (auto-scroll / search /
  copy / save to file); log query & audit (logQuery / sharedLogger / trash
  audit) with a rebuilt LogViewer.
- **Usage statistics** — Settings tab with real-time durations and per-session
  average cache hit rate; onboarding card with one-click install.
- **Model management** — Live model list (local models.json preferred, new
  models take effect on agent restart); model table with capabilities column;
  tiered pricing editor; latency metrics (TTFT / total time / tokens per second)
  in session context detail.
- **Vision bridge** — Gives non-vision models eyes via tool results; prompt
  template persisted to config file.
- **System notifications** — Session end and AI asks raise system notifications;
  clicking jumps to the conversation.
- **Pet status reminders** — Head bubbles, font follows settings, colored status
  words, and waiting-for-action hints.
- **Web service: SSE + React frontend** — `/api/chat` streams via the AI SDK
  UIMessageStream protocol; the external web UI is aligned with the desktop UI.
- **File tree → composer @-references** — Drag files or directories onto the
  input to insert @ references (including @directory).
- **Window & layout memory** — Window size preset `last`; sidebar/drawer widths
  and settings-page tab positions persist across restarts.
- **Cache cleanup** — "Clear UI local cache" action in the settings cache/log
  page.
- **Image generation mode** — Composer switches to image generation, reusing the
  existing model configuration; beUI dot-matrix animation covers generating →
  done → failed states; results render as messages (the prompt appears
  immediately, the image follows the assistant reply).
- **Security management** — Tiered tool-permission gates (pi-deck-security-gate
  extension + Pi management config + session-level switch); thinking effort and
  safety level can be switched while a run is in progress (#146).
- **Model spec autofill** — Built-in SQLite spec table (synced before releases);
  SenseTime / StepFun models included; saved models auto-complete their specs
  instead of hardcoded defaults.
- **Web service: LAN access + QR code** — Local-network access with a scannable
  QR code in settings; the Web UI can start new sessions straight from the home
  page (model / thinking preferences included); model list, create-project and
  header sidebar on the Web panel; session/project lists sorted by time with
  project sessions collapsed to 5 by default.
- **Usage stats: daily breakdown** — Today overview and per-day searchable
  details; aggregator v2 with per-day model/project breakdown.
- **Audit trail expansion** — Session create/copy/export/rename and the full
  runtime lifecycle, settings/security-sensitive operations (secret values never
  written to disk), pi process spawn diagnostics and agent lifecycle exit
  decisions, background image / git init / single-instance / web-service
  start-stop, and log-clearing all leave audit records.
- **Vision bridge enhancements** — Conversions visible in the session (image
  cards + request details); configurable timeout (default 30s → 120s);
  "unlimited" max_tokens option; saves unified through the settings dialog
  header.
- **Collapsible thinking line (deepseek-harness mode)** — Thinking is
  collapsed to a single line by default: while streaming it shows the latest
  line with a sweep animation, then switches to the first line and stops (the
  earlier marquee approach was removed); clicking the title row expands the
  full text.
- **Per-turn duration moved to the end** — Turn duration now sits at the tail
  of the turn (live while streaming); the row header keeps only the time.
- **Send-to-top animation removed** — Sending no longer smooth-scrolls the
  viewport to clear the screen: it conflicted with stream following and caused
  occasional jitter; plain bottom-follow is restored.
- **Diff improvements** — Large-file diffs get GitHub-style folding /
  virtualization / worker rendering; the change view defaults to changed hunks
  only; per-turn file-change lists (TurnFileChanges with beUI FileDiff syntax
  highlighting) replace the bottom global summary; file lists with more than 3
  items collapse by default.
- **Paged history for very long sessions** — 12-turn cache + three-level paging
  pipeline; full output viewable in history sessions; smoother scroll-up paging;
  fixes edit/delete/re-send targeting.
- **Parallel ask panel** — Send-behavior menu always visible (shadcn dropdown)
  with anonymous-session capsule results; ask cards render and support
  answering.
- **Log viewer** — Time-range filtering and paged navigation.
- **Process monitor** — Shows the session title bound to each agent; dedicated
  memory metric matching Task Manager; only pi agents tracked (Electron's own
  processes excluded).
- **Tray restart** — "Restart" item in the tray menu (clean shutdown then
  relaunch).
- **RPC log menu** — Right-click action changed to "Open RPC log" and works
  while the agent is running.
- **Unified save placement** — Pi management and security pages save through the
  dialog header (unsaved-changes yellow dot + close confirmation; per-tab save
  buttons removed).
- **Formula copy** — Inline formulas copy by clicking the formula body; a
  persistent copy button covers both inline and block formulas.
- **UI polish** — Narrow-sidebar button yield, ordered todo list, widget
  type-scale and file-row hover transitions; compact cards aligned with thinking
  cards and long user messages auto-fold; session header breadcrumb
  (project/title) with TODO badge; beUI ReasoningText status indicator;
  completed todos keep a check mark without strikethrough.
- **Prompt management** — Delete confirmation dialog; copy buttons default to
  text with animated shadcn DropdownMenus.
- **Misc** — Ctrl/Cmd+click links open in system browser; fee tooltip converts
  to RMB (est. rate 7.2); boot animation + AppErrorBoundary + error reporting;
  session restart transition animation; default model config for new sessions;
  collapsible ask panel with object options.

### ✨ UX Improvements

- **Sidebar discoverability** — Three-dot menu entry, blurred overlay backdrop,
  and collapsible sub-items in the project tree.
- **Attachment picker** — Defaults to files only; pasted images preview as images.
- **RPC log interaction polish** — Unified right-click menu across session/agent;
  toggle disabled with a hint when the agent is not running.
- **Tool call timeline** — Compact and low-key tool cards with three-state status
  badges.
- **Feishu bound sessions** — ask interactions disabled with a clear hint.
- **Content width & cards** — 100% content width keeps 24px side gaps; message
  and input share one width percentage; mermaid keeps natural width; ask-card
  header compacted; tool cards aligned with system radius tokens.
- **Skill picker** — Simplified path display in the directory picker.

### 🛠 Architecture

- **Issue #113 structure refactor** — `shared/types.ts` split into 11 domain
  files; tsconfig split into main/preload/renderer; IPC handlers extracted per
  domain (`editorsIpc` / `scratchPadIpc` / `projectsIpc` / `storeIpc` /
  `sessionIpc` / `systemIpc`); `agentUtils` / `modelListCache` / `wslExe`
  modules; FeishuConnection extracted from FeishuBridge; App.tsx slimmed via
  10+ hooks (useSessionActions / useComposerSend / useQueuedPrompt / …) and
  component extraction (AppShell / SessionView / SidebarComponents / …).
- **UI 2.0** — Tailwind CSS v4 + shadcn/ui across the app: native inputs /
  textareas / checkboxes / buttons / tabs replaced; dialogs on the shadcn Dialog
  shell; react-resizable-panels for session & workbench layouts; toasts on
  sonner; ~1900 lines of dead CSS removed.
- **Session-first runtime** — SessionRuntimeInjector isolates streaming from the
  App root; session-owned composer / timeline / sidebar / surface; stale runtime
  results rejected by generation.
- **Packaging** — Renderer deps moved to devDependencies; asar compression
  maximum.
- **E2E infrastructure** — Playwright Electron harness with mock-pi RPC flows
  (prompt / stream / done / abort, queued prompts, model picker, compact / fork,
  restart keeps session usable).

### 🔧 Performance

- **Streaming & memory governance** — Incremental message flush, de-shiki
  highlighting, asar store, scroll takeover; renderer message cache cap 20 → 8.
- **Activation paging** — Only the latest 3 turns stream live; history pages in
  by full-turn pagination.
- **Tool output truncation** — Oversized tool results truncated on send with
  "view full output" on demand; lazy image decoding; cache release on agent exit.
- **Timeline rendering** — `content-visibility` skips off-screen layout/paint.
- **Session directory cache** — Cached tree shows immediately, background scan
  pushes updates; cache hit-rate stats file-level cached and parallelized.
- **Electron 43 & startup slimming** — Electron 43 upgrade, memory-sampling
  toolchain and first-paint reduction; process monitor uses a dedicated memory
  metric aligned with Task Manager.

### 🐛 Bug Fixes

- **"Stop" could not stop the agent** — `abort_bash` escalation plus a
  user-facing hint.
- **Disappearing intermediate replies** — Live mount points now require an
  active stream + stopReason protocol; reply-loss loops eliminated.
- **Model list permanently empty on startup** — Empty results are no longer
  cached; first empty fetch auto-retries.
- **Linux Wayland sessions** — No longer force XWayland by default (compat layer
  only when the pet is enabled).
- **Delete operations** — Unified through the system recycle bin with audit logs.
- **Historical session rename/copy** — Uses pi-native session_info append format.
- **Web dev proxy** — Fixed blank page and host column width; HMR websocket
  proxy added.
- **Links in dialogs** — Forced to system browser (skill/extension cards,
  diagnostics docs, env guide, web service).
- **Path refs with spaces** — Pasting absolute paths with spaces now forms
  complete file references; attachment picker defaults to files only.
- **Feishu ask/confirm** — Answer cards no longer block the agent.
- **Split/UI fixes** — Split maximize width restore, runtime-config bottom-bar
  refresh, terminal dock input-height jump, RPC log right-click menu, sidebar
  draft right-click, unstarted-agent composer history keys.
- **Black-screen governance** — Renderer crash auto-recovery; timeline scroll
  windowing.
- **History loading** — Duplicate/missing messages on history reload fixed;
  opening or switching back to history sessions no longer flashes the new-session
  start page; skeleton-screen and fade-in timing fixes; large sessions no longer
  show a wrong start page (compaction paging coordinate space).
- **Editing** — Editing a message scrolled out of view discards the stale history
  prefix ("edit doesn't refresh" fixed).
- **Streaming & timeline** — Live-body mounting gated per turn (steer no longer
  duplicates the same intermediate reply); tombstones keep id/parentId so the
  whole page is never cleared; deleting an assistant reply tombstones the same
  turn's thinking/tool chain; line-wrap scroll follows with a spring; auto-
  collapsed execution no longer steals scroll; negative-growth re-lock escape
  guard.
- **Extensions** — `(filtered)` suffix from `pi list` parsed, so filtered
  installs can be uninstalled / updated / version-checked.
- **WSL** — Session read/write maxBuffer enlarged so large sessions no longer
  vanish from the list (#147).
- **Session security level** — Override now keyed by session identity
  (PIDECK_SESSION_ID), fixing ineffective overrides.
- **Corrupted session repair** — Auto-fixes first-line "path+header" glue and
  legacy private sessionName header lines; catalog rename retries on transient
  EPERM (antivirus locks) instead of blocking new sessions.
- **Clipboard & images** — Bitmap fallback for pasted images; right-click paste
  supports images (WeChat screenshots no longer become @path references).
- **Composer** — Plain @ / & no longer open suggestions; pastes stay plain text
  so the cursor doesn't jump; models switchable during generation (effective
  next round).
- **Tabs & split** — Fork switches to the new session and registers a pinned
  tab; Enter-send promotes preview tabs across all four send paths; pinned tabs
  share normal tab width; drawer float-bar follows zoom; startup width
  oscillation and post-cache-clear drawer flash fixed.
- **Wallpaper mode** — Frosted blocks become transparent; scratchpad panel color
  follows the system panel and background transparency.
- **Git** — Windows 8.3 short paths no longer misreport "outside" or break
  worktree deletes; untracked-file diff opens; manual refresh syncs push/pull
  badges; badges readable in dark mode; non-git repos pause polling; stage/
  unstage races skip stale paths silently.
- **Toasts** — Abnormal-session toasts persist instead of auto-dismissing;
  toasts elevated above dialogs.
- **Links** — Official-site links always open in the system browser, regardless
  of the embedded-browser setting.
- **pi runtime** — mise custom directory and dynamic PATH support; npm
  detection reuses search directories.
- **RPC & process** — RPC timeouts honor user config; failure toasts carry the
  concrete reason; manual stop no longer fires a "completed" system
  notification; first-word/total timing starts at request send (thinking mode
  uses the first body delta).
- **Models** — Spec matching/merge semantics fixed; saved models complete specs
  from the built-in table; 5 historical-model regressions fixed.
- **Misc UI** — Template-picker eye preview / back buttons readable in dark
  mode; empty-body template sends blocked with a clear hint; checkboxes in
  session-management/import dialogs toggle; default model/provider clearing
  only clears values (X no longer misaligned); sidebar section header rows fully
  clickable; extension-page divider removed; pet-window diagnostics and render-
  failure fallback; Windows icon-cache rebuild script (Task Manager shows the
  current icon); refreshed monochrome logo and neutral opencode badge.

### 🙏 Acknowledgements

- **@bfzz / @bfzha** — Git inline operations, split view, session tab bar, UI 2.0
  migration, and much of the session-first refactor.
- **@1900EasonJin** — Theme system, wallpaper transparency, pet status reminders,
  thinking-stream rendering, and terminal/UI polish.
- **@qgx1992** — Ctrl/Cmd+click system-browser links.

Special thanks to community members **微时、kylin、Island、PieDriver** for
providing model services for our software development 🎉

> 💬 **Join our QQ group for feedback & discussion: 1026218644**

Thanks to all group members who submitted suggestions and bug reports! 🙏

---

## v0.6.7 - 2026-07-29

### 🚀 New Features

- **Compact titlebar + Codex-style right sidebar** — Slimmer top chrome and
  right-drawer tabs restyled for denser multi-panel workflows (Files / Git /
  Browser / ScratchPad).
- **File editor nested under Files tab** — Editor tabs live inside the Files
  drawer instead of a separate surface; drawer chrome is tighter and more
  consistent with Git/Browser panels.
- **File tree drag / drop / move** — Drag files into the tree, paste files, and
  drag-to-move entries inside the project file panel.
- **@ file suggestions with directory tree & search** — File picker shows a
  browsable tree plus filter, making deep paths easier to reference.
- **Composer file path refs via paste / drop** — Drop or paste files into the
  input to insert path chips; spaced paths are preserved correctly.
- **Text links open in built-in editor** — Clicking text-file links opens the
  in-app editor; binary files still open externally.
- **Batch Ask Tab UI** — `ask_question` batch mode renders all questions as tabs
  with an optional Submit/review step before returning answers.
- **Ctrl/Cmd+click markdown links open system browser** — Modifier-click leaves
  the in-app browser and hands the URL to the OS default browser.
- **Tailwind CSS v4 + shadcn + sonner toasts** — Renderer styling stack upgraded;
  toast notifications migrate to `sonner` with theme-aware presentation.
- **Sidebar project expand/collapse persistence** — Project fold state is
  remembered across app restarts.
- **Session message Fork** — Fork a new session from a user message (pi `/fork`);
  hidden while the agent is busy; fills the original prompt into the composer
  for edit-and-resend.
- **Boot splash official pi assembly animation** — Cold-start overlay loops the
  same pixel tetromino logo animation as the sidebar (larger/faster); PiDeck
  title and subtitle use Plantin brand serif to match the empty-state tone.
- **Single-instance window reuse** — On by default: opening PiDeck again focuses
  the existing window (including tray-hidden) instead of spawning another
  process; can be disabled in Common settings (restart required).
- **Startup window size presets** — Appearance setting for maximized / fullscreen
  / large-medium-compact windows; default maximized (historical behavior that
  keeps the taskbar visible).
- **Compaction settings UI** — Config → Settings splits `compaction` into Auto
  compact / Reserve reply tokens / Keep recent tokens instead of raw JSON.
- **LaTeX / math fence rendering** — Session `latex`/`tex`/`math` code fences
  render with KaTeX.
- **Electron Chromium sandbox toggle** — Dev setting to enable renderer sandbox
  (off by default for Windows AV/GPU compatibility); requires app restart.

### ✨ UX Improvements

- **Plan mode flow polish** — End-of-plan three-card layout, revise back button,
  and clearer read-only skip behavior.
- **Composer widgets & extension UI** — Extension widgets stay above the
  composer, height is more compact, and built-in extension conflict handling is
  friendlier (including todo labels).
- **Context compact entry** — Composer compact control only shows when context
  usage is above 30%; calmer styling, and friendly toasts for session-too-small
  / nothing-to-compact errors.
- **UI color neutralization** — Reduce saturated green accents; refine composer
  bar and status indicator contrast.
- **Worktree sidebar hierarchy** — Clearer nesting, collapsible worktree
  sessions, lighter fills, and less visual noise on active rows.
- **Extension install / uninstall UX** — Clearer progress and reliable local file
  cleanup on uninstall.
- **RPC / agent launch options** — Optional `--no-themes` / `--offline` /
  `--no-extensions` / `--no-skills`, version cache warm-up on app start, and
  dev settings to disable extensions/skills for faster or safer launches.
- **Docs & community** — Docs-site screenshots updated to the latest UI; expanded
  English home and bilingual nav; README Star History chart auto-updates via CI;
  tutorial video production workflow added for maintainers.

### 🐛 Bug Fixes

- **Composer history ↑/↓ drops half-typed draft** — ArrowUp now snapshots the
  live draft from `livePromptByAgentRef` instead of a stale rendered prompt, so
  ArrowDown restores the full in-progress text.
- **Agent start crash-safety / diagnostics (esp. macOS arm)** — Attach pi process
  lifecycle listeners before `spawn`, keep a default `error` sink so ENOENT no
  longer becomes an uncaught main-process crash, surface structured startup
  failure cards, and log platform/arch + child-process-gone details for Issue
  triage. Also expand macOS pi search paths (`/opt/homebrew/bin`, etc.) for
  Dock-launched PATH gaps.
- **Pet stuck on review/failed/jumping** (#107) — Transition recovery timers are
  no longer cleared by cooldown/overlap early-returns, so review/failed return
  to idle on schedule.
- **Stop abort afterglow** — Seal stream generations on abort so delayed
  thinking/text no longer mix into the next reply; stop feedback is toast-only.
- **Disabled built-in extensions still loaded** — Remove/conflict yield now deletes
  user-dir built-in extension files and purges residuals so third-party tools no
  longer clash and break RPC.
- **Manual compact button & state** — Restore composer compact control; send
  `customInstructions` on RPC; clear `isCompacting` and return to idle after
  finish; surface concrete failure reasons in toasts.
- **System titlebar missing sidebar toggles** (#104) — Left/right sidebar
  switches remain available when using the OS native title bar.
- **Paste image as attachment + spaced path refs** — Image paste attaches as
  image content; file path chips keep spaces instead of breaking mid-path.
- **Terminal dock race / unhandled rejection** — Harden dock against pending
  agent transitions and avoid unhandled promise rejections on close/switch.
- **Terminal dock owner isolation** — Dock state is keyed by owner so project
  terminals no longer leak across agents/sessions.
- **Clipboard “Document is not focused”** — All copy paths go through Electron
  main-process `clipboard.writeText` via preload, with graceful fallbacks.
- **Local file links + todo widget fonts** (#103) — Local file links are
  clickable again; todo widgets honor the configured interface font.
- **Incomplete tool/thinking turns merge into next reply** — Thinking-only
  assistant turns are preserved; normal incomplete runs no longer get merged
  into the following answer.
- **Resend safety** — Resend only truncates descendants of the current user
  turn and refuses unsafe non-last-user roots.
- **Select cancel no longer picks first option** — Cancel returns `value: null`
  instead of a cancelled sentinel that could be misread as a selection.
- **Agent `get_state` timeout auto-retry** — Startup state fetch retries on
  timeout instead of leaving the agent stuck.
- **Composer placeholder & prompt history** — Clearing the input restores the
  placeholder; prompt history persists across restart.
- **Manual release with empty tag** — Workflow_dispatch without a tag publishes
  a formal release instead of a draft-only artifact.
- **macOS test build OOM** — CI mac build uses `build:fast` and a higher Node
  heap limit.
- **package-lock dependency sync** — Restore missing lockfile entries after
  merge/tooling drift.

### 🙏 Acknowledgements

Thanks to all contributors for their PRs, issues, and feedback in this release:

- **@1900EasonJin** — System titlebar sidebar toggles (#104); pet stuck-state fix (#107)
- **@zzq168281-coder** — Interactive local file links & todo font honor (#103)
- **@me9rez** — TypeScript incremental build output hygiene (#97)
- **@weishiair** — Delete residual built-in extension files on disable to stop tool conflicts/RPC failures
- **@clancyclaw** — Preserve RichInput newlines for multi-line drafts

Special thanks to **微时佬友** for providing the Grok model service used in our
community testing environment 🎉

> 💬 **Join our QQ group for feedback & discussion: 1026218644**

Thanks to all users who submitted suggestions and bug reports for PiDeck! 🙏

---

## v0.6.6 - 2026-07-24

### 🚀 New Features

- **Sidebar brand lockup redesign** — The official pi canvas logo now uses a cropped
  bounding box (no empty board space), displays the PiDeck wordmark in Plantin serif,
  and animates on agent start/close events for visual feedback. The settled color is
  theme-adaptive (ink/white).
- **Multi-tab file editor** — Up to 5 concurrent editor tabs, modal/drawer dual mode,
  diff comparison mode, Monaco editor with dark/light themes, Markdown preview, and
  auto-save (Ctrl+S) with dirty state indicator.
- **Session reference (@-mention)** — Type `&` to pop up the session list for the
  current project, select specific messages or reference the full context. Selection
  persists across reopens.
- **Feishu/Lark integration** — Bi-directional messaging, streaming cards, auto-group
  creation, member management, and a dedicated Feishu link indicator in the composer.
- **Git source control (major rewrite)** — VS Code-style 3-tab panel (Changes / History /
  Compare), AI commit message generation, Git graph with colored lanes, cherry-pick /
  revert / reset / drop via context menu, branch switching, and worktree support.
- **Git Push / Pull** — Push and Pull buttons in the Changes pane header with full IPC
  pipeline and error notifications.
- **Customizable Commit Message Prompt** — New Setting `gitCommitMessagePrompt`,
  a textarea in the Git section, template supports `{diff}` placeholder, Gitmoji mapping.
- **Git panel relative paths** — Directory group headers now show paths relative to
  project root instead of absolute file system paths.
- **Chinese Prompt Store (XuePrompt)** — Replaced old yao-prompts files with SQLite
  database (~4000 Chinese prompts). Supports 20+ category filters, FTS3 full-text
  search, pagination, and one-click import.
- **Skills.sh Community Skill Store** — Switched to CLI registry
  (skill.xfyun.cn) for search, installing via `npx -g -s <skill> -y` with sort by
  downloads and installation animations.
- **HTML preview uses built-in browser** — Opening an HTML file defaults to source view.
  Clicking the preview button switches to the right-side browser panel with webview
  rendering, eliminating iframe sandbox restrictions.
- **Composer redesign (OpenCode style)** — Replaced the top pill-button toolbar with a
  bottom bar: mode toggle / prompt template / attachment / model name / thinking level.
- **Client message queue** — Queue messages while the agent is busy (follow-up or steer
  mode). Retract queued messages back to the editor. Visual queue status.
- **Recommended extension packages** — All packages show copy-install-command buttons,
  action buttons arranged horizontally, install status per-package.
- **Async skill installation** — `npx skills install` runs via `execFile` without
  blocking the main process UI.
- **Built-in browser panel** — Browse in the right drawer with tabs, fullscreen, and
  mobile viewport presets. Links open internally in the browser panel.
- **ScratchPad** — Overlay-style scratch pad with content preview, selection mapping,
  and theme-aware semantic colors.
- **Local packaging** — `npm run compile-exe` for fast portable `.exe`. `npm run dist:win`
  supports single-format builds (nsis / portable / zip).
- **Auto-scroll to latest message** on historical session open.
- **Toast notification system** — Self-built notice mechanism replaces `sonner` dependency.
  Agent operations, file copy, model switch, and Git actions all show notifications.
- **Expandable compaction card** — Pre-compaction message history visible in a
  collapsible section.
- **WSL environment support** (experimental) — Session scanning, file operations, and
  path handling adapted for WSL.
- **WSL environment support** — Session scanning, file operations, and path
  handling adapted for WSL (via @Lopution PR #84).

### ✨ UX Improvements

- **Settings redesigned** — Global draft save/cancel replaces per-tab save buttons.
  New tab categories: Common, Appearance, Proxy, Dev, Pet, Storage.
- **Font size/face per-zone** — Independent font size configuration for chat, code,
  sidebar, and composer. Preset themes (Sans/Serif/Mono) and window zoom.
- **File sidebar** — New create file/folder functionality, tree view for Git panel,
  relative paths, persistent drawer state per project.
- **Behavior selector moved left of stop button** — Clearer visual layout.
- **Composer bottom bar style unified** — All buttons use `composer-bar-btn` style
  (28px small radius).
- **Skills/Prompts auto-refresh on local tab switch** — Newly installed items
  immediately visible.
- **Document preview** — Markdown files default to rendered preview (with source
  toggle). HTML files preview in the built-in browser panel.
- **File diff side-by-side toggle** — Now works reliably in modal mode (key remount +
  keepCurrentModel). Button hidden in drawer mode (container too narrow for split view).
- **Built-in browser webview stability** — Fixed initial load cancellation (ERR_ABORTED),
  dom-ready infinite refresh, and webview-not-ready white screen issues.
- **Browser close/maximize buttons moved to tab bar** — Saves vertical space.
- **Copy install command button** — Added next to install buttons for manual terminal use.
- **Session outline & quick action bar** — Floating outline panel with jump-to-message.
  Quick actions: terminal, file drawer, Git, browser, scratch pad, external editor.
- **NoSession anonymous agent** — Chat entry at top of project list, writes to app
  user-data directory for general conversations.
- **Content width restriction** — Draggable content width slider for comfortable
  reading of long code lines.
- **Pin mode** — Pin frequently used agents to the top of the sidebar.

### 🐛 Bug Fixes

- **Monaco CSP error** — `loader.config({ monaco })` moved to module scope, preventing
  CDN fallback blocked by CSP.
- **TurnRow "Rendered fewer hooks" crash** — Moved `useMemo` before early returns,
  fixing white screen on sending messages.
- **"TextModel got disposed before DiffEditorWidget model got reset"** — Added
  `keepCurrentOriginalModel` + `keepCurrentModifiedModel` to prevent model disposal
  race when switching diff editors.
- **Stop button invisible during agent response** — Now always shown when agent is busy.
- **NoSession anonymous agent duplicate in sidebar** — Added `noSession` matching path.
- **Agent startup status stuck on "starting"** — Fixed `setAgents` to overwrite
  existing entries when API returns.
- **Same-session resend truncation** — Fixed to delete only the last message's
  descendant entries, not everything before it.
- **Skills.sh search crash** — Added `Array.isArray` guard in `loadPersisted()`.
- **Prompt category returns no data** — DB category matching fixed between slug
  and original name.
- **Title bar color mismatch** — Unified `background` across `.window-controls`.
- **sql.js ESM loading failure in packaged app** — Fixed WASM path resolution.
- **GitService.getStagedDiff maxBuffer too small** — Increased from 5KB to 10MB.
- **Dev terminal Chinese garbled** — Auto-run `chcp 65001` on Windows.
- **HTML preview white screen** — Fixed webview dom-ready infinite refresh and
  ERR_ABORTED on initial load.
- **Docs site build failure** — VitePress YAML `&` wrapped in quotes.
- **TypeScript CI failure** — Removed duplicate `setAttachedImages` function.
- **Bundled extension disabled/re-enable** — Fixed loss of built-in extensions after
  disable.
- **Old pi compatibility** — Graceful fallback for `--no-approve` parameter.
- **Session loading indicator flicker** — Enforce a 200 ms minimum display duration
  to avoid a brief flash on fast API responses.
- **Send message auto-scroll** — Scroll to end instead of beginning.
- **Thinking animation removed** — Unified "responding" animation as default.
- **Agent idle after agent_end** — Added fallback idle check to avoid stuck animation.
- **Multi-select image share padding** — Added padding to avoid text clipping.
- **Ask dialog interaction** — Confirm button sizing, custom input always visible,
  hide background card when dialog open, filter out Pi's default ✎ option.
- **Message CPA_DONE marker cleanup** — Strips `CPA_DONE` from message end.
- **User message edit** — Edited text backfilled to composer for re-sending.

### 🙏 Acknowledgements

Thanks to all contributors for their PRs, issues, and feedback:

- **@1900EasonJin** — Feishu integration, MemSpacedCard, think throttling, sidebar
  card design, ScratchPad, terminal encoding fix (#80, #74, #60, #44, #42, #35, #34)
- **@frostime** — Session info sync, custom font/zoom, model picker auto-scroll,
  max thinking level, RPC extension lifecycle (#58, #56, #53, #52, #50)
- **@me9rez** — Dependency cleanup, SkillManager symlink scanning (#86, #69)
- **@bfzha** — VS Code-style Git panel with complex workflows (#68)
- **@Lopution** — WSL path handling across desktop boundaries (#84)
- **@buaassp** — Hide internal pi-subagent sessions (#57)
- **@magic2066** — Codex subagent import fix, Linux dev/pet fixes (#40, #41)
- **@pangolinknight** — Stream throttling, tool result truncation, white screen fix (#33)

Special thanks to **微时佬友** for providing the Grok model service used in our
community testing environment 🎉

---


## v0.6.5 - 2026-07-13

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
