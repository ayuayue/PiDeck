import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 运行时目标与 live 判定（sessionCommands.isLiveRuntimeStatus / toSessionRuntimeTarget）。
 *
 * 语义边界：
 * - toSessionRuntimeTarget 只构造「会话 → 当前绑定运行实例」的句柄（agentId + generation），
 *   不做 live 判定：error/closed 终态 Agent 仍持有绑定，stop/restart 仍需能拿到 target
 *   （主进程幂等 stop + 重启重建），不能在这里把 target 抹掉。
 * - 「改文件前是否需要先停 Agent」这类 live 判定，由调用方用 isLiveRuntimeStatus 单独判断。
 */
const sessionCommands = loadTsCommonJs("src/renderer/src/utils/sessionCommands.ts", { stubs: { "../i18n": { t: (key) => key } } });
const { isLiveRuntimeStatus, toSessionRuntimeTarget } = sessionCommands;

test("isLiveRuntimeStatus: only starting/idle/running are live", () => {
	assert.equal(isLiveRuntimeStatus("starting"), true);
	assert.equal(isLiveRuntimeStatus("idle"), true);
	assert.equal(isLiveRuntimeStatus("running"), true);
	assert.equal(isLiveRuntimeStatus("error"), false);
	assert.equal(isLiveRuntimeStatus("closed"), false);
	assert.equal(isLiveRuntimeStatus("detached"), false);
	assert.equal(isLiveRuntimeStatus(undefined), false);
	assert.equal(isLiveRuntimeStatus(null), false);
});

test("toSessionRuntimeTarget: any bound runtime yields a target regardless of status", () => {
	for (const status of ["starting", "idle", "running", "error", "closed", undefined]) {
		const target = toSessionRuntimeTarget("s1", {
			agentId: "a1",
			runtimeGeneration: 1,
			status,
		});
		// vm realm 构造的对象原型与本 realm 不同，deepEqual 会误判 → JSON 归一化比较
		assert.equal(JSON.stringify(target), JSON.stringify({ sessionId: "s1", agentId: "a1", runtimeGeneration: 1 }));
	}
});

test("toSessionRuntimeTarget: missing agentId or generation yields undefined", () => {
	assert.equal(toSessionRuntimeTarget("s1", undefined), undefined);
	assert.equal(toSessionRuntimeTarget("s1", { agentId: undefined, runtimeGeneration: 1, status: "idle" }), undefined);
	assert.equal(toSessionRuntimeTarget("s1", { agentId: "a1", runtimeGeneration: undefined, status: "idle" }), undefined);
});
