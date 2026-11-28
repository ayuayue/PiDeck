import assert from "node:assert";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const policy = load("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts");
const plan = policy.planJumpPageRequest;

const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

test("目标没加载、有 entryId：第一次就按 entryId 一次取页", () => {
	same(plan({ entryId: "e-42", pageFetched: false, expandAttempts: 0 }), { kind: "fetch-page", beforeEntryId: "e-42" });
});

test("坏样本对照：旧的逐页逼近每个尝试次数都只扩窗，不取页", () => {
	// 把「先取页」删掉（改回纯扩窗）时，第一格就变成 expand —— 这就是用户看到的
	//「补一页、看看在不在、不在再补」。
	for (let attempts = 0; attempts < 4; attempts += 1) {
		const withoutFetch = plan({ entryId: undefined, pageFetched: false, expandAttempts: attempts });
		assert.equal(withoutFetch.kind, "expand", "没有 entryId 时只能扩窗");
	}
});

test("取过一次就不再取：拿回来还是没有，说明不在这一页之前", () => {
	const result = plan({ entryId: "e-42", pageFetched: true, expandAttempts: 0 });
	assert.equal(result.kind, "expand");
});

test("没有 entryId（只有 messageId）时不取页，退回扩窗", () => {
	const result = plan({ entryId: undefined, pageFetched: false, expandAttempts: 0 });
	assert.equal(result.kind, "expand");
});

test("扩窗到上限就放弃，不无限转", () => {
	same(plan({ entryId: "e-42", pageFetched: true, expandAttempts: policy.JUMP_MAX_EXPAND_ATTEMPTS }), { kind: "give-up", reason: "attempts" });
	assert.equal(plan({ entryId: undefined, pageFetched: false, expandAttempts: policy.JUMP_MAX_EXPAND_ATTEMPTS }).kind, "give-up");
});

test("扩窗步长按尝试次数指数增长，封顶在倍数上限", () => {
	const first = plan({ entryId: "e-42", pageFetched: true, expandAttempts: 0 });
	const later = plan({ entryId: "e-42", pageFetched: true, expandAttempts: 3 });
	const capped = plan({ entryId: "e-42", pageFetched: true, expandAttempts: 6 });
	assert.equal(first.kind, "expand");
	assert.ok(later.turns >= first.turns, "尝试越多扩得越多或持平");
	assert.ok(capped.turns <= first.turns * policy.JUMP_EXPAND_MAX_MULTIPLIER, "不会超过倍数上限");
});
