/**
 * MCP 页第三方接管识别测试（计划 M5）。
 * 背景变化：pi 0.99 起 MCP 是内置能力；pi-mcp-adapter 等接管型扩展会整体顶掉内置 MCP。
 * PiDeck 从「引导安装 adapter」反转为「识别接管型扩展并给出精确卸载命令」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("旧 adapter 安装引导已整体移除", () => {
	const tab = read("src/renderer/src/config/McpTab.tsx");
	const views = read("src/renderer/src/config/McpResourceViews.tsx");
	// 不再有一键安装（pi install）引导；识别规则本身按包名匹配是允许的
	assert.doesNotMatch(views, /extensions\.install\(|pi install /);
	assert.doesNotMatch(views, /ADAPTER_INSTALL_SOURCE/);
	assert.doesNotMatch(views, /McpAdapterGuide/);
	assert.doesNotMatch(tab, /McpAdapterGuide/);
	assert.doesNotMatch(tab, /adapterInstalled/);
	// 内置提示与可选安装入口的旧 i18n 键不再被引用
	assert.doesNotMatch(tab, /config\.mcp\.builtInNotice/);
	assert.doesNotMatch(tab, /config\.mcp\.optionalAdapter/);
});

test("识别规则窄匹配：只认已知接管型包名，且跳过 PiDeck 内置扩展（shared 单一来源）", () => {
	const shared = read("src/shared/mcpThirdParty.ts");
	const views = read("src/renderer/src/config/McpResourceViews.tsx");
	assert.match(shared, /MCP_PROXY_EXTENSION_RULES.*=\s*\[/s);
	// 规则按具体包名，禁止宽泛 /mcp/ 正则误伤
	assert.match(shared, /\{ id: "pi-mcp-adapter", matchSource: \/pi-mcp-adapter\/i \}/);
	assert.match(shared, /if \(ext\.builtIn\) continue;/);
	// 渲染层 re-export shared（单一来源，不复制实现）
	assert.match(views, /export \{ MCP_PROXY_EXTENSION_RULES, detectThirdPartyMcpExtensions \} from/);
});

test("卸载命令按来源与作用域生成：npm 全局无 -l、项目补 -l、本地文件给空命令", () => {
	const shared = read("src/shared/mcpThirdParty.ts");
	// scope === "project" 时补 -l
	assert.match(shared, /ext\.scope === "project" \? " -l" : ""/);
	// 本地文件扩展不生成 pi remove 命令
	assert.match(shared, /isLocalFile \? "" : `pi remove \$\{source\}/);
});

test("McpTab 横幅渲染三态：命中启用 / 已停用 / 探测失败降级", () => {
	const tab = read("src/renderer/src/config/McpTab.tsx");
	assert.match(tab, /thirdPartyMcp !== null && thirdPartyMcp\.length > 0/);
	assert.match(tab, /config\.mcp\.thirdParty\.title/);
	assert.match(tab, /config\.mcp\.thirdParty\.titleDisabled/);
	assert.match(tab, /config\.mcp\.thirdParty\.detectFailed/);
	// 卸载命令可复制
	assert.match(tab, /clipboard\.writeText\(item\.uninstallCommand\)/);
});

test("i18n 双语文案齐全（thirdParty 系列）", () => {
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const key of ["config.mcp.thirdParty.title", "config.mcp.thirdParty.titleDisabled", "config.mcp.thirdParty.desc", "config.mcp.thirdParty.descDisabled", "config.mcp.thirdParty.localFileHint", "config.mcp.thirdParty.copyCommand", "config.mcp.thirdParty.detectFailed"]) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
});
