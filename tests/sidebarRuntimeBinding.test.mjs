import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * RPC 日志右键菜单：菜单项统一「打开RPC日志」，点击后只给非阻塞 toast；
 * 运行中 agent 的菜单项必须可选中（修复 key 错配：AgentTab.sessionId 是 pi
 * 自身会话 id，不能直接查 runtimeBySessionId（key = 会话记录 id），必须按
 * agentId 反查 live runtime）。
 */

const sidebarContent = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const sidebarComponents = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");

test("RPC 日志菜单项两态：未开启显示「打开RPC日志」，已开启显示「关闭RPC日志」", () => {
	assert.match(sidebarComponents, /t\("menu\.rpcLogging"\)/);
	assert.match(sidebarComponents, /isRpcLogging \? t\("menu\.rpcLoggingOn"\) : t\("menu\.rpcLogging"\)/);
	// 旧的手写勾选前缀（✓ 文案拼接）已删除
	assert.doesNotMatch(sidebarComponents, /`✓ \$\{t\("menu\.rpcLoggingOn"\)\}`/);
});

test("运行中 agent 的 RPC 日志能力判断按 agentId 反查 runtime，不直接拿 sessionId 查", () => {
	// helper 存在
	assert.match(controller, /export function getBoundSidebarRuntimeAgentByAgentId\(/);
	// 菜单判定走 agentId 反查（AgentTab.sessionId 是 pi 自身会话 id，不是
	// runtimeBySessionId 的 key——会话记录 id 才是）
	assert.match(sidebarContent, /getBoundSidebarRuntimeAgentByAgentId\(controller\.catalog, menuAgent\.id\)/);
	// 不允许退回按 menuAgent.sessionId 直查（旧 bug 写法）
	assert.doesNotMatch(sidebarContent, /getBoundSidebarRuntimeAgent\(controller\.catalog, menuAgent\.sessionId\)/);
});

test("开启记录成功后自动打开日志面板（开记录的意图就是「现在要看」）", () => {
	// 两个右键入口（agent 菜单 / 会话菜单）的成功分支统一走同一条 toast 文案
	assert.equal(sidebarContent.match(/showNotice\(enabled \? t\("rpc\.loggingEnabled"\) : t\("rpc\.loggingEnableFailed"\), 2500\)/g)?.length, 2);
	// 开启成功自动打开日志查看器：agent 菜单与会话菜单两个入口都要自动打开
	assert.equal(sidebarContent.match(/if \(enabled\) controller\.openRpcLogs\(/g)?.length, 2);
	// 关闭记录分支不得自动开面板（关就是关）
	assert.doesNotMatch(sidebarContent, /setLogging\([^)]*, false\)[\s\S]{0,220}openRpcLogs\(/);
});

test("已开启时菜单项点击为关闭记录，日志面板提供「停止记录」按钮", () => {
	// 关闭分支：setLogging(id, false) + 结果 toast
	assert.match(sidebarContent, /setLogging\(menuAgent\.id, false\)/);
	assert.match(sidebarContent, /setLogging\(menuSessionRuntimeAgent\.id, false\)/);
	// 日志面板（右侧抽屉 rpcLog）在记录开启时提供停止按钮
	const viewer = readFileSync("src/renderer/src/components/workspace/RpcLogPanel.tsx", "utf8");
	assert.match(viewer, /handleDisableLogging/);
	assert.match(viewer, /setLogging\(agentId, false\)/);
	assert.match(viewer, /t\("rpc\.disableLogging"\)/);
});

test("阻塞式「已打开」确认弹框已移除（AlertDialog 挡操作，菜单已有「查看日志」入口）", () => {
	const parts = readFileSync("src/renderer/src/components/sidebar/SidebarParts.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	// 组件、出口、调用点与状态全部消失
	assert.doesNotMatch(parts, /RpcLogOpenedDialog/);
	assert.doesNotMatch(sidebarComponents, /RpcLogOpenedDialog/);
	assert.doesNotMatch(sidebarContent, /RpcLogOpenedDialog|rpcLogOpenedAgentId/);
	// 三份文案同步删除，不留孤儿 key（TranslationKey 由 zh-CN 推导，en-US 必须同步）
	for (const dict of [zh, en]) {
		assert.doesNotMatch(dict, /rpc\.logOpenedTitle|rpc\.logOpenedDescription|rpc\.logViewNow/);
	}
});

test("右键查记录状态失败不阻断菜单弹出（agent 刚退出时主进程会拒绝）", () => {
	// 回归（2026-09 UI 冒烟）：openMenu 里裸 await getRpcLogging，reject 时
	// ① 冒成未处理异常 toast ② 跳过 setMenu 导致右键菜单弹不出来。
	assert.match(controller, /await options\.getRpcLogging\(target\.agentId\)\.catch\(\(\) => false\)/);
	assert.doesNotMatch(controller, /await options\.getRpcLogging\(target\.agentId\);\s*\n\s*if \(!requestGateRef\.current\.isCurrentMenu\(request\)\) return;/);
});
