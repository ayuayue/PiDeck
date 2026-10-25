# Contributors

Thanks to everyone who has contributed to PiDeck!

<!-- Ordered by first contribution -->

- **1900EasonJin** ([@1900EasonJin](https://github.com/1900EasonJin)) — Feishu/Lark remote control, MemSpacedCard, thinking throttle, sidebar card redesign, scratch pad, terminal encoding fixes; system titlebar sidebar toggles; pet stuck-state fix (#107, #104, #80, #74, #60, #44, #42, #35, #34, #31, #30, #29, #28, #18)
- **zx3022448** ([@zx3022448](https://github.com/zx3022448)) — Model list fetch improvements and error states, model picker UX; MCP and skill import from Claude Code / Codex (#221, #25, #19)
- **frostime** ([@frostime](https://github.com/frostime)) — Session info sync, custom font/size/zoom, model picker auto-scroll, max thinking level, RPC extension UI lifecycle (#58, #56, #53, #52, #50)
- **magic2066** ([@magic2066](https://github.com/magic2066)) — Codex subagent import display fix; Linux desktop pet drag and dev launch fixes (#40, #41)
- **pangolinknight** ([@pangolinknight](https://github.com/pangolinknight)) — Main-process stream throttling and tool-result truncation; large-session renderer white-screen fix (#33)
- **me9rez** ([@me9rez](https://github.com/me9rez)) — Dependency cleanup, SkillManager symlink scanning/cycle detection; TypeScript incremental build output hygiene (#97, #86, #69)
- **bfzha** ([@bfzha](https://github.com/bfzha)) — VS Code-style Git panel and complex workflows; session memory slimming and stream render optimizations; timeline view position preservation; skills/prompts/extensions enable toggles; resource scopes and pi 0.85 parser alignment (#68, #145, #144, #143, #142, #141); run-control "stop answering / close agent" semantics split; built-in web service bound to loopback with mandatory token auth; shell operators no longer rendered as session chips; status-glyph clipping and ask-tone fixes; ask card pinned to the column bottom with full-width option rows (#230); pi 0.86 system-entry entryId misalignment fix; transient retry-success card; file-tree Git status coloring (solid immediate parent, faded deeper ancestors); legacy directory identity keys merged so duplicate records and mismatched titles are gone (#354); history skeleton no longer stuck after a restart (#350); Ctrl+Tab follows the tab-bar order (#346); macOS Dock tailscale GUI fallback (#351); list ordering collapsed into drag plus keyboard nudge; skill-store search argument contract aligned; the trajectory inspector rebuilt end to end (real system-prompt snapshots, index-based bounded reads, rail catalog with merged index, ledger render window with pixel-aggregated overview, event-driven refresh, turn summaries with folding); Markdown image rendering inside conversations (read-only `pideck-file://` protocol, 640×360 and 96px multi-image layouts, copy and save); prompt template argument substitution with same-name merging; and the end-of-turn "modified files" moved into a chip row, fixing the silent file loss caused by `meta.args` truncation (5.0% → 0.69%)
- **Lopution** ([@Lopution](https://github.com/Lopution)) — WSL path handling across desktop boundaries (#84)
- **buaassp** ([@buaassp](https://github.com/buaassp)) — Hide internal pi-subagent sessions (#57)
- **zzq168281-coder** ([@zzq168281-coder](https://github.com/zzq168281-coder)) — Interactive local file links; todo widget honors interface fonts (#103)
- **weishiair** ([@weishiair](https://github.com/weishiair)) — Delete built-in extension files on disable/conflict yield so third-party tools no longer clash and break RPC
- **clancyclaw** ([@clancyclaw](https://github.com/clancyclaw)) — Preserve RichInput newlines so multi-line drafts stay intact
- **octo-patch** ([@octo-patch](https://github.com/octo-patch)) — MiniMax endpoints for auth-only model discovery (#112)
- **c834292137** ([@c834292137](https://github.com/c834292137)) — Unified session component card (todos/subagents/file changes) with a shared aggregation layer (#171)
- **r0y1z2** ([@r0y1z2](https://github.com/r0y1z2)) — Project session pinning, secure composer voice transcription (#177, #176); compact Windows Explorer quick-task window (#243)
- **sgafxh** ([@sgafxh](https://github.com/sgafxh)) — Recovery from request-body-size-limit rejections, Windows pi console-window fix (#188, #180)
- **lerrorgk** ([@lerrorgk](https://github.com/lerrorgk)) — Fixed nicobailon pi-subagents async dispatch being mis-marked complete; panel entries now include the full task description (#206)
- **juzijun233** ([@juzijun233](https://github.com/juzijun233)) — Stability and security hardening series: login-shell PATH probing moved to async warm-up (startup freeze gone), late streaming events after a stop rejected as "no runtime", event payloads carrying sessionId + runtimeGeneration, main-process direct sends restricted to the subscribed-channel allowlist, oversized diff truncation, PiRpcClient line-buffer cap, Git write validation of commit hash and reset mode, per-session subscription isolation so split panes no longer drag each other, plus webview dead attributes and redundant any assertions; the channel-switch version guard so an older dev build is no longer offered (#336), plus the unified API aggregation layer (`piDeckApi` facade with domain-registry assembly — a 55-domain catalog plus sessions/config method grouping, #355)
- **xiaYuTian11** ([@xiaYuTian11](https://github.com/xiaYuTian11)) — Current Git branch in the sidebar project tree (#232), timeline scroll jitter and jump-to-top/bottom fixes (#224), session tab width cap and font size (#226), skill rename routed by skill type so markdown skills no longer move the skill root (#227)
- **Q-xuan** ([@Q-xuan](https://github.com/Q-xuan)) — Inline-code file references are clickable again (#228); bracketed LaTeX formulas now render (#251); the unclosed thinking-marker leak into assistant prose (#363)
- **cmyk-xing** ([@cmyk-xing](https://github.com/cmyk-xing)) — Feature-module visibility switches in appearance settings so unused module entries can be hidden (#254); guide-page bootstrap messages no longer leak into newly created sessions (#256); Windows reopen at their last position, size, and maximized state (#259)

- **EEEEEEEEdison** ([@EEEEEEEEdison](https://github.com/EEEEEEEEdison)) — Right sidebar split into an upper drawer pane and a persistent session-status pane (#334); streaming and end-to-end TPS measurement modes (#327)
- **fengxinzi1814** ([@fengxinzi1814](https://github.com/fengxinzi1814)) — Ask cards submit on click instead of requiring a second click (#344)
- **san-ren** ([@san-ren](https://github.com/san-ren)) — Mobile Web viewport: a top bar that collapses with scroll and a composer that folds away when idle, with the collapse state machine extracted into pure functions and covered by e2e
- **GME** ([@EEEEEEEEdison](https://github.com/EEEEEEEEdison)) — Session-level average TPS (interval unions remove the overlapping time of derived tasks) and thinking intensity clamped to the levels the current model supports
- **TanCan1998** ([@TanCan1998](https://github.com/TanCan1998)) — Usage details derive the used percentage when a probe reports only total and remaining; diagnostics bundles keep redacted detail; HTML preview moves to the `pideck-html://` protocol to lift the CSP limit; an explainable error when the DSH runtime is not installed; rewind checkpoints use a temporary index with the WSL index path and empty-tree edge cases covered (#380, #382, #383, #384, #386)

And everyone who filed issues, shared feedback, and helped spread the word.

## 💖 Special Support

- **微时佬友** ([@weishiair](https://github.com/weishiair)) — Provides the Grok model service used for PiDeck development 🎉
- **橙子** — Provides the subscription service used for PiDeck development 🎉
- **罪** — Provides the model service used for PiDeck development 🎉

---

Want to contribute? Open a Pull Request! See the [development guide](docs-site/guide/development.md) for running from source.
