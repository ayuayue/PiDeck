import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("third-party takeover notice uses runtime /mcp command source when available", () => {
	const agentManager = read("src/main/pi/AgentManager.ts");
	// 运行时事实：get_commands 的 sourceInfo.path 区分 builtin:mcp 与第三方来源
	assert.match(agentManager, /resolveMcpCommandOwner/);
	assert.match(agentManager, /listRegisteredCommands/);
	assert.match(agentManager, /sourceInfo/);
	assert.match(agentManager, /builtin:mcp/);
	// 内置来源时不发“被接管”断言
	assert.match(agentManager, /owner\.builtin\) return/);
	// 只有运行时确认的第三方来源才指名
	assert.match(agentManager, /confirmedSource/);
});

test("third-party takeover notice is delivered even after the first run has started", () => {
	const agentManager = read("src/main/pi/AgentManager.ts");
	// 异步检测可能晚于首个 agent_start：此时直接落时间线，不能永远留在 pending
	const methodStart = agentManager.indexOf("notifyMcpThirdPartyTakeover");
	const methodStart2 = agentManager.indexOf("private async notifyMcpThirdPartyTakeover");
	const method = agentManager.slice(methodStart2, agentManager.indexOf("toSessionHostPath", methodStart2));
	// Wave 4 后暂存/落盘判定迁入 StartupDiagnosticsQueue.deliver；通知侧只应调 deliver。
	assert.match(method, /this\.startupDiagnostics\.deliver\(agentId,/);
});

test("third-party takeover notice carries interpolation params and a working action", () => {
	const agentManager = read("src/main/pi/AgentManager.ts");
	const bridge = read("src/renderer/src/hooks/useSessionRuntimeBridge.ts");
	// i18n 参数随 toast 下发（renderer t() 支持 {source}/{command}）
	assert.match(agentManager, /i18nParams: \{ source: hit\.source/);
	assert.match(agentManager, /action: "openMcpSettings"/);
	// 渲染层解析成真实导航：配置管理 → MCP 页；不再发明 pideck:// 之类路由
	assert.match(bridge, /openMcpSettings/);
	assert.match(bridge, /pane: "config"/);
	assert.match(bridge, /configTab: "mcp"/);
	assert.doesNotMatch(bridge, /pideck:\/\//);
});

test("MCP page 'go to extensions' navigates within the same scope instead of a fake route", () => {
	const tab = read("src/renderer/src/config/McpTab.tsx");
	const modal = read("src/renderer/src/ConfigModal.tsx");
	assert.match(tab, /onGoToExtensions/);
	assert.match(tab, /config\.mcp\.thirdParty\.goToExtensions/);
	assert.doesNotMatch(tab, /pideck:\/\//);
	// 父层回调：同区导航到扩展 section（全局与项目两个入口都接）
	assert.match(modal, /onGoToExtensions=\{\(\) => \{\n\s*\/\/ 同区导航：扩展页与 MCP 页都属于配置区\/项目资源区，保留当前作用域。\n\s*setSection\("extensions"\);/);
	assert.match(modal, /onGoToExtensions=\{\(\) => setSection\("extensions"\)\}/);
});

test("third-party banner copy does not claim every configured server is dead", () => {
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	const agentManager = read("src/main/pi/AgentManager.ts");
	// 断言仍可保留“推荐卸载”，但不能保证第三方不读同一份 mcp.json
	assert.match(zh, /config\.mcp\.thirdParty\.desc/);
	assert.doesNotMatch(agentManager, /一定不会工作/);
	assert.doesNotMatch(en, /will never work/);
});

test("legacy disabled field is reported but no longer treated as authoritative", () => {
	const views = read("src/renderer/src/config/McpResourceViews.tsx");
	const tab = read("src/renderer/src/config/McpTab.tsx");
	assert.match(views, /hasLegacyDisabledField/);
	assert.match(views, /return definition\.enabled === false;/);
	// 写入路径不产生 disabled
	assert.doesNotMatch(tab, /disabled: true/);
});
