import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const webCss = readFileSync("src/renderer/src/web/web.css", "utf8");
const webSidebar = readFileSync("src/renderer/src/web/WebSidebar.tsx", "utf8");
const webHeader = readFileSync("src/renderer/src/web/WebHeader.tsx", "utf8");
const webModelSheet = readFileSync("src/renderer/src/web/WebModelSheet.tsx", "utf8");
const webChatApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
const webSessionStrips = readFileSync("src/renderer/src/web/WebSessionStrips.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
const webDshToolsPanel = readFileSync("src/renderer/src/web/WebDshToolsPanel.tsx", "utf8");

test("Web shell keeps sidebar and chat pane in a horizontal split", () => {
	assert.match(webCss, /\.app\.wechat-shell\s*\{[\s\S]*?flex-direction:\s*row;/, "the desktop shell defaults to a vertical layout, so Web must explicitly restore the horizontal split");
	assert.match(webCss, /\.app\.wechat-shell\s*>\s*\.chat-list-pane\s*\{[\s\S]*?flex:\s*0\s+0\s+280px;[\s\S]*?width:\s*280px;/, "the Web sidebar needs a stable width or it consumes the chat pane");
	assert.match(webCss, /\.app\.wechat-shell\s*>\s*\.chat-pane\s*\{[\s\S]*?flex:\s*1\s+1\s+0;/, "the chat pane must own the remaining horizontal space");
});

test("Web project rows can collapse after the active session is revealed", () => {
	assert.match(webSidebar, /useEffect\(\(\) => \{/);
	assert.doesNotMatch(webSidebar, /expandedProjects\.has\(project\.id\) \|\| project\.id === activeSessionProjectId/, "the active project must not be forced open on every render");
	assert.match(webSidebar, /const expanded = searching \|\| expandedProjects\.has\(project\.id\)/);
});

test("Web model picker lives in a searchable bottom sheet, header stays one row", () => {
	// 模型选择器已从头部的 Command 弹层迁到 composer 的 WebBottomSheet（第三批瘦身）：
	// 搜索输入在 sheet 内，header 不再携带 CommandInput。
	assert.match(webModelSheet, /placeholder=\{t\("web\.modelSearch"\)\}/);
	assert.match(webModelSheet, /t\("web\.modelEmpty"\)/);
	assert.doesNotMatch(webHeader, /CommandInput/);
	// 头部固定单行（全局入口收敛进溢出菜单），不再 flex-wrap 换行。
	assert.match(webHeader, /web-header flex min-w-0 items-center/);
	assert.doesNotMatch(webHeader, /flex-wrap/);
});

test("Mobile Web keeps chat full-screen and opens the project tree as a drawer", () => {
	assert.match(webChatApp, /mobileSidebarOpen/);
	assert.match(webChatApp, /onOpenSidebar/);
	assert.match(webSidebar, /mobile-sidebar-backdrop/);
	assert.match(webSidebar, /mobile-open/);
	assert.match(webSidebar, /onDeleteProject/);
});

test("Web starts with no selected session and exposes a scroll-to-bottom action", () => {
	assert.doesNotMatch(webChatApp, /setActiveSessionId\(next\.sessions\[0\]\?\.id \?\? ""\)/);
	assert.match(webChatApp, /setActiveSessionId\(""\)/);
	assert.match(readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8"), /scroll-to-bottom|ScrollDown|scrollToBottom/);
});

test("Project actions are sibling buttons instead of nested controls", () => {
	assert.match(webSidebar, /project-row-actions[\s\S]*?<Button/);
	assert.doesNotMatch(webSidebar, /project-row-actions[\s\S]*?<span[\s\S]*?role="button"/);
});

// 回归：孤儿 catalog 记录（projectId 不匹配任何项目）必须出现在「未分组」兜底分组里，
// 而不是在侧栏完全不可见。会话行与项目内会话复用同一渲染路径（含运行态圆点 + 点击打开）。
test("Web sidebar groups orphan sessions under an ungrouped fallback", () => {
	assert.match(webSidebar, /t\("web\.ungrouped"\)/);
	assert.match(webSidebar, /projectIds\.has\(session\.projectId\)/);
	assert.match(webSidebar, /const ungroupedSessions = useMemo\(/, "ungrouped sessions must be derived from sessions whose projectId matches no registered project");
	// 未分组分组用与项目内会话相同的 SessionRows 渲染（运行态圆点 + 可点击打开）。
	assert.match(webSidebar, /sessions=\{ungroupedSessions\}/);
	assert.match(webSidebar, /onSelect=\{props\.onSelectSession\}/);
	// 未分组分组不会在无孤儿记录时显示，避免空标题占位。
	assert.match(webSidebar, /ungroupedSessions\.length > 0/);
});

// 回归（第四批视觉打磨）：过程行无框化 + 身份色。web.css 曾经给 .tool-card/.thinking-block
// 加边框+面板底做成「卡片」，与桌面 timeline.css 的无框过程行哲学冲突，此处锁定回收后的形态。
test("Web timeline keeps tool cards and thinking rows frameless with identity colors", () => {
	// 工具卡/思考块不画外框、不铺面板底（视觉对齐桌面过程行）。
	assert.match(webCss, /\.web-app \.tool-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;\s*\}/);
	assert.doesNotMatch(webCss, /\.web-app \.tool-card,\s*[\s\S]*?\.thinking-block\s*\{[\s\S]*?background:\s*var\(--color-bg-panel\)/);
	// 身份色变量必须在 web.css 的两套 :root 覆盖里显式声明（亮/暗各一份），
	// 否则图标掉回灰字（timeline.css 的 .tool-card-icon 引用这些变量）。
	const rootBlocks = webCss.match(/:root[^{]*\{[\s\S]*?\}/g) ?? [];
	assert.ok(rootBlocks.length >= 2, `expected >=2 :root blocks in web.css, got ${rootBlocks.length}`);
	for (const block of rootBlocks) {
		assert.match(block, /--color-tool:\s*var\(--color-info\)/, "every web :root override must redeclare --color-tool");
		assert.match(block, /--color-thinking:/, "every web :root override must redeclare --color-thinking");
	}
	// running 呼吸 + 错误染色走 tone-/data- 状态类（与桌面 timeline 同构）。
	assert.match(webCss, /tone-running \.tool-card-icon[\s\S]*?animation:\s*tool-icon-breathe/);
	assert.match(webCss, /tone-error \.tool-card-icon[\s\S]*?color:\s*var\(--color-danger\)/);
});

// 回归（第五批：回合聚合/过程组）：连续 assistant 消息聚合成单回合，过程内容折叠进
// 「执行过程」容器，操作行只挂回合尾；chevron 方向修正为折叠 ChevronRight / 展开 ChevronDown。
test("Web timeline groups assistant messages into collapsible execution folds", () => {
	// 回合聚合纯函数存在于叶子模块（vm 沙箱可单测）且被主循环使用（不再逐条消息渲染）；
	// 提升门控（流式不提升 final、liveTextId 常显）的行为回归在 webTimelineGrouping.test.mjs。
	const webGrouping = readFileSync("src/renderer/src/web/webTimelineGrouping.ts", "utf8");
	assert.match(webGrouping, /export function groupTimelineEntries[\s\S]*?messages: UIMessage\[\], options: \{ isStreaming\?: boolean \}/);
	// 2027-02 前缀缓存：已完成回合按消息引用复用分组结果，每帧只重分组流式尾段。
	assert.match(webTimeline, /const timelineEntries = useMemo<TimelineEntry\[\]>\(\(\) => \{/);
	assert.match(webTimeline, /groupTimelineEntries\(messages\.slice\(consumed\), \{ isStreaming: props\.streaming \}\)/);
	// 流式末段正文不提升：挂 liveTextId 容器外常显，容器内不双显（桌面 isComplete 门控）。
	assert.match(webTimeline, /liveTextString !== undefined/);
	assert.match(webTimeline, /segment\.id === turn\.liveTextId\) return null/);
	assert.doesNotMatch(webTimeline, /<WebAssistantMessage /, "per-message rendering must be replaced by the turn component");
	assert.match(webTimeline, /<WebAssistantTurn turn=\{entry\.turn\}/);
	// chevron 方向：折叠态指向右（ChevronRight），展开态向下（ChevronDown），不再用 rotate-180 翻转 ChevronDown。
	assert.doesNotMatch(webTimeline, /rotate-180/, "rotate-180 on ChevronDown renders the collapsed state pointing the wrong way");
	assert.match(webTimeline, /processOpen \? [\s\S]*?<ChevronDown[\s\S]*?: [\s\S]*?<ChevronRight/, "collapsed state must point right, expanded must point down");
	// 思考块合并：回合内多段 reasoning 合成一个 thinking 段（texts.join），不再被拆成多块。
	// 分组逻辑已抽到 webTimelineGrouping 叶子模块，行为断言见 webTimelineGrouping.test.mjs；这里只锁「合并发生在分组层」。
	assert.match(webGrouping, /kind: "thinking"[\s\S]*?texts\.push\(/, "adjacent reasoning parts must merge into one thinking segment");
	// 段级流式状态：合并块的 running 以最后一个 reasoning part 的 state 为准，不再用整轮流式标志。
	assert.match(webGrouping, /state === "streaming"/, "thinking segment running must come from part state");
	assert.match(webTimeline, /running=\{segment\.running \?\? false\}/, "WebThinkingBlock must render per-segment running");
	assert.match(webTimeline, /segment\.texts\.join\("\\n\\n"\)/);
	// 操作行只挂回合尾：助手侧 web.msgCopy 只允许出现在 WebAssistantTurn 内（用户气泡另有自己的复制）。
	const turnStart = webTimeline.indexOf("WebAssistantTurn = memo");
	const turnEnd = webTimeline.indexOf("function WebAskCard", turnStart);
	const turnSource = webTimeline.slice(turnStart, turnEnd);
	assert.ok(turnStart >= 0 && turnEnd > turnStart, "WebAssistantTurn component must be found");
	const turnCopyUses = turnSource.match(/web\.msgCopy/g) ?? [];
	assert.equal(turnCopyUses.length, 1, "copy/share actions belong to the final reply of a turn only");
	assert.match(turnSource, /!props\.isStreaming && turn\.finalText/, "actions render only after the final reply settles");
	// 流式时过程组默认展开、结束回落折叠；手动开合优先。
	assert.match(webTimeline, /manualOpen \?\? props\.isStreaming/);
	// 过程组样式：左导轨缩进明细存在（css）。
	assert.match(webCss, /\.web-app \.execution-fold-details\s*\{[\s\S]*?border-left:/);
});

// 回归：头部运行态用紧凑「小圆点+文字」（self-start 防 stretch 拉横条），不用带边框底色的
// agent-status-indicator 大 pill——它在头部占两行高度、与标题/DSH 徽标挤在一起视觉过重。
test("Web header status pill stays compact inside the flex-col title block", () => {
	assert.doesNotMatch(webHeader, /"agent-status-indicator/);
	assert.match(webHeader, /self-start text-micro text-muted-foreground/);
	assert.match(webHeader, /size-1\.5 shrink-0 rounded-full/);
	assert.match(webHeader, /animate-pulse bg-\[var\(--color-accent\)\]/);
});

// 回归：DSH 权限预设入口是单盾牌图标（#214 保护强度语义），下拉选档；
// 曾是 w-36 宽 Select（盾牌+预设文字+箭头三个视觉件），窄屏把标题挤没。
test("Web header DSH permission entry is a single strength icon button", () => {
	assert.match(webHeader, /permissionStrengthIcon\(knownPreset\?\.strength/);
	assert.doesNotMatch(webHeader, /SelectTrigger|SelectValue/);
	assert.match(webHeader, /<PermissionIcon className="size-4" aria-hidden="true" \/>/);
	// 数据源对齐桌面：runtime state 直出优先，会话记录只兜底——否则乐观切换被轮询冲掉、图标切完弹回。
	assert.match(webChatApp, /permissionPreset=\{contextUsage\?\.permissionPreset\s*\?\?\s*activeSession\?\.permissionPreset\}/);
});

// 回归：三条 strip 默认折叠、无框化，且不使用不存在的 Tailwind token
// （bg-bg-surface/text-text-muted/bg-bg-inset 曾是静默 no-op，样式从未生效）。
test("Web session strips stay collapsed by default and use real tokens only", () => {
	assert.match(webSessionStrips, /useState\(false\)/, "StripShell must default to collapsed on mobile");
	assert.doesNotMatch(webSessionStrips, /bg-bg-surface|text-text-muted|bg-bg-inset/, "these tokens do not exist in the theme bridge — they silently no-op");
	// 折叠条只占一行：标题行可点（aria-expanded），明细展开后才渲染。
	assert.match(webSessionStrips, /aria-expanded=\{open\}/);
});

// 回归（流式脱节追赶）：刷新/断网后 useChat 回 ready 但 runtime 仍在跑时，
// 主轮询必须带 runtimeBusy 做恢复判定并周期补拉磁盘快照——否则页面永远停在旧文本。
test("Web stream recovery wires runtimeBusy into every decision site", () => {
	// 两个恢复触发点都携带 runtimeBusy（事件触发器 + 主轮询兼容）。
	assert.equal((webChatApp.match(/runtimeBusy:/g) ?? []).length, 2);
	// 脱节态轮询提速：间隔取决于 SSE 连接（已连降频 30s 心跳）、streaming 或 runtime 忙态，且 effect 依赖含 runtime 状态。
	assert.match(webChatApp, /setInterval\(refresh,\s*stateEventsConnected \? 30_000 : streaming \|\| runtimeBusyNow \? 1000 : 3000\)/);
	assert.match(webChatApp, /\}, \[streaming, activeRuntime\?\.status, stateEventsConnected\]\)/);
	// 忙态镜像 ref 在 render 期赋值（供事件回调读取最新值）。
	assert.match(webChatApp, /activeRuntimeRef\.current = activeRuntime;/);
});

// 回归：「加载更多」前插的是更早历史，入口必须在消息流顶部（往上滚到顶才碰得到），
// 曾经渲染在列表底部（最新消息处），语义反了。
test("Web load-more-history entry stays at the top of the message flow", () => {
	const loadMoreIndex = webTimeline.indexOf("{/* 分页加载更多");
	const entriesIndex = webTimeline.indexOf("{timelineEntries.map(");
	assert.ok(loadMoreIndex >= 0 && entriesIndex >= 0, "load-more block and entries render must exist");
	assert.ok(loadMoreIndex < entriesIndex, "load-more must render BEFORE the message entries (top of flow)");
	// 底部不再残留第二份加载更多入口。
	assert.equal((webTimeline.match(/hasMoreHistory && \(/g) ?? []).length, 1);
});

// 回归：DSH 工具面板的内容容器必须限高——静态插件清单 30+ 条曾把 Dialog 撑出屏幕，
// shadcn DialogContent（default 尺寸）本身不限高，上限必须在面板内部。
test("Web DSH tools panel caps its scroll area so long plugin lists stay on-screen", () => {
	assert.match(webDshToolsPanel, /max-h-\[60vh\]\s+min-h-40\s+overflow-y-auto/);
	// 同面板横向超屏：4 个 tab 在窄屏放不下曾把最后一个 tab 裁掉，tab 条必须可横向滚动且按钮不压缩。
	assert.match(webDshToolsPanel, /flex\s+gap-1\s+overflow-x-auto\s+border-b\s+border-border-subtle/);
	assert.ok((webDshToolsPanel.match(/shrink-0\s+gap-1\.5/g) ?? []).length >= 4, "all tab buttons must be shrink-0");
});

// 回归：头部上下文环必须可点开详情弹层（移动端无悬停 title，纯展示等于点不动）。
test("Web header context ring opens a usage sheet instead of being display-only", () => {
	// 环渲染带 onClick（非纯展示），且套了 32px 触区按钮。
	assert.match(webHeader, /<ContextRing usage=\{contextUsage\} onClick=\{\(\) => setContextSheetOpen\(true\)\} \/>/);
	assert.match(webHeader, /if \(props\.onClick\) \{[\s\S]*?<Button[^>]*onClick=\{props\.onClick\}/);
	// 详情弹层走 WebBottomSheet，主体列总量/输入/输出并提供压缩入口。
	assert.match(webHeader, /import \{ WebBottomSheet \} from "\.\/WebBottomSheet";/);
	assert.match(webHeader, /<ContextUsageSheetBody usage=\{contextUsage\} provider=\{usageProvider\} backend=\{usageBackend\} enabled=\{contextSheetOpen\} onCompact=\{actions\?\.onCompact\}/);
	assert.match(webHeader, /web\.inputTokens/);
	assert.match(webHeader, /web\.outputTokens/);
});

// 回归：web 端不再展示 rewind 检查点（用户明确要求移除；服务端路由与桌面不受影响）。
test("Web rewind checkpoint UI is fully removed from the renderer", () => {
	assert.ok(!existsSync("src/renderer/src/web/WebRewindPanel.tsx"), "WebRewindPanel.tsx must be deleted");
	assert.doesNotMatch(webHeader, /onOpenRewind|History/);
	assert.doesNotMatch(webChatApp, /WebRewindPanel|rewindOpen|onOpenRewind/);
	// 溢出菜单仍保留压缩等动作（移除 rewind 不得误伤其余入口）。
	// m00717：菜单项统一带 lucide 图标（与刷新消息一致），断言改为容忍图标行
	assert.match(webHeader, /onCompact \? \(\s*<DropdownMenuItem onClick=\{actions\.onCompact\}[\s\S]*?<FoldVertical/);
});

// 回归：后端切换仅对「本页新建零消息草稿」开放。历史会话（含复制/克隆/fork 出的）自带
// 消息记录，后端不可切——否则 pi/DSH/生图的历史消息会被错挂到另一个后端上。
test("Web backend switcher stays draft-only; historical sessions are locked", () => {
	assert.match(webChatApp, /webDraftSessionsRef = useRef<Set<string>>\(new Set\(\)\)/);
	assert.match(webChatApp, /markSessionLoaded = \(id: string, freshDraft = false\)/);
	// 仅两处 createSession 新建流程标记 freshDraft；复制/克隆/fork 的 markSessionLoaded(id) 不标记。
	assert.equal((webChatApp.match(/markSessionLoaded\(id, true\)/g) ?? []).length, 2);
	// 锁定判定贯通渲染与点击守卫（防弹层已开后的状态竞态）。
	assert.match(webChatApp, /const backendSwitchLocked = \(sessionId: string\) =>/);
	assert.match(webChatApp, /backendLocked=\{activeSession \? Boolean\(activeRuntime\) \|\| backendSwitchLocked\(activeSession\.id\) : false\}/);
	assert.match(webChatApp, /if \(activeSession && \(activeRuntime \|\| backendSwitchLocked\(activeSession\.id\)\)\) return;/);
});

// 回归（W2 渲染修复）：外部流跨轮保活——一轮 [DONE] 后不关连接，下一轮 start 帧到达时
// 客户端自行重置合并器；服务端收口时清回放源并换新会话级翻译器。旧实现 settle 即 closeStream 且
// effect 依赖不变永不重开，导致 Ask 续答等后续轮次全部丢帧（用户反馈「Ask 回答之后看不到渲染」）。
test("External stream stays alive across turns; visibility gates the connection", () => {
	const webExternalStream = readFileSync("src/renderer/src/web/webExternalStream.ts", "utf8");
	const webEventStream = readFileSync("src/main/web/WebEventStream.ts", "utf8");
	// 客户端：收尾不再关流（连接留给下一轮），关流只发生在 enabled/sessionId/可见性变化。
	const settleBody = webExternalStream.slice(webExternalStream.indexOf("const settle = (withReload: boolean) => {"));
	const settleFn = settleBody.slice(0, settleBody.indexOf("\n\t};"));
	assert.ok(settleFn.length > 0, "settle function must exist");
	assert.doesNotMatch(settleFn, /closeStream\(\)/, "settle must not close the stream (keep-alive across turns)");
	assert.match(settleFn, /不关流/, "settle documents the keep-alive decision");
	// 客户端：同一连接上新一轮的 start 帧重置合并器。
	assert.match(webExternalStream, /frame\.type === "start" && merger\.isFinished\(\)/);
	// 客户端：可见性作为开流条件（后台关、回前台重开），不再只关不开。
	assert.match(webExternalStream, /!visible\) \{/);
	assert.match(webExternalStream, /setVisible\(document\.visibilityState === "visible"\)/);
	// 服务端：keepAlive 选项存在并在 [DONE] 后保留连接（翻译器/回放源是会话级，收口时重置）。
	assert.match(webEventStream, /keepAlive\?: boolean/);
	assert.match(webEventStream, /if \(entry\.keepAlive\) return;/);
	assert.match(webEventStream, /private endRun\(/, "收口时统一清回放源并换新翻译器");
	// 服务端：新连接先回放本轮已产出的帧，客户端 onopen 重建合并器（中途接入/断线重连不丢内容）。
	assert.match(webEventStream, /private replayRun\(/);
	assert.match(webExternalStream, /es\.onopen[\s\S]*?mergerRef\.current\?\.reset\(\)/);
	// 渲染层：流式标志贯通分组（末段正文挂 liveTextId 常显、不提升为 finalText）。
	assert.match(webTimeline, /groupTimelineEntries\(messages\.slice\(consumed\), \{ isStreaming: props\.streaming \}\)/);
});

// 回归（Web 走查 #2）：上下文用量百分比必须走自适应精度。
// pi 的 contextPercent 是浮点（实测 45.50234375），直接插值会显示成「45.50234375%」；
// 桌面端早已用 formatPercent，Web 端两处展示（环 tooltip / 详情大数字）此前漏了。
test("Web context usage renders adaptive-precision percentages", () => {
	assert.match(webHeader, /import \{ formatPercent \} from "\.\.\/components\/session\/TimelineFormat";/);
	assert.match(webHeader, /function resolveContextPercent\(usage: WebContextUsage\): number/);
	assert.equal((webHeader.match(/resolveContextPercent\(/g) ?? []).length >= 3, true, "both the ring and the detail body must resolve through the shared helper");
	// 展示点不再裸插 percent
	assert.doesNotMatch(webHeader, /\$\{percent\}%/, "percent must be formatted, not interpolated raw");
	assert.match(webHeader, /\$\{formatPercent\(percent\)\}%/);
});

// 回归（Web 走查 #4）：390px 视口下 markdown 列表项实测溢出容器（scrollWidth 373 > clientWidth 358）。
// timeline.css 只给 .assistant-text 声明了换行策略，列表项自身仍是默认 normal。
test("Web markdown lists wrap long content instead of overflowing", () => {
	const listRule = webCss.slice(webCss.indexOf(".web-app .markdown-body ul,"));
	assert.ok(listRule.length > 0, "wrap rule must exist in web.css");
	assert.match(listRule.slice(0, 400), /overflow-wrap:\s*anywhere;/, "list items need anywhere wrapping at 390px");
	assert.match(listRule.slice(0, 400), /word-break:\s*break-word;/);
	assert.match(listRule.slice(0, 400), /min-width:\s*0;/);
});

// 回归（Web 走查 #11）：删除项目此前用原生 window.confirm，与删除会话的 AlertDialog 两套风格。
test("Web destructive confirmations both use AlertDialog, never window.confirm", () => {
	assert.match(webSidebar, /from "@\/components\/ui-shadcn\/alert-dialog"/);
	assert.doesNotMatch(webSidebar, /window\.confirm/, "window.confirm has no styling and breaks mobile gestures");
	assert.match(webSidebar, /AlertDialog open=\{pendingDeleteProject != null\}/);
	assert.match(webSidebar, /t\("web\.deleteProjectConfirmTitle"\)/);
	assert.match(webSidebar, /t\("web\.deleteProjectConfirm"\)/);
	assert.match(webChatApp, /AlertDialog open=\{deleteConfirmId != null\}/);
});

// 回归（Web 走查 #8 → 2026-10 修正）：侧栏「更多会话」一度一次渲染 407 行（258ms、DOM 4363 节点），
// 改成首屏窗口后又走了另一头——IntersectionObserver 哨兵在移动端抽屉首次布局就命中 rootMargin，
// 展开大项目被连续补页（实测「聊天」115 条展开即 57 行），体感等同「一打开全都在」。
// 现在语义对齐桌面端「最近会话」：首页 10 条 + 显式「查看更多（剩余 N）」每页 +20 + 「收起」，
// 不随滚动自动加载；分页窗口由 webSidebarPaging 纯函数计算（见 webSidebarPaging.test.mjs）。
test("Web sidebar renders session rows through an explicit paged window", () => {
	assert.doesNotMatch(webSidebar, /const visible = showAll \? sessions : sessions\.slice\(0, 5\);/, "one-shot full render is the regression");
	// 首页 10 条来自纯策略模块，组件不再自己存 5/50 常量
	assert.match(webSidebar, /import \{[^}]*resolveSidebarWindow[^}]*\} from "\.\/webSidebarPaging";/);
	assert.match(webSidebar, /const window_ = resolveSidebarWindow\(\{ total: sessions\.length, requested, searching \}\);/);
	assert.match(webSidebar, /onClick=\{\(\) => setRequested\(growSidebarWindow\(window_\.visibleCount\)\)\}/);
	assert.match(webSidebar, /data-testid="web-sidebar-collapse-sessions"/);
	// 自动补页是本次要修掉的行为：哨兵观察器不许再出现在侧栏会话列表里
	assert.doesNotMatch(webSidebar, /new IntersectionObserver\(/, "sidebar must not auto-load pages on scroll");
	assert.doesNotMatch(webSidebar, /sentinelRef/);
	assert.doesNotMatch(webSidebar, /showAll=\{/, "expanded-session set state is gone; the window owns paging now");
});

// 回归（Web 走查 #9）：模型弹层 343 个 button / 16605px 滚动高度，一次全渲染。
test("Web model sheet renders rows through an incremental window", () => {
	assert.match(webModelSheet, /const MODEL_ROW_WINDOW = 40;/);
	assert.match(webModelSheet, /const MODEL_ROW_STEP = 40;/);
	assert.match(webModelSheet, /function flattenModelRows\(/);
	assert.match(webModelSheet, /const visibleRows = rows\.slice\(0, Math\.min\(rendered, rows\.length\)\);/);
	assert.match(webModelSheet, /new IntersectionObserver\(/);
	// 搜索词变化必须回到首屏窗口，否则过滤后仍渲染旧窗口的行
	assert.match(webModelSheet, /useEffect\(\(\) => setRendered\(MODEL_ROW_WINDOW\), \[query\]\);/);
});

// 回归（Web 走查 #12）：主题三态循环从 system 出发时必须跳到与系统相反的一档，
// 否则系统亮色时第一次点击毫无变化，用户以为按钮坏了。
test("Web theme cycle always produces a visible change", () => {
	const webTheme = readFileSync("src/renderer/src/web/webTheme.ts", "utf8");
	assert.match(webTheme, /export function nextWebTheme\(pref: WebThemePreference, resolved: ResolvedWebTheme\): WebThemePreference/);
	assert.match(webTheme, /return resolved === "dark" \? "light" : "dark";/);
	assert.match(webChatApp, /nextWebTheme\(themePreference, resolvedTheme\)/);
});

// 回归（Web 走查 #14）：图标按钮的原生 outline 被 shadcn 的 outline-none 清掉，
// 键盘用户看不到落点——Web 作用域内统一补 focus 环。
test("Web interactive elements keep a visible focus ring", () => {
	const focusRule = webCss.slice(webCss.indexOf(".web-app button:focus-visible,"));
	assert.ok(focusRule.length > 0, "focus-visible rule must exist in web.css");
	assert.match(focusRule.slice(0, 300), /outline:\s*2px solid var\(--color-text-primary\);/);
	assert.match(focusRule.slice(0, 300), /outline-offset:\s*2px;/);
});

// 回归（Web 走查 #15）：整页此前没有任何 h1/h2/h3，屏幕阅读器无法定位主区。
test("Web header exposes the session title as the page heading", () => {
	assert.match(webHeader, /<h1 className="flex min-w-0 items-center gap-1\.5 truncate/);
	assert.match(webHeader, /<\/h1>/);
});

// 回归（Web 走查 #5）：无会话时输入框不能再写「发送到当前会话」——此时输入是新建会话入口。
test("Web composer placeholder explains new-session mode when nothing is selected", () => {
	const webComposer = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
	assert.match(webComposer, /function composerPlaceholder\(hasSession: boolean, planMode: boolean\): string/);
	assert.match(webComposer, /t\("web\.promptPlaceholderEmpty"\)/);
	assert.match(webComposer, /placeholder=\{placeholder\}/);
	assert.match(webComposer, /aria-label=\{placeholder\}/);
	assert.match(webChatApp, /hasSession=\{Boolean\(activeSessionId\)\}/);
});

// 回归（Web 走查 #13）：会话内搜索此前只扫已加载消息，大会话必然漏命中。
// 契约：后端全会话检索优先；命中落在未加载历史时先补拉历史页再滚动；不可用回退本地。
test("Web search dialog queries the whole session through the backend", () => {
	const dialog = readFileSync("src/renderer/src/web/WebSearchDialog.tsx", "utf8");
	const hook = readFileSync("src/renderer/src/web/useWebSessionSearch.ts", "utf8");
	const webApi = readFileSync("src/renderer/src/web/webApi.ts", "utf8");
	assert.match(webApi, /export async function fetchSessionSearch\(sessionId: string, query: string\): Promise<SessionSearchResult \| null>/);
	assert.match(webApi, /`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/search\?\$\{params\.toString\(\)\}`/);
	assert.match(hook, /export function useWebSessionSearch\(sessionId: string \| undefined, query: string, messages: UIMessage\[\], enabled: boolean\): WebSessionSearchState/);
	assert.match(hook, /export const WEB_SEARCH_DEBOUNCE_MS = 250;/);
	// 后端不可用时必须回退本地并标记 unavailable（不能显示成「没有命中」）
	assert.match(hook, /if \(remoteResult === null\) \{/);
	assert.match(hook, /unavailable: true/);
	assert.match(dialog, /useWebSessionSearch\(sessionId, query, messages, open\)/);
	assert.match(dialog, /unavailable \? t\("web\.searchScopeHint"\) : t\("web\.searchWholeSession"\)/);
	// 命中落在未加载历史：先补拉历史页再滚动，否则点击静默无反应
	assert.match(webChatApp, /const jumpToSearchHit = async \(messageId: string\) => \{/);
	assert.match(webChatApp, /await loadOlderMessages\(\);/);
	assert.match(webChatApp, /const MAX_SEARCH_JUMP_PAGES = 5;/);
	assert.match(webChatApp, /<WebSearchDialog open=\{searchOpen\} onOpenChange=\{setSearchOpen\} sessionId=\{activeSessionId\}/);
});

test("Web context sheet shows provider quota usage next to the context numbers", () => {
	// m02502：用户要的是「额度用量」，不是上下文——详情弹层在上下文数字之下追加
	// 供应商额度区块；数据来自 /api/usage（Web 端自写 hook，不依赖桌面 jotai atoms）。
	assert.match(webChatApp, /usageProvider=\{contextUsage\?\.provider \?\? activeSession\?\.model\?\.provider\}/);
	assert.match(webChatApp, /usageBackend=\{activeSession\?\.backend === "dsh" \? "dsh" : "pi"\}/);
	assert.match(webHeader, /<ContextUsageSheetBody usage=\{contextUsage\} provider=\{usageProvider\} backend=\{usageBackend\}/);
	assert.match(webHeader, /function ProviderUsageBlock\(props: \{ provider\?: string; backend\?: UsageProbeBackend; enabled\?: boolean \}\)/);
	assert.match(webHeader, /useWebProviderUsage\(props\.provider, props\.backend \?\? "pi", props\.enabled !== false && Boolean\(props\.provider\)\)/);
	// 区块完全由 success 结果驱动：未装配/未开启/失败一律不渲染（降级为“没有额度区块”，不是报错）
	assert.match(webHeader, /if \(!props\.provider \|\| !result\?\.success\) return null;/);
	assert.match(webHeader, /data-testid="web-provider-usage"/);
	// 与桌面 ProviderUsageDetails 同源的展示规则：走 providerUsageDisplay 的纯函数，不另起口径
	assert.match(webHeader, /from "..\/utils\/providerUsageDisplay"/);
	assert.match(webHeader, /USAGE_TONE_BAR_CLASS/);
	assert.match(webHeader, /USAGE_TONE_TEXT_CLASS/);
	assert.match(webHeader, /relativeTimeParts\(result\.at\)/);
});

test("Web usage rows are never rendered on germline-less providers", () => {
	// 守卫边沿：不要把「余额为 0」当成「没有数据」（前者是真信号，红字显示）
	assert.match(webHeader, /result\.balance\.value <= 0 \? USAGE_TONE_TEXT_CLASS\.empty : USAGE_TONE_TEXT_CLASS\.ok/);
	// 紧凑 K/M 格式（q2 选型）：上下文数字不再用 toLocaleString 写满七位
	assert.doesNotMatch(webHeader, /toLocaleString\(\)/);
	assert.match(webHeader, /import \{ formatTokens \} from "..\/components\/session\/SessionContextMeter";/);
	assert.match(webHeader, /\$\{formatTokens\(tokens\)\} \/ \$\{formatTokens\(window\)\}/);
});
