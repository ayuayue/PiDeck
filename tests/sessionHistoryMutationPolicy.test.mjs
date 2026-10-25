import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 历史消息改写路径策略（编辑/删除/重发）纯函数测试。
 *
 * 决策矩阵（与 useSessionHistoryMutations 的运行时行为一一对应）：
 * | 场景 | 结果 |
 * | pi 有文件（persisted）+ 编辑/重发 | fork-mutation（fork 到该消息 entry 重试；activate=!live：冷会话先激活） |
 * | pi 有文件 + 删除 | catalog, live=…（删除无 fork 语义，仍走文件墓碑） |
 * | DSH 有文件 + 编辑/重发/删除 | catalog, live=…（DSH 保持 legacy，主进程本就拒绝编辑） |
 * | 匿名（无文件）+ 编辑/删除 | unsupported-anonymous（诚实告知不支持） |
 * | 匿名 + 重发 | runtime-anonymous-resend（重新提交原文本） |
 * | 生图 draft + 重发 | imagegen-resend（提示词放回输入框） |
 *
 * live 由调用方按运行时 status 判定后显式传入（target 存在不代表 live）。
 */
function loadPolicy() {
	const source = readFileSync("src/renderer/src/utils/sessionHistoryMutationPolicy.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "sessionHistoryMutationPolicy.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{ module, exports: module.exports, console },
		{
			filename: "sessionHistoryMutationPolicy.ts",
		},
	);
	return module.exports;
}

const policy = loadPolicy();

// vm realm 构造的对象原型与本 realm 不同，deepEqual 会误判 → 走 JSON 归一化比较
function resolve(kind, options) {
	return policy.resolveHistoryMutationPath({ kind, live: true, ...options });
}
function expectPath(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("persisted pi session edit/resend: fork-mutation (activate only when cold)", () => {
	// fork 化重试：fork 到该消息 entry → 立即以原文/新文本重发；live 会话无需先停
	// （pi fork 会中断当前运行），冷会话先激活（standby 池摊薄成本）。
	expectPath(resolve("edit", { persisted: true }), { path: "fork-mutation", activate: false });
	expectPath(resolve("resend", { persisted: true }), { path: "fork-mutation", activate: false });
	expectPath(resolve("edit", { live: false, persisted: true }), { path: "fork-mutation", activate: true });
	expectPath(resolve("resend", { live: false, persisted: true }), { path: "fork-mutation", activate: true });
});

test("persisted session delete: catalog path regardless of live state (no fork semantics)", () => {
	expectPath(resolve("delete", { persisted: true }), { path: "catalog", live: true });
	expectPath(resolve("delete", { live: false, persisted: true }), { path: "catalog", live: false });
});

test("anonymous session edit/delete: unsupported (no session file to rewrite)", () => {
	// pi 的 editMessage/deleteMessage 都要求 sessionPath（AgentManager 抛
	// "Session not persisted"），运行中也走不通——必须明确告知不支持，而不是
	// 调必然失败的 runtime 命令。
	expectPath(resolve("edit", { persisted: false }), { path: "unsupported-anonymous", reason: "edit" });
	expectPath(resolve("delete", { persisted: false }), { path: "unsupported-anonymous", reason: "delete" });
	// 非 live 也一样不支持
	expectPath(resolve("delete", { live: false, persisted: false }), { path: "unsupported-anonymous", reason: "delete" });
});

test("anonymous session resend: resubmit original text (no truncation possible)", () => {
	expectPath(resolve("resend", { persisted: false }), { path: "runtime-anonymous-resend" });
	expectPath(resolve("resend", { live: false, persisted: false }), { path: "runtime-anonymous-resend" });
});

test("imagegen draft resend: restore prompt into composer instead of truncating a nonexistent pi file", () => {
	expectPath(resolve("resend", { live: false, persisted: false, isImageGenSession: true }), { path: "imagegen-resend" });
	// 生图 draft 优先级高于普通匿名重发
	expectPath(resolve("resend", { persisted: false, isImageGenSession: true }), { path: "imagegen-resend" });
	// 非重发操作不受 isImageGenSession 影响
	expectPath(resolve("delete", { live: false, persisted: false, isImageGenSession: true }), { path: "unsupported-anonymous", reason: "delete" });
});

test("persisted DSH session edit/resend: legacy catalog path (fork migration skips DSH)", () => {
	// DSH 先不动：编辑/重发维持旧路径（主进程本就拒绝 DSH 编辑，行为不变）。
	expectPath(resolve("edit", { persisted: true, isDshSession: true }), { path: "catalog", live: true });
	expectPath(resolve("resend", { persisted: true, isDshSession: true }), { path: "catalog", live: true });
	expectPath(resolve("edit", { live: false, persisted: true, isDshSession: true }), { path: "catalog", live: false });
	expectPath(resolve("delete", { persisted: true, isDshSession: true }), { path: "catalog", live: true });
});

test("resend rollback hint only for definite send failure (not unknown delivery)", () => {
	const { shouldShowResendRollbackHint } = policy;
	// 确定失败：历史已截断但没发出去 → 必须补状态说明（时间线变短有解释、有备份可重试）
	assert.equal(shouldShowResendRollbackHint(false), true);
	// 发送成功：无任何异常状态，不弹
	assert.equal(shouldShowResendRollbackHint(true), false);
	// 投递未知（IPC/网络断开）：消息可能已送达，不能断言「未送出」，不弹
	assert.equal(shouldShowResendRollbackHint("unknown"), false);
});
