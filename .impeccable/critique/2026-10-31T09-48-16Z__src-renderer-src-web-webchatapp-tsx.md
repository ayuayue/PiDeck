---
target: web 移动端聊天页（src/renderer/src/web/WebChatApp.tsx 整面）
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\14012\\pi-desktop-dev\\src\\renderer\\src\\web\\WebChatApp.tsx"
target_fingerprint: "sha256:2255e12e379847fb754f8d726cca99fa6fe10c5d4386f8e928b1cdca0acf46a1"
target_path: "C:\\Users\\14012\\pi-desktop-dev\\src\\renderer\\src\\web\\WebChatApp.tsx"
timestamp: 2026-10-31T09-48-16Z
slug: src-renderer-src-web-webchatapp-tsx
---
# PiDeck Web 移动端聊天页 — 设计评审（impeccable critique）

Method: dual-agent (A: agent_810e61c0 · B: agent_a13513fa)
Target: src/renderer/src/web/WebChatApp.tsx（web 移动端聊天页整面）+ 真机截图（light 主题，DSH 会话，约 390px 视口）
Date: 2026-10-31 · Mode: Operate

## Design Health Score

| # | 启发式 | 分 | 关键问题 |
|---|---|---|---|
| 1 | 系统状态可见 | 3 | 错误卡挂列表尾滚离即隐身；ContextRing 酷似刷新图标 |
| 2 | 贴近真实世界 | 3 | 横「…」与竖「⋮」相邻溢出菜单语义靠 tooltip（触屏无） |
| 3 | 用户控制与自由 | 4 | fork 化编辑/重发/删除、队列可撤、断流磁盘追赶 |
| 4 | 一致性与标准 | 3 | pointer-coarse 升档是典范；亮色语义文字色比桌面语义档低两档 |
| 5 | 错误预防 | 3 | 删除双确认；DSH full-access 一键切换无确认 |
| 6 | 识别而非回忆 | 3 | 三层折叠摘要好；两菜单各装什么全靠记 |
| 7 | 灵活与效率 | 3 | 边缘手势/队列/Ctrl+K；会话内搜索藏进全局菜单 |
| 8 | 美学与极简 | 3 | 行内码 chips 一屏 20+、头部 1+4 图标钮都在加噪 |
| 9 | 错误恢复 | 2 | error.message 原文直出、可能无重试、位置不可见 |
| 10 | 帮助与文档 | 2 | 移动端最需要 Enter 行为说明处恰好没有说明 |
| **Total** | | **29/40** | Good（28-35：底子扎实，补弱项即可） |

## Design Specificity Verdict

**LLM assessment**：结构是 PiDeck 的（execution-fold 左导轨、tool-card 身份色、后端署名鲸鱼、strips 对齐桌面同族），皮是 dsh-web 借的（bluish 灰阶、毛玻璃头部、白卡细线）；ink/paper 桌面灰阶未进入 web 端，语义色档已开始漂移。中上性格，非品类通用件。

**Deterministic scan**：exit 0，49 个 TS/TSX 文件 0 findings（62 条规则）。元素级规则（tiny-text / low-contrast 等）因无可达 URL 未运行，结果为低估值。浏览器可视化 SKIPPED：web 服务需运行中的 Electron host + auth token。

## What's Working

1. **pointer-coarse 全站触控升档体系**：header 36px、消息操作 36px、代码块复制 36px、发送 40px、会话行 40px——不是零散补丁而是一套规范。
2. **阅读模式编排**：非对称 headerAutoHide（上滑 -8px 即露、下滑 24px 才收）+ 程序化滚动豁免 + composer 三条件隐藏，对「手机读长输出」是正确解。
3. **弱网/打断工程**：SSE 断流防抖恢复、visibilitychange 磁盘追赶、队列失败放回队首并暂停，真实打断场景全有归宿。

## Priority Issues

1. **[P1] 移动端 Enter 恒发送，多行输入不可达** — WebComposer.tsx:280-285。虚拟键盘没有 Shift，发送与换行共用一键，误发率高、长指令写不了。修法：`pointer-coarse` 门控 Enter（移动端 Enter=换行，发送只走 40px 按钮），`enterKeyHint` 适配；桌面零变化。→ /impeccable harden
2. **[P1] 错误/待答卡挂列表尾，滚离底部即隐身** — WebTimeline.tsx:798 + WebChatApp.tsx:1365。回读历史时发送/断流/队列失败完全不可见。修法：commandError/transportError 上浮为 composer 上方常驻横幅（复用 recoveryNotice 样式，danger 变体，附重试/关闭）；pendingUiRequest 不在底部时给「Agent 等待回答」跳转横幅。→ /impeccable clarify
3. **[P2] 亮色语义色用 Tailwind 500 系做 11-13px 文字色（#f59e0b≈2:1）** — web.css:56-62；WebTimeline.tsx:268、WebSessionStrips.tsx:68、WebComposer.tsx:224。阳光下/低视力读不到运行状态。修法：token 层拆 bar/text 档（--color-warning-text:#854d0e、--color-success-text:#15803d），组件零改动。→ /impeccable polish
4. **[P2] 双溢出菜单相邻只差图标方向** — WebHeader.tsx:168-237（…9 个会话动作）vs 239-273（⋮ 全局入口）。触屏无 tooltip，全靠背。修法：合并为一个 ⋮，WebBottomSheet 分「会话/应用」两组渲染。→ /impeccable distill
5. **[P3] 代码块移动端三件套** — 常驻横滚条（web.css:207-216）+ 空语言「—」头 34px（streamdownChrome.css:172-189）+ 13px 代码字。修法：pointer:coarse 隐藏滚动条、空语言不渲染头、字号提至 0.875rem。→ /impeccable polish

## Persona Red Flags

- **Casey（单手分心）**：ContextRing 误当刷新图标；Enter 误发；分支 chips ≈24px 低于 44px 拇指标准；抽屉无反向滑动关闭。
- **Alex（性急 power user）**：会话内搜索要点两次+下拉；切模型需先唤起键盘再点选择器；长会话无「回到最新」捷径。
- **Sam（无障碍）**：text-warning/success 2:1 对比；#81858c≈3.5:1 用于 12px 头行；流式输出与 responding 指示无 aria-live 播报。

## Minor Observations

1. composer 快捷键提示 `hidden sm:inline`——移动端反而不显示。
2. 消息列表底部 pb-2 几乎贴住 composer，建议 pb-6。
3. 附件缩略图删除钮 ≈16px 触区（WebComposer.tsx:257）。
4. 队列条移除钮 pointer-coarse 后 ≈28px 仍偏小。
5. idle 用 info 蓝点、运行用墨点脉冲——语义方向可再想。
6. strips 展开态无「最后更新」提示，弱网下数据可能陈旧。

## Provocative Questions

1. 第二语言（dsh-web token）的色档漂移，该不该被 DESIGN.md 的豁免条款管住？
2. Enter=发送为桌面键盘而生，而 web 端存在的意义恰是「离开桌面」——现在的默认在惩罚哪一边？
3. 头部 4 钮 + 2 溢出菜单 + 抽屉 = 7 个导航动作，服务 3 个任务——先砍谁？

## 已修复备注

截图头部的「ent]」碎徽标（ACP "Agent CLI" 文字徽标被塞进 16px 图标位）已在本次会话先行修复（WebBackendMark 图标化，待重建生效）；截图摄于修复生效前。
