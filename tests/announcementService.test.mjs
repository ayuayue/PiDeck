/**
 * AnnouncementService 无服务器公告拉取纯逻辑单测。
 * 守护：feed schema 校验（坏条目丢弃/坏 feed 整包拒绝）、TTL 过滤、minVersion 版本门控、
 * 多源 fallback、全源失败保留现状、缓存落盘/重载（含过期条目再过滤）、已读持久化。
 * 全部用 fake fetch + 临时目录，不依赖真实网络与 electron。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

const require = createRequire(import.meta.url);

/** 用 TypeScript transpileModule 加载 TS 源码（项目测试惯例，见 mirrorHealth.test.mjs）。 */
function loadTsModule(filePath, deps) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (name) =>
				deps[name] ?? (() => { throw new Error(`unexpected require: ${name}`); })(),
			console,
			// 沙箱默认缺这些全局：定时调度与时间源都从注入取，这里兜底真实实现
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			TextDecoder,
			TextEncoder,
			AbortController,
			Buffer, // unwrapAtomgitContents 的 base64 解码依赖
			Date,
			JSON,
			Error,
		},
	);
	return module.exports;
}

// ── 预加载被测模块与其运行时依赖（type-only import 已被擦除，无需提供） ──
const updateSourcesMod = loadTsModule("src/shared/updateSources.ts", {});
const announcementSourcesMod = loadTsModule("src/shared/announcementSources.ts", {
	"./updateSources": updateSourcesMod,
});
const dshManifestMod = loadTsModule("src/shared/types/dshRuntimeManifest.ts", {});
const svcMod = loadTsModule("src/main/announcements/AnnouncementService.ts", {
	"node:fs": require("node:fs"),
	"node:path": require("node:path"),
	"../../shared/announcementSources": announcementSourcesMod,
	"../../shared/types/dshRuntimeManifest": dshManifestMod,
});

/** 临时 userData 目录（每个用例独立，用完清理）。 */
function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-ann-test-"));
	return dir;
}

/** 合法公告条目工厂：字段可覆盖（补丁语义）。 */
function item(patch = {}) {
	return {
		id: patch.id ?? "a1",
		title: patch.title ?? "标题",
		body: patch.body ?? "正文",
		level: patch.level ?? "info",
		publishedAt: patch.publishedAt ?? "2026-09-01T00:00:00Z",
		effectiveUntil: patch.effectiveUntil ?? "2099-01-01T00:00:00Z",
		...(patch.minVersion !== undefined ? { minVersion: patch.minVersion } : {}),
	};
}

const feedJson = (items) => JSON.stringify({ version: 1, announcements: items });

/**
 * fake fetch：按 URL 片段分发路由（match 命中第一个）；error/status/body 三选一。
 * 未命中路由直接拒绝（暴露测试配置错误，不静默）。
 */
function fetchStub(routes) {
	return (url) => {
		const route = routes.find((r) => url.includes(r.match));
		if (!route) return Promise.reject(new Error(`unexpected url: ${url}`));
		if (route.error) return Promise.reject(route.error);
		const status = route.status ?? 200;
		return Promise.resolve({
			ok: status < 400,
			status,
			arrayBuffer: async () =>
				new TextEncoder().encode(route.body ?? "").buffer,
		});
	};
}

// ── AtomGit v5 解包 ──

test("unwrapAtomgitContents：合法 base64 包裹解出原文", () => {
	const raw = feedJson([item({ id: "x" })]);
	const text = JSON.stringify({ encoding: "base64", content: Buffer.from(raw).toString("base64") });
	assert.equal(announcementSourcesMod.unwrapAtomgitContents(text), raw);
});

test("unwrapAtomgitContents：非包裹结构 / 编码异常 / JSON 损坏 → null", () => {
	assert.equal(announcementSourcesMod.unwrapAtomgitContents(JSON.stringify({ foo: "bar" })), null);
	assert.equal(announcementSourcesMod.unwrapAtomgitContents(JSON.stringify({ encoding: "utf8", content: "abc" })), null);
	assert.equal(announcementSourcesMod.unwrapAtomgitContents(JSON.stringify({ encoding: "base64", content: 42 })), null);
	assert.equal(announcementSourcesMod.unwrapAtomgitContents("not json at all"), null);
	assert.equal(announcementSourcesMod.unwrapAtomgitContents(JSON.stringify([1, 2, 3])), null);
});

// ── feed 解析 ──

test("parseAnnouncementFeed：合法条目保留并按发布时间倒序", () => {
	const items = svcMod.parseAnnouncementFeed(
		feedJson([item({ id: "old", publishedAt: "2026-08-01T00:00:00Z" }), item({ id: "new", publishedAt: "2026-09-01T00:00:00Z" })]),
	);
	assert.ok(Array.isArray(items));
	assert.equal(items.length, 2);
	assert.equal(items[0].id, "new"); // 新公告在前
});

