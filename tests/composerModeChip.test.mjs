/**
 * 底栏特殊模式 chip 的交互/动画契约（2026-10 产品改版）：
 * - 普通模式不渲染任何模式控件（旧的闪电图标去掉），普通态就是「没有 chip」；
 *   模式入口收进「+」菜单的模式分组，普通模式不作为菜单项；
 * - chip 在 plan/goal 出现，鼠标移入或键盘聚焦时左侧 glyph 旋成带圈 ×（用户给的参考图），
 *   点击即回到普通模式（setMode("normal")，与 ComposerArea 的 onCancelPlan 同一路径）；
 * - 文案只用短名（计划/目标），底栏不再出现「模式」二字；
 * - 动画尊重 prefers-reduced-motion。
 * 这些都是「看着不对但代码读起来没错」的回归，用源码契约兜住。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chip = readFileSync("src/renderer/src/components/session/composer/ComposerModeChip.tsx", "utf8");
const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("chip：hover/focus 把模式 glyph 换成带圈 ×，整枚 chip 就是退出按钮", () => {
	assert.match(chip, /CircleX/, "带圈 × 是退出提示的图标");
	assert.match(chip, /onPointerEnter=\{/, "鼠标移入触发 × 反馈");
	assert.match(chip, /onPointerLeave=\{/, "移出恢复模式 glyph");
	assert.match(chip, /onFocus=\{/, "键盘聚焦同样给出 × 反馈（不能只有鼠标能看到）");
	assert.match(chip, /onClick=\{props\.onExit\}/, "整枚 chip 点击即退出");
	assert.match(chip, /exitAffordance \? <CircleX size=\{14\} strokeWidth=\{2\} \/> : props\.icon/, "交互态换图标，常态显示模式 glyph");
});

test("chip：进出场与图标切换走 motion，reduced-motion 下退化为静态", () => {
	assert.match(chip, /useReducedMotion\(\)/);
	assert.match(chip, /<AnimatePresence mode="popLayout"/, "图标切换用 popLayout 原地交叉");
	assert.match(chip, /initial=\{reduce \? false :/, "reduce 时不做进场");
	assert.match(chip, /SPRING_SWAP/, "位移/缩放复用 @/lib/ease 的 spring token");
});

test("普通模式不占位：底栏只在 plan/goal 渲染 chip，入口在「+」菜单且不列 normal", () => {
	// chip 渲染条件：只认 plan/goal，且排除 media 后端 / legacy 生图锁定（setMode 会直接 return）
	assert.match(composer, /const chipMode: "plan" \| "goal" \| null/);
	assert.doesNotMatch(composer, /modeGlyph\(props\.composerAgentMode\)/, "旧常驻选择器（含普通态闪电图标）已移除");
	assert.doesNotMatch(composer, /composer-mode-cluster|composer-mode-exit/, "旧的独立退出×已删除");
	// 菜单分组只列特殊模式，普通模式不是可选项
	assert.match(composer, /const specialModes = visibleModes\.filter\(\(mode\) => mode === "plan" \|\| mode === "goal"\)/);
	assert.match(composer, /app\.composerAddMode/);
	assert.match(composer, /onSelect=\{\(\) => props\.onChangeMode\(active \? "normal" : mode\)\}/, "再点当前模式回到普通（与 chip 同一语义）");
});

test("chip/菜单文案用短名：底栏不再出现「模式」二字", () => {
	assert.match(composer, /label=\{t\(MODE_SHORT_LABEL\[chipMode\] \?\? MODE_LABEL\[chipMode\]\)\}/, "chip 标签取短名");
	assert.match(zh, /"app\.composerModePlanShort": "计划"/);
	assert.match(zh, /"app\.composerModeGoalShort": "目标"/);
	assert.match(en, /"app\.composerModePlanShort": "Plan"/);
	assert.match(en, /"app\.composerModeGoalShort": "Goal"/);
	// 退出说明仍用动作文案（取消计划 / 暂停目标），可访问名不落成「计划」
	assert.match(composer, /title=\{t\(MODE_EXIT_LABEL\[chipMode\] \?\? MODE_LABEL\[chipMode\]\)\}/);
});
test("会话 Tab 的模式徽标与底栏 chip 统一：短名 + 图标，全名只留在 title/aria-label", () => {
	const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	// 计划=清单、目标=靶心，与 modeGlyph 同一套图标语义
	assert.match(tabs, /<ListChecks className="size-2\.5" aria-hidden="true" \/>\s*\{t\("app\.composerModePlanShort"\)\}/);
	assert.match(tabs, /<Target className="size-2\.5" aria-hidden="true" \/>\s*\{t\("app\.composerModeGoalShort"\)\}/);
	// 简洁模式（simple）同样短名 + 图标
	assert.match(tabs, /<ListChecks className="size-3" aria-hidden="true" \/>\s*\{t\("app\.composerModePlanShort"\)\}/);
	// 徽标正文不再直接输出全名（Tab 很窄，旧「计划模式」会再挤掉两个字）
	assert.doesNotMatch(tabs, /text-micro font-medium leading-4 text-primary" title=\{t\("app\.composerModePlan"\)\}>\s*\{t\("app\.composerModePlan"\)\}/);
	assert.match(tabs, /aria-label=\{t\("app\.composerModePlan"\)\}/, "全名保留在可访问名");
	assert.match(tabs, /aria-label=\{t\("app\.composerModeGoal"\)\}/);
});

test("chip 圆角与底栏其它按钮同族（rounded-md，非胶囊）", () => {
	assert.match(chip, /rounded-md border border-current\/25 bg-current\/10/);
	assert.doesNotMatch(chip, /rounded-full/, "胶囊形与整排方角按钮不同族（用户反馈换回之前的角边）");
});
