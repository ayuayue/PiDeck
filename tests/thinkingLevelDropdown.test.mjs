import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 思考强度滑条契约（ZCode 渐变强度条同构）。
 * 组件含 hooks（useShortcutBindings/useMemo），不能当普通函数调用拿元素树——
 * 统一走 renderToStaticMarkup（SSR 支持 hooks），交互节点由桩渲染时捕获 props。
 */
const passthrough = ({ children }) => children;

function createHarness() {
	const captured = { sliders: [], buttons: [], tooltipContents: [] };
	const slider = (props) => {
		captured.sliders.push(props);
		// 与 Radix 一致：Root 只渲染 Track/Range/Thumb，children 被丢弃（探针实测），
		// 因此装饰节点必须挂在外层容器，不能靠塞进 Slider 里。
		return createElement("div", { role: "slider", "aria-label": props["aria-label"], className: props.className });
	};
	const button = ({ children, onClick, disabled, ...props }) => {
		captured.buttons.push({ ...props, onClick, disabled, children });
		return createElement("button", { ...props, onClick, disabled }, children);
	};
	// 模型按钮的气泡改用 shadcn Tooltip（Radix）：SSR 需要 TooltipProvider 祖先，真实应用由
	// main.tsx 全局挂载，这里壳透传；气泡文案由 TooltipContent 捕获（原生 title 已退役）。
	const tooltipContent = ({ children }) => {
		captured.tooltipContents.push(children);
		return null;
	};
	// Popover 壳：捕获 onOpenChange（提交时机就在这条回调上，必须可断言）。
	const popover = (props) => {
		captured.popover = props;
		return createElement("div", { "data-slot": "popover" }, props.children);
	};
	// 内容壳：捕获 className（弹层宽度策略决定 7 个档位标签能否装下），children 保留供 SSR 断言。
	const popoverContent = (props) => {
		captured.popoverContent = props;
		return createElement("div", { "data-slot": "popover-content" }, props.children);
	};
	const { ModelThinkingChip, ThinkingLevelDropdown } = loadTsCommonJs("src/renderer/src/components/session/ModelThinkingChip.tsx", {
		stubs: {
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/button": { Button: button },
			"../ui-shadcn/popover": { Popover: popover, PopoverTrigger: passthrough, PopoverContent: popoverContent },
			"../ui-shadcn/slider": { Slider: slider },
			"../ui-shadcn/tooltip": { Tooltip: passthrough, TooltipTrigger: passthrough, TooltipContent: tooltipContent },
			"../../hooks/useShortcutBindings": { useShortcutBindings: () => ({ bindings: { cycleThinking: "Control+T" }, platform: "win32" }) },
		},
	});
	return { captured, ModelThinkingChip, ThinkingLevelDropdown };
}

const noop = () => {};
const BASE = { open: true, onOpenChange: noop, onPick: noop };

test("思考强度条直接呈现（Popover 壳 + 渐变滑条），无单选菜单项/搜索框/确认按钮", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "high" }));
	assert.match(html, /role="slider"/);
	assert.equal(captured.sliders.length, 1);
	// 7 个离散档位刻度标签
	assert.equal(captured.buttons.filter((b) => b["data-tick-value"]).length, 7);
	assert.ok(html.includes("thinking.levelLabel.high"));
	// 快捷键提示跟随生效绑定（hook 桩返回 Control+T）
	assert.ok(html.includes("Ctrl+T"));
	assert.doesNotMatch(html, /role="menuitemradio"|common\.confirm|<input/);
});

test("档位标签行按内容定宽且不裁字（回归：大字档下首尾标签挤出弹层、字头被切）", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "high" }));
	// 弹层宽度跟随标签内容：固定 w-72 在 fontSize=large（标签 13px）下与标签行零余量
	assert.match(captured.popoverContent.className, /(?:^|\s)w-auto(?:\s|$)/);
	assert.doesNotMatch(captured.popoverContent.className, /(?:^|\s)w-72(?:\s|$)/);
	// 标签按钮不得挂 truncate / 固定行高：16px（leading-4）行盒装不下 13~14px 标签，
	// overflow:hidden 会把行盒顶部切掉，字头看起来「被盖住」。
	const ticks = captured.buttons.filter((b) => b["data-tick-value"]);
	assert.equal(ticks.length, 7);
	for (const tick of ticks) {
		assert.doesNotMatch(tick.className, /(?:^|\s)truncate(?:\s|$)/, `${tick["data-tick-value"]} 不得截断`);
		assert.doesNotMatch(tick.className, /(?:^|\s)leading-\d/, `${tick["data-tick-value"]} 行高需跟随 text-micro`);
		assert.match(tick.className, /(?:^|\s)whitespace-nowrap(?:\s|$)/, `${tick["data-tick-value"]} 不得换行`);
	}
	// 标签行内缩：首尾标签不再贴着弹层内容盒边缘
	assert.match(html, /justify-between gap-1 px-2/, "标签行需留出首尾边距");
});