test("parseAnnouncementFeed：坏条目丢弃、好条目保留", () => {
	const items = svcMod.parseAnnouncementFeed(
		feedJson([
			item({ id: "ok" }),
			{ id: "bad-level", title: "t", body: "b", level: "urgent", publishedAt: "2026-09-01T00:00:00Z", effectiveUntil: "2099-01-01T00:00:00Z" },
			{ id: "bad-date", title: "t", body: "b", level: "info", publishedAt: "not-a-date", effectiveUntil: "2099-01-01T00:00:00Z" },
			"not-an-object",
		]),
	);
	assert.equal(items.length, 1);
	assert.equal(items[0].id, "ok");
});

test("parseAnnouncementFeed：JSON 损坏 / version 不符 / 结构缺失 → 整包拒绝（null）", () => {
	assert.equal(svcMod.parseAnnouncementFeed("not json"), null);
	assert.equal(svcMod.parseAnnouncementFeed(JSON.stringify({ version: 2, announcements: [] })), null);
	assert.equal(svcMod.parseAnnouncementFeed(JSON.stringify({ version: 1 })), null);
	assert.equal(svcMod.parseAnnouncementFeed(JSON.stringify([1, 2])), null);
});

test("parseAnnouncementItem：字段边界校验（空 id / 超长 title / 非字符串 minVersion）", () => {
	assert.equal(svcMod.parseAnnouncementItem(item({ id: "" })), null);
	assert.equal(svcMod.parseAnnouncementItem(item({ title: "x".repeat(201) })), null);
	assert.equal(svcMod.parseAnnouncementItem(item({ body: "x".repeat(5001) })), null);
	assert.equal(svcMod.parseAnnouncementItem({ ...item(), minVersion: 1 }), null);
	// minVersion 合法字符串保留
	const ok = svcMod.parseAnnouncementItem(item({ minVersion: "0.6.6" }));
	assert.equal(ok.minVersion, "0.6.6");
});

test("parseAnnouncementItem：category 缺省 notice，flash/guide 透传，非法值退回 notice", () => {
	// 历史 feed/缓存无 category 字段 → notice（正式广播，兼容旧数据）
	const dflt = svcMod.parseAnnouncementItem(item());
	assert.equal(dflt.category, "notice");
	// 合法类别透传（flash 临时通知 / guide 指南常驻）
	for (const category of ["flash", "guide"]) {
		const parsed = svcMod.parseAnnouncementItem({ ...item(), category });
		assert.equal(parsed.category, category);
	}
	// 未知/非字符串类别不丢弃整条，按 notice 兜底（类别只影响展示语义，不判定数据合法性）
	const bad = svcMod.parseAnnouncementItem({ ...item(), category: "spam" });
	assert.equal(bad.category, "notice");
	const weird = svcMod.parseAnnouncementItem({ ...item(), category: 7 });
	assert.equal(weird.category, "notice");
});

// ── TTL + 版本门控 ──

test("filterEffectiveItems：过期条目丢弃（until <= now），未过期保留", () => {
	const now = Date.parse("2026-09-07T00:00:00Z");
	const items = [
		item({ id: "expired", effectiveUntil: "2026-09-06T00:00:00Z" }),
		item({ id: "boundary", effectiveUntil: "2026-09-07T00:00:00Z" }), // 恰好等于 now → 过期
		item({ id: "alive", effectiveUntil: "2026-09-08T00:00:00Z" }),
	];
	const kept = svcMod.filterEffectiveItems(items, now, "0.6.6");
	assert.deepEqual(kept.map((x) => x.id), ["alive"]);
});

test("shouldShowForVersion：minVersion 门控（引导升级语义，升级后不再展示）", () => {
	const entry = item({ minVersion: "0.6.6" });
	assert.equal(svcMod.shouldShowForVersion(entry, "0.6.5"), true); // 旧版本可见
	assert.equal(svcMod.shouldShowForVersion(entry, "0.6.6"), false); // 已达版本不可见
	assert.equal(svcMod.shouldShowForVersion(entry, "0.7.0"), false);
	// 无 minVersion → 所有版本可见
	assert.equal(svcMod.shouldShowForVersion(item(), "0.1.0"), true);
});

// ── 服务：多源 fallback / 全源失败 / 缓存 ──

