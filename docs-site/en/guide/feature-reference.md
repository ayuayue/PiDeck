# Feature Reference

> This handbook walks through every feature of PiDeck by UI area: where each button, menu, context menu, and shortcut lives, how to use it, and what it does.
> New here? Start with the [Usage Guide](/en/guide/usage-guide). For settings details see [Settings & Skills](/en/guide/settings). Stuck on something? See [Troubleshooting](/en/guide/troubleshooting).

## Interface Map

```
┌───────────────┬─────────────────────────────────────┬──────────────┐
│  Left sidebar │  Session tab bar / session header    │  Drawer rail │
│  (projects/    │  Message timeline                    │  (Files /    │
│   sessions/    ├─────────────────────────────────────┤   Source     │
│   search/      │  Composer input                      │   control /  │
│   settings)    ├─────────────────────────────────────┤   Trace /    │
│                │  Terminal Dock (optional)            │   Rewind /   │
│                │                                      │   Browser)   │
└───────────────┴─────────────────────────────────────┴──────────────┘
```

- **Left sidebar**: projects, sessions, global search, settings entry.
- **Center**: session tabs (multi-tab and split view) + chat timeline + composer + optional terminal.
- **Right drawer**: file tree, Git, run trace, checkpoints (rewind), built-in browser.

---

## 1. Left Sidebar

### Top row

| Feature | Location | How to use | Notes |
|---|---|---|---|
| Collapse/expand sidebar | Panel icon next to the logo | Click | Toggles the sidebar to a narrow rail; when collapsed, an expand button appears at the left of the session tab bar |
| New session | First `+` at the top | Click, or `Ctrl/Cmd+N` | Opens the new-session start page (skipped while an input/editor is focused) |
| Global search | Search icon | Click, or `Ctrl/Cmd+F` | Opens a centered command palette searching sessions and projects; typing also filters the list below |

### Navigation tabs (Activity / Chat / Projects)

Three pills switch the sidebar view; the selection is remembered:

- **Activity**: currently **running** Agent sessions across projects. Click to preview, double-click to pin, right-click for the menu.
- **Chat**: the chat session tree. All sessions (drafts / agents / history / archived) grouped by project.
- **Projects**: the project workspace tree — projects, Git worktree workspaces, and their sessions.

### Chat view

- **Section title**: click to collapse/expand the whole section.
- **`+` on the right of the title**: create a new regular session.
- **Collapse/expand all** (chevron icon next to the title): one-click collapse or expand all projects.
- **Section `⋯` menu**: anonymous session, session manager (bulk archive/delete), chat record directory.
- **Session row**:
  - Click → **preview** in the center; double-click → **pin** as a permanent tab.
  - Status dot: running (yellow) / idle (blue) / error (red).
  - Row badges: backend (pi / DSH / Codex / Claude / OpenCode / imagegen), anonymous, pinned, sub-agent count (click to expand the sub-agent list).
  - `⋯` / right-click → session menu (below).
  - Drag a session row to the chat area edge → **split view**.
- **Show more**: each project shows the latest 5 sessions by default; click the bottom button to page.
- **Source filter** (Filter icon on the project row on hover): filter that project's history by source (pi / codex / claude / opencode / dsh / imagegen…), remembered locally.

### Projects view

- **Add project** (`+` next to the title): pick or type a local directory. The empty state card also has an "Add project" button.
- **Project row**: click to expand and select; drag to reorder (persisted); a yellow badge means the directory is missing.
- **Hover actions on a project row**:
  - `+` → new session;
  - `⋯` → project menu;
  - Filter → source filter.
- **Project menu (right-click or `⋯`)**:

