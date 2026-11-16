import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// #537：供应商页的 API Key 空框不等于「没配」——models.json 的 apiKey 只是覆盖层，
// pi 会从 auth.json 解析凭据。留空时必须说清「已在 auth.json」，否则用户会以为 Key 丢了
// 而重填一遍，把同一个明文又存进 models.json。
const require = createRequire(import.meta.url);
const React = require("react");
const { createElement } = React;
const { renderToStaticMarkup } = require("react-dom/server");

const { ProviderEndpointFields } = loadTsCommonJs("src/renderer/src/config/ProviderEndpointFields.tsx", {
	stubs: {
		react: React,
		"../i18n": {
			t: (key, params) =>
				params
					? `${key}(${Object.entries(params)
							.map(([name, value]) => `${name}=${value}`)
							.join(",")})`
					: key,
		},
	},
});

const render = (props) => renderToStaticMarkup(createElement(ProviderEndpointFields, { baseUrl: "https://api.example.com/v1", api: "openai-completions", apiKey: "", onChangeBaseUrl: () => {}, onChangeApi: () => {}, onChangeApiKey: () => {}, ...props }));

test("Key 空着但 auth.json 里有时，说明来源而不是「请填写」", () => {
	const html = render({ apiKey: "", authKeyHint: { length: 51, tail: "abcd" } });
	assert.match(html, /config\.field\.apiKeyFromAuth\(tail=abcd,length=51\)/, "必须带上掩码摘要（末四位 + 长度），用户才能核对自己以为丢的那把 key");
	assert.doesNotMatch(html, /config\.field\.apiKeyEmptyHint/, "两条提示互斥：同时出现会把「已在 auth.json」这个原因埋掉");
});

test("没有 auth.json 凭据时保持原来的空 Key 提示", () => {
	const html = render({ apiKey: "", authKeyHint: null });
	assert.match(html, /config\.field\.apiKeyEmptyHint/);
	assert.doesNotMatch(html, /config\.field\.apiKeyFromAuth/);
});

test("填了 Key 后两条提示都不出现（无论 auth.json 里有没有）", () => {
	for (const authKeyHint of [null, { length: 51, tail: "abcd" }]) {
		const html = render({ apiKey: "sk-filled", authKeyHint });
		assert.doesNotMatch(html, /config\.field\.apiKeyEmptyHint/);
		assert.doesNotMatch(html, /config\.field\.apiKeyFromAuth/);
	}
});

test("DSH 后端不渲染 auth.json 提示（凭据语义不同）", () => {
	const html = render({ apiKey: "", authKeyHint: { length: 51, tail: "abcd" }, backend: "dsh" });
	assert.doesNotMatch(html, /config\.field\.apiKeyFromAuth/);
});
