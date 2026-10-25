import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 终端 tab 标题序号回归测试（TerminalSessionManager）。
 *
 * 背景：标题序号曾用 `runtimes.size + 1`，关闭一个 tab 后桶内 size 回退，
 * 新建 tab 会与存活 tab 撞名（同桶两个「pwsh 2」，用户无法区分）。
 * 修复后改用每归属键单调递增计数器（ownerSeq），桶删除时同步清理。
 * 用 fake pty（node-pty stub）从公开 API（create/close/closeAgent/list）断言行为。
 */

/** fake IPty：node-pty 接口的最小替身（onData/onExit 只登记不触发） */
const makeFakePty = () => ({
	onData: () => {},
	onExit: () => {},
	write: () => {},
	resize: () => {},
	kill: () => {},
	process: "pwsh",
});

function loadManager() {
	const load = createTsSandbox({
		stubs: {
			// 原生模块的加载边界是 ./nodePtyRuntime（TerminalSessionManager 不再静态 import node-pty）
			"./nodePtyRuntime": { loadNodePty: () => ({ spawn: () => makeFakePty() }) },
		},
	});
	return load("src/main/terminal/TerminalSessionManager.ts").TerminalSessionManager;
}

function newManager() {
	const TerminalSessionManager = loadManager();
	return new TerminalSessionManager(
		() => "C:\\proj", // getCwd（agent 目标用）
		() => {}, // emit：batcher/exit 推送的空替身
		() => ({}), // getSettings：无 WSL
	);
}

const projectTarget = { kind: "project", cwd: "C:\\proj" };

test("标题序号单调递增：关闭一个 tab 后新建不与存活 tab 撞名", () => {
	const manager = newManager();
	const a = manager.create(projectTarget, "pwsh");
	const b = manager.create(projectTarget, "pwsh");
	assert.equal(a.title, "pwsh 1");
	assert.equal(b.title, "pwsh 2");

	// 关闭 A 后桶内只剩 B（size=1）：旧实现会把新 tab 命名为「pwsh 2」与 B 撞名
	manager.close(a.id);
	const c = manager.create(projectTarget, "pwsh");
	assert.equal(c.title, "pwsh 3", "序号必须单调递增，不复用已关闭 tab 的编号");
});

test("桶内全部关闭后序号归零：重新开始编号（ownerSeq 随桶清理）", () => {
	const manager = newManager();
	const a = manager.create(projectTarget, "pwsh");
	const b = manager.create(projectTarget, "pwsh");
	manager.close(a.id);
	manager.close(b.id);

	const c = manager.create(projectTarget, "pwsh");
	assert.equal(c.title, "pwsh 1", "桶删除后 ownerSeq 必须同步清理，新会话从 1 开始");
});

test("closeAgent 清理 agent 桶序号：agent 重启后终端从 1 重新编号", () => {
	const manager = newManager();
	const agentTarget = { kind: "agent", sessionId: "s1", agentId: "a1", runtimeGeneration: 1 };
	const a = manager.create(agentTarget, "pwsh");
	assert.equal(a.title, "pwsh 1");

	manager.closeAgent("a1");
	const b = manager.create(agentTarget, "pwsh");
	assert.equal(b.title, "pwsh 1", "agent 重启（closeAgent）后新桶从 1 开始");
});

test("不同归属键的序号互不影响", () => {
	const manager = newManager();
	const projA = manager.create({ kind: "project", cwd: "C:\\proj" }, "pwsh");
	const projB = manager.create({ kind: "project", cwd: "C:\\other" }, "pwsh");
	assert.equal(projA.title, "pwsh 1");
	assert.equal(projB.title, "pwsh 1", "每个归属键独立计数");

	// 归一化后同目录（大小写/分隔符混写）仍是同一个桶
	const projA2 = manager.create({ kind: "project", cwd: "c:\\PROJ/" }, "pwsh");
	assert.equal(projA2.title, "pwsh 2", "同目录不同写法归一化后共享同一序号计数");
});
