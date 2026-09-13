/**
 * atomgitNoCacheBypass 纯函数单元测试。
 * 背景：AtomGit/GitCode 的 releases/download 路由对任何 query 返回 404，
 * electron-updater 检查更新必带 noCache 参数，需在 webRequest 层剥离。
 * 这里只测可脱离 Electron 运行的纯函数；注册逻辑依赖真实 session，不在此测。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	ATOMGIT_DOWNLOAD_PATH_PREFIXES,
	ATOMGIT_DOWNLOAD_URL_PATTERNS,
	stripNoCacheQuery,
	shouldStripNoCache,
} = loadTsCommonJs("src/main/update/atomgitNoCacheBypass.ts", {
	stubs: {},
});

test("stripNoCacheQuery 剥离 electron-updater 的 noCache 参数", () => {
	assert.equal(
		stripNoCacheQuery(
			"https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml?noCache=1k2c2nunv",
		),
		"https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml",
	);
});

test("stripNoCacheQuery 保留其他参数，只删 noCache", () => {
	assert.equal(
		stripNoCacheQuery(
			"https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml?foo=1&noCache=abc&bar=2",
		),
		"https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml?foo=1&bar=2",
	);
});

test("stripNoCacheQuery 对无参数或非法 URL 原样返回", () => {
	assert.equal(
		stripNoCacheQuery("https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml"),
		"https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml",
	);
	assert.equal(stripNoCacheQuery("not-a-url noCache=1"), "not-a-url noCache=1");
});

test("shouldStripNoCache 只命中镜像下载前缀且携带 noCache 的请求", () => {
	// 命中：AtomGit / GitCode 下载路径 + noCache
	assert.equal(
		shouldStripNoCache(
			"https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml?noCache=abc",
		),
		true,
	);
	assert.equal(
		shouldStripNoCache(
			"https://gitcode.com/ayuayue/PiDeck/releases/download/v0.7.5/latest.yml?noCache=abc",
		),
		true,
	);
	// 不命中：无 noCache 参数
	assert.equal(
		shouldStripNoCache("https://atomgit.com/ayuayue/PiDeck/releases/download/latest/latest.yml"),
		false,
	);
	// 不命中：非下载路径（公告 API 等在同一主机的其它用途）
	assert.equal(
		shouldStripNoCache("https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases?noCache=abc"),
		false,
	);
	// 不命中：GitHub 官方链路（正常支持 query，无需剥除）
	assert.equal(
		shouldStripNoCache(
			"https://github.com/ayuayue/PiDeck/releases/latest/download/latest.yml?noCache=abc",
		),
		false,
	);
});

test("ATOMGIT_DOWNLOAD_URL_PATTERNS 与前缀一一对应且带通配尾部", () => {
	// loadTsCommonJs 沙箱导出数组 prototype 不同，deepStrictEqual 会误报，改用 join 断言
	assert.equal(
		ATOMGIT_DOWNLOAD_URL_PATTERNS.join("|"),
		"https://atomgit.com/ayuayue/PiDeck/releases/download/*|https://gitcode.com/ayuayue/PiDeck/releases/download/*",
	);
	assert.equal(ATOMGIT_DOWNLOAD_PATH_PREFIXES.join("|"),
		"https://atomgit.com/ayuayue/PiDeck/releases/download/|https://gitcode.com/ayuayue/PiDeck/releases/download/",
	);
});