| Item | Notes |
|---|---|
| New: Regular session / Anonymous session | Anonymous sessions are temporary — not saved, reclaimed on close |
| Reveal in file manager | Opens the system file explorer |
| Open with | Open the project with a configured external editor / browser |
| Copy project path | Copies the absolute path |
| Rename project | Only top-level regular projects can be renamed |
| Session manager | Bulk archive / delete |
| Skills & Extensions & Prompts | Project-level resource management dialog |
| Filter history | Source filter |
| Refresh project | Rescan the directory |
| Enable/Disable workspace | Register the project as a Git worktree workspace (non-Git repos will be rejected) |
| Import session | Import Codex / Claude / OpenCode local sessions |
| Delete directory record | Danger zone. Blocked while an Agent is running; worktree children use "Delete workspace" |

- **Main workspace row**: appears when workspaces are enabled (branch chip + project name).
- **New workspace** (`+` on "Other workspaces"): creates a Git worktree directory for a branch, letting you work on different branches of the same repo in parallel.
- **Worktree child rows**: branch name + directory hint; hover `+` / `⋯` behaves like a normal project.

### Session menu (right-click / `⋯`)

| Item | Notes |
|---|---|
| Rename | In-place title edit |
| Pin / Unpin | Pin to the top of the tree (persisted) |
| Duplicate session | Copy as a new session |
| Export HTML | Export the session as a web page (not for DSH) |
| Copy session file path / Open session JSONL | Debug helpers; shown when the file exists |
| Restart session | Restart the Agent process (running sessions) |
| Reload session | Only for sessions without a live process |
| Session proxy | Configure a forwarding proxy for this session |
| RPC log | Running sessions only: record Agent RPC traffic; view in a separate window |
| Close agent / Delete session | Stop the process / delete the session (with confirmation) |
| Archive session | Move to archive; restore or delete in Session Manager |

### Bottom dock

- **Settings** (gear): opens settings; shows a red dot when an update is available.
- **Feedback** (bubble icon): opens the feedback page.
- **Website**: opens pideck.caoayu.top.
- **Theme toggle**: cycles light / dark / follow system / scheduled.

> The terminal dock lives at the **bottom of the center area**, not the sidebar.

---

## 2. Center Session Area

### Session tab bar

- **New** (trailing `+`): dropdown to create in "Chat area" or any open project.
- **Close**: click the tab `×`, or middle-click the tab.
- **Tab context menu**: pin/unpin, close, close others, close all.
- **Reorder**: drag a tab to a target position; drag to the chat area edge to create a **split pane**.
- **Auto grouping**: tabs are grouped by project (separators between groups); newly opened sessions join their project group.
- **Split group pill**: click to collapse/expand; right-click to rename (≤24 chars), pick a group color, or un-split.
- **Preview tabs** (italic): double-click to promote to a permanent tab.
- **More `⋯`**: stop, restart, reload the current session; below are tool entries (terminal, scratch pad, open-with, etc. — active ones checked).
- **Drawer toggle** (panel icon at the right end): opens/closes the right drawer.

### Session header

- **Breadcrumb**: `project / session title`; hover for the full name.
- **Anonymous badge**: shown for the project-less "Chat area".
- **DSH tools button** (DSH sessions with a running Agent): goal (progress/pause/resume/complete/clear/new), sub-agents, skills.
- **Permission preset pill** (DSH draft phase): pick a permission preset; locked after activation.
- **Exit split** (maximize button on a split pane): leaves split view.

### Composer

**Sending**

- Round main button at the bottom-right: send arrow when idle; becomes **stop** while the Agent is busy and the input is empty; spinner in imagegen mode.
- Shortcut per settings: bare `Enter`, `Ctrl/Cmd+Enter`, or `Shift+Enter` to send; otherwise `Enter` inserts a newline. In plan mode a bare Enter always sends.

**Typing triggers**

| Input | Effect |
|---|---|
| `@` | File reference: project file tree completion, `/dir/` drill-down; picked files become chips (click to inspect/remove) |
| `&` | Session reference: pick messages from same-project history and inject them into the current conversation |

**Other input features**

- Paste / drop images: thumbnail shown, click to enlarge, `×` to remove; large pasted text becomes a "pasted file" chip.
- Arrow-key history: `↑` on the first line and `↓` on the last line browse send history; `↓` past the last entry restores the current draft.
- Select message text → floating **Quote & ask**: appends the selection as a reference chip.