test("轨道上每个档位都有刻度点，且填充段/未选段分色（不能挂在 Slider children 里）", () => {
	const { ThinkingLevelDropdown } = createHarness();
	const levels = [{ value: "off" }, { value: "low" }, { value: "medium" }, { value: "high" }];
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "low", levels }));
	// 回归：Radix Slider.Root 丢弃 children，星尘点曾因此完全不渲染（DOM 里一个点也没有）。
	// 用 data-track-dot 计数，不依赖 class 拼接顺序。
	const filled = html.match(/data-track-dot="filled"/g) ?? [];
	const idle = html.match(/data-track-dot="idle"/g) ?? [];
	assert.equal(filled.length + idle.length, levels.length, `档位点数量应等于档位数，实际 DOM：${filled.length + idle.length}`);
	// current=low → 下标 1：前两个点落在填充段，其余落在灰轨
	assert.equal(filled.length, 2);
	assert.equal(idle.length, 2);
});

test("滑条离散吸附：min/max 覆盖全部档位，value=当前档位下标，step=1", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const levels = [{ value: "off" }, { value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "medium", levels }));
	const [sliderProps] = captured.sliders;
	// VM realm 的数组与本地 Array 原型不同，逐值比较（见 AGENTS 测试规约）
	assert.equal(sliderProps.value[0], 2);
	assert.equal(sliderProps.min, 0);
	assert.equal(sliderProps.max, 3);
	assert.equal(sliderProps.step, 1);
});

test("仅展示当前模型档位，保留未知未来 id、标签与说明", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const levels = [
		{ value: "low", labelKey: "thinking.levelLabel.low" },
		{ value: "future-level", label: "Future effort", description: "Provider-defined effort" },
	];
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "future-level", levels }));
	assert.equal(captured.buttons.filter((b) => b["data-tick-value"]).length, 2);
	assert.ok(html.includes("Future effort"));
	assert.ok(html.includes('title="Provider-defined effort"'));
	assert.ok(!captured.buttons.some((b) => b["data-tick-value"] === "off" || b["data-tick-value"] === "max"));
});

test("当传入超出模型支持档位（如 max）时，滑条 clamp 到支持档位（如 high）而不泄露", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "max", levels }));
	assert.equal(captured.sliders[0].value[0], 2);
	assert.ok(!captured.buttons.some((b) => b["data-tick-value"] === "max"));
});

test("选择期间只预览：拖拽/刻度/方向键都不提交，关闭弹层才发一次 onPick", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "low", levels, onPick: (value) => picked.push(value) }));
	// 拖拽（onValueChange 逐档触发）：不得提交，也不得提前关闭
	captured.sliders[0].onValueChange([1]);
	captured.sliders[0].onValueChange([2]);
	assert.deepEqual(picked, []);
	// 点刻度：同样只改预览
	captured.buttons.find((b) => b["data-tick-value"] === "medium").onClick();
	assert.deepEqual(picked, []);
	// 关闭弹层：提交当时预览的档位（一次）
	captured.popover.onOpenChange(false);
	assert.deepEqual(picked, ["medium"]);
	// 再次关闭（已应用）：跳过无意义 RPC
	captured.popover.onOpenChange(false);
	assert.deepEqual(picked, ["medium"]);
});

test("打开弹层不提交；打开又原样关闭也不发 RPC", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "medium", levels, onPick: (value) => picked.push(value) }));
	captured.popover.onOpenChange(true);
	assert.deepEqual(picked, []);
	captured.popover.onOpenChange(false);
	assert.deepEqual(picked, []);
});

