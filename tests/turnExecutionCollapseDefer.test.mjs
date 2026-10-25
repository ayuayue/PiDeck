import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/**
 * 「发送置顶动画期间不得收起上一轮」的行为回归。
 *
 * 用户反馈（2026-10）：发送后时间线先向上滚、再向下滚，来回一趟不合逻辑。
 * 根因是发送成功后 bump 的「新一轮折叠」信号在置顶动画途中到达：上一轮执行过程
 * 从刚发送的消息上方瞬间消失数百到上千 px，动画中的视口补偿只能把 scrollTop
 * 往回带，于是先向上再向下。修复后折叠信号等动画结束（sendPinAnimating 落回
 * false）再消费同一个 tick。
 */

/** 每个用例一套全新槽位：宿主按位置复用 state，跨用例共享会把上一轮结果带进来。 */
function setup() {
	const host = quickMessageHookHost();
	const { useTurnExecution } = loadTsCommonJs("src/renderer/src/components/session/turn/useTurnExecution.ts", {
		stubs: { react: host.react },
	});
	let options = {
		runId: "run-a",
		agentRunning: true,
		isComplete: true,
		hasFinalAnswer: true,
		isLatestRun: true,
		expandInterimDuringStream: true,
		newTurnCollapseTick: 0,
		sendPinAnimating: false,
	};
	const render = (patch = {}) => {
		options = { ...options, ...patch };
		return host.render(() => useTurnExecution(options));
	};
	return { render, unmount: () => host.unmount() };
}

test("置顶动画进行中收到新一轮信号：先不收起，动画结束后再收起", () => {
	const h = setup();
	try {
		// 流式轮默认展开（设置①）
		assert.equal(h.render().stepsVisible, true);

		// 新一轮开始（折叠 tick 已 bump），但置顶动画还在跑
		h.render({ isLatestRun: false, newTurnCollapseTick: 1, sendPinAnimating: true });
		// effects 已在 render 内同步执行；再渲染一次读最新 state
		assert.equal(h.render({}).stepsVisible, true, "动画中不得收起上一轮（否则上方内容骤缩造成先上后下）");

		// 动画结束（标记落回 false）：同一 tick 现在可以消费
		h.render({ sendPinAnimating: false });
		assert.equal(h.render({}).stepsVisible, false, "动画结束后必须补上这次折叠");
	} finally {
		h.unmount();
	}
});

test("没有置顶动画时（短会话/已结束）新一轮信号照常立即收起", () => {
	const h = setup();
	try {
		assert.equal(h.render().stepsVisible, true);
		h.render({ isLatestRun: false, newTurnCollapseTick: 1, sendPinAnimating: false });
		assert.equal(h.render({}).stepsVisible, false);
	} finally {
		h.unmount();
	}
});
