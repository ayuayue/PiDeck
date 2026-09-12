import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ChangelogService } = loadTsCommonJs("src/main/update/ChangelogService.ts");

const REAL_CHANGELOG = `## v0.7.5-beta - 2026-09-09

### 🚀 新功能
- **缓存** — 本地复用，离线兜底。

## v0.7.4 - 2026-09-08

### 🐛 修复
- **暗色模式** — 选中态。
`;

const NEXT_CHANGELOG = `## v0.7.6 - 2026-09-10

### 🚀 新功能
- **新版本内容**。

## v0.7.5-beta - 2026-09-09

- 上一版。
`;

function jsonResponse(body, { status = 200 } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		arrayBuffer: async () => new TextEncoder().encode(body).buffer,
	};
}

/** AtomGit OpenAPI contents 响应替身。 */
function atomgitContentsResponse(markdown) {
	return jsonResponse(
		JSON.stringify({
			type: "file",
			encoding: "base64",
			content: Buffer.from(markdown, "utf8").toString("base64"),
		}),
	);
}

const ATOMGIT_API_URL =
	"https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/CHANGELOG.zh-CN.md?ref=main";

/** 每例独立临时缓存目录，用完即删。 */
function makeCacheDir() {
	return mkdtempSync(join(tmpdir(), "pi-changelog-cache-"));
}

/** 按 URL 分派的 fetch 替身，记录全部调用。 */
function fetchByUrl(map, calls = []) {
	return async (url) => {
		calls.push(String(url));
		const handler = map[String(url)];
		if (!handler) throw new Error(`unexpected fetch: ${url}`);
		return typeof handler === "function" ? handler() : handler;
	};
}