**Bottom bar of the composer**

- **`+` menu**: attachment (hidden in imagegen), skills, prompt templates, mode switch (normal / goal / plan / imagegen; a `×` appears when a special mode is active).
- **Model / thinking chip** (center): shows `model · thinking level`. Click for the model picker (search, grouped by provider, favorites, usage badges, refresh) or the thinking picker (off → max). Switching models mid-run applies after the current round ("old → new"); switches that need a restart prompt for confirmation.
- **Backend switcher** (bottom-left logo): pi / DSH / imagegen. Locked once the session is active.
- **Safety level** (bottom-left): security gate levels (off/standard/strict) for pi; permission presets for DSH.
- **Context ring** (next to send): context usage; click to expand: two-segment usage, cache hits, token details, reply performance, usage query, compaction entry.
- **Git branch chip** (bottom-right): current branch; switching asks for confirmation.

**Queued message card**

While the Agent is busy you can keep typing; messages queue. Row buttons:

- `↑` insert into the current round; `☰` queue for the next round; `⑂` send in parallel (opens a separate anonymous session — see Parallel Ask); `✎` pull back into the input; `×` discard.

**Stats line**

Below the input card: rounds/steps, duration, first-token latency, tps, total tokens, cache hits.

### Messages & timeline

- **Hover action bar**: copy (main button copies plain text; arrow menu: plain text / Markdown / image), share, edit, delete; user messages also get re-send, fork from here, and rollback-to-here.
- **Exec-process collapsible bar**: `N tool calls · N thoughts`; auto-expanded while streaming, collapsed by default in history; the final answer is always visible.
- **Tool call card**: icon + tool name + status (running/succeeded/failed/stopped) + duration + a semantic phrase. Click to expand:
  - File tools: inline diff, "Open file" jumps to the editor;
  - Command output: copy button; "View full output" for long output;
  - Ask cards (ask_question): answer question by question.
- **Security confirmation card**: high-privilege tools (file/command) pop "Allow / Deny".
- **Code blocks**: copy button; file paths are clickable.
- **Back-to-bottom button**: appears at the bottom-right when scrolled away.
- **Outline preview rail** (left edge of the session area): vertical strips, hover to preview the title/time, click to jump; updates while streaming. Entries can be dragged to reorder; "Show all" at the bottom.

### Info strips (above the composer)

- **Goal strip**: current goal + phase (active / paused / blocked), with pause/resume/clear (clear asks confirmation). DSH goal mode.
- **Todo strip**: synced from the Agent's todo card, with completed/in-progress counts.
- **Files strip**: files modified this round; expand to see diffs, "Save all"; per-row open-file and diff-viewer actions.
- **Sub-agents strip**: running sub-agents; "Open sub-session" jumps there, "View full result" opens a dialog.

### Parallel ask panel

Triggered by `⑂` on a queued message. It:

- creates an **anonymous session** (separate process, parallel to the current one, no interruption);
- can carry the current context (visible to the model only);
- shows the answer in a floating capsule with copy, insert-into-main-composer, follow-up ask, and close (closing reclaims the anonymous process).

### Other panels & entries

- **Scratch pad**: `Ctrl/Cmd+Shift+S` (also a tool-rail button). Create/delete notes, Markdown mode, task checkboxes, export to file. Notes follow the session.
- **Trace panel**: drawer "Trace" tab — per-round lanes of input/model/tool events.
- **Checkpoints (Rewind)**: drawer "Checkpoints" tab — see below.
- **Session start page**: no messages yet — a large centered composer plus a project switcher.
- **First-trust confirmation**: opening a project directory asks "Deny / Trust once / Trust and remember" (adjustable in security settings).

---

## 3. Right Drawer

**Toggle**: button at the right end of the session tab bar; the open/closed state is remembered per project.

