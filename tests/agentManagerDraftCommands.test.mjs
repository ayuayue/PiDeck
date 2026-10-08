import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 草稿会话斜杠命令预览（Issue #316）回归测试。
 *
 * 背景：draft 没有 pi 进程，斜杠建议只靠本地技能/提示词发现，用户装的
 * 扩展命令（如 grill-me）第一条消息之前永远出不来。修复：只读借用
 * standby 池里同项目已握手进程的 get_commands（peek，不消费）。
 *
 * 本文件只测决策面：开关、项目匹配、指纹新鲜度、进程 idle、RPC 失败。
 * 池 peek 语义见 tests/standbyRuntimePool.test.mjs；
 * 渲染层建议优先级见 tests/draftResourceCommands.test.mjs。
 */

const PROJECT = { id: "project-1", name: "Project", path: "C:/project" };

function createManager({ enabled = true, poolEntry, runtime, rpc } = {}) {
	const manager = new AgentManager(
		(id) => (id === "project-1" ? PROJECT : undefined),
		() => null,
		{ get: () => ({ standbyRuntimeEnabled: enabled, rpcTimeout: 600_000 }) },
		{},
	);
	// 指纹输入依赖完整 spawn 设置快照，这里只测「与当前指纹一致性判定」，
	// 输入敏感性已由 tests/standbyFingerprint.test.mjs 覆盖。
	manager.computeStandbyFingerprintFor = () => "fp-current";
	// standbyPool 是构造期字段，测试里换桩只暴露 peek。
	manager.standbyPool = { peek: () => (poolEntry === undefined ? { agentId: "agent-standby", fingerprint: "fp-current" } : poolEntry) };
	if (runtime !== null) {
		manager.agents.set("agent-standby", {
			tab: { id: "agent-standby", projectId: "project-1", status: runtime?.status ?? "idle" },
			process: {
				client: {
					request: rpc ?? (async () => ({ success: true, data: { commands: [{ name: "grill-me", description: "Grill the plan", source: "skill" }] } })),
				},
			},
		});
	}
	return manager;
}

test("draftCommands: 池命中 + 指纹一致 + idle 时返回 pi 真实命令表（含扩展命令）", async () => {
	const manager = createManager();
	const commands = await manager.draftCommands("project-1");
	assert.deepEqual(commands, [{ name: "grill-me", description: "Grill the plan", source: "skill" }]);
});

test("draftCommands: standbyRuntimeEnabled 关闭时不查池不发 RPC", async () => {
	let requested = 0;
	const manager = createManager({
		enabled: false,
		rpc: async () => {
			requested += 1;
			return { success: true, data: { commands: [] } };
		},
	});
	assert.equal(await manager.draftCommands("project-1"), null);
	assert.equal(requested, 0);
});

test("draftCommands: 未知项目返回 null", async () => {
	const manager = createManager();
	assert.equal(await manager.draftCommands("project-unknown"), null);
});

test("draftCommands: 池条目属于其他项目（peek null）返回 null", async () => {
	const manager = createManager({ poolEntry: null });
	assert.equal(await manager.draftCommands("project-1"), null);
});

test("draftCommands: 指纹过期（设置已变，条目将在认领时被废弃）返回 null", async () => {
	const manager = createManager({ poolEntry: { agentId: "agent-standby", fingerprint: "fp-stale" } });
	assert.equal(await manager.draftCommands("project-1"), null);
});

test("draftCommands: 池条目进程已不在运行表（已停止）返回 null", async () => {
	const manager = createManager({ runtime: null });
	assert.equal(await manager.draftCommands("project-1"), null);
});

test("draftCommands: 池进程非 idle（正在跑任务）只读让路，返回 null 且不发 RPC", async () => {
	let requested = 0;
	const manager = createManager({
		runtime: { status: "running" },
		rpc: async () => {
			requested += 1;
			return { success: true, data: { commands: [] } };
		},
	});
	assert.equal(await manager.draftCommands("project-1"), null);
	assert.equal(requested, 0);
});

test("draftCommands: RPC 失败或 success=false 时吞错返回 null（预览绝不抛错）", async () => {
	const throwing = createManager({
		rpc: async () => {
			throw new Error("rpc down");
		},
	});
	assert.equal(await throwing.draftCommands("project-1"), null);

	const unsuccessful = createManager({ rpc: async () => ({ success: false }) });
	assert.equal(await unsuccessful.draftCommands("project-1"), null);
});

test("draftCommands: pi 未返回 commands 字段时返回空数组而非 undefined", async () => {
	const manager = createManager({ rpc: async () => ({ success: true, data: {} }) });
	const commands = await manager.draftCommands("project-1");
	// 跨 vm realm 数组无法 deepEqual，用形状断言
	assert.equal(Array.isArray(commands), true);
	assert.equal(commands.length, 0);
});

test("draftCommands: peek 不消费池条目（连续两次预览结果一致）", async () => {
	const manager = createManager();
	const first = await manager.draftCommands("project-1");
	const second = await manager.draftCommands("project-1");
	assert.deepEqual(first, second);
});
