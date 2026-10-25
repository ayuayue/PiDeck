import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 「同行文本共基线」契约（2026-09 用户反馈「等宽详情偏高、没纵向居中」）。
 *
 * 背景与原理见 `src/renderer/src/components/session/RowText.tsx`：
 * 行容器是 `flex items-center`（按**盒子**居中），基线落在 `行中心 + (ascent − descent)/2`，
 * 只由字体度量决定 —— 12px 等宽详情与 14px 正文混排必然差约 2–3px，且**与行高无关**
 * （曾改 `--text-chat-detail--line-height` 试过，真机实测只动 0.04px，已回滚）。
 *
 * 唯一正确的解是按基线对齐：把该行**所有**文本项放进 `items-baseline` 组。
 * 本文件是这条规则的源码级守卫 —— 行为级守卫在 `e2e/process-group-display.spec.ts`
 * 的「同行文本共基线」用例（真机量基线极差 ≤0.75px）。
 */

const rowText = readFileSync("src/renderer/src/components/session/RowText.tsx", "utf8");
const ROWS = {
	toolCall: "src/renderer/src/components/session/ToolCallComponents.tsx",
	thinking: "src/renderer/src/components/session/TimelineEventCards.tsx",
	processHead: "src/renderer/src/components/session/turn/ProcessGroupStep.tsx",
};

test("RowText 原语：共基线策略单点定义，并带 e2e 稳定锚点", () => {
	// 断言看**实现行**，避免注释里的举例把断言变成永真
	const impl = rowText.slice(rowText.indexOf("export const RowText"));
	// 策略本体：inline-flex + items-baseline（按真实基线对齐，与字体度量无关）
	assert.match(impl, /inline-flex/);
	assert.match(impl, /items-baseline/);
	// 允许多行（工具名可能折行）：min-w-0 让截断在组内生效
	assert.match(impl, /min-w-0/);
	// e2e 锚点：「同行文本共基线」用例靠它定位文本段
	assert.match(impl, /data-row-text=""/);
	// 只负责对齐策略，伸缩行为交给调用方（组头不需要撑满，工具行需要）
	assert.doesNotMatch(impl, /flex-\[1_1_auto\]/);
});

test("过程行文本段一律走 RowText：混排文本不得各自 items-center", () => {
	for (const [name, file] of Object.entries(ROWS)) {
		const source = readFileSync(file, "utf8");
		// 必须使用共享原语（而不是每处手抄一份 class，避免策略漂移）
		assert.match(source, /import \{ RowText \} from "\.\.?\/(\.\.\/)?RowText"/, `${name} 必须导入 RowText`);
		assert.match(source, /<RowText[^>]*>/, `${name} 必须用 RowText 承载同行文本`);
		// 行内不得再手写「文本各自居中」的容器：这正是本 bug 的成因
		assert.doesNotMatch(source, /<span data-row-text="" className="[^"]*items-center[^"]*"/, `${name} 不得手写 items-center 文本段`);
	}
});

test("盒子类元素不参与基线对齐：徽章 / chevron / kind pill 显式 self-center", () => {
	// 图标、徽章、chevron 有自己的垂直居中语义；进了基线组就必须 self-center，
	// 否则（svg 的基线 = 盒子底边）会被顶到文字基线上去。
	const toolCall = readFileSync(ROWS.toolCall, "utf8");
	assert.match(toolCall, /<span className="inline-flex self-center">\{statusBadge\}<\/span>/);
	assert.match(toolCall, /className="tool-card-kind self-center"/);
	// 工具图标留在文本段之外，由行容器居中
	assert.match(toolCall, /className="tool-card-icon inline-flex shrink-0 items-center justify-center"/);

	const thinking = readFileSync(ROWS.thinking, "utf8");
	assert.match(thinking, /<Brain size=\{16\} className="thinking-row-icon shrink-0"/);
	assert.match(thinking, /ChevronDown size=\{14\} className="shrink-0 self-center text-text-faint"/);
});

test("详情档行高保持自身 1.5 倍：等高行盒修不了跨字体基线（已实测无效）", () => {
	const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	assert.match(tailwind, /--text-chat-detail--line-height:\s*var\(--line-height-chat-detail\);/);
	// 反例守卫：不得再改回「与 chat-row 行盒等高」那版（对等宽详情只影响 0.04px）
	assert.doesNotMatch(tailwind, /--text-chat-detail--line-height:\s*calc\(/);
});
