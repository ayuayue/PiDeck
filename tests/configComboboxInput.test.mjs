import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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