test("fresh cache is reused without touching the network", async () => {
	const cacheDir = makeCacheDir();
	try {
		const calls = [];
		const service = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			fetchImpl: fetchByUrl({ [ATOMGIT_API_URL]: atomgitContentsResponse(REAL_CHANGELOG) }, calls),
		});

		const first = await service.getChangelog("zh");
		assert.ok(first);
		assert.equal(first.fromCache, false);
		assert.equal(calls.length, 1, "首次需走网络");

		const second = await service.getChangelog("zh");
		assert.ok(second);
		assert.equal(second.fromCache, true, "TTL 内应复用缓存");
		assert.equal(second.stale, false);
		assert.equal(calls.length, 1, "第二次不应再打网络");
		assert.equal(second.markdown, first.markdown);
		assert.equal(second.versionCount, first.versionCount);
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

test("expired cache triggers a refetch that overwrites it", async () => {
	const cacheDir = makeCacheDir();
	try {
		const calls = [];
		// TTL=0：任何缓存立即过期
		const service = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			cacheTtlMs: 0,
			fetchImpl: fetchByUrl(
				{
					[ATOMGIT_API_URL]: () =>
						atomgitContentsResponse(calls.length <= 1 ? REAL_CHANGELOG : NEXT_CHANGELOG),
				},
				calls,
			),
		});

		const first = await service.getChangelog("zh");
		assert.match(first.markdown, /v0\.7\.5-beta/);
		const second = await service.getChangelog("zh");
		assert.equal(second.fromCache, false, "TTL=0 时缓存立即过期，重新走网络");
		assert.match(second.markdown, /v0\.7\.6/, "拉到的是新内容");
		assert.equal(calls.length, 2);

		// 缓存文件被新内容覆盖
		const cached = readFileSync(join(cacheDir, "CHANGELOG.zh-CN.md"), "utf8");
		assert.match(cached, /v0\.7\.6/);
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

test("forceRefresh bypasses a fresh cache and overwrites it", async () => {
	const cacheDir = makeCacheDir();
	try {
		const calls = [];
		const service = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			fetchImpl: fetchByUrl(
				{
					[ATOMGIT_API_URL]: () =>
						atomgitContentsResponse(calls.length === 0 ? REAL_CHANGELOG : NEXT_CHANGELOG),
				},
				calls,
			),
		});

		await service.getChangelog("zh");
		const refreshed = await service.getChangelog("zh", { forceRefresh: true });
		assert.equal(refreshed.fromCache, false);
		assert.equal(refreshed.stale, false);
		assert.match(refreshed.markdown, /v0\.7\.6/, "强制刷新拿到最新");
		assert.match(readFileSync(join(cacheDir, "CHANGELOG.zh-CN.md"), "utf8"), /v0\.7\.6/);
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

test("network failure falls back to the cached copy marked stale", async () => {
	const cacheDir = makeCacheDir();
	try {
		const service = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			fetchImpl: fetchByUrl({ [ATOMGIT_API_URL]: atomgitContentsResponse(REAL_CHANGELOG) }),
		});
		await service.getChangelog("zh");

		// 之后网络全挂且缓存已过期（TTL=0）：退回缓存并标注 stale
		const offline = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			cacheTtlMs: 0,
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		const result = await offline.getChangelog("zh");
		assert.ok(result, "离线时应有缓存兜底");
		assert.equal(result.fromCache, true);
		assert.equal(result.stale, true, "网络失败退回的缓存必须标 stale");
		assert.match(result.markdown, /v0\.7\.5-beta/);
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

test("no cache and no network yields null (UI degrades to browser link)", async () => {
	const cacheDir = makeCacheDir();
	try {
		const service = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		assert.equal(await service.getChangelog("zh"), null);
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

test("languages are cached independently and corrupt cache entries are ignored", async () => {
	const cacheDir = makeCacheDir();
	try {
		const enUrl =
			"https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/contents/CHANGELOG.md?ref=main";
		const calls = [];
		const service = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			fetchImpl: fetchByUrl(
				{
					[ATOMGIT_API_URL]: atomgitContentsResponse(REAL_CHANGELOG),
					[enUrl]: jsonResponse('{"message":"Not Found"}'), // 英文仓库里不存在 → 形态异常回退
					"https://raw.githubusercontent.com/ayuayue/PiDeck/main/CHANGELOG.md":
						jsonResponse(REAL_CHANGELOG),
				},
				calls,
			),
		});

		const zh = await service.getChangelog("zh");
		assert.ok(zh);
		const en = await service.getChangelog("en");
		assert.ok(en);
		assert.equal(en.source, "github", "英文走 GitHub 回退");
		// zh 的缓存没被 en 污染：离线（TTL=0 强制走网络）再取 zh 仍能靠缓存兜底
		const offline = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			cacheTtlMs: 0,
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		const zhAgain = await offline.getChangelog("zh");
		assert.ok(zhAgain);
		assert.equal(zhAgain.stale, true);
		assert.match(zhAgain.markdown, /v0\.7\.5-beta/);

		// 坏缓存（meta 缺失）被忽略而不是当成合法内容
		writeFileSync(join(cacheDir, "CHANGELOG.md"), REAL_CHANGELOG, "utf8");
		rmSync(join(cacheDir, "meta.json"), { force: true });
		const broken = new ChangelogService({
			source: () => "atomgit",
			cacheDir,
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		assert.equal(await broken.getChangelog("en"), null, "meta 缺失的缓存不可用");
	} finally {
		rmSync(cacheDir, { recursive: true, force: true });
	}
});

test("cache is disabled when no cacheDir is provided (pure network semantics)", async () => {
	const calls = [];
	const service = new ChangelogService({
		source: () => "atomgit",
		fetchImpl: fetchByUrl({ [ATOMGIT_API_URL]: atomgitContentsResponse(REAL_CHANGELOG) }, calls),
	});
	const first = await service.getChangelog("zh");
	assert.ok(first);
	assert.equal(first.fromCache, false);
	const second = await service.getChangelog("zh");
	assert.equal(second.fromCache, false, "无 cacheDir 时每次都走网络");
	assert.equal(calls.length, 2);
	// 也不该在任何地方写缓存文件（tmpdir 里没有这次会话的目录，断言仅保证不抛错即可）
});
