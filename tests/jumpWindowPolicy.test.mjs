import { sessionTimelineControllerSource } from "./helpers/sessionTimelineControllerSources.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const controllerPath = "src/renderer/src/hooks/useSessionTimelineController.ts";

const compile = (filePath) => createTsSandbox()(filePath);

// 两条模块都走统一沙箱：相对 import 由它按源文件目录解析（原手写 vm 的 require 一律给 {}）。
const policy = compile("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts");

const STEP = 3; // turnRenderWindow.TIMELINE_WINDOW_EXPAND_STEP

test("目标已加载未挂载：兜底扩窗步长指数收敛并封顶（3→6→12→24）", () => {
	const turns = [0, 1, 2, 3, 4].map((expandAttempts) =>
		policy.resolveJumpPendingAction({
			targetInLoadedData: true,
			hasMorePages: true,
			isLoadingPage: false,
			expandAttempts,
			loadAttempts: 0,
		}),
	);
	assert.deepEqual(
		turns.map((action) => action.kind),
		["expand", "expand", "expand", "expand", "expand"],
	);
	assert.deepEqual(
		turns.map((action) => action.turns),
		[STEP, STEP * 2, STEP * 4, STEP * 8, STEP * 8],
	);
});

test("目标在数据里却始终挂不出节点：扩窗到防呆上限后放弃，不无限空转", () => {
	// 场景：命中被 context_edit 移出展示、或轮内节点不渲染 —— 数据里有、DOM 里永远没有。
	// 旧策略对 targetInLoadedData 永远返回 expand，且窗口已够大时每次都是空转。
	const below = policy.resolveJumpPendingAction({
		targetInLoadedData: true,
		hasMorePages: true,
		isLoadingPage: false,
		expandAttempts: policy.JUMP_MAX_EXPAND_ATTEMPTS - 1,
		loadAttempts: 0,
	});
	assert.equal(below.kind, "expand");
	const atCap = policy.resolveJumpPendingAction({
		targetInLoadedData: true,
		hasMorePages: true,
		isLoadingPage: false,
		expandAttempts: policy.JUMP_MAX_EXPAND_ATTEMPTS,
		loadAttempts: 0,
	});
	assert.equal(atCap.kind, "give-up");
});

test("目标已加载时无视补页状态，始终走扩窗", () => {
	const action = policy.resolveJumpPendingAction({
		targetInLoadedData: true,
		hasMorePages: true,
		isLoadingPage: true,
		expandAttempts: 0,
		loadAttempts: 0,
	});
	assert.equal(action.kind, "expand");
});

test("目标未加载且无页可补：放弃跳转", () => {
	const action = policy.resolveJumpPendingAction({
		targetInLoadedData: false,
		hasMorePages: false,
		isLoadingPage: false,
		expandAttempts: 0,
		loadAttempts: 0,
	});
	assert.equal(action.kind, "give-up");
});

test("目标未加载且补页在途：保持挂起等下一轮", () => {
	const action = policy.resolveJumpPendingAction({
		targetInLoadedData: false,
		hasMorePages: true,
		isLoadingPage: true,
		expandAttempts: 0,
		loadAttempts: 0,
	});
	assert.equal(action.kind, "wait");
});

test("目标未加载且可补页：驱动补页；超过防呆上限后放弃", () => {
	const load = policy.resolveJumpPendingAction({
		targetInLoadedData: false,
		hasMorePages: true,
		isLoadingPage: false,
		expandAttempts: 0,
		loadAttempts: policy.JUMP_MAX_LOAD_ATTEMPTS - 1,
	});
	assert.equal(load.kind, "load-page");

	const exhausted = policy.resolveJumpPendingAction({
		targetInLoadedData: false,
		hasMorePages: true,
		isLoadingPage: false,
		expandAttempts: 0,
		loadAttempts: policy.JUMP_MAX_LOAD_ATTEMPTS,
	});
	assert.equal(exhausted.kind, "give-up");
});

