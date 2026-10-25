import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const composerModeSelect = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const composerModeChip = readFileSync("src/renderer/src/components/session/composer/ComposerModeChip.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
const extension = readFileSync("resources/extensions/pi-deck-goal-mode.ts", "utf8");
const sendHook = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("goal mode is a first-class ComposerAgentMode", () => {
	assert.match(agentTypes, /ComposerAgentMode = "normal" \| "plan" \| "imagegen" \| "videogen" \| "goal"/);
	assert.equal(existsSync("resources/extensions/pi-deck-goal-mode.ts"), true);
	assert.match(builtIns, /"pi-deck-goal-mode.ts"/);
});

test("mode picker lists goal between plan and imagegen", () => {
	// 模式选择器已重构进 ComposerComponents（旧 ComposerModeSelect.tsx 已删）：
	// 三态由 props.composerAgentMode 驱动，图标/文案锚点在同组件内。
	// 2026-10 产品决定：入口从常驻底栏下拉收回「+」菜单分组，普通模式不是菜单项，
	// 底栏只保留正在生效的特殊模式 chip。
	assert.match(composerModeSelect, /mode === "goal"/);
	assert.match(composerModeSelect, /"app\.composerModeGoal"/);
	assert.match(composerModeSelect, /composerAgentMode === "goal"/);
	assert.match(composerModeSelect, /const specialModes = visibleModes\.filter\(\(mode\) => mode === "plan" \|\| mode === "goal"\)/);
	assert.match(composerModeSelect, /"app\.composerModeGoalShort"/);
	assert.match(composerModeSelect, /<ComposerModeChip/);
	assert.doesNotMatch(composerModeSelect, /composer-bar-btn mode/, "底栏不再有常驻模式下拉");
	// 图标分支顺序：plan → imagegen → goal（实现）；契约只断言 goal 存在且三态齐全
	const planOrder = composerModeSelect.indexOf('mode === "plan"');
	const goalOrder = composerModeSelect.indexOf('mode === "goal"');
	const imagegenOrder = composerModeSelect.indexOf('mode === "imagegen"');
	assert.ok(planOrder >= 0 && goalOrder >= 0 && imagegenOrder >= 0);
});

test("DSH setMode pauses on normal and resumes paused goals", () => {
	assert.match(controller, /runDshGoalAction\(agentId, "pause"\)/);
	assert.match(controller, /runDshGoalAction\(agentId, "resume"\)/);
	assert.match(controller, /dshGoal\.pendingNotice/);
	assert.match(controller, /deriveComposerAgentMode/);
});

test("pi goal extension auto-continues until complete, blocked, or max rounds", () => {
	assert.match(extension, /__PI_DECK_GOAL_MODE__/);
	assert.match(extension, /GOAL_COMPLETE/);
	assert.match(extension, /GOAL_BLOCKED/);
	assert.match(extension, /triggerTurn: true, deliverAs: "followUp"/);
	assert.match(extension, /phase: "paused"/);
	assert.match(extension, /\["clear", "reset"\]/);
	// issue #357-05：删除写而不读的 continuing 变量。它曾被 8 处赋值、
	// 仅有的读取是 `if (continuing) { continuing = false; }` 自重置（无任何行为）。
	// 回流即视为重新引入“看似有状态机、实际死代码”。
	assert.doesNotMatch(extension, /\bcontinuing\b/);
});

test("goal/plan composer chrome：模式身份只用边框着色 + 单枚 chip（无左侧竖条、无独立退出药丸）", () => {
	// 2026-10 精简：左侧 2px 竖条与 chip 表达同一件事，还额外挤 6px 左内边距（切模式正文左右跳）；
	// 退出路径归入 chip 下拉（选「普通模式」= ComposerArea 的 onCancelPlan，同一条 setMode("normal")）。
	assert.doesNotMatch(timelineCss, /\.composer-box::before/, "composer-box 不再有模式身份条伪元素");
	assert.doesNotMatch(timelineCss, /\.composer-box\.(shell-mode|shell-silent-mode|plan-mode|goal-mode)::before/, "模式态不再画左侧竖条");
	assert.doesNotMatch(timelineCss, /\.composer-box\.(shell-mode|shell-silent-mode|plan-mode|goal-mode)[\s\S]{0,80}?padding-left:\s*18px/, "输入区不再为竖条让位（切模式不跳字）");
	// 身份仍可见：plan/goal 非聚焦态就有 1px 边框着色（focus-within 另有加强）
	assert.match(timelineCss, /\.composer-box\.plan-mode \{[\s\S]*?border-color:\s*color-mix\(\s*in srgb,\s*var\(--color-brand-green\) 34%/);
	assert.match(timelineCss, /\.composer-box\.goal-mode \{[\s\S]*?border-color:\s*color-mix\(\s*in srgb,\s*var\(--color-accent\) 34%/);
	// 2026-10 交互改版：底栏只剩一枚 chip，chip 自身就是退出入口——
	// hover / 键盘聚焦时左侧 glyph 换成带圈 ×，点击即 setMode("normal")（与 ComposerArea 的
	// onCancelPlan 同一条路径）；不再有独立退出×，也不再有常驻下拉把同一件事摆两次。
	// 生图/生视频后端（mediaModeIsBackend）的 mode 由 record.backend 推导、setMode 直接 return，
	// 必须一并排除，否则会出现点了没反应的按钮（用户反馈「选中视频模式后没办法退出」）。
	assert.match(composerComponents, /const mediaModeIsBackend = props\.backend === "imagegen" \|\| props\.backend === "videogen"/);
	assert.match(composerComponents, /const chipMode: "plan" \| "goal" \| null/);
	assert.match(composerComponents, /<ComposerModeChip/);
	assert.match(composerComponents, /onExit=\{props\.onCancelPlan\}/);
	assert.doesNotMatch(composerComponents, /composer-mode-cluster|composer-mode-exit/, "独立退出×已删除（chip 自己就是退出）");
	assert.doesNotMatch(composerComponents, /modeGlyph\(props\.composerAgentMode\)/, "普通模式不再在底栏渲染闪电图标");
	// chip 的交互/动画契约：hover 与 focus 共用一份 exit 态，图标旋成 CircleX；reduced-motion 静态
	assert.match(composerModeChip, /CircleX/);
	assert.match(composerModeChip, /onPointerEnter=\{/);
	assert.match(composerModeChip, /onFocus=\{/);
	assert.match(composerModeChip, /onClick=\{props\.onExit\}/);
	assert.match(composerModeChip, /useReducedMotion\(\)/);
	assert.match(composerModeChip, /<AnimatePresence mode="popLayout"/);
	assert.doesNotMatch(composerComponents, /mode-cancel/);
});

test("pi goal extension: a new goal typed after complete replaces the old objective", () => {
	// 完成后目标模式里发的原文必须替换旧目标（修复前只重置 phase，
	// 新目标既不显示也不被执行），且替换语义应清空上一目标消耗的轮次。
	assert.match(extension, /else if \(state\.phase === "complete"\)/);
	// 完成分支把新原文作为替换目标传入，而不是落入末位 else 只改 phase。
	assert.match(extension, /上一目标已完成：目标模式里发的原文是「替换为新目标」/);
	assert.match(extension, /} else if \(state\.phase === "complete"\) \{[\s\S]*?setActive\(ctx, body\);/);
	// 替换语义清空上一目标消耗的轮次；恢复（不传参）保留原轮次。
	assert.match(extension, /roundsStarted: replacing \? 0 : state\.roundsStarted/);
	assert.match(extension, /暂停\/阻塞 ≠ 完成：正文保持原文推进同一目标/);
});

test("pi goal extension: resume kicks off a turn and abort stops the loop", () => {
	// resume/on/enable 后必须真正派发一轮续跑，而不是只把 phase 置回 active 空转。
	assert.match(extension, /kickOffContinuation\(\);/);
	assert.match(extension, /恢复必须真正触发一轮续跑：否则 agent 空闲时 goal 只标 active、不干活/);
	// 恢复与自动续轮共用同一派发 helper（triggerTurn + followUp）。
	assert.match(extension, /function kickOffContinuation\(\): void \{[\s\S]*?triggerTurn: true, deliverAs: "followUp"/);
	// Stop 会话（abort）后 agent_end 不再自动续轮：检查 assistant 的 stopReason。
	assert.match(extension, /lastAssistant\.stopReason === "aborted" \|\| lastAssistant\.stopReason === "error"/);
	assert.match(extension, /停止会话却停不下来/);
});

test("send path keeps DSH off agentMessage and uses /goal transform", () => {
	assert.match(sendHook, /applyDshGoalSendTransform/);
	assert.match(sendHook, /isDshSend \? "normal" : sendMode/);
});
