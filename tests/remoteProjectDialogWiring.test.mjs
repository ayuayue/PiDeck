import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { configModalSource } from "./helpers/configModalSources.mjs";

/**
 * 项目管理弹窗与配置页的接线契约（2026-11 远端项目管理）。
 *
 * 这一组防的是「又退回本机」这类静默回归：四个页签的失败形态都是稳定码，界面上看不出是
 * 目标绑错了还是主机拒绝了。断言分两层：
 * - 纯函数：resourceOnlyTarget 只从入口项目的 locator 派生目标；
 * - 源码接线：远端目标与 projectId 一路传到底（弹窗 → 编辑器 → 资源 facade），
 *   MCP 页在 SSH 上与本地共用同一套表单，只有 WSL 仍是文本编辑。
 */

const targetModel = loadTsCommonJs("src/renderer/src/config/piConfigTargetModel.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const modal = configModalSource;

test("资源管理器的目标只从入口项目派生：远端项目固定其主机，其它一律本机", () => {
	assert.deepEqual(plain(targetModel.resourceOnlyTarget(undefined)), { kind: "local" });
	assert.deepEqual(plain(targetModel.resourceOnlyTarget({ kind: "local", environment: "native", localPath: "/work/app" })), { kind: "local" });
	assert.deepEqual(plain(targetModel.resourceOnlyTarget({ kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app" })), { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111" });
});

test("项目管理弹窗把入口项目与 projectId 一起交给编辑器，不再固定本机", () => {
	// 入口项目由右键菜单传入；就是它决定目标环境（不再继承「上次的 Pi 环境」）。
	assert.match(modal, /useState<PiConfigTarget>\(\(\) => \(resourceOnly \? resourceOnlyTarget\(projects\[0\]\?\.locator\) : loadLastConfigTarget\(\)\)\)/);
	// 项目作用域只对资源管理器成立：全局页没有项目，也就不传 projectId。
	assert.match(modal, /useConfigEditorApi\(configTarget, window\.piDesktop, resourceOnly \? projectId : undefined\)/);
	// 项目弹窗仍走 ConfigPane（同一套页面），且只传入口项目本身。
	const modalShell = readFileSync("src/renderer/src/components/app/ProjectResourcesModal.tsx", "utf8");
	assert.match(modalShell, /<ConfigPane resourceOnly projectId=\{props\.project\.id\}[\s\S]{0,200}?projects=\{\[props\.project\]\}/);
});

test("projectId 一路传到远端资源 facade", () => {
	const hook = readFileSync("src/renderer/src/config/useConfigEditorApi.ts", "utf8");
	assert.match(hook, /useConfigEditorApi\(target: PiConfigTarget, api: PiDesktopApi, projectId\?: string\)/);
	assert.match(hook, /createRemoteConfigEditorApi\(api, hostId, ensureConnected, projectId\)/);
	const editor = readFileSync("src/renderer/src/config/remoteConfigEditorApi.ts", "utf8");
	assert.match(editor, /createRemoteResourceEditorApi\(api, hostId, connected, projectId\)/);
	// 资源页不再直接把 projectResources 转给本机实现：facade 必须有远端实现。
	const resourceFacade = readFileSync("src/renderer/src/config/remoteResourceEditorApi.ts", "utf8");
	assert.match(resourceFacade, /projectResources: \{/);
	assert.match(resourceFacade, /list: projectList/);
	// 项目作用域请求带 scope + projectId；主机层请求不带，避免把项目请求降级成主机请求。
	assert.match(resourceFacade, /input\.scope === "project" \? \{ \.\.\.input, projectId \} : input/);
});

test("MCP 页在 SSH 上与本地共用同一套表单，只有 WSL 仍是文本编辑", () => {
	const mcpTab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	// 页面从编辑器 facade 取 API：本机 / WSL / SSH 主机 / 远端项目都走同一个作用域。
	assert.match(mcpTab, /const \{ api \} = useConfigEditor\(\)/);
	assert.doesNotMatch(mcpTab, /window\.piDesktop\.config/);
	// 同一条规则也管第三方 MCP 扩展探测：不能再问本机的扩展列表。
	assert.match(mcpTab, /await api\.extensions\.list\(\)/);
	const configMcp = readFileSync("src/renderer/src/config/configModal/ConfigMcpTab.tsx", "utf8");
	assert.match(configMcp, /\{wslTargetHost \? \(/);
	assert.doesNotMatch(configMcp, /remoteTargetHostId/, "SSH 不再走文本编辑器分支");
	assert.match(configMcp, /<McpTab ref=\{mcpTabRef\}/);
});

test("保存分发：MCP 页只有 WSL 走文本保存，其余走 McpTab 自己的保存", () => {
	const save = readFileSync("src/renderer/src/config/configModal/useConfigSaveOrchestration.ts", "utf8");
	assert.match(save, /case "config:mcp": \{[\s\S]{0,300}?if \(configTarget\.kind === "wsl"\) return handleSaveWslMcp\(\);/);
	assert.match(save, /await mcpTabRef\.current\?\.save\(\)/);
	const loader = readFileSync("src/renderer/src/config/configModal/useConfigLoader.ts", "utf8");
	assert.match(loader, /target === "mcp"\) \{[\s\S]{0,300}?configTargetOption\?\.target\.kind === "wsl"/);
});
