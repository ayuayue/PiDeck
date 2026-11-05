import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/**
 * 「安静收起」按时刻判定的行为回归。
 *
 * 用户反馈（2026-11）：最后一轮的执行过程「有时候不折叠」，不稳定触发；并且最后一轮
 * 收起时，上面几轮手动展开的过程应该一起收掉。两条漏收路径：
 * ① timeline 的收起信号原本是自增计数器，终态 flush 让 run 换 id 重挂载时会被当成
 *    旧信号吞掉，同时初始态又按记忆把展开恢复了；
 * ② 信号到达那一刻 `hasFinalAnswer` 还没落位（终态 messages 晚于 idle 边沿），旧实现
 *    先把标记消费掉再门控，之后即使最终回答补齐也不会再收。
 * 现在信号是时刻戳（autoCollapseAt），与记忆里的写入时刻比较，重挂载与迟到都能判定。
 */

function setup() {
	const host = quickMessageHookHost();
	const { useTurnExecution } = loadTsCommonJs("src/renderer/src/components/session/turn/useTurnExecution.ts", {
		stubs: { react: host.react },
	});
	const writes = [];
	let options = {
		runId: "run-a",
		agentRunning: true,
		isComplete: true,
		hasFinalAnswer: true,
		isLatestRun: true,
		expandInterimDuringStream: true,
		newTurnCollapseTick: 0,
		sendPinAnimating: false,
		autoCollapseAt: 0,
		onStepsVisibleMemoryChange: (visible, atTick, atMs) => writes.push({ visible, atTick, atMs }),
	};
	const render = (patch = {}) => {
		options = { ...options, ...patch };
		host.render(() => useTurnExecution(options));
		return options;
	};
	const state = () => host.render(() => useTurnExecution(options));
	return { render, state, unmount: () => host.unmount(), writes };
}

test("①流式中展开、run 换 id 重挂载后仍会被安静收起", () => {
	const h = setup();
	// 流式期间：设置① 展开，记忆写在 t=1000
	h.render();
	assert.equal(h.state().stepsVisible, true);
	const memory = { visible: true, atTick: 0, atMs: 1000 };

	// 终态 flush 让 run 换 id：卸载重挂（tick 级信号在这一刻已经没有区分度）
	h.unmount();
	h.render({
		runId: "run-a2",
		agentRunning: false,
		autoCollapseAt: 2000,
		stepsVisibleMemory: memory,
	});
	assert.equal(h.state().stepsVisible, false, "收起时刻晚于记忆写入，重挂载后必须保持收起");
});

test("②收起时刻先到、最终回答后到：补齐后仍然收起", () => {
	const h = setup();
	h.render();
	assert.equal(h.state().stepsVisible, true);
	h.render({ agentRunning: false, hasFinalAnswer: false, autoCollapseAt: 2000 });
	assert.equal(h.state().stepsVisible, true, "没有最终回答时不能收（会只剩空壳）");
	h.render({ hasFinalAnswer: true });
	assert.equal(h.state().stepsVisible, false, "最终回答落位后同一时刻要补收，标记不能被提前消费");
	// 收起同时清记忆（下次挂载回到折叠）
	assert.equal(h.writes.at(-1)?.visible, undefined);
});

test("③更早的轮次也被同一次收起带走（用户诉求）", () => {
	const h = setup();
	h.render({ runId: "run-old", isLatestRun: false });
	assert.equal(h.state().stepsVisible, true, "旧轮次挂载时按记忆/设置展开");
	h.render({ autoCollapseAt: 2000 });
	assert.equal(h.state().stepsVisible, false, "最后一轮收起时，上面开着的轮次一并收起");
});

test("④用户在收起之后亲手展开：重挂载仍恢复展开状态", () => {
	const h = setup();
	h.render({ agentRunning: false, autoCollapseAt: 2000, stepsVisibleMemory: { visible: true, atTick: 0, atMs: 3000 } });
	assert.equal(h.state().stepsVisible, true, "比收起时刻更晚的展开意愿是用户最新意图");
	// 手动点开写入新时刻，再次重挂载仍然展开
	h.render({ stepsVisibleMemory: { visible: true, atTick: 0, atMs: 4000 } });
	assert.equal(h.state().stepsVisible, true);
});
