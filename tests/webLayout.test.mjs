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
	// 回合聚合纯函数存在且被主循环使用（不再逐条消息渲染）。
	assert.match(webTimeline, /export function groupTimelineEntries[\s\S]*?messages: UIMessage\[\]/);
	assert.match(webTimeline, /timelineEntries = useMemo\(\(\) => groupTimelineEntries\(messages\)/);
	assert.doesNotMatch(webTimeline, /<WebAssistantMessage /, "per-message rendering must be replaced by the turn component");
	assert.match(webTimeline, /<WebAssistantTurn turn=\{entry\.turn\}/);
	// chevron 方向：折叠态指向右（ChevronRight），展开态向下（ChevronDown），不再用 rotate-180 翻转 ChevronDown。
	assert.doesNotMatch(webTimeline, /rotate-180/, "rotate-180 on ChevronDown renders the collapsed state pointing the wrong way");
	assert.match(webTimeline, /processOpen \? [\s\S]*?<ChevronDown[\s\S]*?: [\s\S]*?<ChevronRight/, "collapsed state must point right, expanded must point down");
	// 思考块合并：回合内多段 reasoning 合成一个 thinking 段（texts.join），不再被拆成多块。
	assert.match(webTimeline, /kind: "thinking"[\s\S]*?texts\.push\(/, "adjacent reasoning parts must merge into one thinking segment");
	// 段级流式状态：合并块的 running 以最后一个 reasoning part 的 state 为准，不再用整轮流式标志，
	// 避免「回复已出、思考还在转圈」的错序观感（m00717）。
	assert.match(webTimeline, /state === "streaming"/, "thinking segment running must come from part state");
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
	// 脱节态轮询提速：间隔取决于 streaming 或 runtime 忙态，且 effect 依赖含 runtime 状态。
	assert.match(webChatApp, /setInterval\(refresh,\s*streaming \|\| runtimeBusyNow \? 1000 : 3000\)/);
	assert.match(webChatApp, /\}, \[streaming, activeRuntime\?\.status\]\)/);
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
	assert.match(webHeader, /<ContextUsageSheetBody usage=\{contextUsage\} onCompact=\{actions\?\.onCompact\}/);
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
