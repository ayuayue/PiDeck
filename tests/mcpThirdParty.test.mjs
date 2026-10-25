/**
 * 第三方接管型 MCP 扩展识别纯函数测试（shared/mcpThirdParty，M5/M5b 单一来源）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { detectThirdPartyMcpExtensions, MCP_PROXY_EXTENSION_RULES } = loadTsCommonJs("src/shared/mcpThirdParty.ts");

test("命中 npm 安装的 pi-mcp-adapter 并生成全局卸载命令", () => {
	const hits = detectThirdPartyMcpExtensions([{ id: "user:npm:pi-mcp-adapter", source: "npm:pi-mcp-adapter", scope: "user", enabled: true }]);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].source, "npm:pi-mcp-adapter");
	assert.equal(hits[0].uninstallCommand, "pi remove npm:pi-mcp-adapter");
	assert.equal(hits[0].enabled, true);
	assert.equal(hits[0].isLocalFile, false);
});

test("项目作用域补 -l；未启用条目保留但标记 enabled=false", () => {
	const hits = detectThirdPartyMcpExtensions([{ source: "npm:pi-mcp-adapter", scope: "project", enabled: false }]);
	assert.equal(hits[0].uninstallCommand, "pi remove npm:pi-mcp-adapter -l");
	assert.equal(hits[0].enabled, false);
});

test("本地文件扩展不生成 pi remove（走扩展页删除）", () => {
	const hits = detectThirdPartyMcpExtensions([{ source: "pi-mcp-adapter.ts", scope: "user", enabled: true }]);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].isLocalFile, true);
	assert.equal(hits[0].uninstallCommand, "");
});

test("空 source 与缺字段条目安全", () => {
	assert.equal(detectThirdPartyMcpExtensions([{ source: "" }]).length, 0);
	assert.equal(detectThirdPartyMcpExtensions([{}]).length, 0);
});

test("PiDeck 内置扩展与普通扩展不误伤", () => {
	const hits = detectThirdPartyMcpExtensions([
		{ source: "pi-deck-todo.ts", builtIn: true, enabled: true },
		{ source: "npm:context-mode", scope: "user", enabled: true },
		{ source: "npm:mcp-anything-else", scope: "user", enabled: true },
	]);
	assert.equal(hits.length, 0);
});

test("规则集是窄匹配白名单（当前仅 pi-mcp-adapter）", () => {
	assert.equal(MCP_PROXY_EXTENSION_RULES.length, 1);
	assert.equal(MCP_PROXY_EXTENSION_RULES[0].id, "pi-mcp-adapter");
});

test("空 source / 空列表安全", () => {
	assert.equal(detectThirdPartyMcpExtensions([]).length, 0);
	assert.equal(detectThirdPartyMcpExtensions([{ source: "" }]).length, 0);
});

test("id 精确匹配可命中 source 不含包名的条目；file: 源仍是可卸载的 package source", () => {
	const hits = detectThirdPartyMcpExtensions([{ id: "pi-mcp-adapter", source: "file:C:/ext/pi-mcp-adapter", scope: "user", enabled: true }]);
	assert.equal(hits.length, 1);
	// file: 带协议前缀 → pi remove 可处理；真正无前缀的本地 .ts 才走扩展页删除
	assert.equal(hits[0].isLocalFile, false);
	assert.equal(hits[0].uninstallCommand, "pi remove file:C:/ext/pi-mcp-adapter");
});
