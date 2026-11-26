import assert from "node:assert/strict";
import test from "node:test";
// 直接 import 生产 .ts 会走 Node 的 ESM 解析：jumpTarget.ts 依赖 "../../../../../shared/sessionJumpAnchor"
// （无扩展名，打包器才认），Node 解析不到 → 整个文件红。helper 在 CommonJS VM 里解析依赖图，
// 不必为了测试去改生产 import（2026-11-25 这条红与本次改动无关，见 loadTsCommonJs 的说明）。
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveJumpMessageIndex } = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");
const { resolveAnchoredTurnWindow } = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

const TURNS = 636;
const WINDOW = 31;

function makeSession() {
	const messages = [];
	const runs = [];
	for (let turn = 1; turn <= TURNS; turn += 1) {
		const userMsg = { id: `user-${turn}`, role: "user", meta: { entryId: `entry-${turn}` } };
		const asstMsg = { id: `asst-${turn}`, role: "assistant", meta: { entryId: `entry-${turn}-a` } };
		messages.push(userMsg, asstMsg);
		runs.push({
			kind: "agent-run",
			id: `run-${turn}`,
			items: [
				{ kind: "message", message: userMsg },
				{ kind: "message", message: asstMsg },
			],
			startedAt: turn,
			endedAt: turn + 1,
		});
	}
	return { messages, runs };
}

test("点第 1 条命中：目标那一轮必须出现在窗口里（636 轮）", () => {
	const { messages, runs } = makeSession();
	const index = resolveJumpMessageIndex(messages, "entry-1");
	assert.equal(index, 0);
	const targetMessageId = messages[index].id;
	const window = resolveAnchoredTurnWindow(runs, WINDOW, targetMessageId);
	const ids = window.flatMap((run) => run.items.map((item) => item.message.id));
	assert.ok(ids.includes(targetMessageId), "目标必须在窗口内，实际 " + window.length + " 轮");
	assert.ok(window.length <= 19);
});

test("点第 351 条命中：同样必须出现在窗口里", () => {
	const { messages, runs } = makeSession();
	const index = resolveJumpMessageIndex(messages, "entry-351");
	assert.equal(index, 700);
	const targetMessageId = messages[index].id;
	const window = resolveAnchoredTurnWindow(runs, WINDOW, targetMessageId);
	const ids = window.flatMap((run) => run.items.map((item) => item.message.id));
	assert.ok(ids.includes(targetMessageId), "目标必须在窗口内");
	assert.ok(!ids.includes("user-636"), "窗口不该退到尾部");
});

test("点最后一条：窗口仍含目标", () => {
	const { messages, runs } = makeSession();
	const index = resolveJumpMessageIndex(messages, "entry-636");
	const targetMessageId = messages[index].id;
	const window = resolveAnchoredTurnWindow(runs, WINDOW, targetMessageId);
	const ids = window.flatMap((run) => run.items.map((item) => item.message.id));
	assert.ok(ids.includes(targetMessageId));
});

test("没有锚点时退回尾部窗口", () => {
	const { runs } = makeSession();
	const window = resolveAnchoredTurnWindow(runs, WINDOW, null);
	assert.equal(window.length, WINDOW);
	assert.equal(window[window.length - 1].id, "run-636");
});
