# Troubleshooting Guide

> Hit a problem? Follow the paths below — most cases resolve without reading logs. If yours isn't covered, use the **diagnostic report** at the bottom to bundle your environment info and ask for help with it.

## 0. The General Routine (do this first)

1. **Restart the app**: many stuck states (Agent processes, listeners, session caches) recover with a single restart.
2. **Check the version**: Settings → Dev → "Check for updates" — make sure you're on a recent release. Most historical bugs are fixed.
3. **Generate a diagnostic report**: Settings → Dev → Diagnostics → Generate. The report contains sanitized environment info, health checks, and recent error logs — no code or secrets. Export and share it directly with maintainers or in an Issue.

---

## 1. Installation & Launch

### "pi not detected" at startup

1. Verify pi works in a terminal: `pi --version`
2. Settings → Dev → **Pi CLI status card** → "Detect environment" to rescan
3. If detection keeps failing: fill the full path in "Custom pi path" (e.g. `C:\Users\<you>\AppData\Roaming\npm\pi.cmd` on Windows) → "Validate path"
4. **WSL users on Windows**: switch "Pi source" to WSL, pick the distro, and "Validate user"

### Blank/white screen or missing icons

- Restart the app first;
- Check Settings → Appearance → Theme — a skin can be incompatible;
- Still broken: Settings → Dev → "Open data directory" and inspect app logs (see "Where are the logs");
- Windows antivirus/GPU conflicts: try toggling the Chromium sandbox (Settings → Dev → Runtime → Chromium sandbox; **disabled by default on purpose**, requires an app restart).

### Weird window behavior (multiple instances / won't close)

- Settings → General → Window: check "Close to tray" — the window may be hidden, not quit;
- The single-instance switch needs an **app restart**; different PiDeck versions can run side by side (version-based mutex), so don't mistake this for a bug.

### Wrong language / fonts

Settings → Appearance: language is under "General"; font size, zoom, and per-zone sizes are all under "Appearance".

---

## 2. Sessions & Agents

### Agent won't start / endless spinner

1. Open the "Trace" drawer tab or right-click the session → **RPC log** to inspect Agent communication;
2. Check the **model config**: Config → Models — verify the model is usable ("Test connection");
3. Check **RPC timeout**: Settings → Dev → Runtime → RPC timeout (minimum 600 s); raise it on slow networks;
4. Check **proxy**: Settings → Proxy → Pi proxy / the per-model proxy list;
5. Try "Restart session" (session context menu).

### Sent a message but nothing responds

1. Confirm the Agent is **idle (blue dot)**; while busy (yellow), messages go to a **queue card** — inspect the queue (insert current round / queue next round / send in parallel / pull back / discard);
2. Hit the **Stop** button (bottom-right) to abort a long request;
3. Check the network / API key: Config → Auth;
4. Check logs: Settings → Storage & logs → App log / RPC log.

### Model switch doesn't take effect

- Switching mid-run applies after the current round ("old → new");
- If a restart is required, confirm it in the dialog;
- Empty/unreachable model list: Config → Models → "Refresh" or "Fetch remote"; also check whether the desktop proxy blocks model-list fetches.

### A session disappeared / can't find history

1. Each project shows only the latest 5 sessions by default — click "Show more";
2. It may be **archived**: Chat section `⋯` → Session manager → Archive view to restore;
3. A source filter may be active — clear it via the Filter icon on the project row;
4. Still missing: check the chat record directory setting (Chat section `⋯` menu).

### Session content empty / garbled timeline

- Old versions had such bugs; fixed since v0.6.2 — update first;
- Still broken after updating: restart that session (right-click → Restart session).

### What is "Send in parallel"?

When the Agent is busy, the `⑂` button on a queued message spawns an **anonymous independent session** to answer it (without interrupting the current one). The answer appears in a floating capsule — copy, bring back into the main composer, or keep asking. Closing reclaims the session; nothing is persisted.

---

## 3. Config, Auth & Network

### 401 / auth failures

1. Config → Auth: verify the provider key (or re-login via OAuth);
2. Proxy environments: requests may go through a proxy that doesn't allow them — remember **Pi proxy** (affects Agent processes) and **desktop proxy** (affects model-list fetching, connection tests) are separate; check both; the per-model list forces proxy for listed models and direct for the rest;
3. Usage-query endpoints (`/usage` etc.) returning 401: use the usage-query button → generic / New API templates; most providers are built in and need no config.

### Model list empty / can't fetch

- Config → Models → "Refresh";
- Check whether the "Desktop proxy" is needed (the model catalog is fetched from GitHub);
- The built-in catalog can be updated manually: Settings → Dev → Model catalog → "Update from GitHub".

### Slow access to overseas resources

- Settings → Proxy: set up Pi proxy + desktop proxy;
- Slow update downloads: Settings → Dev → Update source — switch to **ghfast / ghproxy.net / CN mirror**, or a custom URL (default is GitHub).

