import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// UI 走查 P0.4：「状态」必须靠语义 token 表达，而不是 Tailwind 字面色。
// 背景：foundation.css 里 --color-success/-warning/-danger/-info 已经有浅色与暗色两套值、
// 也过了 themeContrast 的 AA 校验；页面里写 emerald/amber 字面色就得自己补 dark: 变体，
// 同一个「成功」在不同页面会长成两种绿。这组断言把收敛结果钉住，防止回退。
const BADGE = "src/renderer/src/components/ui-shadcn/badge.tsx";
const ANIMATED_BADGE = "src/renderer/src/components/motion/animated-badge.tsx";
const AUTOMATION_HISTORY = "src/renderer/src/components/automation/AutomationHistoryList.tsx";
const AUTOMATION_TASKS = "src/renderer/src/components/automation/AutomationTaskList.tsx";

const badge = readFileSync(BADGE, "utf8");
const animatedBadge = readFileSync(ANIMATED_BADGE, "utf8");
const automationHistory = readFileSync(AUTOMATION_HISTORY, "utf8");
const automationTasks = readFileSync(AUTOMATION_TASKS, "utf8");

/** 字面色：emerald/amber/rose/blue 等带具体阶数，或用 dark: 变体手工补偿状态色。 */
const LITERAL_STATUS_COLOR = /(?:text|bg|border)-(?:emerald|amber|rose|sky|blue|green|red)-\d{2,3}/;
const DARK_COMPENSATED_STATUS = /dark:text-(?:emerald|amber|rose|sky|blue|green|red)-\d{2,3}/;

test("badge 提供 success/warning/danger/info/neutral 五个语义档", () => {
	// neutral 是「无状态/次要」，用的是一次级文本色而不是状态色。
	const expectedText = {
		success: "text-success",
		warning: "text-warning",
		danger: "text-danger",
		info: "text-info",
		neutral: "text-text-secondary",
	};
	for (const [tone, textClass] of Object.entries(expectedText)) {
		assert.match(badge, new RegExp(`${tone}: "[^"]*${textClass}`), `badge 缺少 ${tone} 语义档`);
	}
	// 语义档的底色/描边同样走 token（/15、/30 透明度档），不得写字面色。
	assert.match(badge, /success: "border-success\/30 bg-success\/15 text-success"/);
	assert.match(badge, /neutral: "border-border-subtle bg-bg-muted text-text-secondary"/);
	assert.doesNotMatch(badge.split("const badgeVariants")[1].split("const SIZE")[0], LITERAL_STATUS_COLOR);
});

test("badge 尺寸两档固定为 default/sm，状态列不再逐处重写 h-5 px-1.5 text-micro", () => {
	assert.match(badge, /size: \{[\s\S]*?default: "px-1\.5 py-0\.5 text-xs"/);
	assert.match(badge, /size: \{[\s\S]*?sm: "h-5 px-1\.5 text-micro"/);
	assert.match(badge, /data-size=\{size\}/);
	// 表格状态列迁移后不应再自带尺寸类。
	assert.doesNotMatch(automationHistory, /<Badge[^>]*className="h-5 /);
});

test("AnimatedBadge 的状态色与 badge 语义档同源", () => {
	const statusMap = animatedBadge.split("const STATUS_CLASS")[1].split("const SIZE_CLASS")[0];
	assert.doesNotMatch(statusMap, LITERAL_STATUS_COLOR, "STATUS_CLASS 不得使用 Tailwind 字面色");
	assert.doesNotMatch(statusMap, DARK_COMPENSATED_STATUS, "语义 token 会自行翻转暗色，不需要 dark: 补偿");
	for (const tone of ["success", "warning", "danger", "info"]) {
		assert.match(statusMap, new RegExp(`text-${tone}\\b`), `STATUS_CLASS 缺少 ${tone} token`);
	}
});

test("自动化历史的状态列使用 badge 语义档而不是裸染色", () => {
	assert.match(automationHistory, /<Badge variant="info" size="sm" className="animate-pulse">/);
	for (const variant of ["success", "danger", "warning", "neutral"]) {
		assert.match(automationHistory, new RegExp(`<Badge variant="${variant}" size="sm">`), `状态列缺少 ${variant} 档`);
	}
	assert.doesNotMatch(automationHistory, LITERAL_STATUS_COLOR, "状态列不得使用 Tailwind 字面色");
	assert.doesNotMatch(automationHistory, /text-micro font-normal/, "字号/字重由 size 档承担，不在调用点重复");
});

test("任务列表的运行状态只做角色映射，色值不重复实现第二份", () => {
	assert.match(automationTasks, /function runStatusVariant\(status: AutomationRun\["status"\]\)/);
	assert.doesNotMatch(automationTasks, LITERAL_STATUS_COLOR, "状态不得使用 Tailwind 字面色");
	// 语义档已经带 border/bg/text/尺寸，调用点再写就是第二份实现。
	assert.doesNotMatch(automationTasks, /<Badge[^>]*className=\{`h-5/);
	assert.doesNotMatch(automationTasks, /text-\[10px\]/);
	assert.match(automationTasks, /<Badge variant=\{isRunning \? "info" : task\.enabled \? "success" : "neutral"\} size="sm"/);
});