**Rail (panel switcher)**: top pills — **Files**, **Source control** (when Git management is enabled and a project exists), **Trace**, **Checkpoints** (pi-backend only), **Built-in browser**. Click to open/switch; clicking the open one again closes it.

- **Resize**: drag the drawer's left edge (240–560 px, remembered across restarts).
- **Collapse panel** (to a thin rail) → `←` to expand.
- **Pin panel** (pin icon): remembers the current panel per project; a pinned panel cannot be closed or switched.
- **Close** (`×` or on the panel header).

### Files panel

- **File tree**: single-click = **preview** tab (italic, non-editing) in the center; double-click = **permanent** editing tab; directories collapse/expand on click.
- **Context menu (file/directory/blank)**: quote into conversation (`@` relative path), open with default app, reveal in folder, copy path, paste file here, rename, delete (to recycle bin + confirm).
- **Toolbar**: sort (name/mtime/ctime/size + asc/desc), collapse middle packages (deep chains into one row), open folder, refresh, collapse all.
- **Drag & drop**: OS files dragged in are copied to the target directory; intra-tree drags move; `Ctrl/Cmd+V` in the panel pastes clipboard files.

### Center file editing

- **Display mode**: split (side-by-side) / maximize (fill), via the viewer header; drag the divider to adjust width.
- **Edit tabs**: up to 5; double-click a preview tab to promote; `×` to close.
- **Text editing** (CodeMirror): line numbers, code folding, wrap, bracket matching, find (`Ctrl+F`), JSON validation, comment (`Ctrl+/`); autosaves 500 ms after edits; `Ctrl/Cmd+S` saves immediately; unsaved shows `●`.
- **Preview**: Markdown (GitHub style + KaTeX), HTML (sandboxed iframe, switchable to the built-in browser), SVG/images/PDF; binaries are rejected; files over 5 MB (configurable) warn.
- **Diff viewer** (read-only): split/single pane; open from modified-file lists, commits, or workspace changes.
- **`path:line` links**: open a file at a specific line; right-click selected text → "Quote selection" inserts `@path:line` into the composer.

### Git panel (Source control)

- **Branch switcher** (top current-branch button): dropdown to switch; "Create branch" at the bottom to branch and switch; non-Git repos show `+` (git init).
- **Repo switcher**: when multiple repos are found (VS Code SCM style).
- **Changes in three groups**: merge conflicts / staged / workspace changes; headers collapse with counts and stage/unstage-all; hovering a directory header offers directory-level stage or discard (with confirmation).
- **Per-file buttons**: `+` stage, `−` unstage, `↺` discard (confirmation), 📄 open in center editor; clicking the filename opens the diff; right-click deletes the file (recycle bin + confirm).
- **Toolbar**: collapse/expand all, refresh, **Push** (ahead-count badge; offers a copied `git push --set-upstream` command when no upstream exists), **Pull** (behind-count badge).
- **Commit**: message box (`Ctrl/Cmd+Enter` commits) + "Commit" button (stages everything and commits if nothing is staged; remember Yes/Always/Never).
- **AI commit message** (✨): generate from staged files (needs staged changes; prompts to configure a model if missing).
- **Commit history graph** (lanes): up to 8 lanes and 6 colors. Rows show author/message/branch tag badges; click a row to expand its file list (click a file for diff); hover 500 ms for a detail card (author/email/time/full message/±lines); "Load more" adds 30.
- **Commit row context menu**: Cherry-pick, Revert, Soft/Mixed/Hard Reset (confirmation), Drop (danger confirmation).
- **Branch compare**: base → target + "Compare" → ahead/behind, file counts, file list (A/D/R/M colored).

### Browser panel

- **Address bar**: Enter navigates; missing protocol gets `https://` prepended.
- **Tabs**: `+` new (defaults to the PiDeck home page), click to switch, `×` to close; tab state survives drawer/fullscreen toggles.
- **Navigation**: back / forward / refresh / home.
- **Device presets**: PC / iPhone (mobile UA) / iPad (tablet UA) — switches UA and constrains the viewport.
- **Fullscreen**: maximize in the header; click blank space to leave; while fullscreen you can minimize back or close.
- **New windows**: http(s) links open a new in-app tab; non-http protocols (mailto etc.) go to the system browser.