---

## 4. Git & Files

### The Git panel doesn't show

- Settings → Git → "Enable Git management" (the whole panel hides when off);
- The project must be a Git repo: non-repos show an init button (`+`).

### Commit/push fails

- Read the error text (auth, network, remote drift);
- No upstream: the toolbar offers a copied `git push --set-upstream` command;
- AI commit message (✨) failing: confirm files are **staged** and a model is configured (Settings → Git → commit-message model).

### Can't delete a worktree workspace

- Deletion is blocked while an Agent is running — close its sessions first;
- "Delete workspace" also cleans the Git worktree directory.

### File opens as binary / too large

- Binary files (images etc.) open in preview; code/text uses the editor;
- Files above the "Max editor file size" (5 MB default, Settings → Dev → Runtime) warn — raise the value if needed.

---

## 5. UI & Layout

### Can't find a panel / drawer is gone

- Right drawer: the **panel icon** at the right end of the session tab bar; once open, the **rail** switches Files / Source control / Trace / Checkpoints / Browser;
- A **pinned** panel can't be switched or closed — unpin first;
- Terminal: the "Terminal" button in the tab bar tool area;
- Scratch pad: `Ctrl/Cmd+Shift+S` or the tool-area button.

### Dialogs too big/small or bad fonts

Settings → Appearance: window zoom (0.8–1.5), font size levels, per-zone sizes (UI/chat/composer independent), chat content width (60–100%).

### Theme looks off / background image gone

Settings → Appearance → Theme (system/scheduled/light/dark) and skin themes, background image, background opacity (default 80%). Sunrise/sunset times live under "Scheduled".

### The desktop pet is in the way

Settings → Desktop pet: off switch / un-pin / scale / patrol interval. It's a purely cosmetic component — no relation to coding logic.

---

## 6. Performance & Resources

### High memory usage

- Settings → General → Idle Agent memory optimization: auto-release idle Agents (on by default), keep count (default 5), timeout minutes (default 60) — long-idle Agents are reclaimed and restart on reuse;
- Settings → Process monitor: per-process memory; "Stop" a runaway Agent (confirmation);
- Too many projects/sessions at once: reduce parallel Agents.

### UI lag

- Large diffs / long timelines are common sources: close unneeded drawer panels (Trace / Checkpoints);
- Settings → Storage & logs → "Clear UI cache" (clears local storage and reloads; session files untouched).

### Agent stuck (not responding/stopping)

Session tab `⋯` → Stop/Restart; if that fails → Settings → Process monitor → stop the process; last resort: restart the app. RPC logs recorded before the hang are gold — enable "RPC log" first, then reproduce.

---

## 7. Data, Logs & Privacy

### Where are the logs

Settings → Storage & logs:

- **App log / RPC log**: size shown, "Open" the log directory, delete, plus a built-in viewer (level filter + search + date range + refresh);
- "Clear all logs" and "Clear UI cache" are two separate buttons.

### Where are sessions stored / how to back up

- Session files: Settings → Storage & logs → Open data directory; the chat record directory is changeable via the Chat section `⋯` menu;
- Export a single session: session menu → Export HTML (not for DSH).

### Privacy & telemetry

PiDeck sends an **anonymous, low-frequency** `app_heartbeat` (version spread/platform/active installs) by default; no project paths, code, or message content. Disable in Settings → Dev → Privacy → telemetry. Review the diagnostic report before sharing (it's sanitized, but check anyway).

---

## 8. Updates & Rollback

### Update download fails / slow

Settings → Dev → Update source: switch gateway (ghfast / ghproxy.net / CN mirror / custom). Windows can auto-download updates (on by default).

### Problems after an update

- Restart first; if it's a new-version regression: grab the previous release from GitHub Releases and reinstall (session data is not affected);
- When reporting, attach the **diagnostic report** + reproduction steps.

---

## 9. Config Cheat Sheet by Symptom

| Symptom / need | Where to configure |
|---|---|
| Image understanding (screenshot questions) is weak | Settings → Vision bridge (model/endpoint/API key/concurrency/timeout) |
| Generate images | Settings → Imagegen (provider/model/reference-image mode) |
| Feishu bot | Settings → Feishu bot (the "Usage guide" dialog has the full flow) |
| Usage/balance queries | Usage-query button (generic / New API templates), or Settings → Usage stats |
| DSH backend | Settings dialog → Config → DSH (install/version/models/permissions) |
| External editors | Settings → External editors (detect/path/enable) |
| LAN access (phone preview) | Settings → Web service (port/QR code) |

---

## 10. Still stuck?

1. Generate a **diagnostic report** (Settings → Dev → Diagnostics);
2. Search or open an Issue at [GitHub Issues](https://github.com/ayuayue/PiDeck/issues) (attach report + version + repro steps);
3. Join the community **QQ group: 1026218644**.

> When debugging, confirm the version first, then cross-check the [changelog](/en/changelog) for known issues.
