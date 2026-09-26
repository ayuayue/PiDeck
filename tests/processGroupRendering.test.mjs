import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 过程组渲染的**结构性契约**（源码级断言）。
//
// 为什么这些必须由测试钉住而不是靠注释：
// 1. 「组头全宽」是用户反复强调的硬要求（悬停框必须与流式输出同宽），
//    退回 inline-flex / self-start 就是返工——靠人眼 review 会漏。
// 2. 两级挂载预算只有在前置不变量「组体关闭时不挂载成员」成立时才是真预算。
//    若有人为了动画把组体改成常驻挂载（forceMount），预算就形同虚设——必须由测试守住。
// 3. 特性开关关闭时必须**完整保留**原有扁平渲染路径（行为与改动前一致），
//    两个分支都要在，不能因为加了新路径就把旧路径删掉。
//
// 正则一律空白容忍（AGENTS.md：源码扫面型测试不得写死缩进/字面空格）。

const foldSource = readFileSync("src/renderer/src/components/session/turn/ProcessFold.tsx", "utf8");
const groupSource = readFileSync("src/renderer/src/components/session/turn/ProcessGroupStep.tsx", "utf8");

/** WCAG 相对亮度 → 该色对白底的对比度。把「组头静止色必须过 AA」写成可执行断言，而不是注释里的口头承诺。 */
function contrastOnWhite(hex) {
	const channel = (v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const luminance = 0.2126 * channel(Number.parseInt(hex.slice(1, 3), 16)) + 0.7152 * channel(Number.parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(Number.parseInt(hex.slice(5, 7), 16));
	return 1.05 / (luminance + 0.05);
}
const turnRowSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const budgetSource = readFileSync("src/renderer/src/components/session/timeline/turnMountBudget.ts", "utf8");

test("过程组组头必须全宽：占满内容列，不许按文字宽度收缩", () => {
	// 取组头 <button> 的开标签（到 aria-expanded 为止），只看它的 class
	const header = groupSource.match(/<button[\s\S]{0,600}?aria-expanded=\{props\.open\}/)?.[0] ?? "";
	assert.ok(header.length > 0, "组头 button 必须存在且带 aria-expanded");
	assert.match(header, /w-full/);
	assert.doesNotMatch(header, /inline-flex/);
	assert.doesNotMatch(header, /self-start/);
	assert.doesNotMatch(header, /align-self/);
	assert.doesNotMatch(header, /w-fit/);
});

test("组体默认不挂载——这是两级挂载预算成立的前提", () => {
	// 组体容器必须在 props.open 条件内渲染
	const bodyIndex = groupSource.indexOf('className="ml-5 mt-1 border-l-2');
	assert.ok(bodyIndex > 0, "组体容器必须存在");
	const guardIndex = groupSource.lastIndexOf("{props.open && (", bodyIndex);
	assert.ok(guardIndex > 0, "组体必须在 `{props.open && (` 条件内渲染；改成常驻挂载会让预算失效");
	// 反向守卫：不允许出现「常驻挂载 + forceMount」这类写法
	assert.doesNotMatch(groupSource, /forceMount/);
});

test("两级挂载预算各自落在真正会一次性挂载的那一层", () => {
	// 组内成员：每组一份预算（原 OOM 事故的入口）
	assert.match(groupSource, /boundMountedSteps\(\s*props\.group\.members\s*,\s*PROCESS_GROUP_MEMBER_LIMIT/);
	assert.match(groupSource, /timeline\.showEarlierSteps/);
	// 大折叠栏一级节点：每轮一份预算（中间回复是重量级节点）
	assert.match(foldSource, /boundMountedSteps\(\s*props\.nodes\s*,\s*PROCESS_FOLD_NODE_LIMIT/);
	assert.match(foldSource, /timeline\.showEarlierSteps/);
	// 两个常量都从既有实测档位派生，不引入未调参的新数字
	assert.match(budgetSource, /export const PROCESS_GROUP_MEMBER_LIMIT = TIMELINE_MOUNTED_STEP_LIMIT;/);
	assert.match(budgetSource, /export const PROCESS_FOLD_NODE_LIMIT = TIMELINE_MOUNTED_STEP_LIMIT;/);
});

test("组体限高 + 内部滚轮，且子项不得被压扁", () => {
	assert.match(groupSource, /max-h-\[min\(320px,30vh\)\]/);
	assert.match(groupSource, /overflow-y-auto/);
	// 组内滚轮到边才把滚轮交还外层时间线
	assert.match(groupSource, /overscroll-contain/);
	// AGENTS.md 记录过的高度塌陷事故：限高 flex 列的子项必须 shrink-0
	assert.match(groupSource, /className="shrink-0"/);
});

test("TurnRow 两条渲染路径都在：开关关闭时必须保持原扁平渲染", () => {
	assert.match(turnRowSource, /flowSettings\.processGroupDisplay\s*\?/);
	assert.match(turnRowSource, /<ProcessFold/);
	// 扁平路径的既有要素一个都不能少（关掉开关 = 与改动前完全一致）
	assert.match(turnRowSource, /boundMountedSteps\(foldableItems, TIMELINE_MOUNTED_STEP_LIMIT/);
	assert.match(turnRowSource, /mountedSteps\.items\.map/);
	assert.match(turnRowSource, /timeline\.showEarlierSteps/);
	assert.match(turnRowSource, /variant="process"/);
	assert.match(turnRowSource, /<FinalAnswer/);
	assert.match(turnRowSource, /<Collapsible/);
	assert.match(turnRowSource, /<CollapsibleContent/);
});

test("过程组模式复用既有行组件，不新造行样", () => {
	assert.match(groupSource, /<ThinkingStep/);
	assert.match(groupSource, /<ToolStep/);
	assert.match(foldSource, /<InterimAnswer/);
	assert.match(foldSource, /<RetryStep/);
	assert.match(foldSource, /<ErrorStep/);
	// live 中间回复仍由 TurnRow 挂在大折叠栏外，折叠内必须跳过以免双份
	assert.match(foldSource, /node\.id === props\.liveInterimId/);
	assert.match(turnRowSource, /liveInterimId/);
});

test("组开合走手风琴 hook，且大折叠栏关闭时清空两个通道", () => {
	assert.match(turnRowSource, /useProcessGroupOpenState\(/);
	assert.match(turnRowSource, /syncLatestProcessGroup\(latestProcessGroupId\)/);
	assert.match(turnRowSource, /resetProcessGroups\(\)/);
	// 最新组必须按 id 判定（按下标会在尾部切片后错位）
	assert.match(foldSource, /node\.id === runningGroupId/);
});

test("组头不得小于组体里的行（用户反馈：容器比内容小 = 层级倒置）", () => {
	// 成员行是 text-chat-row（正文 −2px，默认 13px）/ min-h-7。组头若退回界面轨道的 caption(12px)
	// + 固定 h-6/h-7，就会出现「容器比内容还小」的倒置（用户原话"组头偏小"）。
	const header = groupSource.match(/data-process-group-head=""[\s\S]{0,700}?aria-expanded=/)?.[0] ?? "";
	assert.ok(header.length > 0, "组头 button 必须带 data-process-group-head 锚点");
	const cls = header.match(/className="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
	assert.ok(cls.includes("text-chat-row"), "组头字号必须与成员行同档（会话正文 −2px）");
	assert.ok(cls.includes("min-h-7"), "组头高度必须与成员行同档");
	assert.ok(!cls.includes("h-7") && !cls.includes("h-6"), "不得用固定高度：字号放大后会裁切行");
	assert.ok(!cls.includes("text-caption") && !cls.includes("text-control"), "不得退回界面字号轨道");
});

// 过程层字号轨道（2026-08 用户要求：组头 / 工具调用 / 思考全部跟进「会话正文字号」）。
// 原先是挂在界面轨道（text-control / -caption / -micro）上的固定值——用户调大正文时过程行不变大，
// 而这既违反可访问性（用户调大字号就是因为看不清），又和已确立的「降权只走颜色/字重、不靠缩小字号」
// 原则冲突。现在改为从 --font-size-chat 派生三档，层级由固定偏移量保证。
// 这条守卫防两类回归：(1) 有人图省事把某行改回界面轨道 class；
// (2) 偏移量被改坏，导致「正文 > 标题 > 详情 > 徽章」的层阶不再成立。
test("过程层字号派生自会话正文：层阶恒定，且默认档与迁移前的 13/12/11 逐像素等价", () => {
	const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	const offsetOf = (tier, floor) => {
		const m = foundation.match(new RegExp(`--font-size-chat-${tier}:\\s*max\\(\\s*${floor}px\\s*,\\s*calc\\(\\s*var\\(--font-size-chat\\)\\s*-\\s*(\\d+)px\\s*\\)\\s*\\)`));
		return m ? Number(m[1]) : null;
	};
	const rowOff = offsetOf("row", 13);
	const detailOff = offsetOf("detail", 12);
	assert.deepEqual([rowOff, detailOff], [2, 4], "两档偏移必须是 2 / 4（恒定 2px 步长）");
	assert.doesNotMatch(foundation, /--font-size-chat-micro:/, "过程层只保留两档：徽章并入详情档，不再有第三档");

	// 会话正文必须是 4 档、等距 2px（旧的 5 档 14/15/16/18/20 里有 1px 步长，相邻档肉眼分不出）
	const chatSizes = [...new Set([...foundation.matchAll(/--font-size-chat:\s*(\d+)px/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
	assert.deepEqual(chatSizes, [14, 16, 18, 20], "字号档位必须是紧凑 14 / 中 16 / 大 18 / 特大 20");

	for (const chat of chatSizes) {
		// 与 CSS 的 max() 下限保护一致：小档位下不继续缩
		const row = Math.max(13, chat - rowOff);
		const detail = Math.max(12, chat - detailOff);
		assert.ok(detail < row && row < chat, `正文 ${chat}px 时层阶必须成立（得到 标题 ${row} / 详情 ${detail}）`);
	}

	// 行高必须用无单位倍率（固定 px 行高会在大档位下压扁文字）
	for (const tier of ["row", "detail"]) {
		assert.match(foundation, new RegExp(`--line-height-chat-${tier}:\\s*[\\d.]+\\s*;`), `--line-height-chat-${tier} 必须是倍率而非固定 px`);
	}
});

test("过程层组件不得回退到界面字号轨道", () => {
	// TimelineEventCards 只扫思考行相关行：该文件还渲染通知/诊断卡片，它们不在本次范围内。
	const wholeFiles = {
		"ToolCallComponents.tsx": "src/renderer/src/components/session/ToolCallComponents.tsx",
		"RetryStep.tsx": "src/renderer/src/components/session/turn/RetryStep.tsx",
		"ErrorStep.tsx": "src/renderer/src/components/session/turn/ErrorStep.tsx",
		"ProcessGroupStep.tsx": "src/renderer/src/components/session/turn/ProcessGroupStep.tsx",
		"ProcessFold.tsx": "src/renderer/src/components/session/turn/ProcessFold.tsx",
		"TurnRow.tsx": "src/renderer/src/components/session/turn/TurnRow.tsx",
	};
	for (const [name, path] of Object.entries(wholeFiles)) {
		const src = readFileSync(path, "utf8");
		const bad = src.match(/\btext-(control|caption|micro)\b/g) ?? [];
		assert.deepEqual(bad, [], `${name} 不得再用界面轨道字号 class，应使用 text-chat-row / text-chat-detail / text-chat-micro`);
	}
	// 已有的界面轨道字号 token 也不得出现在过程层的 legacy CSS 里
	const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
	const processCss = timelineCss.match(/\.(execution-summary-(toggle|collapse)|thinking-card|responding-indicator|tool-card-kind|tool-activity-copy|ask-question-card|ask-inline-bar)[\s\S]{0,120}?\{[^}]*\}/g) ?? [];
	assert.ok(processCss.length > 0, "必须能匹配到过程层 legacy 规则");
	for (const block of processCss) {
		assert.doesNotMatch(block, /var\(--font-size-(control|caption|micro)\)/, `过程层 legacy 规则不得再用界面轨道字号：\n${block.slice(0, 120)}`);
	}
});

// 组头「自重」契约（2026-08 用户两轮反馈的产物）：
//   第一次「组头偏小」→ 尺寸不得小于成员行（下一条测试钉住字号/高度）；
//   第二次「组头喧宾夺主，比中间回复还重」→ 降权**只能走颜色/填充**，而且静止色仍须过 WCAG AA。
// 注意中间回复本来就更大（text-chat 15px / text-primary，组头是 13px）：组头抢戏靠的是
// 「全场唯一实心色块 + 600 字重 + 一轮里重复出现」这三件事，所以守卫防的是把它们加回去。
test("组头不得靠填充/字号抢戏：无实心色块 + 静止降色且仍过 WCAG AA", () => {
	// ① 不填色：类别图标方块（size-[22px] 那个 span）不得有任何 bg- 填充
	const chip = groupSource.match(/size-\[22px\][\s\S]{0,300}?<Icon/)?.[0] ?? "";
	assert.ok(chip.length > 0, "必须能找到类别图标方块（size-[22px] → <Icon>）");
	assert.doesNotMatch(chip, /\bbg-/, "① 类别图标方块不得有底色填充——那曾是整屏唯一的实心块");
	assert.match(chip, /--color-tool/, "运行中仍须保留工具身份色图标，作为「正在跑」的信号");

	// ④ 静止降色：tertiary → hover secondary；不得改用 opacity 压暗
	const headerTag = groupSource.match(/<button[\s\S]{0,900}?aria-expanded=\{props\.open\}/)?.[0] ?? "";
	assert.ok(headerTag.length > 0, "必须能找到组头 button 开标签");
	assert.match(headerTag, /text-text-tertiary/, "④ 组头静止色应为 text-tertiary（比 secondary 退后一档）");
	assert.match(headerTag, /hover:text-text-secondary/, "hover 应回到 secondary");
	assert.doesNotMatch(headerTag, /hover:text-text-primary/);
	assert.doesNotMatch(headerTag, /\bopacity-\d/, "④ 不得用 opacity 淡化：会把静态对比度压到 AA 以下（实测约 2.87:1）");

	// ② 降字重：组头曾是整轮唯一的 600（胶囊/过程行/正文分别是 500/400/400）→ 降到 500
	assert.match(headerTag, /font-medium/, "② 组头字重应为 500（font-medium）");
	assert.doesNotMatch(headerTag, /font-semibold/, "② 组头不得回到 600——那会是整轮最粗的一行，重新喧宾夺主");
	assert.doesNotMatch(headerTag, /hover:font-/, "② hover 不改字重（宽度变化会导致行内 chevron 抖动）");

	// 静止色对白底的对比度必须 ≥ 4.5:1（AGENTS.md：浅色档必须够深才能过 AA）
	const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	const tertiaryHex = foundation.match(/--color-text-tertiary:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? "";
	assert.ok(tertiaryHex, "必须能读到亮色主题的 --color-text-tertiary");
	const ratio = contrastOnWhite(tertiaryHex);
	assert.ok(ratio >= 4.5, `--color-text-tertiary(${tertiaryHex}) 对白底仅 ${ratio.toFixed(2)}:1，低于 WCAG AA 4.5:1——组头静止色不能用比它更浅的 token`);
});

test("运行中组头报「正在」必须用当前工具类别，不能用整组摘要", () => {
	// 2026-08 审计：组内从搜索切到读取后，用摘要（topActivityKinds 首位）会写「正在搜索代码」，
	// 而右侧实时详情（lastToolLoadingLabel）已是「正在读取 main.ts」——同一行自相矛盾。
	assert.match(groupSource, /props\.running \? lastToolCategory\(props\.group\.members\) : undefined/);
	assert.doesNotMatch(groupSource, /lastToolCategory\(props\.group\.members\) \?\? topKind/);
	assert.match(groupSource, /const runningLabel = props\.running \? runningGroupLabel\(runningKind\) : ""/);
	// 已结束的组仍是摘要（doneLabel），不能改成最后一个工具
	assert.match(groupSource, /const doneLabel = props\.running \? "" : doneGroupLabel\(props\.group\.counts\)/);
	// 最后一个成员是思考时，旧工具的实时详情也必须一并消失。
	assert.match(groupSource, /if \(current\?\.kind !== "tool-entry"\) return undefined/);
});

test("running 只看尾部节点是不是该组：尾部追加中间回复 / 重试后旧组不得再 shimmer", () => {
	// 2026-08 审计：旧实现用 lastProcessGroup(props.nodes)（= 最后一个**组**）判定 running。
	// 组后面再追加中间回复 / 重试 / 错误行时，那个组已经跑完，继续报「正在…」是在撒谎。
	assert.match(foldSource, /const lastNode = props\.nodes\[props\.nodes\.length - 1\];/);
	assert.match(foldSource, /const runningGroupId = props\.agentRunning && lastNode\?\.kind === "group" \? lastNode\.id : undefined;/);
	// 旧的「最后一个组」判定不得回来
	assert.doesNotMatch(foldSource, /props\.agentRunning \? lastProcessGroup\(props\.nodes\)\?\.id : undefined/);
});

test("组头 / 组体有稳定 DOM 锚点（e2e 依赖，不许改名）", () => {
	assert.match(groupSource, /data-process-group-id=\{props\.group\.id\}/);
	assert.match(groupSource, /data-process-group-head=""/);
	assert.match(groupSource, /data-process-group-body=""/);
	assert.match(groupSource, /data-process-group-scroller=""/);
});

test("回到底部按钮不能被 aria-hidden 父层从辅助技术中隐藏", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	assert.match(source, /data-scroll-to-bottom=""/);
	assert.doesNotMatch(source, /<div\s+className="pointer-events-none absolute inset-0 z-20"\s+aria-hidden="true"/);
});

test("组体内部滚轮必须自己跟底，且复用时间线同一个跟底引擎", () => {
	// 复现的原问题：组体超过 max-height（min(320px,30vh)）后，外层时间线的 ResizeObserver
	// 收不到增高通知，新来的思考 / 工具内容只落在**内部**滚动容器下方；内层若不自己跟底，
	// 表现为「组体框里的滚珠停在上面、不到底」。
	//
	// 修法刻意**复用同一个跟底引擎**（lib/stick-to-bottom），不另写简化版：引擎里沉淀了
	// 离散增高 instant、内容收缩不追底、clamp 不被误判为用户滚动、resizeScrollGuard 等
	// 历史修复；自造简化版会把这些坑重踩一遍（用户反馈过的「跟底偶发跳动」正是这类问题）。
	// 本测试同时守卫「不得把引擎内部逻辑复刻回组件」与「引擎增长贴底语义不被改坏」。
	const engineSource = readFileSync("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", "utf8");
	// 必须实例化同一引擎；内层是限高小窗，取 instant（不引入弹簧变量）
	assert.match(groupSource, /useStickToBottom\(\{\s*initial:\s*"instant",\s*resize:\s*"instant"\s*\}\)/);
	// 引擎 ref 分别挂到滚动容器与内容包装盒（引擎观察内容盒才能感知增长）
	assert.match(groupSource, /ref=\{stickScrollRef\}/);
	assert.match(groupSource, /<div ref=\{stickContentRef\}/);
	// 滚轮必须路由进引擎：引擎不注册自己的 wheel 监听，靠 noteWheel 从外部喂意图，
	// 不路由则上滚无法逃逸（内容一增长又被拽回底部）
	assert.match(groupSource, /onWheel=\{\(event\)\s*=>\s*stickNoteWheel\(event\.deltaY,\s*event\.target\)\}/);
	// 展开后显式落底：挂载那一刻已有历史成员不会再产生 resize 事件，不显式定位就停在顶部
	assert.match(groupSource, /useLayoutEffect\(\(\) => \{[\s\S]*?stickScrollToBottom\(\{\s*animation:\s*"instant"\s*\}\)/);
	// 组内滚动不得上报外层 controller（契约 §7 已知限制 1 保持原样，不在本次修复扩大范围）
	assert.doesNotMatch(groupSource, /onUserIntent/);
	// 不得在本组件复刻引擎内部的 ResizeObserver / 贴底逻辑（跟底真相只能有一处）
	assert.doesNotMatch(groupSource, /new ResizeObserver/);
	assert.doesNotMatch(groupSource, /scrollHeight - /);
	// 本次修复依赖的引擎语义：instant 增长在 RO 回调内同步写 scrollTop（防多一帧旧位置）
	assert.match(engineSource, /if \(animation === "instant"\) \{/);
	assert.match(engineSource, /state\.scrollTop = state\.calculatedTargetScrollTop;/);
});
