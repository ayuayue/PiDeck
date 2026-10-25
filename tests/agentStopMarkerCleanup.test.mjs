/**
 * AgentManager userInitiatedStop 标记泄漏回归：
 *
 * 旧缺陷：stop() 先 userInitiatedStop.add → agents.delete → process.stop()，迟到 exit
 * 在监听器的 stale guard（agents.get(agentId)?.process !== piProcess）或握手分支提前
 * return，永远走不到 handleCreateProcessExit 里的标记清理——每次 stop 泄漏一个 entry；
 * agentId 复用（重启同一会话）时会把意外退出误判为用户主动停止，跳过自动重连。
 *
 * 修复契约：exit 监听器的两个早退分支都必须补删标记；handleCreateProcessExit 的
 * 消费路径（标记命中 → 清理 + 标 closed）行为保持不变。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-live",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	};
	manager.agents.set("agent-live", runtime);
	return manager;
}

test("行为：handleCreateProcessExit 命中标记 → 清理且标 closed（消费路径不回归）", () => {
	const manager = createManager();
	manager.userInitiatedStop.add("agent-live");
	const tab = manager.agents.get("agent-live").tab;
	manager.handleCreateProcessExit("agent-live", tab, { code: 0, signal: null });
	assert.equal(manager.userInitiatedStop.has("agent-live"), false, "标记必须被清理");
	assert.equal(tab.status, "closed", "用户主动停止的会话标 closed");
});

test("行为：非标记早退分支（compacting 中）不误碰标记集", () => {
	const manager = createManager();
	const tab = manager.agents.get("agent-live").tab;
	manager.compactingAgents.add("agent-live");
	manager.handleCreateProcessExit("agent-live", tab, { code: 0, signal: null });
	assert.equal(manager.userInitiatedStop.size, 0);
	assert.equal(tab.status, "closed");
});

test("源码契约：exit 监听器两个早退分支都在 return 前补删标记", () => {
	const src = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// 从 exit 监听器注册处截到 options.onExit(payload)（含），这段前缀里的补删都发生在
	// 早退分支内；handleCreateProcessExit 自己的清理在 onExit 之后，不会被计入。
	const block = src.match(/piProcess\.on\("exit"[\s\S]*?options\.onExit\(payload\);/)?.[0] ?? "";
	assert.ok(block, "exit 监听器存在");
	const deletes = block.match(/this\.userInitiatedStop\.delete\(agentId\)/g) ?? [];
	assert.equal(deletes.length, 2, "握手分支 + stale guard 分支各补删一次");
	assert.match(block, /if \(this\.startupHandshakeAgents\.has\(agentId\)\)\s*\{[\s\S]*?this\.userInitiatedStop\.delete\(agentId\);\s*return;/);
	assert.match(block, /if \(this\.agents\.get\(agentId\)\?\.process !== piProcess\)\s*\{[\s\S]*?this\.userInitiatedStop\.delete\(agentId\);\s*return;/);
});
