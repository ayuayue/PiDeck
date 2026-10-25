import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const runtimeNotification = loadTsCommonJs("src/renderer/src/utils/runtimeNotification.ts");

test("collectPendingBackgroundAsks：只收 pending/responding 的 Ask 方法，key 带 runtimeGeneration", () => {
	const uiById = {
		"s-a": {
			runtimeGeneration: 3,
			requests: {
				r1: { status: "pending", request: { method: "input", requestId: "r1", title: "你的名字？" } },
			},
		},
		"s-b": {
			runtimeGeneration: 1,
			requests: {
				r2: { status: "done", request: { method: "confirm", requestId: "r2" } },
				r3: { status: "pending", request: { method: "bash", requestId: "r3" } }, // 非 Ask 方法
			},
		},
		"s-c": {
			runtimeGeneration: 2,
			requests: {
				r4: { status: "responding", request: { method: "editor", requestId: "r4" } },
			},
		},
	};
	const asks = runtimeNotification.collectPendingBackgroundAsks(uiById);
	// vm 加载模块返回的数组原型不在测试 realm，deepStrictEqual 直接比较会误报，逐项收集到本地数组
	const keys = [];
	for (const ask of asks) keys.push(ask.key);
	assert.deepEqual(keys, ["s-a:3:r1", "s-c:2:r4"]);
	assert.equal(asks[0].sessionId, "s-a");
	assert.equal(asks[0].requestTitle, "你的名字？");
	assert.equal(asks[1].requestTitle, undefined);
});

test("collectPendingBackgroundAsks：空快照返回空数组", () => {
	assert.equal(runtimeNotification.collectPendingBackgroundAsks({}).length, 0);
});

test("源码契约：巡检收敛到单点，runtime 控制器不再订全局 Map", () => {
	const controller = readFileSync("src/renderer/src/hooks/useSessionRuntimeController.ts", "utf8");
	assert.doesNotMatch(controller, /useAtomValue\(sessionRuntimeUiByIdAtom\)/, "M7：全局 UI Map 订阅移出分栏 hook");
	assert.doesNotMatch(controller, /useAtomValue\(sessionRecordsAtom\)/, "M7：全局 records Map 订阅移出分栏 hook");

	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /useBackgroundAskPatrol\(/, "App 级单点挂载");

	const patrol = readFileSync("src/renderer/src/hooks/useBackgroundAskPatrol.ts", "utf8");
	assert.match(patrol, /collectPendingBackgroundAsks/);
	assert.match(patrol, /rememberBackgroundAsk/);
});
