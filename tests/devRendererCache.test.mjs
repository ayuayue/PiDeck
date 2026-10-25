import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { KEEP_DEV_HTTP_CACHE_ENV, shouldClearDevRendererCache, clearDevRendererCache } = loadTsCommonJs("src/main/devRendererCache.ts");

function createSessionStub(options = {}) {
	const calls = [];
	return {
		calls,
		clearCache: async () => {
			calls.push("clearCache");
			if (options.failOn === "clearCache") throw new Error("cache locked");
		},
		clearCodeCaches: async (input) => {
			// `urls: []` 是「全清」哨兵，断言取原始值：模块在 vm realm 内构造对象，跨 realm deepStrictEqual 会比原型。
			calls.push({ method: "clearCodeCaches", urlsLength: input.urls?.length ?? -1 });
			if (options.failOn === "clearCodeCaches") throw new Error("code cache locked");
		},
	};
}

test("保留缓存开关按 truthy 解释，其余取值都不关护栏", () => {
	for (const flag of ["1", "true", "TRUE", " 1 "]) {
		assert.equal(shouldClearDevRendererCache(flag), false, flag);
	}
	for (const flag of [undefined, "", "0", "false"]) {
		assert.equal(shouldClearDevRendererCache(flag), true, String(flag));
	}
});

test("开关常量就是环境变量名 PIDECK_DEV_KEEP_HTTP_CACHE", () => {
	assert.equal(KEEP_DEV_HTTP_CACHE_ENV, "PIDECK_DEV_KEEP_HTTP_CACHE");
});

test("置了保留标记就完全不触碰 session", async () => {
	const sessionStub = createSessionStub();
	const logs = [];
	await clearDevRendererCache({ session: sessionStub, keepHttpCacheFlag: "1", onLog: (outcome) => logs.push(outcome) });
	assert.equal(sessionStub.calls.length, 0);
	assert.deepEqual(logs, ["skipped"]);
});

test("HTTP 缓存与 JS 编译缓存各清一次，编译缓存走全清", async () => {
	const sessionStub = createSessionStub();
	const logs = [];
	await clearDevRendererCache({ session: sessionStub, onLog: (outcome) => logs.push(outcome) });
	assert.equal(sessionStub.calls[0], "clearCache");
	assert.equal(sessionStub.calls[1].method, "clearCodeCaches");
	assert.equal(sessionStub.calls[1].urlsLength, 0);
	assert.deepEqual(logs, ["cleared"]);
});

test("清理失败只记录，不抛出挡住宿主窗口创建", async () => {
	for (const failOn of ["clearCache", "clearCodeCaches"]) {
		const logs = [];
		await clearDevRendererCache({ session: createSessionStub({ failOn }), onLog: (outcome) => logs.push(outcome) });
		assert.deepEqual(logs, ["failed"], failOn);
	}
});

// 装配契约：护栏必须 await 在加载 dev renderer 之前——放在 loadURL 之后清一次等于没清，
// 首个模块图仍然来自旧缓存。这里守住「先清后载」的时序，不靠人工 review。
test("createWindow 在加载 dev renderer 之前 await 缓存清理", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	const clearAt = source.search(/await\s+clearDevRendererCache\s*\(/);
	const loadAt = source.search(/mainWindow\s*\.\s*loadURL\s*\(\s*devRendererUrl\s*\)/);
	assert.ok(clearAt > -1, "index.ts 未调用 clearDevRendererCache");
	assert.ok(loadAt > -1, "index.ts 未找到 dev renderer 加载点");
	assert.ok(clearAt < loadAt, "缓存清理发生在 loadURL 之后，旧 chunk 仍会被命中");
});
