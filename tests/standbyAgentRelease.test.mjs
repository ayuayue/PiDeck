/**
 * standby 预热进程回收（2026-10 用户反馈）：
 * 「新建会话 → 切到生图/生视频后端」时，之前为本项目预热出来的 pi 进程服务不了这个会话，
 * 不能只靠 10min TTL 自然回收。两处收口：
 * 1. AgentManager.releaseStandbyAgent(projectId)：只丢项目匹配的池条目并停进程（池是单槽位，
 *    同项目另一个新草稿仍可能认领它，不能无条件 clear）；
 * 2. sessions:catalog:update 在草稿会话切到非 pi 后端时调用它——放在后端锁定判定之后，
 *    已锁定的会话先报错、不改状态也不回收进程。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const PROJECT = { id: "project-1", name: "Project", path: "C:/project" };

/** 极简 harness：只覆盖 releaseStandbyAgent 需要的方法面（池条目 + agents map 的可停进程）。 */
function createManager({ poolEntry = { projectId: "project-1", agentId: "agent-standby", idleMs: 0 } } = {}) {
	const calls = { clear: 0, stopped: [] };
	const manager = new AgentManager(
		(id) => (id === "project-1" ? PROJECT : undefined),
		() => null,
		{ get: () => ({ standbyRuntimeEnabled: true, rpcTimeout: 600_000 }) },
		{},
		undefined,
		{ info: () => undefined, warn: () => undefined },
	);
	manager.standbyPool = {
		status: () => poolEntry,
		clear: () => {
			calls.clear += 1;
			const agentId = poolEntry?.agentId ?? null;
			poolEntry = null;
			return agentId;
		},
	};
	manager.stop = async (agentId) => {
		calls.stopped.push(agentId);
	};
	return { manager, calls };
}

test("releaseStandbyAgent: 项目匹配才回收（丢条目 + 停进程）", async () => {
	const { manager, calls } = createManager();
	assert.equal(manager.releaseStandbyAgent("project-2"), false, "项目不符不得动别的项目的池条目");
	assert.equal(calls.clear, 0, "项目不符时不得 clear");
	assert.deepEqual(calls.stopped, []);
	assert.equal(manager.releaseStandbyAgent("project-1"), true);
	assert.equal(calls.clear, 1);
	await new Promise((resolve) => setTimeout(resolve, 0)); // stop 是 fire-and-forget
	assert.deepEqual(calls.stopped, ["agent-standby"], "回收必须停掉进程，否则条目没了进程还在");
});

test("releaseStandbyAgent: 池空时无事发生（不报错、不重复停）", () => {
	const { manager, calls } = createManager({ poolEntry: null });
	assert.equal(manager.releaseStandbyAgent("project-1"), false);
	assert.equal(calls.clear, 0);
	assert.deepEqual(calls.stopped, []);
});

test("sessions:catalog:update 在切到非 pi 后端时回收本项目的 standby 进程", () => {
	const source = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	const handler = source.slice(source.indexOf("ipcChannels.sessionsCatalogUpdate"), source.indexOf("ipcChannels.sessionsCatalogRemove"));
	const release = handler.indexOf('patch.backend !== "pi"');
	assert.ok(release >= 0, "草稿切到非 pi 后端必须回收 standby 预热进程");
	assert.match(handler.slice(release), /agentManager\.releaseStandbyAgent\(entry\.projectId\)/, "回收按 catalog 条目的 projectId 定位池条目");
	// 顺序：先过锁定判定再回收（已锁定的会话直接抛错，不该顺手改状态或动进程）
	const lockGuard = handler.indexOf("session.backendLocked");
	assert.ok(lockGuard >= 0 && lockGuard < release, "回收必须放在后端锁定判定之后");
});
