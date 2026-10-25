import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 只替换叶子控件；生产组件仍处理草稿回显、行 key 和只读事件。 */
function harness(initialValue, writable = true) {
	const host = quickMessageHookHost();
	let value = initialValue;
	const load = createTsSandbox({
		stubs: {
			react: host.react,
			"../i18n": { t: (key) => key },
			"../components/ui-shadcn/input": { Input: "input" },
			"../components/ui-shadcn/button": { Button: "button" },
			"./ConfigShared": { ConfigComboboxInput: "combobox" },
		},
	});
	const { DshHeadersEditor } = load("src/renderer/src/config/DshHeadersEditor.tsx");
	const render = () =>
		host.render(() =>
			DshHeadersEditor({
				value,
				writable,
				onChange: (next) => {
					value = next;
				},
			}),
		);
	return {
		render,
		get value() {
			return value;
		},
		replace: (next) => {
			value = next;
			render();
		},
		close: host.unmount,
	};
}

/** React 元素树遍历，不执行叶子组件或依赖 DOM。 */
function findAll(node, predicate) {
	if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
	if (!node || typeof node !== "object") return [];
	return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}
const names = (tree) => findAll(tree, (node) => node.type === "input" && node.props["aria-label"] === "config.dsh.headerNamePlaceholder");
const rows = (tree) => findAll(tree, (node) => node.type === "div" && Array.isArray(node.props.children) && node.props.children.some((child) => child?.type === "input"));

test("请求头改名后保持 React 行 key 与顺序，删除名称仍能继续输入", () => {
	const view = harness({ "X-One": "one", "X-Two": "two" });
	try {
		const original = view.render();
		const keys = rows(original).map((row) => row.key);
		names(original)[0].props.onChange({ target: { value: "X-Renamed" } });
		const renamed = view.render();
		assert.deepEqual(
			rows(renamed).map((row) => row.key),
			keys,
		);
		assert.deepEqual(
			names(renamed).map((input) => input.props.value),
			["X-Renamed", "X-Two"],
		);
		names(renamed)[0].props.onChange({ target: { value: "" } });
		assert.equal(names(view.render())[0].props.value, "");
		names(view.render())[0].props.onChange({ target: { value: "x-opencode-session" } });
		assert.equal(view.value["x-opencode-session"], "one");
	} finally {
		view.close();
	}
});

test("删除最后一个请求头后保持空表；外部刷新仍能带回新配置", () => {
	const view = harness({ "x-opencode-session": "manual" });
	try {
		findAll(view.render(), (node) => node.type === "button" && node.props["aria-label"] === "common.delete")[0].props.onClick();
		assert.equal(names(view.render()).length, 0);
		assert.equal(view.value, undefined);
		view.replace({ "X-Reloaded": "new" });
		assert.equal(names(view.render())[0].props.value, "X-Reloaded");
	} finally {
		view.close();
	}
});

test("只读页面的所有输入均禁用，旧 UA 可展示但不提供虚假的覆盖预设", () => {
	const view = harness({ "User-Agent": "legacy", "X-Other": "keep" }, false);
	try {
		const tree = view.render();
		const controls = findAll(tree, (node) => ["input", "button", "combobox"].includes(node.type));
		assert.ok(controls.length > 0);
		assert.ok(controls.every((node) => node.props.disabled === true));
		assert.equal(findAll(tree, (node) => node.type === "combobox").length, 0);
		assert.equal(names(tree)[0].props.value, "User-Agent");
	} finally {
		view.close();
	}
});
