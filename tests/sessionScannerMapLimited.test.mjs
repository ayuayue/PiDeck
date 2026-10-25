import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 守卫 2026-10 侧栏扫描回归：SessionScanner.mapLimited 曾经每批之间 `setTimeout(resolve, 0)`，
 * 而 Windows 定时器最小粒度 16.3ms —— 1040 个会话 / 并发 4 = 260 批 → 每次扫描白等约 4.2s
 * （实测 3994ms，真正的 stat 只要 45ms）。下面第 3 条断言直接统计定时器次数，不靠时间阈值，
 * 因此在任何平台都能抓住回退。
 */

const electronStub = { app: { getPath: () => tmpdir() }, shell: {} };

/** mapLimited 是实例上的 private 方法（TS 编译后即普通属性）。 */
function createScanner() {
	const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", { stubs: { electron: electronStub } });
	return new SessionScanner();
}

const doubled = async (item) => item * 2;

test("mapLimited 结果顺序与输入一致（滑动窗口不是乱序返回）", async () => {
	const items = Array.from({ length: 25 }, (_, index) => index);
	assert.deepEqual(
		Array.from(await createScanner().mapLimited(items, 4, doubled)),
		items.map((value) => value * 2),
	);
});

test("mapLimited 同时最多跑 concurrency 个 mapper", async () => {
	const scanner = createScanner();
	let inFlight = 0;
	let peak = 0;
	await scanner.mapLimited(
		Array.from({ length: 20 }, (_, index) => index),
		3,
		async (item) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setImmediate(resolve));
			inFlight -= 1;
			return item;
		},
	);
	assert.equal(peak, 3);
});

test("mapLimited 不通过 setTimeout 让出（Windows 上每次 16.3ms）", async () => {
	const original = globalThis.setTimeout;
	let scheduled = 0;
	// 沙箱加载时会从全局取 setTimeout，所以先替换再加载才能统计到 mapLimited 的调用。
	globalThis.setTimeout = (...args) => {
		scheduled += 1;
		return original(...args);
	};
	try {
		const scanner = createScanner();
		await scanner.mapLimited(
			Array.from({ length: 200 }, (_, index) => index),
			4,
			doubled,
		);
	} finally {
		globalThis.setTimeout = original;
	}
	assert.equal(scheduled, 0, "mapLimited 不应在批次之间插入 setTimeout（Windows 粒度 16.3ms/次）");
});

test("mapLimited 空数组与单元素边界直接返回", async () => {
	const scanner = createScanner();
	// vm 沙箱的数组属于另一个 realm，deepStrictEqual 会比对原型；先落到本 realm 再比。
	assert.deepEqual(Array.from(await scanner.mapLimited([], 4, doubled)), []);
	assert.deepEqual(Array.from(await scanner.mapLimited([7], 4, doubled)), [14]);
});

test("mapLimited 的 mapper 拒绝会让整体 reject（与原 Promise.all 语义一致）", async () => {
	await assert.rejects(
		createScanner().mapLimited([1, 2, 3], 2, async (item) => {
			if (item === 2) throw new Error("boom");
			return item;
		}),
		/boom/,
	);
});
