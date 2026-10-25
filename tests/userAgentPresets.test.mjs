/**
 * Provider User-Agent 预设与校验单测。
 *
 * 背景（用户报告）：
 *  1. 部分第三方网关按 UA 做白名单/风控（如 agentrouter 需 claude-cli 系 UA 才肯给模型列表），
 *     所以内置预设必须覆盖「官方 CLI / 官方 SDK / 通用 HTTP 客户端 + 浏览器」三类，
 *     并且要能过 `claude-cli/*`、`claude-code/*`、`Kilo-Code/*` 这类白名单前缀。
 *  2. 旧 UI 把 UA 做成「下拉 + 另一个输入框」两个控件，两者会互相覆盖；现在合并为
 *     单个可输入下拉，因此需要断言选项列表里**没有**旧的自定义哨兵项，且首项是「不写入」。
 *  3. UA 含控制字符会被静默丢弃（表现为「配了却不生效」），必须能被 isValidUserAgent 拦下。
 *
 * 纯函数模块（只依赖 i18n 的 t）。i18n 目录是 barrel（目录导入在 node ESM 下不合法），
 * 所以用 createTsSandbox 按源文件目录解析相对 import。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const { USER_AGENT_PRESETS, USER_AGENT_UNSET, getUserAgentOptions, isValidUserAgent, resolveUserAgentSelection } = load("src/renderer/src/config/userAgentPresets.ts");

test("预设清单覆盖官方 CLI 白名单前缀（claude-cli / claude-code / Kilo-Code）", () => {
	const values = USER_AGENT_PRESETS.map((preset) => preset.value);
	// 这三类是实测能过 claude-cli 系 UA 白名单的取值，缺任何一个都会让用户又回到
	// 「手写 UA」的麻烦里，所以按前缀断言而不是按完整字符串断言。
	assert.ok(
		values.some((value) => value.startsWith("claude-cli/")),
		"缺少 claude-cli 预设",
	);
	assert.ok(
		values.some((value) => value.startsWith("claude-code/")),
		"缺少 claude-code 预设",
	);
	assert.ok(
		values.some((value) => value.startsWith("Kilo-Code/")),
		"缺少 Kilo-Code 预设",
	);
});

test("预设清单覆盖官方 SDK 与通用 HTTP 客户端两类", () => {
	const values = USER_AGENT_PRESETS.map((preset) => preset.value);
	// SDK 组：网关按 SDK 特征放行时用
	assert.ok(values.includes("OpenAI/JS 6.26.0"));
	assert.ok(values.includes("anthropic-sdk-typescript/0.27.3"));
	// HTTP 客户端组：网关只看「是不是浏览器/脚本」时用
	assert.ok(values.some((value) => value.startsWith("python-requests/")));
	assert.ok(values.some((value) => value.startsWith("axios/")));
	assert.ok(values.some((value) => value.startsWith("Mozilla/5.0")));
});

test("预设值唯一（重复项会让下拉出现两条同值条目、选中态错乱）", () => {
	const values = USER_AGENT_PRESETS.map((preset) => preset.value);
	assert.equal(new Set(values).size, values.length);
});

test("getUserAgentOptions: 首项为「不写入」且值是空串", () => {
	const options = getUserAgentOptions();
	assert.equal(options[0].value, USER_AGENT_UNSET);
	assert.equal(USER_AGENT_UNSET, "");
});

test("getUserAgentOptions: 不再暴露旧的 __custom__ 哨兵项（单控件改造）", () => {
	const options = getUserAgentOptions();
	// 旧实现用 __custom__ 区分「下拉选预设」与「手写值」，两个控件并存；
	// 合并成单控件后手写值本身就是合法选中值，哨兵项必须消失。
	assert.equal(
		options.some((option) => option.value === "__custom__"),
		false,
	);
});

test("getUserAgentOptions: 覆盖全部预设且 label 非空", () => {
	const options = getUserAgentOptions();
	// 首项是「不写入」，其余应与预设一一对应
	assert.equal(options.length, USER_AGENT_PRESETS.length + 1);
	for (const option of options) {
		assert.ok(option.label.length > 0, `选项 ${option.value} 缺少展示文本`);
	}
});

test("getUserAgentOptions: 浏览器预设展示为人话（带 labelKey）", () => {
	const options = getUserAgentOptions();
	const browser = options.find((option) => option.value.startsWith("Mozilla/5.0"));
	assert.ok(browser, "缺少浏览器 UA 预设");
	// 不能直接把完整 Chrome UA 甩给用户看，应该有可读标签
	assert.equal(browser.label.includes("Chrome/131"), false);
});

test("resolveUserAgentSelection: trim 后返回，空值保持空", () => {
	assert.equal(resolveUserAgentSelection("  claude-cli/2.1.161  "), "claude-cli/2.1.161");
	assert.equal(resolveUserAgentSelection("   "), "");
	// 手写值原样保留（不再映射到哨兵项，否则用户手写的 UA 会在 UI 上被吞掉）
	assert.equal(resolveUserAgentSelection("My-Custom-UA/1.0"), "My-Custom-UA/1.0");
});

test("isValidUserAgent: 换行/回车等控制字符被拒绝（请求头注入防护）", () => {
	// 这些值写入 headers 会被静默忽略 → 用户以为配了却无效，必须显式判非法。
	assert.equal(isValidUserAgent("claude-cli/2.1.161 (external, cli)"), true);
	assert.equal(isValidUserAgent("evil\r\nX-Injected: 1"), false);
	assert.equal(isValidUserAgent("evil\nUA"), false);
	assert.equal(isValidUserAgent("evil\0UA"), false);
	assert.equal(isValidUserAgent("tab\there"), false);
});