### Trace panel

Shows the current session's run trace (message/tool events in per-round lanes). Empty state when no session; "Load more" at the bottom.

### Checkpoints (Rewind) panel

- **Checkpoint list**: automatic (round/tool-triggered) + manual snapshots, newest first: trigger-type badge, tool name/round, relative time, change summary (file count + ±lines).
- **View changes**: per-row diff button, expands the diff between that checkpoint and the current workspace.
- **Restore** (undo dropdown, three scopes):
  - **Files only**: workspace files return to the checkpoint (overwrites current changes — irreversible; untracked new files are cleaned; ignored directories unaffected);
  - **Conversation only**: rolls back conversation content;
  - **All**: files + conversation; a conversation scope **forks into a new session** (the original is kept).
  - All restores confirm first.
- **Refresh / Load more**: manual refresh and paging.
- **Boundary**: pi-backend sessions only; DSH / imagegen say unsupported.

---

## 4. Terminal Dock

- **Open/close**: the "Terminal" button in the session tab bar's tool area. Ownership: with an Agent = Agent terminal; without = project terminal; switching sessions never leaks across. Not available in LAN web-preview mode.
- **Tabs**: `+` new (current shell); click to switch; `×` to close (exited shells show "· exited"); "Close all" confirms.
- **Shell picker** (header dropdown): PowerShell / CMD / Zsh / Bash / Fish / Sh / Git Bash / WSL; unavailable shells are grayed.
- **Themes** (header `⋯`): pi-soft (light/dark), Solarized (light/dark), One Dark, Monokai.
- **Collapse/expand**: header button; drag to resize (120 px minimum, remembered).
- **Right-click**: with a selection = copy (toast).
- **Misc**: URLs open in the system browser; 5000 scrollback lines; shell exit codes are shown.

---

## 5. Keyboard Shortcuts

| Shortcut | Action | Scope |
|---|---|---|
| `Ctrl/Cmd+N` | New session | Global (skipped while an input is focused) |
| `Ctrl/Cmd+F` | Global search | Global (in-editor find while an editor is focused) |
| `Ctrl/Cmd+Shift+S` | Toggle scratch pad | Global |
| `Ctrl/Cmd+S` | Save current file | File/config editors |
| `Ctrl/Cmd+Enter` | Commit Git message / send message (per settings) | Git panel / composer |
| `Enter` | Send or newline (per send-shortcut setting) | Composer |
| `↑` / `↓` | History navigation (cursor on first/last line) | Composer |
| `Ctrl+/` | Comment | File editor |
| Middle-click a tab | Close session tab | Session tab bar |
| Double-click session row / tab | Promote preview to permanent | Sidebar / tab bar |
| Drag to the chat-area edge | Create a split view | Session rows / tabs / files |

> Every button has a tooltip — hover 1–2 seconds to see it. Shortcuts use `Ctrl` on Windows/Linux and `Cmd` on macOS.

---

## 6. Input Syntax Cheat Sheet

| Input | Effect |
|---|---|
| `@path` | Reference a file (`@/src/...` drill-down) |
| `&keyword` | Reference messages from a past session |
| Paste/drop an image | Ask with the image (model must support vision) |

---

## 7. Settings Entry Points

- **System settings** (bottom-left gear): appearance, proxy, web service, editors, Git commit, dev/updates, Feishu, desktop pet, storage & logs, usage stats, process monitor, vision bridge, imagegen — see [Settings & Skills](/en/guide/settings).
- **Config management** (switchable inside the settings dialog): pi / DSH backend models, auth, settings.json, trust, MCP, raw JSON files, security (tool confirmation), extensions, skills, prompts.

For problems, see the [Troubleshooting guide](/en/guide/troubleshooting).
