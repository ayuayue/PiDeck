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

test("组头 / 组体有稳定 DOM 锚点（e2e 依赖，不许改名）", () => {
	assert.match(groupSource, /data-process-group-id=\{props\.group\.id\}/);
	assert.match(groupSource, /data-process-group-head=""/);
	assert.match(groupSource, /data-process-group-body=""/);
	assert.match(groupSource, /data-process-group-scroller=""/);
});
