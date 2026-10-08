import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const passthrough = ({ children }) => children;
const menu = ({ children, ...props }) => createElement("div", { role: "menu", "aria-label": props["aria-label"] }, children);
const radioGroup = ({ children }) => createElement("div", { role: "group" }, children);
const radioItem = ({ children, value, disabled, ...props }) => createElement("button", { role: "menuitemradio", disabled, "data-picker-value": value, title: props.title }, children);
const button = ({ children, variant: _variant, size: _size, ...props }) => createElement("button", props, children);

const { ModelThinkingChip, ThinkingLevelDropdown } = loadTsCommonJs("src/renderer/src/components/session/ModelThinkingChip.tsx", {
	stubs: {
		"../../i18n": { t: (key) => key },
		"../ui-shadcn/button": { Button: button },
		"../ui-shadcn/dropdown-menu": {
			DropdownMenu: passthrough,
			DropdownMenuTrigger: passthrough,
			DropdownMenuContent: menu,
			DropdownMenuGroup: passthrough,
			DropdownMenuRadioGroup: radioGroup,
			DropdownMenuRadioItem: radioItem,
		},
	},
});

const noop = () => {};
const baseProps = { open: true, onOpenChange: noop, onPick: noop };

test("公共组件门面不再导出已移除的思考弹框", () => {
	for (const path of ["src/renderer/src/components/app/AppParts.tsx", "src/renderer/src/components/session/ComposerParts.tsx"]) {
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(source, /export\s*\{[^}]*\bThinkingPicker\b[^}]*\}\s*from/, path);
	}
});

/** 找出公开组件返回树中的交互节点，UI 原语仍由专用浏览器回归验证。 */
function findElement(tree, predicate) {
	if (!isValidElement(tree)) return undefined;
	if (predicate(tree)) return tree;
	for (const child of Children.toArray(tree.props.children)) {
		const found = findElement(child, predicate);
		if (found) return found;
	}
	return undefined;
}

test("思考选择直接呈现小下拉，无搜索框、对话框或确认按钮", () => {
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...baseProps, current: "high" }));
	assert.match(html, /role="menu"/);
	assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 7);
	assert.ok(html.includes("thinking.levelLabel.high"));
	assert.doesNotMatch(html, /role="dialog"|<input|common.confirm/);
});

test("仅展示当前模型档位，保留未知未来 id、标签与说明", () => {
	const levels = [
		{ value: "low", labelKey: "thinking.levelLabel.low" },
		{ value: "future-level", label: "Future effort", description: "Provider-defined effort" },
	];
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...baseProps, current: "future-level", levels }));
	assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 2);
	assert.ok(html.includes("Future effort"));
	assert.ok(html.includes('title="Provider-defined effort"'));
	assert.doesNotMatch(html, /data-picker-value="off"|data-picker-value="max"/);
});

test("后端明确返回空档位时展示不可用提示，不回退静态档位", () => {
	const html = renderToStaticMarkup(createElement(ThinkingLevelDropdown, { ...baseProps, levels: [] }));
	assert.ok(html.includes("app.thinkingPickerUnsupported"));
	assert.doesNotMatch(html, /role="menuitemradio"/);
});

test("单档位与历史选择不匹配时不自动改写选择", () => {
	const picked = [];
	const tree = ThinkingLevelDropdown({ ...baseProps, current: "max", levels: [{ value: "off" }], onPick: (value) => picked.push(value) });
	const group = findElement(tree, (element) => element.type === radioGroup);
	assert.equal(group.props.value, "max");
	assert.deepEqual(picked, []);
	const option = findElement(tree, (element) => element.type === radioItem);
	option.props.onSelect();
	assert.deepEqual(picked, ["off"]);
});

test("选中当前档位正确高亮，点选一次直接提交原始 id", () => {
	const picked = [];
	const tree = ThinkingLevelDropdown({ ...baseProps, current: "high", levels: [{ value: "low" }, { value: "high" }], onPick: (value) => picked.push(value) });
	assert.equal(findElement(tree, (element) => element.type === radioGroup).props.value, "high");
	findElement(tree, (element) => element.type === radioItem && element.props.value === "low").props.onSelect();
	assert.deepEqual(picked, ["low"]);
});

test("启动中禁用触发器和所有档位，但运行中不额外禁用", () => {
	for (const disabled of [true, false]) {
		const tree = ThinkingLevelDropdown({ ...baseProps, disabled, levels: [{ value: "high" }] });
		assert.equal(findElement(tree, (element) => element.type === button).props.disabled, disabled);
		assert.equal(findElement(tree, (element) => element.type === radioItem).props.disabled, disabled);
	}
});

test("模型按钮独立打开现有模型选择器，并保留待生效标签与思考入口", () => {
	let opened = 0;
	const tree = ModelThinkingChip({ modelLabel: "Current model", modelPendingTo: "Next model", modelPendingTitle: "Next turn", onPickModel: () => opened++, thinkingControl: createElement("button", { "data-testid": "thinking-control" }, "high") });
	const trigger = findElement(tree, (element) => element.type === button);
	trigger.props.onClick();
	assert.equal(opened, 1);
	assert.equal(trigger.props.title, "Next turn");
	const html = renderToStaticMarkup(tree);
	assert.ok(html.includes("Current model → Next model"));
	assert.ok(html.includes('data-testid="thinking-control"'));
	assert.doesNotMatch(html, /role="menu"/);
});
