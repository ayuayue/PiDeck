import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
const form = readFileSync("src/renderer/src/config/ProviderConnectionForm.tsx", "utf8");
const shared = readFileSync("src/renderer/src/config/ConfigShared.tsx", "utf8");

/**
 * 供应商表单「兼容性」组的版式契约。
 *
 * 背景（回归来源）：`352d20fb` 把常驻的兼容性说明小字收进 tooltip 后，
 * `.config-compat-item` 上给第二行留位的 `flex-direction: column` 变成了废规则。
 * 前三项只有一个复选框行，看不出问题；第四项「严格工具采样」是「标签 + 三态下拉」，
 * 于是被拆成上下两行，整个兼容性组变成两行高、下拉与复选框错位。
 * 这里锁住「四项都必须是横向一行」的版式，避免再次被 column 拆开。
 */

test("config-compat-item 必须横向排列，三种子项才能在同一行对齐", () => {
	const rule = surfaces.match(/\.config-compat-item\s*\{([^}]*)\}/);
	assert.ok(rule, "surfaces.css 应保留 .config-compat-item 规则");
	assert.doesNotMatch(rule[1], /flex-direction\s*:\s*column/, ".config-compat-item 不能回到 flex-direction: column（会把「严格工具采样」的标签与下拉拆成两行）");
	assert.match(rule[1], /align-items\s*:\s*center/, "标签与下拉需要垂直居中对齐");
});

test("config-compat-group 允许换行，窄弹窗下不会撑破表单", () => {
	const rule = surfaces.match(/\.config-compat-group\s*\{([^}]*)\}/);
	assert.ok(rule, "surfaces.css 应保留 .config-compat-group 规则");
	assert.match(rule[1], /flex-wrap\s*:\s*wrap/, "窄弹窗（<640px）下四项必须能整体换行而不是溢出");
});

test("严格工具采样是内联「标签 + 下拉」，标签不再是复选框标签", () => {
	const item = form.match(/t\("config\.strictToolSampling"\)\}([\s\S]{0,900}?)onChange=\{\(value\) =>/);
	assert.ok(item, "应能找到严格工具采样项（标签 → 下拉 → onChange 的结构）");
	// config-checkbox-label 带 cursor:pointer 且是 <label>，但本项内没有可切换的控件
	assert.doesNotMatch(item[1], /config-checkbox-label/, "严格工具采样项的标签不应复用复选框标签样式（点击无响应却显示手型光标）");
	assert.match(item[1], /<ConfigSelect\s+triggerClassName="w-auto/, "内联下拉必须收窄（不写死 px，按内容定宽）");
});

test("ConfigSelect 的 triggerClassName 确实作用到 SelectTrigger（否则 w-auto 是死代码）", () => {
	assert.match(shared, /triggerClassName\?:\s*string/, "ConfigSelect 应暴露可选的 triggerClassName");
	assert.match(shared, /<SelectTrigger\s+className=\{cn\(\s*"config-select-trigger w-full"\s*,\s*props\.triggerClassName\s*,?\s*\)\}/, "triggerClassName 必须经 cn 合进 SelectTrigger（cn 走 twMerge，w-auto 才能压过默认 w-full）");
});
