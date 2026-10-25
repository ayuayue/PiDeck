import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
const gateway = readFileSync("src/main/agents/CompositeAgentGateway.ts", "utf8");

/**
 * 2027-03 审计发现 A/B（ACP 激活窗口静默 + 重下发对多后端失效）：
 *
 * A：emitSessionRuntimeEvent 依赖 binding 才转发，而 coordinator.activate 要等
 * create+waitUntilReady 完成才 bind()——ACP 握手 ~8.5s 期间渲染层收不到任何状态，
 * 恢复条停在静态提示、加载动画数据源（status=starting）永远不出现。
 * B：emitReplacementState 只查 pi AgentManager，ACP/DSH 的 tab 查不到直接 return，
 * 换绑/重启后的「状态+消息窗口重下发」对非 pi 后端全部静默失效。
 *
 * 本契约只锚定接线形态（行为回归由 runtimeAtoms/compositeAgentGateway 测试覆盖）。
 */

test("activateRuntime 入口：激活前发合成 starting（hasLiveRuntime 守卫），成功后重下发状态+窗口", () => {
	assert.match(sessionIpc, /if \(!sessionRuntimeCoordinator\.hasLiveRuntime\(sessionId\)\)\s*emitSessionActivating\?\.\(sessionId\);/, "激活窗口的合成 starting 必须以 hasLiveRuntime 守卫（已有活 runtime 不得闪状态）");
	assert.match(sessionIpc, /if \(result\.ok\) \{\s*[^}]*emitReplacementState\(result\.value, true\);/, "激活成功必须立即补发完整 tab 状态 + 消息窗口（deckSessionId/backend 让侧栏配对即时生效）");
	assert.match(sessionIpc, /else if \(!sessionRuntimeCoordinator\.hasLiveRuntime\(sessionId\)\) \{[\s\S]*?emitSessionActivationFailed\?\.\(sessionId\);/, "激活失败且无活 runtime 时必须补发合成 error，否则加载态永挂（失败终态同样因无绑定被丢弃）");
});

test("emitSessionActivating：session 级合成 envelope（agents:state + starting + 当前代数）", () => {
	assert.match(mainIndex, /function emitSessionActivating\(sessionId: string\): void \{[\s\S]*?sourceChannel: ipcChannels\.agentsState,[\s\S]*?payload: \{ status: "starting" \},[\s\S]*?\}/, "合成事件必须走 agents:state 通道带 starting 载荷（渲染层 agents:state 分支才能吃到）");
	assert.match(mainIndex, /runtimeGeneration: sessionRuntimeCoordinator\.currentRuntimeGeneration\(sessionId\),/, "代数必须取 bind 前当前值（压住旧 runtime 迟到事件）");
	assert.match(coordinator, /currentRuntimeGeneration\(sessionId: string\): number \{\s*return this\.generationBySession\.get\(sessionId\) \?\? 0;/, "coordinator 必须公开 bind 前代数读取");
});

test("emitReplacementState：多后端 tab 查找（composite 优先）+ 窗口路由（无窗口实现回退全量）", () => {
	// 2027-03 重构：内联查找提成 findRuntimeTab（activateRuntime / findRuntimeAgent 共用），
	// 不变量不变——必须先问 composite（ACP/DSH 不在 pi manager 列表）。
	assert.match(mainIndex, /function findRuntimeTab\(agentId: string\): AgentTab \| undefined \{\s*return compositeAgentGateway\?\.list\(\)\.find\(\(([a-z]+)\) => \1\.id === agentId\) \?\? agentManager\.list\(\)\.find\(/, "tab 查找必须先走 composite（ACP/DSH 不在 pi manager 列表）");
	assert.match(mainIndex, /function emitReplacementState\([\s\S]*?const tab = findRuntimeTab\(binding\.agentId\);/, "emitReplacementState 必须走统一的多后端 tab 查找");
	assert.match(mainIndex, /compositeAgentGateway\?\.getMessageWindow\(binding\.agentId\) \?\? agentManager\.getMessageWindow\(binding\.agentId\)/, "消息窗口必须按后端路由");
	assert.match(gateway, /getMessageWindow\(agentId: string\)/, "composite 网关必须提供 getMessageWindow 路由");
	assert.match(gateway, /if \(typeof ownerWindow === "function"\) return ownerWindow\.call\(gateway, agentId\);/, "有窗口实现（pi）透传窗口协议；无实现回退 getMessages 全量");
});
