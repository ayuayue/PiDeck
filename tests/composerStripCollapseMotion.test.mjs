import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * composer 折叠条的开合动画契约（2026-10 motion 体验优化）。
 *
 * 背景：待办 / 子代理 / Team 条原先是手写 `{!collapsed && (...)}` 瞬时挂载，
 * 只靠 `motion-safe:animate-in fade-in` 淡入——高度从 0 硬跳到实测值，整叠卡片
 * 上下顶一下；收起则直接卸载，没有任何过渡。
 *
 * 现统一走 `ui-shadcn/collapsible`（Radix Collapsible + tw-animate-css 的
 * collapsible-down/up）：真高度渐变、Radix Presence 等 exit 动画播完才卸载、
 * reduced-motion 自动退回瞬时开合。仓库里 TurnRow / FileTreeRows / approval-card
 * 已是同一做法，不另起第三套动画语言。
 *
 * 折叠状态所有权不变：仍由 composer 通道（useComposerWidgetCollapsed）持有，
 * `<Collapsible>` 只做受控呈现（open={!collapsed}）——这里同时钉住「别把状态搬进 Radix」。
 *
 * 正则以 \\s* 容忍换行与缩进：格式化不应打红本契约（AGENTS.md 空白容忍纪律）。
 */

const sessionComponent = (file) => readFileSync(`src/renderer/src/components/session/${file}`, "utf8");

const STRIPS = ["SessionTodoStrip.tsx", "SessionTeamStrip.tsx", "SessionSubagentsStrip.tsx"];

for (const file of STRIPS) {
	test(`${file} 折叠内容走共享折叠原语（高度渐变 + exit 后卸载）`, () => {
		const source = sessionComponent(file);
		assert.match(source, /import \{\s*Collapsible[^}]*\}\s*from "\.\.\/ui-shadcn\/collapsible"/, "must import the shared collapsible primitive instead of hand-rolling one");
		assert.match(source, /<Collapsible\s+open=\{!collapsed\}>/, "the disclosure root must stay controlled by the composer collapse channel");
		assert.match(source, /<CollapsibleContent>[\s\S]*<\/CollapsibleContent>/, "collapsed content must mount inside CollapsibleContent");
	});
}

test("composer 条不再手写瞬时折叠与自绘入场动画", () => {
	for (const file of STRIPS) {
		const source = sessionComponent(file);
		assert.doesNotMatch(source, /\{\s*!\s*collapsed\s*&&\s*\(/, `${file} must not resurrect the instant mount/unmount disclosure`);
		// 入场交给 CollapsibleContent 的 motion-safe 高度动画；自绘 fade-in 会与之叠成两帧节奏。
		assert.doesNotMatch(source, /motion-safe:animate-in/, `${file} must not hand-roll a fade-in on collapsed content`);
		assert.doesNotMatch(source, /motion-reduce:animate-none/, `${file} reduced-motion is the primitive's job now`);
	}
});

test("折叠状态所有权仍在 composer 通道，Radix 不做第二份状态", () => {
	for (const file of STRIPS) {
		const source = sessionComponent(file);
		assert.match(source, /useComposerWidgetCollapsed\(/, `${file} must keep the composer collapse store as the single owner`);
		// 受控用法：不给 Radix defaultOpen/onOpenChange 自持状态。
		assert.doesNotMatch(source, /<Collapsible\s+(defaultOpen|onOpenChange)/, `${file} must not let Radix own the disclosure state`);
	}
});

test("子代理条三处展开各占一个 disclosure root（列表与行内详情一致）", () => {
	const source = sessionComponent("SessionSubagentsStrip.tsx");
	const openCount = (source.match(/<Collapsible\s+open=\{!collapsed\}>/g) || []).length;
	const contentCount = (source.match(/<CollapsibleContent>/g) || []).length;
	assert.equal(openCount, 3, "strip list + pi row detail + dsh row detail must each own one disclosure root");
	assert.equal(contentCount, 3, "every disclosure root needs its matching content wrapper");
});

test("条内限高列表保留各自上限与滚轮约定（迁移不得顺手改滚动契约）", () => {
	const caps = [
		["SessionSubagentsStrip.tsx", "max-h-\\[240px\\]"],
		["SessionTodoStrip.tsx", "max-h-\\[180px\\]"],
		["SessionTeamStrip.tsx", "max-h-\\[260px\\]"],
	];
	for (const [file, cap] of caps) {
		const source = sessionComponent(file);
		const list = source.match(new RegExp(`<(?:ul|div)\\s+className="[^"]*${cap}[^"]*"`));
		assert.ok(list, `${file} should still keep its capped list`);
		assert.doesNotMatch(list[0], /overscroll-contain/, "条内限高列表带 overscroll-contain 会把滚轮吞在自身（见 composerStripWheelChain）");
	}
});
