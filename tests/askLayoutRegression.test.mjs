import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const timelineCards = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
const chatContentWidth = readFileSync("src/renderer/src/components/session/chatContentWidth.ts", "utf8");
const overlay = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const timelineStyles = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const toolCards = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
const approvalCard = readFileSync("src/renderer/src/components/ui-shadcn/approval-card.tsx", "utf8");
const securityCard = readFileSync("src/renderer/src/components/overlays/SecurityConfirmCard.tsx", "utf8");
const planModeExt = readFileSync("resources/extensions/pi-deck-plan-mode.ts", "utf8");

test("Ask cards keep long content readable in every render path", () => {
	// 选项卡片和题干应自然换行；tab 胶囊仍只做 14ch 单行摘要，避免挤占问答空间。
	assert.match(overlay, /break-words whitespace-normal/);
	assert.match(overlay, /max-w-\[14ch\] min-w-0 truncate text-left/);
	// 整颗 tab 按钮都能悬停/聚焦看全文；Portal 提示不受卡片 overflow-hidden 裁切。
	assert.match(overlay, /<PromptTooltip\s+key=\{question\.id\}\s+text=\{question\.question\}>[\s\S]*?<Button[\s\S]*?role="tab"/);
	assert.doesNotMatch(overlay, /title=\{question\.question\}/);
	assert.match(approvalCard, /<PromptTooltip\s+text=\{props\.title\}>/);
	assert.match(toolCards, /whitespace-normal break-words font-mono text-chat-detail/);
	assert.match(toolCards, /formatAskTitle\(item\.question/);
	assert.match(webTimeline, /formatAskTitle\(props\.request\.title/);
	assert.match(webTimeline, /flex-col items-start justify-center whitespace-normal/);
	// Ask 的展开内容必须交给会话时间线滚动，卡片本身不能因固定高度裁掉步骤或说明。
	assert.match(timelineStyles, /\.tool-card \{[\s\S]*?overflow: visible;/);
});

test("Batch input questions keep the input flexible and submit button compact", () => {
	// Button 默认带 shrink-0；纯输入题若再叠加 w-full，会优先占满整行宽度，把输入框压成截图中的窄条。
	// 输入框负责吸收剩余空间，提交按钮只保留自身文案宽度。
	assert.match(overlay, /<div className="flex w-full items-center gap-2">[\s\S]*?className="h-9 flex-1[\s\S]*?className="shrink-0"[\s\S]{0,40}?variant="default"/);
	assert.doesNotMatch(overlay, /className="w-full"\n\s*variant="default"\n\s*disabled=\{props\.responding \|\| !props\.inputValue\.trim\(\)\}/);
});

test("Batch ask selected options carry a check mark for low-contrast themes", () => {
	// 2026-12 用户反馈：部分主题色 accent 对比度低，选框只靠边框/背景变色难分辨已选项。
	// select 选项与 confirm 按钮在选中态都要渲染描线对勾（DrawCheck，beui Checkbox 同款动效）；
	// 图标色走 success token 而非 accent。
	assert.match(overlay, /props\.answer === value \? <DrawCheck className="shrink-0 text-\[var\(--color-success\)\]" \/> : null/);
	assert.match(overlay, /props\.answer === true \? <DrawCheck className="shrink-0 text-\[var\(--color-success\)\]" \/> : null/);
	assert.match(overlay, /props\.answer === false \? <DrawCheck className="shrink-0 text-\[var\(--color-success\)\]" \/> : null/);
	assert.match(overlay, /选中态对勾标记：主题色 accent 对比度低时只靠边框\/背景变色难分辨已选项/);
	// 单卡单选（最常走的 ask 路径）同样补对勾：夜间模式下底色差可能不明显，
	// 非颜色线索是最后一道保障。
	assert.match(overlay, /selectedOption === option \? <DrawCheck className="shrink-0 text-\[var\(--color-success\)\]" \/> : null/);
});

/**
 * 换题仍保留 AnimatePresence mode=wait 与选项横向滑入；题干改为整段淡入，
 * 不能退回内部 nowrap 的逐字滚动组件。真实行框与 hover 行为见 e2e/ask-title.spec.ts。
 */
test("Batch question switching keeps motion while allowing long question wrapping", () => {
	const drawCheck = readFileSync("src/renderer/src/components/motion/draw-check.tsx", "utf8");
	assert.match(overlay, /import \{ AnimatePresence, motion, useReducedMotion \} from "motion\/react"/);
	assert.match(overlay, /<AnimatePresence initial=\{false\} mode="wait">/);
	// 每题一个 key：换题 = 重挂子树，滑出/滑入由外层 motion.div 承担。
	assert.match(overlay, /key=\{`ask-q-\$\{currentQuestion\.id\}`\}/);
	// reduced-motion 降级路径必须存在（静态透明度切换，不跑位移）。
	assert.match(overlay, /reduce \? \{ opacity: 1 \} : \{ opacity: 0, x: 8 \}/);
	// 题干按题目 id 重新淡入，文本保持自然文档流；换行符与无空格长路径都不能被裁掉。
	assert.match(overlay, /<PromptTooltip\s+key=\{currentQuestion\.id\}\s+text=\{currentQuestion\.question\}>/);
	assert.match(overlay, /whitespace-pre-wrap[^"\n]*\[overflow-wrap:anywhere\]/);
	assert.match(overlay, /<motion\.div\s+initial=\{reduce\s*\?\s*false\s*:\s*\{\s*opacity:\s*0,\s*y:\s*3\s*\}\}/);
	assert.doesNotMatch(overlay, /ActionSwapRollText/);
	assert.match(overlay, /import \{ DrawCheck \} from "\.\.\/motion\/draw-check"/);
	// DrawCheck 本体：描线（pathLength 0→1）+ reduce 降级。
	assert.match(drawCheck, /pathLength: 0/);
	assert.match(drawCheck, /useReducedMotion/);
});

/**
 * 用户反馈「夜间模式 ask 选中样式不明显」的回归守卫。
 *
 * ask 选项是 shadcn Button variant="outline"：utilities 层的 bg-background /
 * dark:bg-input/30 / dark:border-input 按层序（legacy < utilities）稳压 legacy 的
 * `.ask-inline-bar-option.selected`——亮色下只剩边框变色，暗色下选中与未选中完全同色。
 * 所以选中态必须由组件层 utility（含 dark: 对手类）表达，twMerge 才会丢掉冲突的
 * variant 类；否则「加了选中样式但看不见」会再次静默发生。
 */
test("selected ask options stay visible under the outline variant's dark utilities", () => {
	assert.match(overlay, /const ASK_OPTION_SELECTED_CLASS\s*=\s*"selected border-\[var\(--color-accent\)\][^"]*dark:border-\[var\(--color-accent\)\][^"]*dark:bg-\[color:color-mix/);
	// 声明 1 处 + 5 个渲染点（批量单选/多选/confirm 是/否/单卡单选）全部要带上。
	const uses = overlay.match(/ASK_OPTION_SELECTED_CLASS/g) ?? [];
	assert.equal(uses.length, 6, "selected-state utility must be declared once and used at every ask option site");
	// 旧写法（只挂 legacy class）在两种主题下都会静默失效，禁止回归。
	assert.doesNotMatch(overlay, /\? " selected" : ""/);
	// 批量题目 tab 同理：tab 上有 bg-transparent / border-border-subtle / text-text-secondary
	// 三个 utility，legacy 的 .ask-batch-tab.active 同样被压死。
	assert.match(overlay, /const ASK_TAB_ACTIVE_CLASS\s*=\s*"active border-\[var\(--color-accent\)\]/);
	assert.match(overlay, /const ASK_TAB_ANSWERED_CLASS\s*=\s*"answered border-\[var\(--color-success\)\]/);
	assert.doesNotMatch(overlay, /\$\{active \? " active" : ""\}/);
	// legacy 里不得再留一份永远被压过的选中态样式（留着会让人以为改 CSS 有效）。
	assert.doesNotMatch(timelineStyles, /\.ask-inline-bar-option\.selected\s*\{/);
});

test("Batch question tabs stay on one scrolling line, and single-choice answers auto-advance", () => {
	// 2026-12 用户反馈：标签条换行后占掉好几行，太占位置。
	// 结论：条本身固定单行（overflow-x-auto），靠「短标题 + 序号」压住宽度；
	// 不再 flex-wrap（issue #230 的「看得全」诉求改由 cap 后的短标签 + 内滚承担）。
	assert.match(overlay, /className="mb-1 flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border-subtle pb-1" role="tablist"/);
	assert.doesNotMatch(overlay, /flex-wrap gap-1 border-b border-border-subtle/);

	// issue #230 第 1 点：单值选择选完自动前进，末题同样自动（去审阅/直接提交）。
	// 策略走纯函数 shouldAutoAdvanceBatchAnswer（见 askUiStateMachine），
	// 推进编排收敛到 BatchAskInlineBar.answerAndAdvance 一处。
	assert.match(overlay, /shouldAutoAdvanceBatchAnswer\(\{ type: question\.type, total \}\)/);
	const advances = overlay.match(/(?:^|\s)answer\((?:true|false|value)/g) ?? [];
	assert.equal(advances.length, 3, "confirm 是/否 + 批量单选 三条单值选择路径都要走 answer()");
	// 末题必须带上刚写入的答案提交，不能读同一事件里尚未提交的草稿（写盘是异步应用的）。
	assert.match(overlay, /submitAnswers\(committed\)/);
	assert.match(overlay, /const committed = commitBatchAnswer\(batch, /);
	// multi_select 不得自动前进（需多次勾选）：它仍然直连 props.onAnswer，不走 answer() 包装。
	assert.match(overlay, /props\.onAnswer\(next, next\.join\("、"\)\);/);
	assert.doesNotMatch(overlay, /answer\(next,/);
	// 自动前进后被点的按钮随换题卸载，焦点会掉回 body：换题后把焦点收回卡片容器。
	assert.match(overlay, /refocusAfterAdvanceRef\.current = true/);
	assert.match(overlay, /containerRef\.current\?\.focus\(\)/);
	assert.match(overlay, /tabIndex=\{-1\}/);
});

test("Ask options render as full-width horizontal bars, one per row", () => {
	// 2026-12 用户反馈：2/4 列栅格在长文案下把选项压成窄条，标签与说明挤在一起。
	// 单选/多选/单卡三条渲染路径统一改成整行横条（flex-col + w-full），
	// 与 WebTimeline 的既有选项语言一致；不得退回 grid-cols-* 栅格。
	const bars = overlay.match(/className="flex min-w-0 flex-col gap-2"/g) ?? [];
	assert.equal(bars.length, 3, "batch select / batch multi_select / single select must all be one-per-row bars");
	assert.doesNotMatch(overlay, /grid-cols-[24]/);
	// 横条高度由内容决定（长描述自然换行），不再靠 72px 固定最小高度对齐栅格单元。
	assert.doesNotMatch(overlay, /min-h-\[72px\]/);
	// 横条密度：整行横条 + 32px 下限 + 6px 纵向内边距。
	// 2026-12 用户反馈「很密集不舒服」：曾压到 26px/3px/1.35，观感过挤。
	assert.match(overlay, /ask-inline-bar-option h-auto min-h-\[32px\] w-full min-w-0 max-w-none items-center justify-start gap-1\.5 px-2\.5 py-1\.5 text-left break-words whitespace-normal/);
	// 说明与标签同一行、同字号（text-caption）、空格分隔，只靠颜色淡（tertiary）区分——
	// 用户反馈：说明别用小字、也别压成第二行（大屏上又小又局限）；禁止再引入破折号/小字。
	assert.match(overlay, /<span className="text-text-primary">\{label\}<\/span>/);
	assert.match(overlay, /<span className="text-text-tertiary">\{` \$\{description\}`\}<\/span>/);
	assert.doesNotMatch(overlay, /text-micro font-normal leading-\[1\.5\] text-text-tertiary/);
	assert.doesNotMatch(overlay, / — \$\{description\}/);
	// 说明同一行后横条是单行布局，不再 flex-col 两行堆叠。
	assert.doesNotMatch(overlay, /min-h-\[32px\][^"]*flex-col/);
	// 题号行「详情 i/n」已删（用户反馈：多余，tab 已有序号 + 头部有进度）。
	assert.doesNotMatch(overlay, /common\.details/);
});

test("Plan/simple select options render as single-row optically aligned buttons", () => {
	// 2026-12 用户反馈：上下两行（标签/说明各一行）文本对不齐。
	// live 卡选项改为单行：固定高度 + 标签不缩 + 说明 truncate，等宽等高光学对齐。
	// TimelineEventCards 的 AskQuestionCard 死代码与其专属 CSS 已删除（2026-08 清理），
	// 该视觉语言现只由 SessionRuntimeUiOverlay 的 ask-inline-bar-option 承载。
	assert.match(overlay, /ask-inline-bar-option h-\[32px\] w-full min-w-0 max-w-none items-center justify-start gap-2 px-2\.5 py-0 text-left/);
	assert.match(overlay, /max-w-\[45%\] shrink-0 truncate text-caption font-medium leading-none text-text-primary/);
	assert.match(overlay, /min-w-0 flex-1 truncate text-micro leading-none text-text-tertiary/);
});

test("Plan mode prompts keep steps concise and visually separated", () => {
	// 2026-12 用户反馈：步骤挤在一起难读。两处约束：
	// 1) 注入模型的 PLAN MODE 提示词要求每步一句短句、独立编号行（从源头控制简洁度）；
	// 2) 选单标题里每步之间空一行，卡片段落视觉隔离。
	assert.match(planModeExt, /Keep plan steps concise: one short sentence per step/);
	assert.match(planModeExt, /Put each step on its own numbered line/);
	assert.match(planModeExt, /\.join\("\\n\\n"\)/);
	// 摘要行带「是否执行」提问：卡片默认折叠时也能看懂下一步待确认的动作。
	assert.match(planModeExt, /是否执行？/);
	// 摘要第二行引导用户去上方待办条查看详细列表（2026-12 用户反馈：单一提问行不够明显）。
	assert.match(planModeExt, /具体计划可点击下方待办查看详细列表/);
});

test("Long ask descriptions collapse to a preview with eye toggle", () => {
	// 2026-12 用户反馈：plan 草案步骤太多导致卡片过高。默认折叠为 2 行摘要，
	// 可换行/滚动的 hover 全文提示与眼睛展开并存；不能只依赖无法滚动的原生 title。
	assert.match(approvalCard, /descriptionPreviewLines\?: number/);
	assert.match(approvalCard, /descriptionClamped && "line-clamp-2"/);
	assert.match(approvalCard, /<PromptTooltip\s+text=\{props\.description\}>/);
	assert.doesNotMatch(approvalCard, /title=\{descriptionClamped/);
	assert.match(approvalCard, /descExpanded \? <EyeOff size=\{14\}/);
	// live 卡与时间线卡都用 2 行预览：提问行 + 引导去待办查看详情，步骤默认隐藏。
	// （TimelineEventCards 的 AskQuestionCard 死代码已删除，交互卡统一由 overlay 承载）
	assert.match(overlay, /descriptionPreviewLines=\{2\}/);
	// 「1口」乱码回归：plan 草案步骤前缀不得用 ☐（部分 Windows 字体渲染成空心方框）。
	// widget/进度消息的 ☑/☐ 保留（agentTodoList 测试锁定，完成态语义明确）。
	assert.doesNotMatch(planModeExt, /\$\(item\.step\)\. ☐/);

	// 折叠触发器只能包 chevron：标题/描述若包进 trigger，划选结束后的 mouseup 会把选项折起来。
	const triggerBlocks = [...approvalCard.matchAll(/<CollapsibleTrigger asChild>[\s\S]*?<\/CollapsibleTrigger>/g)];
	assert.equal(triggerBlocks.length, 1);
	const triggerBlock = triggerBlocks[0][0];
	assert.match(triggerBlock, /<ChevronDown/);
	assert.doesNotMatch(triggerBlock, /props\.title/);
	assert.doesNotMatch(triggerBlock, /props\.description/);
	assert.doesNotMatch(triggerBlock, /<Eye[\s\S]*EyeOff|EyeOff[\s\S]*<Eye/);
	// 标题/描述是普通 select-text 节点，不是 button，才能原生划选复制。
	assert.match(approvalCard, /text-foreground select-text"\s*>\s*\{props\.title\}/);
	assert.match(approvalCard, /text-muted-foreground select-text"/);
	// 眼睛是 trigger 的兄弟，只切 descExpanded，不得改 open。
	assert.match(approvalCard, /onClick=\{\(\) => setDescExpanded\(\(next\) => !next\)\}/);
	assert.match(approvalCard, /<\/CollapsibleTrigger>[\s\S]*descExpanded \? <EyeOff size=\{14\}/);
	// 一键复制未折叠全文（clamp 只影响展示）。
	assert.match(approvalCard, /from "\.\.\/\.\.\/utils\/clipboard"/);
	assert.match(approvalCard, /props\.description \? `\$\{props\.title\}\\n\\n\$\{props\.description\}` : props\.title/);
	assert.match(approvalCard, /writeClipboard\(text\)/);
	assert.match(approvalCard, /ask\.copyPrompt/);
	assert.match(approvalCard, /ask\.expandOptions/);
	assert.match(approvalCard, /ask\.collapseOptions/);
});

test("Ask option clicks skip submit while text is selected", () => {
	// 选项/允许/拒绝是 button：划选结束后 mouseup 落在按钮上会冒充 click。
	// overlay submitValue + BatchQuestion true/false/select、安全卡 allow/deny
	// 都必须在提交前用按压感知守卫（shouldSuppressAskClick）判定并跳过——
	// 只吞本次按压新拖出的选区；旧守卫直接查全局选区会把「划选复制/双击选词
	// 之后的真实点击」也吞掉（ask 选项点很久才能勾上的根因，2026-09 修复）。
	// TimelineEventCards 的 AskQuestionCard 死代码已删除（2026-08 清理），
	// 交互卡片统一由 SessionRuntimeUiOverlay 承载。
	assert.match(overlay, /shouldSuppressAskClick/);
	assert.match(securityCard, /shouldSuppressAskClick/);
	assert.doesNotMatch(overlay, /hasTextSelection/);
	assert.doesNotMatch(securityCard, /hasTextSelection/);
	const overlayGuards = overlay.match(/if \(shouldSuppressAskClick\(\)\) return;/g);
	const securityGuards = securityCard.match(/if \(shouldSuppressAskClick\(\)\) return;/g);
	assert.ok(overlayGuards && overlayGuards.length >= 4);
	assert.ok(securityGuards && securityGuards.length >= 2);
});

/**
 * Ask 是会话级阻塞交互，不应参与 composer 的 flex 高度分配；否则 Ask 展开时会和
 * 编辑器的最小高度互相挤压。回归契约从两方面锁定这个边界：composer 不再接收 runtimeUi，
 * timeline 负责承载它；Ask 内容也不再创建第二个纵向滚动 owner。
 */
test("ask floats over the timeline instead of taking the column bottom", () => {
	assert.doesNotMatch(composerArea, /runtimeUi/);
	// Ask 不再进时间线滚动内容（issue #230：看历史时提问卡在视口外）。
	assert.doesNotMatch(sessionView, /<SessionSurfaceStage[\s\S]*runtimeUi,/);
	// 浮层而非列底槽位：时间线保持整列高度，用户能先读完回复再作答（可折叠、可拖动）。
	assert.match(sessionView, /\{runtimeUi && askPanelVisible \? <FloatingAskLayer>\{runtimeUi\}<\/FloatingAskLayer> : null\}/);
	assert.doesNotMatch(sessionView, /askMaxHeight/);
	assert.match(sessionView, /className="session-v-timeline relative flex min-h-0 flex-col"/);
	const floating = readFileSync("src/renderer/src/components/session/FloatingAskLayer.tsx", "utf8");
	assert.match(floating, /session-v-ask session-v-ask--floating absolute z-30/);
	assert.match(floating, /--ask-float-reserve/);
	// 不吃掉时间线自带控件：抬「回到底部」按钮、让开刻度轴并把刻度抬到卡片之上、自带不透明底。
	assert.match(floating, /--ask-float-scroll-lift/);
	assert.match(floating, /parent\.dataset\.askFloating = ""/);
	const stage = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	assert.match(stage, /bottom: "calc\(0\.375rem \+ var\(--ask-float-scroll-lift, 0px\)\)"/);
	const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
	assert.match(timelineCss, /\.session-v-timeline\[data-ask-floating\] \.outline-hover\.session-outline-pane \{\s*z-index: 31;/);
	assert.match(timelineCss, /\.session-v-ask--floating \{\s*background-color: var\(--color-bg-panel\);/);
	assert.match(timelineCss, /:root\[data-bg-image="on"\] \.session-v-ask--floating \{[^}]*backdrop-filter: blur\(18px\)/);
	// 浮层期间 composer 仍坍缩让位（输入框坍缩到零高，整列留给时间线）。
	// 不卸载——粘贴转文件的删盘动作在 composer 卸载路径上会丢（orphan 临时文件）。
	assert.match(sessionView, /const composerMaxHeight = askPanelVisible \? "0px" : `min\(\$\{COMPOSER_MAX_HEIGHT\}px, calc\(100% - var\(--session-timeline-min, \$\{TIMELINE_MIN_HEIGHT\}px\)\)\)`/);
	assert.match(sessionView, /maxHeight: composerMaxHeight/);
	// composer 全程挂载（不因 ask 卸载）；坍缩到 0px 时同时 inert + aria-hidden，
	// 不可见编辑器不得再被 Tab/点击命中（否则用户会往隐形输入框里打字）。
	assert.match(sessionView, /bottomComposerVisible && \(/);
	assert.match(sessionView, /inert=\{askPanelVisible\}/);
	assert.match(sessionView, /aria-hidden=\{askPanelVisible \|\| undefined\}/);
	assert.doesNotMatch(sessionView, /composerMaxHeight = `min\(\$\{COMPOSER_MAX_HEIGHT\}px/);
	// 占位判据必须与 overlay 同源，否则 stale runtime 的残留 pending 会让 composer 白让高度。
	assert.match(sessionView, /askPanelVisible\?: boolean/);
	const injector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
	assert.match(injector, /const askPanelVisible = React\.useMemo\(\(\) => Boolean\(resolveActiveAskRequest\(currentSessionRuntime, currentSessionRuntimeUi\)\)/);
	assert.match(injector, /askPanelVisible=\{askPanelVisible\}/);
	assert.match(timeline, /className="session-runtime-ui mx-auto w-full/);
	assert.doesNotMatch(timeline, /session-runtime-ui sticky bottom-0/);
	// 内容宽度：消息区/输入框 inline width；浮动 Ask 量同一列的实际矩形（见 FloatingAskLayer），
	// 默认与消息列/输入卡同宽居中，不再自带上限与右下角锚点。
	// 时间线侧挂在 MessageScroller 的 contentProps（内层 [role=log]）上，
	// 视口铺满面板、滚动条贴面板最右，内容列仍与 composer 同宽居中。
	// 空态例外：showSurfaceEmptyState 时去掉约束（起始页自控宽度，与引导页一致）。
	assert.match(timeline, /contentProps=\{showSurfaceEmptyState \? undefined : \{ style: chatContentWidthStyle \}\}/);
	assert.doesNotMatch(timeline, /style=\{chatContentWidthStyle\}/);
	assert.doesNotMatch(timeline, /--chat-inline-pad/);
	assert.doesNotMatch(foundation, /--chat-inline-pad|--chat-side-gap/);
	assert.doesNotMatch(overlay, /CollapsibleContent className="min-h-0 overflow-y-auto"/);
	assert.doesNotMatch(overlay, /max-h-\[(?:55vh|180px|240px)\][^\n]*overflow-y-auto/);
});

/**
 * 没有 Ask 时，composer 仍从输入卡的最小高度起步；footer 的底部留白是内容的一部分，
 * 列按固有高度撑开，Ask 不参与 composer 分配。
 */
test("composer measurement includes the bottom breathing room after ask moves to timeline", () => {
	assert.match(composerArea, /className="composer[^\"]*px-0 pb-2"/);
});

/**
 * 消息列与输入框必须共享同一条滚动条槽位：时间线视口由自身 scrollbar-gutter 预留，
 * composer 面板用 overflow-hidden + scrollbar-gutter:stable 预留同宽槽位，两者百分比
 * 宽度/居中基准一致——任何宽度设置与平台（macOS 覆盖式滚动条时两侧同为 0）下都对齐，
 * 不依赖写死的像素补偿。
 */
test("composer panel reserves the same scrollbar gutter as the timeline", () => {
	assert.match(sessionView, /session-v-composer[\s\S]*\[scrollbar-gutter:stable\]/);
	assert.doesNotMatch(sessionView, /paddingRight/);
	// 时间线侧：宽度约束挂在滚动内容上（视口自带 scrollbar-gutter:stable 预留槽位）；
	// 空态例外：showSurfaceEmptyState 时去掉约束（起始页自控宽度，与引导页一致）。
	assert.match(timeline, /contentProps=\{showSurfaceEmptyState \? undefined : \{ style: chatContentWidthStyle \}\}/);
	assert.match(chatContentWidth, /scrollbar-gutter:stable/);
});

function loadFloating() {
	return import("./helpers/loadTsCommonJs.mjs").then(({ loadTsCommonJs }) =>
		loadTsCommonJs("src/renderer/src/components/session/FloatingAskLayer.tsx", {
			stubs: { react: {}, "lucide-react": { GripHorizontal: "grip" }, "../../i18n": { t: (key) => key } },
		}),
	);
}

test("floating ask defaults to the message/composer column and stays inside it", async () => {
	const { clampAskFloatOffset, askFloatFrame, ASK_FLOAT_MARGIN } = await loadFloating();
	const bounds = { parentWidth: 1000, parentHeight: 800, cardWidth: 760, cardHeight: 300, columnLeft: 120, columnWidth: 760 };
	// 默认框与消息列/输入框同宽同左缘（正常内容宽度下就是同一列）
	assert.deepEqual({ ...askFloatFrame(bounds) }, { left: 120, width: 760 });
	// 拖出左上界被收回：左边贴列留边 12px，顶部不出列
	assert.deepEqual({ ...clampAskFloatOffset({ x: -5000, y: -5000 }, bounds) }, { x: ASK_FLOAT_MARGIN - 120, y: -(800 - 300 - 2 * ASK_FLOAT_MARGIN) });
	// 往右拖也受限：卡片右缘停在列留边内（不再只能往左拖）
	assert.deepEqual({ ...clampAskFloatOffset({ x: 5000, y: 50 }, bounds) }, { x: 1000 - ASK_FLOAT_MARGIN - (120 + 760), y: 0 });
	// 右缘让开刻度轴后，右拖空间随之缩小
	assert.deepEqual({ ...clampAskFloatOffset({ x: 5000, y: 0 }, { ...bounds, rightInset: 48 }) }, { x: 1000 - 48 - (120 + 760), y: 0 });
	// 内容宽度拉到 100%：默认框按刻度让位收窄并左移，仍不压刻度
	const wide = askFloatFrame({ ...bounds, columnLeft: 24, columnWidth: 952, rightInset: 48 });
	assert.equal(wide.width, 1000 - 48 - ASK_FLOAT_MARGIN);
	assert.equal(wide.left + wide.width, 1000 - 48);
	// 0 尺寸测量（未布局、隐藏）不能把记住的位置夹成 {0,0}
	assert.deepEqual({ ...clampAskFloatOffset({ x: -120, y: -300 }, { parentWidth: 0, parentHeight: 0, cardWidth: 0, cardHeight: 0, columnLeft: 0, columnWidth: 0 }) }, { x: -120, y: -300 });
	// 列临时变矮只影响渲染位置：preferred 不变，列恢复后夹紧结果回到原位
	const preferred = { x: 0, y: -400 };
	assert.equal(clampAskFloatOffset(preferred, { ...bounds, parentHeight: 400 }).y, -(400 - 300 - 2 * ASK_FLOAT_MARGIN));
	assert.equal(clampAskFloatOffset(preferred, bounds).y, -400);
});

test("floating ask measures the same column as messages and composer", () => {
	// 宽度/居中必须来自聊天内容契约，而不是自己拍一个宽度上限。
	const floating = readFileSync("src/renderer/src/components/session/FloatingAskLayer.tsx", "utf8");
	assert.match(floating, /\.message-timeline > \[role="log"\]/);
	assert.match(floating, /--chat-content-pct-set/);
	assert.doesNotMatch(floating, /min\(640px/);
});

test("floating ask reserves the timeline tail whenever the card sits on the bottom, however tall", async () => {
	const { askFloatReserve, ASK_FLOAT_MARGIN, ASK_FLOAT_TAIL_CLEARANCE } = await loadFloating();
	const at = (cardHeight, y = 0) => askFloatReserve({ x: 0, y }, { parentWidth: 1000, parentHeight: 760, cardWidth: 760, cardHeight, columnLeft: 120, columnWidth: 760 });
	// 维护者给的边界：368 与 369 高的卡片不能一个 388、一个 0
	assert.equal(at(368), 368 + ASK_FLOAT_MARGIN + 8);
	assert.equal(at(369), 369 + ASK_FLOAT_MARGIN + 8);
	for (const height of [420, 500, 600, 736]) assert.equal(at(height), height + ASK_FLOAT_MARGIN + 8);
	// 拖离底部、下面留出足够的缝：尾部内容能从卡片下方滚出来，不再留余量
	assert.equal(at(300, -ASK_FLOAT_TAIL_CLEARANCE), 0);
	assert.ok(at(300, -(ASK_FLOAT_TAIL_CLEARANCE - ASK_FLOAT_MARGIN - 1)) > 0);
	assert.equal(askFloatReserve({ x: 0, y: 0 }, { parentWidth: 0, parentHeight: 0, cardWidth: 0, cardHeight: 0, columnLeft: 0, columnWidth: 0 }), 0);
});

test("floating ask lifts the scroll-to-bottom button only when the card covers it", async () => {
	const { askFloatScrollButtonLift, ASK_FLOAT_MARGIN } = await loadFloating();
	const bounds = { parentWidth: 1200, parentHeight: 760, cardWidth: 960, cardHeight: 300, columnLeft: 120, columnWidth: 960 };
	// 与输入框同宽的居中卡片贴着列底时必然压住居中的「回到底部」按钮
	assert.equal(askFloatScrollButtonLift({ x: 0, y: 0 }, bounds), 300 + ASK_FLOAT_MARGIN + 8);
	// 卡片拖离底部：按钮不被盖住，不抬
	assert.equal(askFloatScrollButtonLift({ x: 0, y: -300 }, bounds), 0);
	// 拖到侧边、让开列中线：不抬
	assert.equal(askFloatScrollButtonLift({ x: -600, y: 0 }, bounds), 0);
	// 几乎占满整列的卡片：按钮最多抬到列顶附近，不出列
	assert.equal(askFloatScrollButtonLift({ x: 0, y: 0 }, { ...bounds, cardHeight: 736 }), 760 - 48);
});
