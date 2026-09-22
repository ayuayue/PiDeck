## v0.7.7-beta - 2026-09-21

### 🚀 New Features
- **Search workspace files by name (#215)** — The file drawer toolbar gains a search button that searches as you type (250ms debounce): the main process scans file names across the whole workspace (same ignore rules as the file tree, any depth), skips oversized directories one level at a time, and returns whatever it has collected once it hits the 200-result cap or the 8s timeout — huge monorepos get usable results in seconds instead of hanging or being rejected. Results are a flat list with the same Seti icons as the tree and highlighted matches; single-click previews, double-click opens permanently, and the right-click menu is shared with the file tree (reveal in folder / copy path work out of the box). While the debounce is pending, shortening the query filters the last full snapshot client-side for zero-latency feedback, and stale results from a slow scan are dropped by generation so they never overwrite newer input; Esc first clears the query, then closes back to the tree.
- **Import sessions from another directory (recover history after a move or rename)** — The project context menu gains “Import sessions from another directory”: it first lists the session directories that actually contain sessions (the source list only holds directories with sessions — pick one to list its sessions, or use “choose another directory”), then imports the checked ones in one go and reports how many succeeded / failed. Imports go through the existing importer and are converted into pi-readable sessions tagged by source instead of being copied raw, so a moved or renamed project folder gets its history back without moving JSONL by hand; selecting an ancestor directory (the whole session-library root, say) no longer floods the candidate list with every session.
- **Import external resources (MCP / skills / prompt templates)** — The configuration page gains an Import entry that pulls MCP configs, skills and prompt templates in from an external source, with a choice of destination (global Pi MCP / project Pi MCP / global skills / project skills …). Reads and writes are boundary-checked first, so a path escaping the project or the app-data directory is rejected instead of half-writing into existing config (thanks @zx3022448, PR #221).
- **Strict tool sampling can be switched explicitly (`compat.supportsStrictMode`)** — Since pi 0.86 the read / bash / edit / write tools are described with strict JSON-schema definitions (on by default for openai-completions), and a relay that does not understand strict mode can leak tool calls as plain text markers (common on DeepSeek-family routes). The provider form gains a three-state “strict tool sampling” control — follow pi's default / on / off — so config files no longer need hand-editing.
- **Hide and reorder providers, models and auth entries** — Models can be hidden individually (collected under a “hidden models” group with one-click restore) and auth entries have their own independent hide / restore; provider cards support drag reordering (drag, plus move up / down and “restore default order”). The order is a local PiDeck preference that is never written back to config; the Models and Auth pages share one order, the model picker follows it, and DSH lists providers in the same order.
- **New “cycle model” and “cycle thinking effort” shortcuts (Ctrl+M / Ctrl+T, macOS ⌘⌥M / ⌘⌥T)** — Cycle through the session's favourite models (the footer model name updates immediately) and through thinking effort; empty favourites, a single favourite, models without effort control and a failed catalogue load each get an explicit message, and both bindings are rebindable in Settings.
- **Session tab hover tooltips show the workspace** — The tooltip is now two lines: the session title first, the workspace (project folder name + full path) second, and the breadcrumb's workspace segment gained a pill background — same-named sessions across projects can be told apart without opening them.
- **Hour-scale durations for long tasks** — Steps past an hour render in hours (days beyond that) instead of readings like “3120m”.
- **DSH host can be stopped manually (persisted across restarts)** — The DSH configuration overview gains “Stop host / Start host”: once stopped, PiDeck never auto-starts it again (restarts included), active DSH sessions stop too, and the overview reports “stopped manually” with a way back. This removes the deadlock where the DSH CLI wanted to own the host while the foreground PiDeck instance kept taking it back.
- **The pi environment guide installs portable Node and the pi CLI in one click** — The environment guide walks through “install Node → confirm npm → install pi” with runnable steps, and existing installs take the “already installed pi?” branch to verify; the portable Node copy only serves PiDeck and leaves the system PATH untouched.
- **DSH runtime archives are cross-packed from a single runner** — Runtime archives for all six platforms are now cross-packed by one runner, shortening the re-publish path instead of queueing per-platform native runners.
- **The model catalogue moves to pi 0.86.1 (1443 models)** — Refreshed from upstream against the previous 0.85.1 snapshot: 145 entries added, 56 removed and 140 changed, bringing two new providers (radius at 27 entries, meta at 5), amazon-bedrock gaining its apac / eu / global / in / us-gov region prefixes (+38) and an openrouter refresh (366 → 380). Settings → Model catalogue → “Check for updates” pulls it right away, from either source, with no release required.
- **Compact Windows quick tasks straight from Explorer (PR #243)** — The Explorer right-click menu for the desktop, folders and folder backgrounds gains “PiDeck quick task” (on Windows 11 you may need “Show more options” first): picking a folder opens a compact 720×760 window with nothing but the composer, and whatever you send runs in the normal session runtime. Closing the small window returns to the workbench with the task still running, and **nothing executes until you press send** (no accidental runs); a folder that is not yet a project asks you to confirm “add it as a project” before you can type, and a missing / non-folder / no-permission path each get their own message instead of a generic failure. The entry can be toggled in Settings — it registers independent verbs, so switching it off leaves the existing “Open with PiDeck” registration untouched (thanks @r0y1z2, PR #243).
- **A cross-project “recent sessions” section on the activity page (10 rows by default, load more on demand)** — The activity rows only cover agents bound to the current runtime (live and terminal states), so after a restart the agent list is empty and the whole activity page goes blank — the sessions you just used are the ones with no way back in. A cross-project “recent sessions” section now sits below the activity rows, separated by a divider: the row count is windowed (10 by default, +10 per “load more”), decoupling DOM from total history (exactly what made the page feel slow); row chrome, selected background and the trailing “⋯” menu are character-for-character identical to history session rows; mounting quietly warms up project catalogues that have not been scanned yet (one request per project, no loading state, no scan storm), the full-page empty state only appears when both sections are empty, and an empty recent section collapses entirely rather than leaving a floating divider. A follow-up round tightened the layout further: the activity page is split into two independently scrolling regions (each `min-h-0 + flex-1 + overflow-y-auto`) with “recent sessions” living permanently in the lower half — a long activity list can no longer push it out of view, nor the other way round — and section titles stick to the top; the pager is `sticky bottom-0`, pinned to the lower edge when the content overflows so it is visible without scrolling all the way down, while still occupying its own row so it never covers the last one. The pager entry is verbatim the project page's (the margin / padding that pushed it 14px to the right is gone, and the number column uses `session-more-btn + ml-auto`), row height is 26px everywhere (session rows are 32px, so the pager sits one notch lower), section titles went up to `font-semibold` to match the project page's group headings so a section reads as a section rather than one more session row, and once the list has been expanded a “collapse” entry appears (gated by the `canCollapseRecent` pure function — the initial 10 rows alone cannot be collapsed).
- **Import dialogs: search and incremental rendering for session and directory lists** — Importing external sessions can mean thousands of rows, and rendering them all at once is visibly slow: the three session lists (Codex parent rows / orphan subagents / generic list) and the “import sessions from another directory” source list now render 40 rows first and append as you reach the bottom, with the search row outside the scroll container so it stays visible while scrolling. Matching lives in a pure strategy module (the index is rebuilt only when the session list changes, and typing only does substring checks), so it is unit-testable without React. In search mode “select all” applies to matching rows only, so already-checked rows that do not match are never cleared; the source list can be searched by project path / group directory / session count / last used.
- **Quick messages in the composer footer (insert, or send straight away — maintain them in Settings)** — The usual nudges (continue, commit, push, commit + push …) had to be retyped or dug out of history every time. A quick-message button now sits to the right of the permission control in the composer footer: clicking an entry inserts it into the input, while the button at the end of the row sends it right away — without consuming the draft or attachments and without restoring the text if delivery is rejected, so whatever you were writing stays intact. The factory list is no longer hard-coded: the shipped resource `resources/quick-messages.default.json` provides 16 common instructions, and the single runtime source of truth is `quick-messages.json` in your user-data directory — editable by hand, with “open config file” and “reload” in Settings, and re-read every time the popup opens, so hand edits need no restart; entries left behind in `settings.json` by an older build are migrated into it on first read. Entry management no longer sits flat on the settings page — 16 inputs plus reorder buttons stretched it to nearly a screen and a half and pushed the rest of the settings out of sight. The settings row now keeps only “first 3 entries + N total + configure more…”, which opens a dedicated dialog: the dialog has its own scroll area and its height does not change with the entry count, it supports search (case-insensitive substring; Enter inserts the first hit and leaves IME composition alone) and paging (8 per page with the page number clamped), rows are 28px tall and long entries are truncated, and insert / send are two side-by-side buttons that no longer rely on menu `stopPropagation`; “open config file” / “reload” collapse into icon buttons on the search row. (At the 30-entry cap a dropdown menu burst through the window, so the popup became a Popover.) Settings → Common → “Quick messages” still supports add / delete / move up / move down / restore defaults, caps the list at 30 entries with case-insensitive de-duplication, merges keystrokes over 400ms, writes add / delete / reorder immediately and flushes on blur or dialog close (outside the settings dialog's save / cancel cycle).
- **Typing `/login` in the composer opens the desktop login dialog instead of being sent to the model** — `/login` was already in the built-in command table and its hint text, but the send path intercepted only two hard-coded patterns (`/new` and `/compact`), so `/login` fell through to the ordinary send branch: users asked to log in and the model answered “I can't do that”. Classification of the take-over commands (new / compact / login) now lives in a pure module (`composerSlashCommand.ts`) and the send path only dispatches: a `/login` hit opens the login dialog (`/login <provider>` preselects a provider) without writing an optimistic bubble, creating a session or taking the send lock, since logging in produces no conversation content. The dialog side adds `ProviderLoginModal` + `useProviderLoginFlow`, going through the auth exception channel (`resources/pi-auth-host.mjs`) to list providers, log in, answer pi's follow-up prompts, cancel and log out — credentials are still written into pi's own `auth.json`. One adjacent reducer defect that could stall the flow is fixed too: unrelated events no longer clear a pending prompt (which made the input box vanish while pi was waiting, stalling until timeout).
- **The session tab width cap is now an appearance setting** — The hard-coded 104px (132px for tabs carrying a DSH / image-gen / Plan badge) was the measured readability floor, but it felt tight on wide screens and could not be adjusted at all. It is now a slider under Settings → window appearance: 104 by default (zero migration, pixel-identical to the old look), range 80–400, with badge-carrying tabs widened by +28px (the old 132 − 104 delta). The slider clamps locally for instant preview and the main process normalises again on save, so dirty values (non-numeric / out of range / strings) fall back to the default. The boundary rules live in a pure module (`shared/sessionTabWidth.ts`) shared by the store and the settings page so the two min/max pairs cannot drift, and session tabs plus file / diff tabs read the same root-injected CSS variables (`--session-tab-max-w` / `--session-tab-max-w-badged`).
- **Provider compatibility hints moved into a “?” tooltip beside the label** — The permanent small text under developer role / reasoning effort / return thinking content / strict tool sampling made the form loose and pushed the checkboxes out of view. All four are now a help icon beside the label: hover or keyboard focus reveals the original text, the full copy stays in `aria-label`, the longest one (strict tool sampling, ~130 characters) wraps inside a width-capped left-aligned tooltip, and click / Enter / Space on the trigger stop propagating so the checkbox is no longer toggled by accident. The now-unused `.config-compat-item-desc` rule is gone and the row height is tight again.

### 🐛 Fixes
- **Third-party relays no longer fail to list models — or to use a manually typed one** — two independent root causes. First, the proxy handed to the pi child process only set `HTTPS_PROXY` and friends, but pi's LLM calls go through undici, which by **default ignores those variables entirely** — so the proxy looked configured while requests still went direct, and a gateway that is only reachable through a proxy showed up as "can't list models / Connection error even with a model typed in". `NODE_USE_ENV_PROXY=1` is now injected alongside the proxy (measured: `HTTPS_PROXY` alone → FAIL; with the switch → OK models=15), and the assembly rules moved into `sessionProxyPolicy.buildPiProxyEnvPatch`, shared with the DSH host so the two can't drift. Second, turning the desktop proxy off explicitly sent `direct`, i.e. force-bypassing any proxy the user already has configured in the OS; it now falls back to `system` (follow the system setting), so PiDeck no longer cuts off the user's own network path. Model fetching is also diagnosable now: a WAF challenge page / non-JSON body reports that the request was blocked by a gateway and suggests switching the proxy or using an official client UA, and TLS handshake failures and connection timeouts each get actionable wording instead of a blanket "failed to load the model list".
- **Provider User-Agent collapsed into a single editable dropdown, with a much fuller preset list** — Previously a "pick a preset" dropdown plus a separate free-text field fought each other (after choosing a preset the text field still held the old value, and a hand-typed value never appeared among the options); they are now one editable dropdown where presets are picked and arbitrary values are typed, with "unset (use runtime default)" as a regular entry. Presets are grouped into Official CLI / Official SDK / Generic HTTP client and, beyond the existing claude-cli / claude-code / Kilo-Code, now cover codex-cli, cursor-agent, OpenAI/JS, anthropic-sdk-typescript, openai-node, GoogleGenerativeAI, Mistral, Go-http-client, curl and a full Chrome UA — for gateways that allow-list by UA. A UA containing control characters such as newlines is now flagged in the form instead of being dropped silently.
- **Shared DSH config directory is now called out (#189)** — PiDeck defaults to your local `~/.dsh`, sharing config, credentials, and plugin state with the dsh CLI, while DSH itself allows only one host per `DSH_HOME` — running both overwrites each other (the classic symptom: a catppuccin theme picked in the CLI web UI is written back to the default within minutes by the foreground PiDeck instance). PiDeck was in fact already detecting this, but only wrote it to the app log, so nothing was visible in the UI. The DSH configuration overview now reports it in two tiers: when the default directory is un-isolated it neutrally explains the overwrite risk and gives a paste-ready `DSH_HOME` isolation command; when the lock file shows another live PiDeck host it escalates to a warning and reports that host's pid; after the user has explicitly switched directories nothing is shown. The decision logic is a pure module (`dshHomeSharing.ts`) with 13 unit tests covering stale locks, our own lock, and corrupt locks (no false positives).
- **Announcement toasts no longer repeat forever** — A toast was only deduplicated in renderer memory, while the only way to mark an announcement read was opening the announcement center. Closing a toast (or letting it time out) therefore recorded nothing, so the same unread announcement was re-shown on **every launch** and **every renderer crash-reload** — and a backlog of unread items was popped one by one at 4s intervals, which is exactly the “it keeps popping up, not just once” report. The “already notified” set is now persisted in the main process (`notifiedIds`, separate from `readIds`, following the same save path as the read set), so each announcement toasts **once per machine**; a round shows only the newest item and marks the suppressed older ones as notified too (otherwise they would take their turn as the next “newest”, popping N times for N backlogged items) — older unread items still surface via the sidebar dot. Turning off “Announcement notifications” while running now also takes effect immediately: the toggle is re-read on every poll tick, so a poll already in flight can no longer keep popping (previously only the sidebar entry disappeared). Turning off a toast is deliberately **not** treated as read — the red dot and the read archive stay until the user actually opens the announcement center.
- **Wallpaper-mode dialogs are no longer see-through, and the night-mode selected state in ask cards is back** — Two separate problems. First, with a background image enabled the workbench dialogs (Settings / Pi configuration / project resources / environment) were deliberately dropped to panel-level opacity — just 30% opaque at 80% image visibility — so the page text behind them bled straight into the settings content and two layers of text interleaved; every dialog (the scratch pad included) now shares the ≥90% “dialog baseline”, while inner cards stay flattened so no double-translucent patch reappears. Second, the selected ask option was nearly indistinguishable from an unselected one in dark mode: options are shadcn `Button variant="outline"`, whose `bg-background` / `dark:bg-input/30` / `dark:border-input` utilities live in the utilities layer and, by layer order (legacy < utilities), override the legacy selected rule — in light mode only the border colour survived, and in dark mode even that was overridden. The selected state is now expressed through component utilities (with `dark:` / `hover:` counterparts) at all five option sites (batch single- and multi-select, confirm yes / no, single-card select); dark mode uses a stronger accent tint plus an accent border, the single-card select also carries a check mark as a non-colour cue, and the batch question tabs' `active` / `answered` states were collected the same way.
- **The session tab bar is no longer stretched by long titles** — Tab width caps had been widened to 208 / 256px for long titles, were tightened to 176 / 224px, and are now down to 104px (normal tabs) and 132px (tabs carrying a DSH / image-gen / Plan / Goal badge): the fixed overhead is roughly 54px (16px padding + 10px status dot + 16px close button + two 12px gaps), which leaves about 50px ≈ 4-5 CJK characters for the title at 104px — the readability floor, so squeezing further means making the status dot and close button occupy space only when active or hovered. Long titles no longer fill the whole bar, while the micro font size and per-line character budget stay; the cap is now a configurable appearance setting (defaulting to exactly these two values — see “The session tab width cap is now an appearance setting” above), and the regression guard now forbids hard-coding the old caps again (116 / 148 and max-w-44/52/56/64). The contrast problems of the tab hover tooltip and the breadcrumb workspace segment (grey, hard-to-read hover text on light themes) are fixed as well (thanks @xiaYuTian11, PR #226).
- **Bracketed LaTeX formulas now render (PR #251, thanks @Q-xuan)** — When a model follows the LaTeX convention of `\(...\)` / `\[...\]` delimiters, prose and table cells showed raw source like `\le` or `\boxed`: the remark-math pipeline only understands dollar delimiters, and Markdown had already swallowed the bracket delimiters as plain escapes. The render copy now normalizes bracket delimiters to `$…$` / `$$…$$` before chunking (code blocks / inline code / existing dollar math / unclosed streaming fragments stay untouched, and prose after a display formula does not fall into the formula block), still through the existing KaTeX — no new dependencies; the session text and copy content are never rewritten. Ships with real remark-math / KaTeX regression tests and an Electron E2E.
- **“Stop answering” and “Close agent” are no longer the same phrase for different things** — The run-control menu used one ambiguous phrase for two actions with very different outcomes (stop the current answer vs. terminate the process); the names are now split by intent so the target and the consequence are obvious in the menu (thanks @bfzha).
- **Skill rename is routed by skill type** — Renaming a markdown skill no longer moves the whole skill root directory (which made the skill disappear), and the missing `skills:rename` IPC handler is registered, restoring global skill rename (thanks @xiaYuTian11, PR #227).
- **Plan Mode is no longer kicked out by an ordinary message** — Sending a normal message after `/plan` no longer drops out of plan mode immediately, so a planning session can keep the conversation going.
- **Small fixes around the file tree, file references and shell text** — A file-tree lazy-load placeholder can no longer stick permanently over file names; file references inside inline code are clickable again (thanks @Q-xuan, PR #228); shell operators such as `&&` and `|` are no longer rendered as session chips; the status-glyph canvas is widened to 16×16 so its right edge stops clipping; the redundant file-reference hint extension is removed and a scheduled-task shutdown race is fixed.
- **Ask waiting hints use the question tone** — “Waiting for an answer” on ask cards (the background-ask patrol notice included) is no longer classified as an error, so the tone matches the card state.
- **Automatic retries now land in the run's process row instead of a standalone card** — The retry status card used to be inserted between tool calls and the following answer, split off from the tool timeline and visibly out of order. `diagnostic.retry*` messages are now collected into the owning agent-run's process sequence as process rows on the same level as tools / thinking (reusing the tool-card visual language), with three isomorphic states: retrying (spinning icon + amber running badge), finally failed (red icon and text + danger-soft failure badge) and retry succeeded (neutral completion badge — success still goes to a toast, and the row stays as the cycle's end marker). Grouping order matters: inside a run the retry branch flushes the preceding tools before joining the group so its timing is strictly after them, and when no run has started it stays a standalone entry rather than fabricating an empty run (`buildTurnDisplay` / `segmentSummary` summarise the retry-entry process item and `retryCount`). The timeline's system branch short-circuits every retry card through `isRetryStatusMessage`, handing the trace-keeping job over to the process rows; the success / failure toast path (`composeFailureNotice`) is unchanged.
- **The model picker's primary and secondary lines are pinned down** — The favourites bar and the “hidden models” group mix providers without group headings for context, and previously showed only the model name, so neither the owning provider nor the id was visible. The primary line is now the name (falling back to the id when missing or blank) and the secondary line is always `provider/id`; hidden rows share the same rules as visible ones (just de-emphasised). The value and fallback rules are a pure module (`modelRowLabels`) with 5 locking cases.
- **No model_change write when the model did not change** — `setModel` is now idempotent: re-applying the same model within one run no longer emits a meaningless model-change event (nor triggers a redundant session reload).
- **Backup pruning no longer deletes the wrong (oldest) backup** — The backup list sort gained a deterministic secondary key, so count-based `prune` no longer mis-deletes when timestamps collide within the same second.
- **The DSH session timeline no longer splits every intermediate reply into its own turn** — Intermediate replies within a step belong to the same turn again, matching pi's own rhythm.
- **dsh-bill no longer pins the CPU while the host starts** — Historical backfill is off by default, so starting the host no longer maxes out a core replaying old bills.
- **A provider with a proxy selected no longer goes direct** — The “fetch models” request now carries the proxy choice, so providers configured with a proxy stop failing to list models.
- **A torn settings write no longer silently resets everything** — `settings.json` is now written atomically, serialized and backed by a `.bak` fallback: a killed process or a full disk no longer makes the app read a half-written file back as all-default settings.
- **The built-in web service binds loopback by default, with mandatory token auth off-loopback** — Exposing it to the LAN is no longer wide open, and JSON bodies are capped at 2MiB (413 beyond that, the connection is dropped past 16MiB) so a single request cannot blow up the main process (thanks @bfzha).
- **Concurrent image-gen writes no longer lose lines** — Old-format migration and appends are serialized per file, so two concurrent snapshots can no longer overwrite each other, and images that cannot be stored are no longer dropped silently during migration (a count mismatch keeps the original line intact). Image-gen responses are capped at 32MB with a streaming abort that reports `responseTooLarge`, and extension-updater downloads stream with the same early abort.
- **Timeline scroll races** — Fixes occasional jumps to top / bottom when switching sessions, cold restore pinning the view to the top, slow upward scrolling being unable to escape (keeping the 30% quiet-collapse and the two-stage escape), and the inverted ordering between restore-to-bottom and asynchronous transcript reads (thanks @xiaYuTian11, PR #224).
- **AtomGit update checks 404 on macOS** — The check now reads the version from the OpenAPI, restoring update detection for macOS builds.
- **The main process is no longer frozen by login-shell PATH probing** — Probing moved to asynchronous warm-up with a process-level cache, so a first launch or a new terminal no longer stalls the app.
- **Multi-pane (split) performance** — Composer subscriptions are isolated per `sessionId` through an atomFamily, the background-ask patrol collapses into a single App-level mount, and the timeline controller subscribes to a per-session `loadState` slice: streaming in one pane no longer re-renders the other.
- **A custom Git executable path now applies everywhere** — Only some Git operations honoured the configured path while 11 read paths still used bare `git`; every one goes through `currentGitExecutable` now, so a custom Git (portable, or installed outside PATH) works for reads too.
- **Session and event boundary hardening** — Late streaming events after a stop are rejected as “no runtime” instead of leaking dead agent state; `agentsLog` / `agentsTextStream` payloads carry the full `sessionId + runtimeGeneration` triple so stale results from an old runtime are dropped; main-process direct sends are restricted to the subscribed-channel allowlist; `PiRpcClient`'s line buffer is capped at 8MB (unterminated data can no longer grow forever); Git write operations validate the commit hash and reset mode; oversized diffs are truncated to `maxBytes` before reaching the renderer; the renderer drops the webview's dead `allowpopups` / `allowfileaccess` attributes, and a batch of redundant `any` assertions plus dead IPC channel constants is gone (thanks @juzijun233 for the hardening series).
- **The skill and prompt pages can create resources again** — An earlier cleanup that removed the old forms took the whole creation path with it, leaving both pages unable to create anything. Reinstated selectively for the current architecture: the new-skill card (name / location / description) and the new-prompt card are back, routed to the global or project-level API by scope, and project-level creation still validates the project boundary. The card labels had also been flattened into one character per line by a legacy `display: grid` rule overriding the shared Label's flex layout — they now use a native label with full-width fields, and the dead styling plus its dark-mode / narrow-screen overrides are gone.
- **The sidebar segmented control no longer leaves an empty track** — Only the buttons stretched before, so widening the sidebar exposed a blank stretch on the right; the three segments (Activities / Chats / Projects) now split the track evenly, adapt to the width, and truncate labels that would overflow.
- **A disabled vision bridge no longer reports a fake “conversion failed”** — When the bridge was off and the current model had not declared image input, the old code applied the failure marker outright: users saw a red “vision bridge conversion failed: vision bridge not configured” and were sent to check their key and endpoint, which pointed the investigation in the wrong direction. In reality pi degrades unsupported images to “(image omitted: model does not support images)” before the request leaves the process, so the original image never reaches the provider and cannot 400 — “bridge is off” is a configuration fact, not a fault. It is now a neutral “[image #N not sent to the model: <reason>]” marker with an amber card and an actionable next step per cause (no image selected / stale model catalogue, restart the session / no vision model chosen), while genuine failures (unresolvable endpoint, call failed or timed out) keep the failure text; the catalogue check reads `models.json` and compares it by path + mtime.
- **The AtomGit update source now actually fetches files** — Two independent layers of breakage. First, `atomgit.com/<owner>/<repo>/raw/<ref>/<path>` had been taken over by GitCode's frontend, so a programmatic request came back as an SPA HTML shell (captcha SDK included) and `JSON.parse` on it could only fail. Second, even with the right URL the official AtomGit contents API answers with a **base64 envelope** (`{type,encoding,content}`) that the model-catalogue chain handed straight to the JSON parser without ever decoding it. Both are fixed together: URL construction (per-segment path encoding, ref moved into the query) and the base64 decoding now live in one shared module (`src/main/update/atomGitContents.ts`) used by all four chains that pull files out of the repository — built-in extension hot update, built-in prompts/skills hot update, the changelog and the model catalogue — and every source pair keeps GitHub raw as its fallback half, so choosing AtomGit changes speed, not success. Verified against the live API (`source: atomgit` → `checkRemote ok`, `remoteVersion 0.86.0`, `update ok`), with a source-scan regression guard that turns red if `${host}/.../raw/` concatenation reappears anywhere under `src/`.
- **Per-model User-Agent no longer takes up a whole column** — Most models never need their own UA override, so an inline input on every row wasted width and looked cluttered; it collapses into a fingerprint icon in the actions column — grey when unset, accent-highlighted with the current value in its tooltip when set, opening a dialog for edits (reusing the preset dropdown, groups included) with a one-click clear for overrides. Two adjacent bugs went with it: the UA dropdown rendered its group heading as the literal `section.group` (missing JSX braces), and the empty-table column count comment disagreed with the real column count.
- **The files drawer's search entry actually opens now** — The magnifier button in the files panel toolbar never rendered: the drawer passed the current project only to the session-history panel, so the files panel always received an empty project, the button's conditional render never held and no search could be issued. And even inside the search view an empty query returned `null` for the whole panel, leaving blank space with no input box in sight. The drawer now passes the current project through to the files panel and adds two keyboard entries: `Ctrl+F` (`⌘F` on macOS) and type-to-search, where the first character is carried into the query of an input that focuses itself on open; leaving search returns focus to the panel so keystrokes keep working. Search itself is unchanged (full-depth name scan, 250ms debounce, 200 results / 8s cap).
- **The ask card is pinned to the bottom of the column with full-width option rows, and the composer stays visible (#230)** — A blocking question no longer scrolls away with the timeline content: the card moved to the bottom of the timeline column, side by side with the composer, so it stays in view while you scroll back for context. Ask and the composer each take their own space, so the input box stays visible and focusable (the Ask card's height ceiling reserves the composer's minimum height, long Ask content scrolls inside the card, and the two bottom bars cannot overlap in a narrow window). Options are full-width rows everywhere (the 2/4-column grid and its 72px minimum-height heuristic are gone), so long option text is no longer squeezed into a narrow strip; single-value answers (single select / confirm) advance to the next question automatically and submit on the last one, multi_select / input / editor still advance explicitly, and single-question batches deliberately do not auto-advance so “click the option = submit” cannot misfire (thanks @bfzha).
- **File links in the chat: Ctrl/⌘ + click opens the default app, and extension-less files / directories are clickable too (#229)** — The file-link context menu gains “Open with default app” (so a `.md` mentioned in a reply can open in Typora) with the same order as the files-drawer menu. A plain click is unchanged (text still opens in the built-in editor with line targeting and a read-only diff); Ctrl/⌘ + click hands the path to the system default app, reusing the modifier gesture external links already use, with one shared platform label for the menu entry and the tooltip. Extension-less files (Makefile, .gitignore, …) and directories (trailing slash, multi-segment extension-less) are recognised now: they stay *candidates*, existence is verified by a silent stat, and false positives degrade to plain text (thanks @bfzha, @Q-xuan).
- **pi 0.86 `system` entries no longer make edits and deletes land on the wrong entry** — pi 0.86 records system-prompt and tool-list changes as `role:"system"` session entries; they produce no chat message but were mixed into an entry list filtered only by `type`, which shifted every entryId: edits and deletes that locate an entry by id landed on a neighbouring entry (resend had a text check as a backstop, edit and delete had none). The same root cause pushed notification and compaction card anchors too far down the timeline (sometimes clamping them to the end), drifted the “load more” anchor, and made the sidebar message count tally system entries as messages. “Consumes an entryId slot” is now a single predicate (`isRoleMessageRole`) shared by window-id collection, card anchors, window offsets and counting, with red-to-green regression tests (thanks @bfzha).
- **DSH v1+ sessions are visible again, and “load more” pages by turn** — Official session log files carry a format generation (v0 has no version in the name, later generations append `vN`) and PiDeck only recognised the unversioned name, so v1+ sessions simply did not exist as far as the app was concerned: on this machine 79 v0 and 21 v3 sessions coexist, and those 21 were never listed and could not be deleted. Discovery now accepts v0/v1+, picks the highest generation when several exist and prefers the compressed file within one generation, so the foreign-session list and archived titles support the new format (non-official patterns are still rejected, so half-written files never count as sessions). A separate bug: “load more” handed the renderer's *turn* count to the host as a message-event count, so a sparse session advanced 3 messages per click and took many clicks to reach older content — the count is converted by a pure function now (turns × 24 clamped to [60,120], 240 per page, at most 3 turns topped up), the page start aligns to a turn boundary, and out-of-range events are dropped so the cursor cannot stall. A click shows a spinner, and **failures are no longer silent**: a failure row (raw error in its tooltip) appears under the button with a retry, cleared when you switch sessions so it never leaks across sessions.
- **The DSH stats line has its data back** — 0.1.5 split the event mux into three streams and PiDeck subscribed only to session events plus the approval/question stream, missing the host-level `session/control` stream — the only source of projection-change broadcasts. Token usage, context pressure and cache-hit rate therefore froze at their subscribe-time values (a brand-new session had nothing at all), and the line under the composer fell back to “N turns · M steps”. The control subscription is in place now (same exponential-backoff self-healing as the main stream, with the host's re-sent baseline filling the gap after a reconnect), baseline and history-tail share one projection-seeding path, and older sequence numbers can no longer overwrite newer frames.
- **After a manual DSH host stop, history reads report a dedicated state instead of an error** — Reopening a DSH session after stopping the host manually returned an error that only surfaced as “it won't open”; that error is now the “runtime stopped” state with a primary “Start host” button that restores it in one click, and a failed read no longer overwrites the manual-stop state with an empty cache.
- **DSH foreign-session scanning is bounded in CPU and memory** — Single-frame decompression carries an 8MiB cap (zstd frames declare a contentSize, and a 339-byte frame can legitimately expand to 10MB — unbounded decompression is a main-process memory spike), title folding became an explicit opt-in that is off by default (the list only needs ids, yet read a 256KiB prefix per session and decompressed it frame by frame), and the prefix read is two-stage (64KiB first, 256KiB only when folding is really needed). Measured over 79 local sessions: id enumeration 78.5ms → 17.1ms, sidebar list 78.5ms → 26.1ms.
- **Windows no longer restore off-screen** — Restored window bounds are constrained to the visible work area, so unplugging an external monitor or changing resolution can no longer leave the window somewhere unreachable.
- **Notice details render through the same markdown pipeline as session messages** — Clicking “view details” on a long toast body used to render plain text, while announcements and similar content are markdown, so users saw literal `**bold**` and code fences; the body now goes through the same streamdown sanitize pipeline as session messages, the announcement center and the changelog (plain-text notices still break lines normally), the dialog and the announcement center no longer look different, and long bodies get a height ceiling. Clipboard writes collapsed into one `writeClipboard` as well: the toast's own implementation silently failed while the window was unfocused, and everything now goes through the Electron main process and only ticks the check mark once the write actually succeeded.
- **Per-turn duration moved onto the action row** — The duration and the action buttons now share one row with the duration at the end, saving a row of height; turns with no final answer (tool/thinking only) still show their duration. Icon sizing was aligned too (clock 12 → 14) along with the button gaps, and the translucent de-emphasis moved from the button group to the whole row so icons and the number no longer look mismatched.
- **Auth presets cover the two new 0.86 providers** — Meta (Muse) via `META_API_KEY` and Radius, which is OAuth-only (run `/login radius` in the pi terminal; the preset is marked oauth and links to the pi docs), plus a value-uniqueness guard on the preset table.
- **DSH sessions could not be created in WSL mode** — The DSH host is a native Windows process and normalises the workspace path through `realpath`, while a WSL-mode project record is a Linux path (`/mnt/h/...`): handed to the host as-is it is read as a directory on the current drive root (`realpath('/mnt/h/x')` → `C:\mnt`) and fails with ENOENT, so session creation always failed. The conversion now lives at the host boundary (`configureWsl` + `toHostPath`): workspace creation, the session file directory, archive / unarchive / delete all go through it; the manifest keeps the project-path form of cwd (so sessions still match their project and no duplicate project is created) and stores hostCwd alongside, so toggling WSL during archiving can still resolve back to the real host directory. `tab.cwd` from the renderer is deliberately untouched — it doubles as the baseDir for file links and the editor, and a WSL project needs exactly the Linux form (5 regression cases, all red before the DshHost change).
- **Session titles no longer mistake an expanded prompt template for user intent (#250)** — When the first message uses `/template`, the `<prompt_template …>` wrapper is an instruction envelope for the model, not something the user said, but neither title path stripped it: the placeholder title wrote the whole template XML into the tab name, and the async summary failed to strip before its 1600-character cut so the template body ate the budget (in the reported 2096-character message, “how are you” sat after the closing tag and never reached the title request). `shared/expandedRefBlocks` gains `textForSessionTitle`: it keeps only the text the user wrote outside the blocks, falling back to the block label (template name / session name / quote) when there is none, and all four plain-text exits (placeholder title, scan fallback, catalogue backfill, async summary) go through the same cleaning; a template-only message is named after the template directly, saving a model request the template would have drowned out. The extension is a standalone file loaded by pi via `-e` and cannot import application source, so it carries its own same-semantics copy, with tests keeping the two in lockstep step by step (any divergence is a regression). Titles already dirtied by older builds self-heal now: a title that is an unfolded block's raw text is corrected on the next message or the next scan instead of sitting in the sidebar forever. DSH's title folding (`dshSessionTitleFold`) was deliberately left alone — it is a contract isomorphic to the official dsh-session-title.
- **Title ownership is settled on PiDeck's auto-naming, and locked sessions stop being re-scanned** — two adjacent problems. First, anyone could write the catalogue title: pi runtime renames (`/name`, TUI rename, `session_info_changed`, the first-turn auto rename) all went through one callback and could overwrite a name PiDeck had generated. Only PiDeck's own auto-title extension marker (`pideck:auto-title`, and it must immediately precede the matching `session_info` change) can now claim a fresh placeholder title; `claimTitleOwnership` / `applyAutomaticTitle` separate “the user already owns this” from “still auto-overridable”, generic pi runtime names no longer enter that write-back path at all, and ownership is reserved before the asynchronous `set_session_name` lands so a late automatic result cannot outrun a manual claim. Second, sessions whose title was already locked were still re-reading their head/tail windows whenever the file mtime changed — pure waste. `SessionTitleFetchOptions.includeTitle=false` now lets locked records read only the bounded header for structural metadata (flattened-subagent parent links, fork markers), never touching the title windows, with `inferSessionNameAndValidity` branching accordingly and only the one disk probe that repairs a legacy flat subagent's missing parent link retained.
- **The todo strip's scrollbar no longer flickers** — The “in progress” icon is a rotating 16×16 svg, and Chromium measures scroll overflow from a descendant's **post-transform bounding box**: at 45° the AABB is 16×√2 ≈ 22.6px, about 1.3px taller than the 20px row, which pushed the outer `overflow-y:auto` list's scrollHeight from 104 to 105 — so the native scrollbar appeared and disappeared at the rotation's frequency (measured: 23~34 of 60 frames carried a scrollbar, clientWidth alternating 991↔981; only visible when the last row was in-progress, because only overflow below the last row counts towards scrollHeight). The row `<li>` gains `overflow-hidden`, confining the rotating AABB to the 20px row (16px of ring ink plus 2px of centred slack, clipping nothing visible), so scrollHeight stays constant and the scrollbar never appears. The rotation must stay on the svg root: moving it down to the `<circle>` was tried, but Chromium gives SVG children a default `transform-origin` of `0 0`, so the ring swings out of the box around the viewBox origin and gets clipped into a small arc. The `scrollbar-gutter: stable` added to the widget stack last round is reverted as well — the strip's own list is what flickers, a gutter cannot fix it, and it narrowed the card by 10px, breaking the alignment contract with the composer / message column. An E2E case samples the scroll fingerprint frame by frame as a regression guard.
- **Continuous upward scrolling in a long session no longer deadlocks the preload window** — Programmatic-scroll suppression used to be a boolean meaning “this frame's scroll was ours”, reset only in the next rAF: during one continuous up-scroll new scrolls kept overwriting the flag while the older rAF's cleanup ended a newer suppression early, so real up-scrolling was permanently misread as programmatic, the window stopped expanding, and you could keep scrolling back without anything earlier ever loading. Suppression is now a **deadline**-backed `programmaticScrollGuard` (with a generation token so an older rAF cannot clear a newer suppression window, and a finite window that a single-frame marker cannot cut short), so the flag can no longer latch. The E2E case grew from a 6-turn to a 9-turn conversation and requires one continuous up-scroll to cross two 3-turn windows — exactly the path that used to fail.

### 🙏 Thanks

Special thanks to **微时佬友** for providing the model service used in our
software development 🎉

Thanks to **juzijun233, bfzha, xiaYuTian11, Q-xuan, zx3022448, r0y1z2** and other contributors for their code 🙏

What each contributed this cycle: juzijun233 (the stability / security hardening series — no more main-process freezes from PATH probing, session and event boundaries, per-session subscription isolation), xiaYuTian11 (timeline scroll fixes #224, session tab width and font size #226, skill rename routed by type #227), bfzha (run-control semantics split, web service loopback binding with token auth, shell text and status glyph fixes — plus this cycle's ask card rework #230, the pi 0.86 system-entry misalignment fix and the retry card cleanup), Q-xuan (clickable inline-code file references #228), zx3022448 (external resource import #221), r0y1z2 (the compact Windows Explorer quick-task window, PR #243).

Thanks to **miller, 伊森龙** for their generous donations and support! 🎉

Thanks to all group members who submitted suggestions and bug reports! 🙏

Thanks to everyone who filed issues and feature requests on GitHub! 🙏

> 💬 **QQ feedback group: 1026218644** | **Author's WeChat: caoayu97** (mention "PiDeck"; WeChat group invites available)

## v0.7.6 - 2026-09-17

### 🚀 New Features
- **Customizable global shortcuts** — Settings gains a Shortcuts tab: Open Settings / New Session / Search / DevTools can all be rebound. Click Edit to record a key, Esc to cancel, Delete to restore the default; conflicting bindings disable save. Matching lives in the main process and applies immediately after save or backup restore; sidebar kbd hints follow the real binding, and the built-in browser webview forwards the same shortcuts.
- **Ctrl/Cmd+P command palette** — A new global command palette: fuzzy-search and jump to every settings tab plus the configuration pages (models / auth / MCP / trust / raw file), or run actions directly — restart / stop the current agent, reload the session, copy the agent ID, start a new session, open settings. Matched characters are highlighted; ↑↓ to move, Enter to run, Esc to close. Rebindable in Settings (Ctrl+P by default). It is deliberately separate from session search (Ctrl+F): the palette searches configuration and commands, Ctrl+F searches projects and sessions. Specific settings fields are searchable too: the palette jumps straight to an individual setting item (wherever an anchor is annotated) and briefly highlights the landing spot; an anchor-list-vs-source test keeps renamed fields from silently scrolling to nothing.
- **Hot updates for official prompt templates and built-in skills** — Official templates and bundled skills reuse the built-in-extension overlay (read-only `resources` → userData overlay): remote manifest + per-file sha256, atomic replace, AtomGit / GitHub dual sources; writes take effect without a restart. The settings store panel can check and one-click update.
- **WB enhancement prompt templates in the store** — Ships “general enhancement” and “deep enhancement” WB templates, available directly from the prompt store.
- **Project-scoped scheduled tasks, management as a modal** — Automation tasks can be scoped to a project. The manager is now a modal instead of covering the session workspace, so opening it does not interrupt the current session or split panes.
- **Session tab “current session actions”** — The ⋯ menu gains the same actions as the sidebar context menu: rename / duplicate / export HTML / copy session file path / open session file. When search lands on a session the sidebar has not rendered, the ⋯ menu is the stable entry.
- **Context menu for file path links in sessions** — Right-clicking a file path link in the timeline opens a menu: open in the file explorer (files are located and selected, directories open directly), copy the absolute path, or copy the project-relative path. Clicking a directory link no longer fails with a cryptic "illegal operation on a directory" — clicks are routed through a scoped stat that distinguishes files from directories first.
- **Copy the agent ID from sidebar and tab menus** — The run-control group in both the sidebar session / agent context menu and the session tab ⋯ menu gains “Copy agent ID”, so the running instance id can be pasted straight into a log while debugging (it is not the same as the restart-stable session record id); the entry is hidden when there is no binding (never started / detached).
- **DSH permission button unified with the pi security-level menu (#214)** — The DSH permission preset trigger is now icon-only, using the same shield-strength iconography as pi's security-level menu; the current preset is shown via tooltip.
- **Ask cards submit on Enter** — Single and batch cards submit with Enter after an answer (including “select then Enter”). IME composition Enter only confirms a candidate and never submits; the editor still uses Enter for newline and Ctrl/Cmd+Enter to submit.
- **Import Cursor Agent sessions** — The project context menu scans the agent transcripts under `~/.cursor/projects` and converts them into native pi sessions (toolCall and toolResult paired up), with import, source filtering, and a source badge in the sidebar.
- **Official installer no longer ships DSH runtime** — The default pack is lite: extraResources stays empty. First DSH use downloads the platform archive from the current latest app Release (AtomGit / GitHub), same sidecar pattern as runner-node. Offline / intranet builds still use `--full`. npm leftover hashed dirs from old DSH upgrades are no longer packed into the tarball.
- **Manual DSH runtime publish** — New `Publish DSH runtime` Action: packs tgz + per-platform indexes on 6 native runners (win/mac/linux × x64/arm64) and attaches them to the current latest app Release (`v*`), or an explicitly chosen tag so a patched runtime can land on an older release. No standalone sidecar tag. Re-run AtomGit sync after attaching; the workflow caches node_modules keyed by the lockfile hash, cutting the ~10-minute dependency install on windows-11-arm when unchanged.
- **Manual three-platform builds and collaboration templates** — New Windows / macOS / Linux manual build workflows (x64 / arm64 matrices off `main`, artifacts uploaded, `publish=never`), plus Bug report / feature request issue templates and a PR checklist template.
- **Compaction is handed off to extensions that own the context window** — When a session extension takes over the context window by cancelling pi's compaction through the `session_before_compact` hook (e.g. Magic Context), the ring's compact action and `/compact` no longer send a compact request that is guaranteed to be rejected: PiDeck detects the owner (its command is confirmed registered in this session via `get_commands`, the takeover switch is read from user-level config), rewrites the action into that extension's own compaction command (Magic Context → `/ctx-wrapup`) and says so; when the owner has no usable entry point it explains why (historian model not configured, several owners installed at once) instead of appearing to do nothing.

### 🐛 Fixes
- **Image-gen sessions no longer OOM the renderer from inline base64** — Images are content-addressed blobs plus refs; base64 no longer lands in JSONL. Reads use a bounded tail window, and the old format self-migrates on first open. The `reason:"oom"` crash-reload loop and blank window from repeated image gen are gone.
- **Layered renderer OOM controls** — Main-process heap stays at 384MB while session windows rise to 2GB. History windows add an entry budget on top of “last N turns”; a turn’s fold mounts only the tail steps by default; failed compaction no longer unconditionally reloads the whole transcript.
- **Resident caches gain byte budgets** — Log-line cache, session-history full-text LRU, and on-disk history messages now have byte / count caps, closing four unbounded-growth paths.
- **Huge sessions no longer fail to open or crash the app** — Session JSONL is now scanned in chunks with a bounded load window instead of being read as a single string (the V8 single-string cap is ~537M characters and the main process only has 384MB of heap, so a few hundred MB of transcript aborts the process). Index rebuilds, rename, export, process events, the WSL channel, and file-change reads all share the same streaming implementation; the 438M- and 1.03B-character sessions seen in the field now open, paginate, and rename normally.
- **Last full-file read behind 1GB imported-session crashes** — The cache-hit-stats poller and the six importers' import-meta readers still read whole session JSONL files; selecting a 1GB-scale Codex session aborted the main process under its 384MB heap (exit 134, no stack). Cache stats now stream line-by-line and reuse results on two levels (zero scans when unchanged, tail-only scans for appends); import metadata reads a fixed head window, decoupling memory from file size.
- **Claude / Cursor / WorkBuddy imports no longer crash on large source files (concurrency is a multiplier)** — These three importers read every source file in full and fan them out with Promise.all; twelve 60MB files scanned in parallel were enough to exhaust the main-process heap. Scanning is now head-bounded with bounded concurrency, and importing streams line-by-line through an atomic temp-file rename; even modest files no longer crash, and scan/import share one converter so a fix can no longer land in one importer and miss the others.
- **Size guard for editing messages in huge sessions** — Editing / deleting / resending a message needs the full document to recompute parent chains and write back atomically, which cannot be streamed; beyond the 32MB guard (same threshold as the scanner) a readable "session file too large" error is thrown instead of aborting the process mid-read. The error-code-to-copy chain is complete in both languages (with actual size and limit placeholders), no longer falling back to a generic "session operation failed".
- **WSL custom path validation follows the on-screen config** — The settings modal is draft-based: "verify and save" only writes the draft, while "check and use" reads persisted settings in the main process — switching WSL source / distro / user without pressing Save first made the Linux path run as a Windows file and fail unconditionally. WSL draft fields are now committed before detect / check; the first stderr line is surfaced into the settings page on failure (it used to go only to the dev console), and a Linux absolute path without a WSL context gets an actionable message instead of a generic "cannot run pi CLI".
- **Imported sessions are written as proper pi JSONL** — Claude / Codex / OpenCode / ZCode / WorkBuddy / Cursor imports now pair tool calls with tool results, serialize tool arguments as objects, normalize stop reasons to pi's enum, and fall unknown blocks back to JSON text. Small images become pi image blocks; oversized or byte-less ones become placeholders, so large base64 no longer lands in session files.
- **pi startup failures are no longer a silent timeout** — A spawn failure (process never started) used to report nothing and simply wait out the RPC timeout (10 minutes by default); it now fails in milliseconds, settles the pending request immediately, and restores extensions parked for this start. Windows misreports a missing working directory as `spawn cmd.exe ENOENT`, which is now translated back into the real cause; a pi path invalidated by an nvm/fnm version switch is identified separately. The startup handshake timeout drops from 600s to 90s, and both timeouts and skipped extension fallbacks are explained in the diagnostic card.
- **Built-in extension hot-update overlays carry their vendored runtime dependencies** — pi resolves module imports by walking up from the extension file's directory, and the userData overlay has no node_modules above it, so an updated overlay crashed pi at startup (`Cannot find module 'undici'`) and disabled every extension (the 2026-09-15 incident). Updates now bundle `node_modules/<pkg>` alongside the overlay files, and existing verified overlays self-heal at startup without a manual re-update.
- **"Extensions disabled" now tells you why** — The timeline diagnostic card and the toast share one reason resolution: the Settings → Developer "start without extensions" switch (a persistent cause inherited by every new session, which used to be completely silent) and a one-shot startup fallback (this run only) each get their own copy, and each cause's toast fires once per run instead of on every session.
- **Windows now always launches pi via node (fallback is no longer silent)** — Locally installed `node_modules/.bin/*.cmd` shims used to always go through `cmd.exe /d /s /c`; like npm global shims they are now reduced to `node <entry>` (extension-less entries are recognized by shebang), which also restores the command-line budget from 8191 to 32767. Only a missing shim / unrecognized shape / missing entry falls back to cmd.exe, and the fallback reason plus launch channel are written into the diagnostic card.
- **Packaged DSH black console window (koffi)** — koffi is now an app dependency with a complete runtime resolve chain, so host/runner can hide the console after packaging and no longer spawn a visible black window.
- **DSH sandbox runner uses local Node 24** — On Windows the sandbox runner no longer starts as electron.exe (GUI). It reuses the machine’s `node.exe` (detect / set the path in Developer settings, including nvm/fnm/mise/Scoop). The installer does not ship Node; if none is found you can one-click download a PiDeck-only copy from the current latest app Release (AtomGit/GitHub). PATH stays unchanged.
- **DSH runtime downloads follow the matching app release** — Runtime archives are resolved against a specific app tag: packaged builds fetch the runtime paired with their own version, dev follows latest (or an explicitly configured tag), instead of always pulling latest and risking a runtime/app version mismatch. Dev and packaged installs now share the same external-runtime probe / install chain; the bundled node_modules fallback only serves pre-partition installers.
- **Broken DSH runtime archives can no longer ship silently** — The v0.7.5 sidecar archive contained a local `file:` package with `src/` but no compiled `lib/`, and the archive gate mistook the always-present `exports["./package.json"]` metadata export for a resolvable entry, so CI stayed green. Packing now pre-checks every closure package's on-disk entries (file: packages are built automatically when their entry is missing), and the gate ignores metadata / wildcard exports.
- **Installer payload trim** — Drops unused Electron shader DLLs (`dxcompiler` / `dxil` / SwiftShader), the Lark SDK ESM copy (`es/`), and node-pty compile-time trees (`src` / `third_party` / `build` / `deps`). Windows PTY still ships `prebuilds/<platform>/conpty`. Renderer Shiki now aliases a web+coding language set instead of the 346-lang full bundle.

- **Linux “double-click does nothing” after an update** — The single-instance lock now handshakes and checks whether the lock owner still responds. Stale upgrade locks, PID reuse, and zombie owners no longer make the second instance exit silently. Problem-feedback health checks now report lock status.
- **Stopping a session kills the whole subagent tree** — Child processes spawned by pi-subagents / acp_delegate are cleaned up with the parent, so orphans no longer keep burning tokens.
- **Stale model preferences no longer block send** — If a saved model was renamed or deleted, the runtime keeps its current model and the timeline prompts a re-pick, instead of failing every send with “Failed to apply session preferences”.
- **Empty new-session history is no longer a load error** — ENOENT before the first JSONL write is treated as empty history. Live-runtime subagent panels reconcile against this generation’s start time, so leftover history rows no longer show as still running.
- **Timeline stick-to-bottom no longer leaves on layout growth** — Growing thinking blocks / tool cards / the composer only correct geometry; stick-to-bottom is left only by a real user scroll up.
- **Scrolling back through history is no longer yanked around by window growth** — Expansion and pagination now compensate the position of the turn you are reading relative to the viewport top instead of a whole-page height delta; late syntax highlighting and images still pin that position, and wheel-up scrolling is not locked.
- **Auto-title works again on reasoning models** — The title sidecar’s output budget was too small and got spent entirely on thinking. Budget 64→512, with one retry at 2048 when truncated with no visible text.
- **Empty automation budgets stay unlimited** — Saving “unlimited” no longer silently snaps back to 30min / 200K / 200 steps on the next edit.
- **Announcements drop jsDelivr** — Fetch prefers the AtomGit contents API with GitHub raw as fallback, so a CDN snapshot (up to 24h stale) can no longer hide new announcements even after a manual refresh.
- **Release asset sync no longer skips same-named artifacts silently** — The AtomGit sync upgraded from “dedupe by file name” to “file name + remote size” validation, treating same-name-different-size as a conflict; `--force-resync` now deletes every attachment of that tag and re-uploads everything (AtomGit only exposes deletion by attachment id and has no delete-whole-release API). After the v0.7.5 re-tag, the new artifacts used to be skipped entirely by name, which left mirror users upgrading to the old build even once the update check was fixed. A follow-up fixed the size probe itself — the AtomGit download CDN answers HEAD with 401, which had left remote sizes unknown and the conflict check inert — by falling back to a `Range: bytes=0-0` request; the sync script also gains `--only` / `--select` / `--force-upload` / `--dry-run` for re-uploading a hand-picked subset instead of wiping the whole release.
- **Idle animations no longer burn CPU / GPU** — The desktop pet switched from a 60fps rAF spin to on-demand scheduling (zero painting while idle, a 100ms low-frequency fallback, and 1/4 frame rate under reduced-motion); the tool-card sheen sweeps once on entry instead of looping forever, the timeline node halo uses a static ring with opacity breathing instead of a box-shadow spread, and a batch of unreferenced animation components was removed.
- **Brand shimmer no longer occupies the GPU while idle** — The wordmark now sweeps once every 5 minutes and drops `bg-clip-text` to a flat color while resting; a hidden window or a reduced-motion preference stops it entirely, and the sidebar π logo plays on click instead of on session start.
- **Cancelled compaction no longer looks like "nothing happened"** — An extension that owns context management in the session (e.g. a context-compression plugin) rejects pi's compaction before summarization starts via the `session_before_compact` hook; that `Compaction cancelled` used to be classified as silent, so clicking the ring's compact action or `/compact` just appeared to do nothing. The main process now resolves the source from evidence (hook rejected before summarization → extension owns compaction; our own stop was pressed during the window → interrupted) and throws a stable message the renderer turns into an actionable notice; the `Compaction ended` log gained start→end elapsed time and `Compact failed` carries the resolution evidence.
- **Rewind checkpoints are actually pruned now** — The prune code paths existed but were never called, so one repo accumulated 5,627 `refs/pi-checkpoints/*` entries and 73% of `git log --all` was snapshot noise. Current-session checkpoints are trimmed to the retention cap (throttled to once a minute per repo), inactive sessions' checkpoints are cleaned on each session's first run (throttled to ten minutes), and deletions go through a batched `git update-ref --stdin` instead of one process per ref.
- **Config deep links switch the top-level section too** — Opening a deep link to models / auth / MCP / usage while the config modal was last left on skills / prompts / extensions now lands on the right page; previously only the tab changed and the modal stayed on the old section.
- **Provider migration overwrite confirmation uses the in-app dialog** — Replaces the native `window.confirm` (which ignored the app theme and blocked the renderer) with the styled ConfirmDialog; the flow became preview → confirm → apply.
- **Store search submits on Enter** — The extension store and prompt store search no longer fire a request per keystroke (the previous 300ms debounce); Enter or the search button submits, and pressing it again on an unchanged query forces a cache-bypassing refresh.
- **Custom notification sounds play again** — The renderer CSP had no `media-src`, so custom sounds loaded via the `pideck-sound://` protocol fell back to `default-src 'self'` and were silently blocked — no error, just no sound. The CSP now declares `media-src 'self' pideck-sound:`, and a regression test guards the whole chain (media-src sources, the privileged scheme declaration, and the protocol handler's filename whitelist) against future CSP edits.
- **Two 400s from DeepSeek relays** — The `latest_reminder` role in the upstream error enum is DeepSeek V4's own, which shows the relay is proxying the official API: DeepSeek's OpenAI-compatible layer rejects the `developer` role and requires `reasoning_content` to be passed back on historical turns that carry tool_calls. pi's automatic compat detection only matches a provider name / baseUrl containing `deepseek.com`, so custom relays (88api / b.ai / tokendance …) were missing both keys and failed with `unknown variant 'developer'` and `The reasoning_content in the thinking mode must be passed back to the API`. The provider form gains a three-state "pass back thinking content" checkbox (untouched writes no key / explicit true / explicit false vetoes auto-detection), auto-filled when the provider name, baseUrl or any model ID looks DeepSeek-backed; DSH migration carries the two whitelisted keys for openai-completions only, and compat merging is now per-key with pi-side custom keys preserved (no more losing `thinkingFormat`).
- **Subagent leftovers: stale state, duration and wake-up turns** — A finished parent left subagents showing "running", durations piling up into thousands of minutes, and a wake-up by a background subagent folding the previous final answer into an "intermediate" one. Stale-state downgrade now covers plugin-record sources (the renderer's fast snapshot no longer overwrites the main process's downgrade), the built-in extension gained a `session_shutdown` hook (pi retires the runner on /new, resume, fork and quit, so the old session file no longer stays running forever), durations gained h / d units with anything still running / queued past two hours labelled "stopped (unreachable)", and the `custom_message` pi drops before waking the parent is projected back into the message stream as a collapsible notice card that restores the turn boundary (older data falls back to breaking turns on `stopReason === "stop"`).
- **Saving from the window header no longer skips the provider form** — Add / edit provider is a sub-page inside the models tab whose fields live in page-local state; the header save button went straight to writing `models.json`, bypassing that draft, so clicking it and refreshing lost the new provider. The page now exposes one submit entry point through `onRequestSave`, the first click commits the in-page draft and the next state update continues to disk, and the in-page button shares the same draft; a failed form validation clears the pending flag so it cannot leak into the next visit.
- **Automatic session titles are now off by default** — The title request makes an extra call to the current pi model after the first run and consumes tokens, which used to happen without the user noticing. It is now opt-in (main-process settings, renderer defaults, the preview shell and the switch fallback all agree), and the setting description spells out the extra model call and small token cost.
- **Ask cards: visible batch progress and correct input-question button width** — The batch ask card gains a progress bar (answered / total, turning success-coloured when complete) whose text doubles as the accessible name; the pure-input question's submit button carried `w-full`, which combined with Button's default `shrink-0` squeezed the input into a narrow strip — the button now keeps its own width and the input absorbs the remaining space.
- **Launch-argument injection budget now guarded for all three resource kinds** — Extensions / skills / prompt templates share one command-line budget computed per launch channel (cmd.exe 8191 / CreateProcess 32767); when it is exceeded the injection is dropped entirely and pi falls back to default discovery, with the reason spelled out in the diagnostic card and toast. Only skills had this guard before, so oversized extension or prompt-template lists ran into the Windows command-line limit and handed pi a truncated argument list.

### 🙏 Thanks

Special thanks to **微时佬友** for providing the model service used in our
software development 🎉

Thanks to  **追梦**  for their generous donations and support! 🎉

Thanks to all group members who submitted suggestions and bug reports! 🙏

Thanks to everyone who filed issues and feature requests on GitHub! 🙏

> 💬 **QQ feedback group: 1026218644** | **Author's WeChat: caoayu97** (mention "PiDeck"; WeChat group invites available)

## v0.7.5 - 2026-09-12

### 🚀 New Features
- **Inline reference chips aligned with Proma and self-contained persistence** — Composer and bubble reference chips now share the Proma skeleton (tinted background, same-hue text and icon, no border, baseline aligned); file chips show only the file name, directory references use a folder icon, and only the `@` prefix remains since the icon conveys the type. Bubble reference chips render back at their original position so multiple references are no longer reordered. Reference / session / skill / prompt-template blocks persist self-containedly: switching sessions or restarting still restores chips, and edit-resend or fork replay no longer leaks raw XML. The file-tree context menu “add to conversation reference” now supports directories (`@dir/`, the trailing slash distinguishing a directory from a mention) and reuses the same reference format as drag-and-drop and the editor context menu.
- **Sidebar session hover preview card** — Hovering a sidebar session row for 1.5s opens a preview card (debounced against races), so you can confirm a session's content without opening it first.
- **Configurable Git executable path with detection** — A new `gitExecutablePath` setting: empty means auto-resolve (PATH → common install locations), and a configured value applies to every Git operation (GitService / WorktreeService / checkpoint / git init). The Git tab gains a path input with detect / browse / reset buttons showing source, version and path; saving applies immediately without a restart.
- **Built-in prompt templates restored and AtomGit mirror added** — Built-in prompt templates are back in the prompt store; the README and docs-site link to the AtomGit mirror.
- **DeepSeek DSH runtime upgraded to 0.1.5 (Typert Remote)** — The bundled DSH backend runtime moves from 0.1.1-rc.2 to 0.1.5-rc.1 and adopts the new Connection / Gateway Remote transport. Every domain the desktop talks to (session, settings, credentials, LLM, workspace, skills, goals, subagents) is re-mapped onto the new wire contract, with a descriptor-level payload checker (`npm run check:dsh-wire`) guarding field names, nesting and required fields against the runtime's own schemas. The bundled agent-preset roster works again — standard / code / minimal compose with the subagent model-selection host service mounted, the static plugin inventory lists the loader entries of the host composition, and the composition file now lives inside the runtime install so preset package rows resolve from the right `node_modules`.
- **DSH sessions stream their thinking again, and tool cards show results** — Assistant deltas no longer live in the session log in 0.1.5; the follow stream now opts into the live assistant channel, so the thinking process streams in real time and long answers appear incrementally. Tool results carry their content again (the new `tool-result` wrapper block is unwrapped), so tool cards show what actually came back instead of only which tool ran.
- **DSH runtime version gate** — If the installed runtime does not match the version this PiDeck build pairs with, DSH is disabled outright with a guided reinstall prompt — no more starting a runtime whose bridge protocol may have changed underneath, which previously surfaced as loader or plugin-tree crashes.
- **Scheduled tasks (Automation)** — Cron-based scheduled tasks with a visual cron editor, entry point moved to the sidebar, run-history management, stop, and floating status cards; each task runs in normal / plan / goal mode, completion detection was rewritten (fixing blank sessions, runs that never ended and missing notifications), and DSH-backed sessions can run scheduled tasks as well.
- **In-app update log** — A changelog viewer fetches `CHANGELOG.md` / `CHANGELOG.zh-CN.md` from the AtomGit OpenAPI with a local cache, reachable from two entry points.
- **Update source now prefers AtomGit** — The update source order becomes AtomGit (first choice) plus GitHub official; releases sync to AtomGit automatically (or manually, with tag batching and hosts-accelerated transfers), and existing users' `updateSource` migrates from GitHub to AtomGit once.
- **Per-session proxy settings** — Proxy can be configured for a single session (follow global / on / off) without affecting others; saving applies immediately, entries were added to the session tab bar and the Agent menu, and the dialog host is consolidated into the App layer.
- **`pi-deck-trash-guard` built-in extension** — File deletions are backed up to the system recycle bin first, so an agent's over-eager delete is recoverable.
- **Built-in extension remote hot updates** — Built-in extensions can now be updated without shipping a new release: the repo maintains an `extensions-manifest.json` (per-file sha256, package-level version gating); the client fetches and verifies it, writes a userData overlay with atomic replacement and a `.bak` fallback, validates the overlay as a complete set (partial overlays never activate), and the extension manager gains an update-check / one-click-update panel.
- **Release pipeline & docs site** — The release pipeline builds Linux arm64 artifacts (deb / AppImage / tar.gz) and the manual builder accepts an explicit branch and architecture; the docs site gains VitePress scaffolding.
- **Smaller UI polish** — Notice toasts truncate long messages with a details dialog; the sidebar "show more" row splits its counts into right-aligned columns; dock entry tooltips are unified; extension-backed models no longer hydrate by default (restore via the refresh button), and saving a model gives instant feedback.

### 🐛 Fixes
- **AtomGit mirror update checks no longer return 404** — The AtomGit/GitCode `releases/download` route rejects any query string, while electron-updater always appends a `?noCache=` cache-buster when checking for updates, so the AtomGit update source could never reach `latest.yml` and always failed with a 404. Update requests are now stripped of the `noCache` parameter at the session level via `webRequest` interception on the updater's own partition session (electron-updater sends requests on a dedicated `"electron-updater"` partition, not the default session); the official GitHub update source is unaffected.
- **DSH sandbox hang and console window fixed** — The runtime environment for the two-level sandbox runners previously only reached the first level: the second-level ACL runner lacked `ELECTRON_RUN_AS_NODE` and loaded as a GUI app whose event loop never exits (commands returned correct output but every call burned the full 120s timeout), and it spawned pwsh with a newly created visible console. Node run-mode and the runner preload are now installed into the host process environment at boot and passed down the chain, so the second-level runner inherits the hidden console — both the hang and the black window are gone.
- **Second and subsequent DSH sessions respond again** — An early return on the shared event pump's startup path swallowed the per-session journal follow pump (the sole source of session events in 0.1.5), so a second session streamed nothing, never completed, and logged no error. Every runtime now ensures its follow pump is created (idempotent, safe to call repeatedly).
- **DSH journal replay no longer duplicates messages and traces** — During journal snapshot replay (the tail snapshot sent when a follow pump opens), messages and process events are deduplicated by id, eliminating React duplicate-key warnings in the timeline and trace list (`dsh:*` / `process:dsh-process:*`).
- **DSH model discovery no longer always reports "0 models fetched"** — Fixed reading a nonexistent `.models` field off the wire result of `llm/discoverModels` (which is a plain array), which made every provider fetch 0 models on the config page; both the bare-array and `{models:[...]}` wrapped response shapes are handled.
- **DSH runtime install EPERM failure fixed** — Install / import now stops the DSH host first and restarts it afterwards when it was running (previously only uninstall did; the host process maps native modules like `koffi.node` into DLL handles, so replacing the directory always failed with `EPERM: operation not permitted`); placement cleanup gains retries.
- **DSH runtime installs ~5× faster** — Extraction now uses the OS-bundled tar (Windows / macOS / Linux) in a two-pass scheme: list every entry for safety validation first (any unsafe entry falls back to the previous implementation), then extract natively, cutting ~44k small files from ~80s to ~17s; when the target version is already installed and verifies cleanly, download and extraction are skipped entirely (repeat installs return instantly); partially-removed install directories can be re-entered and reinstalled.
- **Built-in Todo extension plan cache freezing** — The plan text is now carried by the latest tool result only (append-only) and the per-turn context reminder is gone; a persistent briefing is re-injected after compaction / fork. Relay users no longer bust the prompt-prefix cache on every plan change (which previously froze the cache and spiked token usage).
- **Automation list no longer jumps on toggle** — List sorting now uses the creation time (previously every save bumped `updatedAt`, so toggling a card pushed it to the top and looked like "the other card got clicked").
- **Web chat per-turn idempotency** — `/api/chat` now carries a per-turn idempotency key, fixing duplicated messages in retry scenarios.
- **Extension manager long descriptions no longer break the table** — Long description cells wrap with a two-line clamp (full text on hover), so the version and action columns stay visible.
- **Process metrics memory caption** — The memory column shows a persistent caption clarifying the real pi process memory accounting after node-direct launch.
- **Kimi Coding multi-window quotas and booster wallet** — Usage queries support Kimi Coding's 5h / weekly / monthly windows plus the booster wallet.
- **Web Ask prompt missing and sidebar pending-question badge** — Fixed the missing Ask question text and concurrent-input warning on the Web surface; the sidebar now shows a pending-question badge.
- **Accent colors no longer bleed into session status lights** — Removed the `--color-info` override from all 9 accent blocks so session and sidebar status semantics (idle blue / running yellow / error red) stay constant across themes.
- **Dark-mode selected states no longer render white-on-white** — Usage-query preset pills now use `--color-text-inverse`, with the same fix applied to settings model checkboxes and the Git push badge.
- **Usage dialog built-in badge no longer stretched** — Fixed the flex-col stretch turning the “built-in” badge into a full-width grey bar; it now sits inline with its label.
- **Context menu failing to open and project-open flow** — Stopped pre-escaping the registry command value (which caused the Windows “cannot access the specified device” error); cold start / second instance now waits for projectStore before resolving the project directory; adding a project from the context menu broadcasts a sidebar refresh.
- **Problem-feedback copy no longer mentions email** — Removed the leftover half-sentence about sending email (#194).
- **DSH preset composition could not resolve bundled plugins** — 24 shipped preset rows (persona, tool-fs, plan-mode, subagent, workflow…) failed to resolve because the host composition file lived under the user data directory, where the node_modules lookup walk never reaches the runtime; the composition now lives inside the runtime install and the preset roster composes normally.
- **DSH session chain payload and streaming defects** — `session/prompt` was missing its mandatory `requestId` (the host's idempotency key, also used to bind attachments), `session/page` payloads were not wrapped in `request`, `session/list` used the wrong wire name, and the plugin static inventory always showed 0 entries because an async host call was not awaited.
- **Skill Hub install failing on Node 24 / Windows** — Directly spawning a `.cmd` raised EINVAL; the call is now wrapped through `cmd.exe /d /s /c`.
- **Ask badges** — The pending-question badge moved down to the session row so several waiting sessions can be told apart, and missing badges on the Chat / activity pages were restored; store search misses and the locked default category were fixed too.
- **Sent bubble corruption on special characters** — `/skill:`, `/permit`, `@` and `&` in a sent message no longer render incorrectly.
- **Store hot-keyword chips losing their label on hover** — The accent surface colour was being used as the text colour.
- **Danger-menu icon colour and sidebar hover-preview fallback** — Corrected the icon colour inside destructive menus and the preview card's summary fallback.
- **Resend after session restart no longer reports “message not found”** — Restarting a session and resending now works without the stale-message error.
- **WSL global skills honor the Linux home whitelist** — WSL mode now merges global skills from the Linux home directory into the whitelist (issue #203).
- **nicobailon subagent async dispatch no longer mis-marks completion** — Async pi-subagents dispatch no longer marks tasks complete before they finish, and panel entries show the task description (thanks @lerrorgk, PR #206).

### 🙏 Thanks

Special thanks to **微时佬友** for providing the Grok model service used in our
software development 🎉

Thanks to **sgafxh, r0y1z2, c834292137, bfzha, lerrorgk** and all contributors for their code contributions 🙏

Thanks to all group members who submitted suggestions and bug reports! 🙏

Thanks to everyone who filed issues and feature requests on GitHub! 🙏

> 💬 **QQ feedback group: 1026218644**

## v0.7.4 - 2026-09-08

### 🚀 New Features
- **App update & portable build optimizations** — The update card now explicitly informs Windows portable users that the in-app update runs the setup installer, with a direct link to download the portable executable manually from GitHub Releases; Linux AppImage auto-updates now preserve a fixed artifact name to cleanly overwrite the running binary in place without breaking desktop shortcuts; update mirror health check dynamically resolves the real setup asset filename from `latest.yml` with path traversal sanitization, eliminating hardcoded version numbers; failing GitHub direct updates now suggest switching to a mirror.
- **WorkBuddy session import** — Import WorkBuddy sessions automatically from `~/.workbuddy/projects` matching the current project: the project context menu gains an "Import WorkBuddy Sessions" action, listing sessions by recency with new / current / outdated badges. Injected system-reminder contexts and user_query wrappers are cleanly stripped to preserve original prompts, reasoning thoughts and tool call executions are merged into standard assistant turns, and file rollback snapshot noise is filtered out; imported sessions display a dedicated WorkBuddy source badge with sidebar filtering support.
- **Enhanced project and directory context menus** — Sidebar chat projects now open the full project context menu; directories now support an "Open in PiDeck" context menu action.
- **About dialog displays runtime component versions** — The About modal now shows not only the PiDeck app version, but also detected versions of the pi CLI, DeepSeek DSH, bundled pi-ai model catalog, and the package build timestamp.
- **Config backup & announcement system advancements** — Config backups now support manual export, single-file and full restore, and batch deletion; announcements have migrated to the `announcements-md` build pipeline with full Markdown rendering, detail modals, and community discussion links.
- **DSH version fallback & auto-usage query toggle** — Enhanced fallback version detection for the DSH runtime, along with an auto-usage query toggle for model providers.
- **Unified settings multi-level tabs & store search UI** — Restyled multi-level navigation tabs in Config Management and unified the store search bar appearance; sidebar branding area upgraded with a two-line beUI wordmark layout.
- **Command Code usage query support** — A new commandcode-credits parser reads the /alpha/billing/credits endpoint and shows 5h / weekly / monthly windows; the monthly window reverse-looks-up the 5h/week cap combo from the official pricing table with a double check (cap matches the plan + remaining is under the cap), degrading to remaining-only on failure (fail-closed against fabricated denominators).
- **Application update lifecycle hardening** — The update service is restructured into automatic (electron-updater downloads and installs) / manual (unsigned macOS builds only check and guide manual downloads) delivery modes; stale updater references removed, install-time exit preparation with timeout recovery, so the update flow is more reliable.
- **Update source mirrors with auto health checks** — The update settings can switch between GitHub official / built-in mirrors (ghfast, ghproxy.net, ghproxy.cxkpro) / a custom mirror prefix, applied at runtime without a restart; opening the settings page auto-probes mirror availability and speed with ok / slow / broken markers, plus a manual re-check button.
- **Composer voice transcription** — Built-in microphone recording in the composer with requesting / recording / transcribing / cancel states; audio is transcribed through a configurable OpenAI-compatible `/audio/transcriptions` endpoint in the main process and inserted at the captured caret/selection without auto-sending. The microphone button stays hidden until base URL, model and API key are all configured. Credentials are encrypted with the OS keychain (`safeStorage`) and never leave the main process; audio stays in memory.
- **Recovery from request body size limits** — When a gateway rejects the session with HTTP 413 / request-too-large errors, a confirmation offers to compact the session with a temporary model (auto-restored afterwards), breaking the deadlock where both the chat request and the compaction request exceed the same limit.
- **Built-in TokenDance provider** — TokenDance (tokendance.space) ships as a built-in provider with a live model catalog, one-click OAuth key install, in-line balance display in the auth list and DSH migration support; manually added TokenDance providers automatically receive the `X-App-URL` attribution header so usage is credited to the app.
- **pi v0.85.0 tracking** — The bundled model catalog is regenerated against pi-ai 0.85.0 (1336 entries) with updated model lists and capability fields.
- **ZCode session import** — Import ZCode (Z.ai CLI) sessions from `~/.zcode/cli/db/db.sqlite`: the project context menu gains an "Import ZCode Sessions" entry with a picker showing title / preview / message count and new / current / outdated status. Conversations are converted into Pi-readable sessions (text, reasoning, tool calls with matched results, image attachments restored from artifacts), subagent sessions and timeline noise are skipped, and imported sessions carry a ZCode source badge with dedicated filtering.
- **pi.dev extension store** — Extension management gains a two-pane "Installed / Store" view; the store lists packages from the pi.dev Package Catalog page (name / description / author / type / monthly downloads / publish date / npm & GitHub links) with search, type filtering, sort by downloads or latest, and pagination. One-click install, copy the install command, open the pi.dev page, and already-installed packages are marked "installed" with the install button disabled.
- **Provider groups sorted by recent use** — The model picker's provider groups now sort "recently used first" (the newest used provider jumps to the top, up to 8 remembered); never-used / non-built-in providers fall back to built-in-pinned alphabetical order, and the `other` fallback group always stays last, so commonly used providers need no repeated scrolling.
- **Serverless announcement system** — Announcements are managed as a repo-root `announcements.json` (announcing = committing), fetched from multiple sources with a staggered 2h polling timer; the sidebar announcement center shows an unread dot / popup list / manual refresh / mark-all-read; the popup policy is do-not-disturb aware (deferred while typing, an agent is running, a modal is open, or the window is inactive, then auto-complemented when idle).
- **TokenDance one-click setup now grabs the API key too** — Authorization and key retrieval merge into one click: a loopback callback server (RFC 8252 §7.3, system-assigned port, 128-bit random callback token) captures the code, exchanges it and writes the key; it degrades to the manual paste path when the local bind fails.
- **Model catalog updates via GitHub branch + app-update mirrors** — Catalog check/download switch from the npm `latest` tag to pre-generated branch artifacts over GitHub raw, reusing the update mirror configuration (auto-generated mirror proxy URLs) for far better reachability in CN networks; falls back to npm latest when every source fails, keeping the anti-downgrade version comparison.
- **Settings gains a dedicated “Notifications” tab** — The notification toggles (session done / Ask / agent count) and sound alerts merge into one tab under Common settings.
- **Ask notifications no longer depend on session focus** — Any pending Ask question in the background now notifies.
- **Resource management aligned with pi 0.85** — Extension / prompt / skill discovery and project-level installs follow pi 0.85 semantics; the project resource management screen reuses the settings-page resource UI.
- **Announcement center entry hides when reminders are off** — Turning off announcement reminders also hides the sidebar announcement entry.

### 🐛 Fixes
- **WSL environment Node/pi detection** — Fixes an issue where desktop PiDeck could not detect pi in WSL environments using version managers like nvm or fnm (#191).
- **Split-pane independent Git branch display** — Split panes now show and switch Git branches independently based on the active session's project scope.
- **Session timeline stick-to-bottom smoothing** — Fixed race conditions during streaming and scrolling so auto-scrolling to the bottom is much smoother.
- **Adaptive inference for ask_question type** — The `type` field in extension tool questions is now optional and automatically inferred based on the question shape.
- **Update dot popover overflow protection** — Fixed the first-time update dot explanatory bubble overflowing off the left edge of the screen and getting clipped by the sidebar.
- **Thinking/generating indicator restored** — Restored the dot-matrix Loader animation for clearer response generation states.
- **Provider usage UI refinements** — Polished layout details and formatting for provider credit and usage cards.
- **Tool stopwatch no longer resets mid-stream** — Tool duration now starts from meta.startedAt (same baseline as the final durationMs), so long-running commands no longer flash back to near-zero while streaming output.
- **Vision-bridge model picker fits extra-long model names** — Overlong provider/model tokens truncate inside the button with an ellipsis (full name on hover) instead of breaking the layout.
- **Unified session turn counting** — Pi sessions count “N rounds” by speaking-turn cycles (consecutive user messages merge into one turn); DSH keeps the official sessionStats semantics with a dsh-web-aligned fallback; the usage page renames “turns” to “call counts” to avoid confusion with session turns.
- **Fork titles persist and long sidebar names scroll** — Forked session titles survive restarts; extra-long sidebar titles scroll on hover.
- **Git badge state survives tab switches** — Ahead/behind badges are cached per project + repo scope, so switching session tabs no longer blanks them (the cached value shows instantly and a background refresh corrects it shortly after).
- **Calmer title scrolling** — Sidebar and tab title scrolling is unified to a constant 5px/s with no upper duration cap, so very long titles never turn into a fast flicker.
- **Ask wait time no longer counts into reply duration** — Elapsed time while waiting for the user's answer is excluded from the reported response time.
- **Ask select boxes no longer swallow clicks on press-drag** — A press-perception guard keeps press-drag selection from eating the click underneath.
- **Edit / resend after stopping a session no longer errors** — Stopped messages keep their identity, so editing or resending no longer reports “Message not found”.
- **Pasted long text is stored in the app-data directory** — Oversized pasted content goes under the app data dir; the settings storage page can count and clean it up.
- **Crash-page auto-refresh countdown fixed** — The 5-second countdown no longer freezes in dev builds (StrictMode double-mount race).
- **Welcome-page model pick is no longer silently overridden** — The model chosen on the welcome page wins even when a default model is configured.
- **Catalog update check not fooled by stale jsDelivr cache** — jsDelivr is removed from catalog sources (stale CDN data previously reported “already up to date”); mirror proxies + GitHub raw remain, with npm-latest fallback on failure.
- **Prompt name and action-area display fixed** — In Config Management, prompt names and their action area no longer render incorrectly.
- **Model list write order matches the picker** — Persisted model lists are sorted by the same shared rule (`shared/modelOrder`) the dropdown shows.
- **macOS layout hides the pi brand logo** — The logo no longer takes space in the compact macOS layout.

### 🙏 Thanks

Special thanks to **微时佬友** for providing the Grok model service used in our
software development 🎉

Thanks to  **歌者、幕书、王女士、何希尔**  for their generous donations and support! 🎉

Thanks to **sgafxh, r0y1z2, c834292137, bfzha** and all contributors for their
code contributions 🙏

Thanks to all group members who submitted suggestions and bug reports! 🙏

> 💬 **QQ feedback group: 1026218644**

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
