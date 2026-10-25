import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * DSH 会话模型补录（catalog 真值同步）契约。
 *
 * 背景（线上案例）：PiDeck 的 SessionRecord.model 只在用户「通过 PiDeck 改模型」时写入，
 * 历史/外部 DSH 会话的模型只存在 host 会话投影（modelSelection.next ?? lastUsed）里。
 * catalog 缺 model 时底栏回退「部署默认模型」这个全局单值——会话实际 magpie/group/free，
 * 底栏却显示部署默认 magpie/auto，用户看到「改了一个会话，其他会话的模型显示也跟着变」。
 */

const { dshSessionModelPatch } = loadTsCommonJs("src/main/dsh/dshSessionModelSync.ts");

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("dshSessionModelPatch: catalog 缺模型与档位时全量补录", () => {
	const patch = dshSessionModelPatch({}, { provider: "magpie", model: "group/free", reasoningEffort: "max" });
	assert.deepEqual(plain(patch), {
		model: { provider: "magpie", modelId: "group/free", modelName: "group/free" },
		thinkingLevel: "max",
	});
});

test("dshSessionModelPatch: 已有模型只补缺失档位", () => {
	const patch = dshSessionModelPatch({ model: { provider: "zuiapi", modelId: "deepseek-v4.1-flash", modelName: "DeepSeek V4.1 Flash" } }, { provider: "magpie", model: "group/free", reasoningEffort: "max" });
	assert.deepEqual(plain(patch), { thinkingLevel: "max" }, "用户通过 PiDeck 选过的模型不得被 host 投影覆盖");
});

test("dshSessionModelPatch: 已有档位只补缺失模型", () => {
	const patch = dshSessionModelPatch({ thinkingLevel: "high" }, { provider: "magpie", model: "group/free", reasoningEffort: "max" });
	assert.deepEqual(plain(patch), { model: { provider: "magpie", modelId: "group/free", modelName: "group/free" } });
});

test("dshSessionModelPatch: host 选择没有档位时只补模型", () => {
	const patch = dshSessionModelPatch({}, { provider: "magpie", model: "group/free" });
	assert.deepEqual(plain(patch), { model: { provider: "magpie", modelId: "group/free", modelName: "group/free" } });
});

test("dshSessionModelPatch: 无需更新 / 无 host 选择时返回 undefined", () => {
	assert.equal(dshSessionModelPatch({ model: { provider: "a", modelId: "b", modelName: "b" }, thinkingLevel: "max" }, { provider: "a", model: "b", reasoningEffort: "max" }), undefined);
	assert.equal(dshSessionModelPatch({}, undefined), undefined);
	assert.equal(dshSessionModelPatch(undefined, { provider: "a", model: "b" }), undefined);
});

test("契约: 打开 DSH 历史会话时主进程冷读 host 投影并补录 catalog", () => {
	const ipc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	assert.match(ipc, /readDshSessionModel\?:/, "DshBackendIpcDeps 必须声明冷读依赖");
	assert.match(ipc, /const backfillDshSessionModel = async \(sessionId: string\)/, "补录入口必须存在于 sessionIpc");
	assert.match(ipc, /if \(!entry \|\| entry\.backend !== "dsh" \|\| !entry\.dshSessionId\) return;/, "只对 DSH 会话补录");
	assert.match(ipc, /sessionRuntimeCoordinator\.getTarget\(sessionId\)/, "运行中会话由 runtime state 展示，不参与补录");
	assert.match(ipc, /dshSessionModelPatch\(current, selection\)/, "补丁必须走纯函数（只补缺失字段）");
	// 两条 DSH 历史读取路径（全量读 / 分页读）都要触发，否则打开会话的入口不同就修不全。
	assert.equal((ipc.match(/void backfillDshSessionModel\(sessionId\);/g) ?? []).length, 2);
});

test("契约: main 装配把 DSH host 投影冷读注入 IPC 依赖", () => {
	const index = readFileSync("src/main/index.ts", "utf8");
	assert.match(index, /readDshSessionModel:\s*\(dshSessionId\)\s*=>\s*dshAgentManager\.readSessionModelSelection\(dshSessionId\)/);
});

test("契约: DSH 网关提供 host 当前选择（Coordinator 据此跳过无变化重放）", () => {
	const manager = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
	assert.match(manager, /getRuntimeModelThinkingState\(agentId: string\): Promise<SessionRuntimeModelSelection \| undefined>/);
	assert.match(manager, /readSessionModelSelection\(dshSessionId: string\)/);
});