test("重新打开弹层时清掉上次未提交的预览（不把旧预览当新选择发回去）", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, open: false, current: "low", levels, onPick: (value) => picked.push(value) }));
	// 上一次残留的预览（例如提交失败 / RPC 未落地）
	captured.sliders[0].onValueChange([2]);
	captured.popover.onOpenChange(true);
	captured.popover.onOpenChange(false);
	assert.deepEqual(picked, [], "重新打开后应回到已应用档位，关闭时无变化不发 RPC");
});

test("键盘方向键预览（onValueChange）、Enter/空格 = 确认并关闭（关闭时才提交）", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "low", levels, onPick: (value) => picked.push(value) }));
	const key = (key) => captured.sliders[0].onKeyDown({ key, preventDefault: () => {} });
	// Radix 事件流：方向键由 Slider 内部处理并回调 onValueChange（预览），Enter 不移动值
	captured.sliders[0].onValueChange([1]);
	assert.deepEqual(picked, []);
	key("Enter");
	assert.deepEqual(picked, ["medium"]);
	// 已关闭（open=false）后重复 Enter 不再发
	key("Enter");
	assert.deepEqual(picked, ["medium"]);
});

test("点刻度标签只改预览，不提交", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const picked = [];
	const levels = [{ value: "low" }, { value: "medium" }, { value: "high" }];
	renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "low", levels, onPick: (value) => picked.push(value) }));
	captured.buttons.find((b) => b["data-tick-value"] === "medium").onClick();
	assert.deepEqual(picked, []);
});

test("后端明确返回空档位时展示不可用提示，不渲染滑条", () => {
	const { captured, ThinkingLevelDropdown } = createHarness();
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, levels: [] }));
	assert.ok(html.includes("app.thinkingPickerUnsupported"));
	assert.equal(captured.sliders.length, 0);
	assert.equal(captured.buttons.filter((b) => b["data-tick-value"]).length, 0);
});

test("启动中禁用触发器、滑条与刻度标签；运行中不额外禁用", () => {
	for (const disabled of [true, false]) {
		const { captured, ThinkingLevelDropdown } = createHarness();
		renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, disabled, levels: [{ value: "high" }] }));
		const trigger = captured.buttons.find((b) => !b["data-tick-value"]);
		assert.equal(trigger.disabled, disabled);
		assert.equal(captured.sliders[0].disabled, disabled);
		assert.equal(captured.buttons.find((b) => b["data-tick-value"]).disabled, disabled);
	}
});

test("模型按钮独立打开现有模型选择器，并保留待生效标签与思考入口", () => {
	const { captured, ModelThinkingChip } = createHarness();
	let opened = 0;
	const html = renderToStaticMarkup(createElement(ModelThinkingChip, { modelLabel: "Current model", modelPendingTo: "Next model", modelPendingTitle: "Next turn", onPickModel: () => opened++, thinkingControl: createElement("div", { "data-testid": "thinking-control" }, "high") }));
	assert.ok(
		captured.buttons.some((b) => b.title === undefined),
		"悬停文案改走 Tooltip，不应再叠原生 title 气泡",
	);
	assert.ok(captured.tooltipContents.includes("Next turn"), "待生效标题应在悬停气泡文案里");
	assert.equal(opened, 0);
	assert.ok(html.includes("Current model → Next model"));
	assert.ok(html.includes('data-testid="thinking-control"'));
});

test("滚轮接管区：滑条与刻度标签行同在 data-wheel-owned 容器内", () => {
	const { ThinkingLevelDropdown } = createHarness();
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, current: "high" }));
	const marker = html.indexOf("data-wheel-owned");
	assert.ok(marker >= 0, "SSR 输出应含 data-wheel-owned 标记");
	const inside = html.slice(marker);
	assert.ok(inside.includes('role="slider"'), "滑条必须在滚轮接管容器内");
	const ticks = inside.match(/data-tick-value="[a-z]+"/g) ?? [];
	assert.equal(ticks.length, 7, "7 个档位标签必须与滑条同在滚轮接管容器内");
});

test("后端明确返回空档位时不渲染滚轮接管区（滚轮回到无效果的现状）", () => {
	const { ThinkingLevelDropdown } = createHarness();
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...BASE, levels: [] }));
	assert.doesNotMatch(html, /data-wheel-owned/);
});
