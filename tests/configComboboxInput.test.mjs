import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 运行时回归：设置页「默认供应商 / 默认模型」等 combobox 的触发器必须是文本框。
 *
 * 症状：整框空白——连灰色占位提示都没有。成因是 shadcn <Input> 被直接作为
 * Radix <PopoverTrigger asChild> 的子元素，Slot 会把 trigger 的 type="button"
 * 合到 input 上；按钮类型不渲染 placeholder，值为空时整个框看起来像坏掉了。
 *
 * 断言方式：直接加载生产模块做 SSR 渲染（真实走 Radix Slot 合并），
 * 不读源码字符串——去掉 type="text" 时本文件必然红。
 */
const require = createRequire(import.meta.url);
const React = require("react");
const { createElement } = React;
const { renderToStaticMarkup } = require("react-dom/server");

const { ConfigComboboxInput } = loadTsCommonJs("src/renderer/src/config/ConfigShared.tsx", {
	stubs: {
		react: React,
		"../i18n": { t: (key) => key },
		"../utils/clipboard": { writeClipboard: async () => {} },
		"./providerHeaders": { PROVIDER_API_OPTIONS: [], DSH_PROVIDER_API_OPTIONS: [], API_TYPE_LABELS: {}, getApiTypeDescription: () => "" },
		"lucide-react": new Proxy({}, { get: (_target, name) => () => createElement("span", { "data-icon": String(name) }) }),
	},
});

const render = (props) => renderToStaticMarkup(createElement(ConfigComboboxInput, { onChange: () => {}, ...props }));

test("触发器是 text input，带值显示值、空值显示 placeholder", () => {
	const withValue = render({ value: "magpie", options: [{ value: "magpie" }], placeholder: "选择或输入服务商" });
	assert.match(withValue, /<input type="text"/, "触发器必须是 text 类型，否则按钮类型不渲染 placeholder");
	assert.doesNotMatch(withValue, /type="button"/);
	assert.match(withValue, /value="magpie"/);

	const empty = render({ value: "", options: [], placeholder: "选择或输入服务商" });
	assert.match(empty, /<input type="text"/);
	assert.match(empty, /placeholder="选择或输入服务商"/, "空值必须显示占位提示，而不是一片空白");
});

test("保留 readonly 与展开下拉的键盘可达性", () => {
	const html = render({ value: "magpie", options: [{ value: "magpie" }] });
	assert.match(html, /readOnly=""/, "仍须 readonly：该控件只用于选择，不接受手输");
	assert.match(html, /aria-haspopup="dialog"/, "Radix trigger 的展开语义仍然挂在同一元素上");
});