test("扩窗与补页计数互不挤占：补页多次不抬高扩窗步长，扩窗多次不吃掉补页预算", () => {
	// 旧版共用一个 attempts：扩窗几轮后补页预算只剩两三次，点最上面的刻度
	// 经常中途 give-up，「点第二次才成功」。分离后补页 5 次时扩窗仍从基础步长开始，
	// 扩窗 4 轮后补页预算也仍然完整。
	const afterLoads = policy.resolveJumpPendingAction({
		targetInLoadedData: true,
		hasMorePages: true,
		isLoadingPage: false,
		expandAttempts: 0,
		loadAttempts: 5,
	});
	assert.equal(afterLoads.kind, "expand");
	assert.equal(afterLoads.turns, STEP);

	const afterExpands = policy.resolveJumpPendingAction({
		targetInLoadedData: false,
		hasMorePages: true,
		isLoadingPage: false,
		expandAttempts: 4,
		loadAttempts: 0,
	});
	assert.equal(afterExpands.kind, "load-page");
});

test("补页防呆上限足以覆盖长会话跳首条（40 页 × 3 轮 = 120 轮深度）", () => {
	assert.ok(policy.JUMP_MAX_LOAD_ATTEMPTS >= 40);
});

test("estimateJumpExpandTurns：按目标（含）到末尾的用户轮数 + 1 冗余估算", () => {
	const messages = [
		{ role: "user" }, // 0 第 1 轮
		{ role: "assistant" },
		{ role: "user" }, // 2 第 2 轮
		{ role: "assistant" },
		{ role: "user" }, // 4 第 3 轮
		{ role: "assistant" },
	];
	// 目标在第 1 轮：目标到末尾 3 条 user + 1 冗余 = 4
	assert.equal(policy.estimateJumpExpandTurns(messages, 0), 4);
	// 目标在最后一轮起点：1 + 1 = 2
	assert.equal(policy.estimateJumpExpandTurns(messages, 4), 2);
	// 目标是末尾 assistant（所在轮起点之前无 user）：0 + 1 = 1（末轮已在窗口内）
	assert.equal(policy.estimateJumpExpandTurns(messages, 5), 1);
});

test("estimateJumpExpandTurns：目标越早窗口越大，首条消息要求全量窗口", () => {
	const messages = Array.from({ length: 100 }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
	}));
	assert.equal(policy.estimateJumpExpandTurns(messages, 0), 51);
	// 目标越靠前，其后（含）的轮数越多，所需窗口越大
	assert.ok(policy.estimateJumpExpandTurns(messages, 98) < policy.estimateJumpExpandTurns(messages, 50));
	assert.ok(policy.estimateJumpExpandTurns(messages, 50) < policy.estimateJumpExpandTurns(messages, 0));
});

test("estimateJumpExpandTurns：目标不在数据中时返回基础步长（走补页路径）", () => {
	assert.equal(policy.estimateJumpExpandTurns([{ role: "user" }], -1), STEP);
	assert.equal(policy.estimateJumpExpandTurns([{ role: "user" }], 1), STEP);
	assert.equal(policy.estimateJumpExpandTurns([], 0), STEP);
});

test("补页失败不得吃掉跳转预算：失败短路必须排在状态机之前", () => {
	// loadAttempts 是「补页防呆」的保险丝（JUMP_MAX_LOAD_ATTEMPTS = 40）。
	// 旧实现先 resolve 再 +1，失败也照算 —— 用户连点几次就把保险丝烧断，之后彻底跳不动。
	// 2026-11 重构后判据换成 nextJumpTick（单一状态机），同一条顺序要求照旧。
	const source = sessionTimelineControllerSource;
	const start = source.indexOf("const stillInData = targetIndex >= 0;");
	assert.ok(start > 0, "找不到 pendingJump effect 主体");
	const body = source.slice(start, start + 6000);
	const failGuardAt = body.indexOf("if (!stillInData && loadMoreError) return;");
	const actionAt = body.indexOf("const action = toPendingAction(");
	assert.ok(failGuardAt > 0, "找不到补页失败短路");
	assert.ok(actionAt > 0, "找不到 nextJumpTick 调用");
	assert.ok(failGuardAt < actionAt, "失败短路必须在状态机之前");
	// 判断窗口跟着 actionAt 走，不跟「effect 开头 + 固定长度」走：effect 主体会随注释变长，
	// 用固定窗口会在没改行为的情况下假红（2026-11-25 实际发生过）。
	// 从 source 取而不是从 body 取：body 只有 6000 字符，actionAt 已经接近它的尾部，
	// 在 body 上再开窗口只会拿到几百字符（2026-11-25 就是这么假红的）。
	const afterAction = source.slice(start + actionAt, start + actionAt + 8000);
	assert.match(afterAction, /loadAttempts: action\.kind === "load-page"/, "推进点仍存在（只是失败时到不了这里）");
});
