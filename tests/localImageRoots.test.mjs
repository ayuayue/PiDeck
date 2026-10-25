import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createCanonicalRootsProvider } = loadTsCommonJs("src/main/media/localImageRoots.ts");

/**
 * 白名单根提供者的缓存契约（2026-10-20 review P2-2）。
 *
 * 来历：协议与 IPC 原本每次请求都对**全部**白名单根做一遍 `realpathSync.native`（同步系统
 * 调用）；一条消息几十张图 × 十几个项目根，主进程会被反复阻塞。现在同一份缓存 5s 复用，
 * 并发请求合并成一次计算。缓存不能吃掉规范化：Windows 8.3 短名必须仍然展开成长名。
 */

const SHORT = "C:\Users\ADMINI~1\AppData\Local\Temp\pideck-shots";
const LONG = "C:\Users\Administrator\AppData\Local\Temp\pideck-shots";

test("TTL 内只计算一次，命中缓存直接复用", async () => {
	let clock = 1_000;
	let calls = 0;
	const provider = createCanonicalRootsProvider(
		() => {
			calls += 1;
			return [SHORT];
		},
		{ ttlMs: 5_000, now: () => clock, realpath: () => LONG },
	);

	const first = await provider();
	const second = await provider();
	assert.equal(calls, 1, "TTL 内不应重新枚举根");
	assert.equal(second, first, "同一份数组（引用相等）");
});

test("超过 TTL 后重新计算（新增项目 5 秒内生效）", async () => {
	let clock = 1_000;
	let calls = 0;
	const provider = createCanonicalRootsProvider(
		() => {
			calls += 1;
			return [`/proj-${calls}`];
		},
		{ ttlMs: 5_000, now: () => clock },
	);

	await provider();
	clock += 4_999;
	await provider();
	assert.equal(calls, 1);
	clock += 2;
	const refreshed = await provider();
	assert.equal(calls, 2);
	assert.equal(refreshed[0], "/proj-2");
});

test("并发请求合并成一次规范化", async () => {
	let calls = 0;
	const provider = createCanonicalRootsProvider(
		() => {
			calls += 1;
			return ["/a", "/b"];
		},
		{ realpath: (root) => root },
	);

	const results = await Promise.all([provider(), provider(), provider()]);
	assert.equal(calls, 1, "并发下只枚举一次");
	assert.equal(results[0].length, 2);
	assert.equal(results[0], results[1]);
});

test("缓存不吞掉规范化：8.3 短名展开成长名，重复根去重，realpath 失败保留原值", async () => {
	const provider = createCanonicalRootsProvider(() => [SHORT, SHORT, "/missing"], {
		realpath: (root) => {
			if (root === SHORT) return LONG;
			if (root === "/missing") throw new Error("ENOENT");
			return root;
		},
	});

	const roots = await provider();
	assert.equal(roots.length, 2, "重复根去重");
	assert.ok(roots.includes(LONG), "短名必须展开成长名");
	assert.ok(!roots.includes(SHORT), "短名不应留在结果里");
	assert.ok(roots.includes("/missing"), "realpath 失败时保留原值（该目录里也没有可读文件）");
});
