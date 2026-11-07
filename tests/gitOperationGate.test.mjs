import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createGitOperationGate } = loadTsCommonJs("src/renderer/src/utils/gitOperationGate.ts");

/**
 * W5（第三批 C 片）：取消 / 互斥 / unknown / 迟到读 四条规则只有一份实现。
 *
 * 这组用例钉的是**规则本身**：本地 GitPanel 与远端 remoteGitViewState 都从这里拿判断，
 * 任何一侧再写一遍就必然在这四条上分叉（一边能清 unknown、另一边不能；一边取消后还发布旧结果）。
 */
test("取消：retire 之后旧令牌一律作废，新读是新一代", () => {
	const gate = createGitOperationGate();
	const first = gate.beginRead();
	assert.equal(gate.isCurrent(first), true);
	assert.equal(gate.retire(), gate.current(), "retire 换代");
	assert.equal(gate.isCurrent(first), false, "在途读的结果不能再发布");
	const second = gate.beginRead();
	assert.equal(gate.isCurrent(second), true);
	assert.equal(gate.isCurrent(first), false, "只认最新一代");
});

test("互斥：写者在途由调用方回答；读可要求不重叠，但不阻止显式刷新抢先", () => {
	let writing = false;
	const gate = createGitOperationGate({ isWriting: () => writing });
	assert.equal(gate.writing(), false);
	const write = gate.beginWrite();
	assert.equal(typeof write, "number", "空闲时写可以开始");
	writing = true;
	assert.equal(gate.beginWrite(), undefined, "已有写时第二个写被拒绝");
	writing = false;

	// 静默轮询：不重叠（请求还在途就这拍不读），一次读结束后恢复。
	const silent = gate.beginRead({ exclusive: true });
	assert.equal(typeof silent, "number");
	assert.equal(gate.beginRead({ exclusive: true }), undefined, "在途时静默读被跳过");
	gate.endRead();
	assert.equal(typeof gate.beginRead({ exclusive: true }), "number", "读结束后静默读恢复");

	// 显式刷新（非 exclusive）永远可以开：它以新代取胜，旧结果自然作废。
	const manual = gate.beginRead();
	const newer = gate.beginRead();
	assert.equal(gate.isCurrent(manual), false, "旧的手动刷新结果被新的一代取代");
	assert.equal(gate.isCurrent(newer), true);
	gate.endRead();
	gate.endRead();
});

test("unknown：写结果未知会一直保留，只有成功的事实读能解除（取消/失败读都不算）", () => {
	const gate = createGitOperationGate();
	assert.equal(gate.unknownCode(), undefined);
	gate.markUnknown("GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(gate.unknownCode(), "GIT_WRITE_RESULT_UNCONFIRMED");

	// 取消（卸载/断开/收起）不是核对：不能把“可能已经写进去”的告警抹掉。
	gate.retire();
	assert.equal(gate.unknownCode(), "GIT_WRITE_RESULT_UNCONFIRMED");

	// 一次成功的事实读才是用户要求的核对。
	gate.resolveUnknown();
	assert.equal(gate.unknownCode(), undefined);
});

test("迟到读：写一开始，在途读就不再代表现状（写完也不必再单独取消）", () => {
	const gate = createGitOperationGate();
	const read = gate.beginRead();
	assert.equal(gate.isCurrent(read), true);
	gate.beginWrite();
	assert.equal(gate.isCurrent(read), false, "写改变了事实：写前的读不得发布");
	gate.endRead();
});