test("refresh：主源失败 → GitHub raw 兜底成功，state=remote 且缓存落盘", async () => {
	const dir = makeTempDir();
	try {
		const snapshots = [];
		const svc = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			fetchImpl: fetchStub([
				{ match: "api.atomgit.com", status: 500 },
				{ match: "raw.githubusercontent", body: feedJson([item({ id: "via-raw" })]) },
			]),
			now: () => 1_000,
			onSnapshot: (state) => snapshots.push(state),
		});
		const state = await svc.refresh("manual");
		assert.equal(state.source, "remote");
		assert.equal(state.fetchedAt, 1_000);
		assert.equal(state.items.length, 1);
		assert.equal(state.items[0].id, "via-raw");
		assert.equal(snapshots.length, 1); // 拉取成功推送一次快照
		assert.ok(existsSync(join(dir, svcMod.ANNOUNCEMENT_CACHE_FILE)), "缓存应已落盘");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refresh：AtomGit 主源返回 v5 base64 包裹 → 解包成功且命中", async () => {
	const dir = makeTempDir();
	try {
		const svc = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			fetchImpl: fetchStub([
				{
					match: "api.atomgit.com",
					body: JSON.stringify({
						type: "file",
						encoding: "base64",
						size: 42,
						name: "announcements.json",
						path: "announcements.json",
						content: Buffer.from(feedJson([item({ id: "via-atomgit" })])).toString("base64"),
					}),
				},
			]),
			now: () => 1_000,
		});
		const state = await svc.refresh("manual");
		assert.equal(state.source, "remote");
		assert.equal(state.items.length, 1);
		assert.equal(state.items[0].id, "via-atomgit");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refresh：AtomGit 包裹异常（非 v5 结构）→ 自动 fallback raw", async () => {
	const dir = makeTempDir();
	try {
		const svc = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			// AtomGit 返回了非包裹结构（如被代理劫持成别的 JSON）——与解包失败同等处理
			fetchImpl: fetchStub([
				{ match: "api.atomgit.com", body: JSON.stringify({ foo: "bar" }) },
				{ match: "raw.githubusercontent", body: feedJson([item({ id: "via-raw" })]) },
			]),
			now: () => 1_000,
		});
		const state = await svc.refresh("manual");
		assert.equal(state.source, "remote");
		assert.equal(state.items.length, 1);
		assert.equal(state.items[0].id, "via-raw");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refresh：全部源失败 → 保留现状不覆盖、不抛出", async () => {
	const dir = makeTempDir();
	try {
		const svc = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			fetchImpl: async () => {
				throw new Error("network down");
			},
			now: () => 1_000,
		});
		const after = await svc.refresh("manual");
		// 逐字段断言而非整个 state deepEqual（vm 沙箱跨 realm 原型差异）
		assert.equal(after.source, "cache"); // 初始空态
		assert.equal(after.items.length, 0);
		assert.equal(after.fetchedAt, null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("缓存重载：重启后 source=cache，过期条目在加载时被再过滤", async () => {
	const dir = makeTempDir();
	try {
		// 第一次拉取写入含过期条目的全量缓存
		const first = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			fetchImpl: fetchStub([
				{
					match: "api.atomgit.com",
					body: JSON.stringify({
						encoding: "base64",
						content: Buffer.from(
							feedJson([
								item({ id: "fresh", effectiveUntil: "2099-01-01T00:00:00Z" }),
								item({ id: "stale", effectiveUntil: "2026-01-01T00:00:00Z" }),
							]),
						).toString("base64"),
					}),
				},
			]),
			now: () => Date.parse("2026-09-07T00:00:00Z"),
		});
		await first.refresh("manual");
		// 新实例（模拟重启）：同目录读缓存
		const second = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			fetchImpl: async () => {
				throw new Error("should not fetch");
			},
			now: () => Date.parse("2026-09-07T00:00:00Z"),
		});
		second.start();
		try {
			const state = second.getState();
			assert.equal(state.source, "cache");
			assert.deepEqual(state.items.map((x) => x.id), ["fresh"]); // 过期条目消失
		} finally {
			second.stop(); // 清掉启动定时器，避免挂起句柄
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("缓存损坏：读失败走空态，不抛出", () => {
	const dir = makeTempDir();
	try {
		const svc = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			now: () => 1_000,
		});
		require("node:fs").writeFileSync(join(dir, svcMod.ANNOUNCEMENT_CACHE_FILE), "{broken");
		svc.start();
		try {
			const state = svc.getState();
			assert.equal(state.items.length, 0);
			assert.equal(state.source, "cache");
		} finally {
			svc.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 已读集合 ──

test("markRead：幂等追加；markAllRead 覆盖当前可见条目；readIds 跨实例持久化", async () => {
	const dir = makeTempDir();
	try {
		const svc = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			fetchImpl: fetchStub([
				{
					match: "api.atomgit.com",
					body: JSON.stringify({
						encoding: "base64",
						content: Buffer.from(feedJson([item({ id: "a1" }), item({ id: "a2" })])).toString("base64"),
					}),
				},
			]),
			now: () => 1_000,
		});
		await svc.refresh("manual");
		svc.markRead("a1");
		svc.markRead("a1"); // 幂等
		// vm 沙箱内创建的数组原型与宿主不同，必须 Array.from 转换后再 deepEqual
		assert.deepEqual(Array.from(svc.getState().readIds), ["a1"]);
		svc.markAllRead();
		assert.deepEqual(Array.from(svc.getState().readIds).sort(), ["a1", "a2"]);
		// 新实例读回已读集合
		const second = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			now: () => 1_000,
		});
		second.start();
		try {
			assert.deepEqual(Array.from(second.getState().readIds).sort(), ["a1", "a2"]);
		} finally {
			second.stop();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("markRead：非法入参静默忽略（边界防御，不抛不崩）", () => {
	const dir = makeTempDir();
	try {
		const svc = new svcMod.AnnouncementService({
			userDataDir: dir,
			appVersion: "0.6.6",
			now: () => 1_000,
		});
		svc.markRead("");
		svc.markRead("x".repeat(129));
		assert.deepEqual(Array.from(svc.getState().readIds), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
