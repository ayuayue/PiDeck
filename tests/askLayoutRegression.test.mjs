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
	// 选项卡片/描述必须换行展示（break-words whitespace-normal），不能截断或裁切；
	// 注意批量问答 tab 胶囊是例外：tab 只做单行摘要（truncate），完整问题在详情区展示。
	assert.match(overlay, /break-words whitespace-normal/);
	// 批量问答 tab 胶囊：单行截断 + 悬停 title 看全文，禁止多行溢出胶囊固定高度；
	// 宽度封顶 14ch（2026-12 用户反馈：28ch 太长，标签条太占位置）。
	assert.match(overlay, /max-w-\[14ch\] min-w-0 truncate text-left" title=\{question\.question\}/);
	assert.match(toolCards, /whitespace-normal break-words font-mono text-caption/);
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
	// select 选项与 confirm 按钮在选中态都要渲染 Check 图标；图标色走 success token 而非 accent。
	assert.match(overlay, /props\.answer === value \? <Check size=\{14\} className="shrink-0 text-\[var\(--color-success\)\]" aria-hidden="true" \/> : null/);
	assert.match(overlay, /props\.answer === true \? <Check size=\{14\} className="shrink-0 text-\[var\(--color-success\)\]" aria-hidden="true" \/> : null/);
	assert.match(overlay, /props\.answer === false \? <Check size=\{14\} className="shrink-0 text-\[var\(--color-success\)\]" aria-hidden="true" \/> : null/);
	assert.match(overlay, /选中态对勾标记：主题色 accent 对比度低时只靠边框\/背景变色难分辨已选项/);
	// 单卡单选（最常走的 ask 路径）同样补 Check：夜间模式下底色差可能不明显，
	// 非颜色线索是最后一道保障。
	assert.match(overlay, /selectedOption === option \? <Check size=\{14\} className="shrink-0 text-\[var\(--color-success\)\]" aria-hidden="true" \/> : null/);
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
	// 末题必须带上刚写入的答案提交，不能读同一事件里尚未提交的 state。
	assert.match(overlay, /submitAnswers\(committed\)/);
	assert.match(overlay, /const committed = commitAnswer\(question\.id, value, label, wasCustom\)/);
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
	// hover（title）可看全文，眼睛按钮显式切换全文/摘要；不传 previewLines 时行为不变。
	assert.match(approvalCard, /descriptionPreviewLines\?: number/);
	assert.match(approvalCard, /descriptionClamped && "line-clamp-2"/);
	assert.match(approvalCard, /title=\{descriptionClamped \? props\.description : undefined\}/);
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
test("ask owns a pinned slot between the timeline stage and the composer", () => {
	assert.doesNotMatch(composerArea, /runtimeUi/);
	// Ask 不再进时间线滚动内容（issue #230：看历史时提问卡在视口外）。
	assert.doesNotMatch(sessionView, /<SessionSurfaceStage[\s\S]*runtimeUi,/);
	// 底栏本身是唯一新增的 Ask 滚动层；高度就是「列高 - 对话区保底」，不设固定像素。
	assert.match(sessionView, /session-v-ask min-h-0 shrink-0 overflow-y-auto overscroll-contain \[scrollbar-gutter:stable\]/);
	assert.match(sessionView, /\{runtimeUi && askPanelVisible \? \(/);
	assert.match(sessionView, /const askMaxHeight = `calc\(100% - var\(--session-timeline-min, \$\{TIMELINE_MIN_HEIGHT\}px\)\)`/);
	// 不设固定像素上限（用户反馈：别限卡片高度）；超长才由内滚兜底。
	assert.doesNotMatch(sessionView, /ASK_PANEL_MAX_HEIGHT/);
	// Ask 与 composer 互斥分高（issue #230 定案 B：弹卡时卡片独占列底，输入框坍缩到零高）。
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
	// 宽度基准与消息列/输入框同源，不另开一套宽度。
	assert.match(sessionView, /<div className="pb-2" style=\{chatContentWidthStyle\}>[\s\S]*?\{runtimeUi\}/);
	assert.match(timeline, /className="session-runtime-ui mx-auto w-full/);
	assert.doesNotMatch(timeline, /session-runtime-ui sticky bottom-0/);
	// 内容宽度：消息区/输入框 inline width，Ask 随时间线同宽。
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
