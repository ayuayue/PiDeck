import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { searchHostPluginMarket, clearHostPluginMarketCache, parseRegistryEntries, HOST_PLUGIN_MARKET_TOPIC } = loadTsCommonJs("src/main/plugins/hostPluginMarket.ts");

const REGISTRY_URL = "https://raw.githubusercontent.com/ayuayue/pideck-plugins/main/registry.json";
const GITHUB_SEARCH_URL = `https://api.github.com/search/repositories?q=topic:${HOST_PLUGIN_MARKET_TOPIC}&sort=stars&order=desc&per_page=30`;

const registryPayload = (plugins) => ({ schemaVersion: 1, plugins });

const githubSearchPayload = (items) => ({ total_count: items.length, items });

const githubItem = (overrides = {}) => ({
	full_name: "someone/their-plugin",
	default_branch: "main",
	description: "a third-party panel",
	stargazers_count: 7,
	license: { spdx_id: "MIT" },
	pushed_at: "2026-01-02T03:04:05Z",
	homepage: "https://example.com",
	fork: false,
	archived: false,
	...overrides,
});

const rootManifest = (overrides = {}) => ({
	schemaVersion: 1,
	apiVersion: 1,
	id: "their-plugin",
	name: "Their Plugin",
	version: "2.1.0",
	description: "manifest description",
	permissions: ["sessions.read"],
	contributes: { panels: [{ id: "main", title: "Their Plugin", entry: "app.html", icon: "bar-chart", presentation: "page" }], commands: [] },
	...overrides,
});

/**
 * 假 fetch：按 URL 精确路由。未命中的 URL 抛错，避免测试悄悄依赖真实网络。
 * 返回 `{ fetchImpl, calls }`，calls 用来断言缓存与请求次数。
 */
function fakeFetch(routes) {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		const route = routes[url];
		if (route === undefined) throw new Error(`unexpected fetch: ${url}`);
		if (route instanceof Error) throw route;
		return {
			ok: route.status >= 200 && route.status < 300,
			status: route.status,
			json: async () => route.body,
		};
	};
	return { fetchImpl, calls };
}

const countOf = (calls, url) => calls.filter((call) => call === url).length;

/**
 * `loadTsCommonJs` 在独立 realm 里求值：模块内部 `[]` 字面量造出的数组原型与本测试 realm 不同，
 * 而 `assert.deepEqual`（strict）会比较原型。跨 realm 比较前先把数组搬进本 realm。
 */
const own = (value) => [...value];

test("merges both sources with the curated registry first and community results after", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl } = fakeFetch({
		[REGISTRY_URL]: { status: 200, body: registryPayload([{ id: "session-stats", name: "会话统计", repo: "ayuayue/pideck-plugins", subpath: "plugins/session-stats", author: "ayuayue", license: "MIT" }]) },
		[GITHUB_SEARCH_URL]: { status: 200, body: githubSearchPayload([githubItem()]) },
		["https://raw.githubusercontent.com/someone/their-plugin/main/pideck-plugin.json"]: { status: 200, body: rootManifest() },
	});
	const result = await searchHostPluginMarket({ keyword: "", fetchImpl });
	assert.deepEqual(
		own(result.entries).map((entry) => [entry.id, entry.source]),
		[
			["session-stats", "registry"],
			["their-plugin", "github"],
		],
	);
	assert.deepEqual(own(result.warnings), []);
	// registry 的 subpath 要拼进安装链接：它比「装整仓」精确。
	assert.equal(result.entries[0].installUrl, "https://github.com/ayuayue/pideck-plugins/tree/main/plugins/session-stats");
	// 社区源固定整仓安装，让 downloadGitHubPlugin 自己问默认分支。
	assert.equal(result.entries[1].installUrl, "https://github.com/someone/their-plugin");
});

test("deduplicates by repository, keeping the curated entry over the community one", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl } = fakeFetch({
		[REGISTRY_URL]: { status: 200, body: registryPayload([{ id: "session-groups", name: "会话分组", repo: "Lamb-Yang/pideck-plugin", ref: "main", author: "Lamb-Yang", license: "MIT" }]) },
		[GITHUB_SEARCH_URL]: { status: 200, body: githubSearchPayload([githubItem({ full_name: "Lamb-Yang/pideck-plugin" })]) },
		["https://raw.githubusercontent.com/Lamb-Yang/pideck-plugin/main/pideck-plugin.json"]: { status: 200, body: rootManifest({ id: "session-groups" }) },
	});
	const result = await searchHostPluginMarket({ keyword: "", fetchImpl });
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0].source, "registry");
	assert.equal(result.entries[0].installUrl, "https://github.com/Lamb-Yang/pideck-plugin/tree/main");
});

test("keeps every curated entry from one monorepo while still dropping its community duplicate", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl } = fakeFetch({
		[REGISTRY_URL]: {
			status: 200,
			body: registryPayload([
				{ id: "session-stats", name: "会话统计", repo: "ayuayue/pideck-plugins", subpath: "plugins/session-stats", author: "ayuayue", license: "MIT" },
				{ id: "project-notes", name: "项目便签", repo: "ayuayue/pideck-plugins", subpath: "plugins/project-notes", author: "ayuayue", license: "MIT" },
			]),
		},
		// 同一个 monorepo 自己也打了 topic：它只能整仓安装，所以应该被丢掉。
		[GITHUB_SEARCH_URL]: { status: 200, body: githubSearchPayload([githubItem({ full_name: "ayuayue/pideck-plugins" })]) },
		["https://raw.githubusercontent.com/ayuayue/pideck-plugins/main/pideck-plugin.json"]: { status: 200, body: rootManifest({ id: "pideck-plugins" }) },
	});
	const result = await searchHostPluginMarket({ keyword: "", fetchImpl });
	assert.deepEqual(
		own(result.entries).map((entry) => [entry.id, entry.source]),
		[
			["session-stats", "registry"],
			["project-notes", "registry"],
		],
	);
});

test("filters both sources by keyword across name, description, tags and repo", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl } = fakeFetch({
		[REGISTRY_URL]: {
			status: 200,
			body: registryPayload([
				{ id: "session-stats", name: "会话统计", repo: "ayuayue/pideck-plugins", subpath: "plugins/session-stats", tags: ["sessions", "charts"], author: "ayuayue", license: "MIT" },
				{ id: "project-notes", name: "项目便签", repo: "ayuayue/pideck-plugins", subpath: "plugins/project-notes", tags: ["notes"], author: "ayuayue", license: "MIT" },
			]),
		},
		[GITHUB_SEARCH_URL]: {
			status: 200,
			body: githubSearchPayload([githubItem({ full_name: "someone/charts", description: "chart panel" }), githubItem({ full_name: "someone/other", description: "unrelated" })]),
		},
		["https://raw.githubusercontent.com/someone/charts/main/pideck-plugin.json"]: { status: 200, body: rootManifest({ id: "charts", name: "Charts" }) },
		["https://raw.githubusercontent.com/someone/other/main/pideck-plugin.json"]: { status: 200, body: rootManifest({ id: "other", name: "Other" }) },
	});
	const result = await searchHostPluginMarket({ keyword: "CHARTS", fetchImpl });
	// 关键词大小写无关；tags 命中 registry，description 命中社区源。
	assert.deepEqual(
		own(result.entries)
			.map((entry) => entry.id)
			.sort(),
		["charts", "session-stats"],
	);
});

test("a failing source degrades to a warning while the other still returns entries", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl } = fakeFetch({
		[REGISTRY_URL]: new Error("registry unreachable"),
		[GITHUB_SEARCH_URL]: { status: 200, body: githubSearchPayload([githubItem()]) },
		["https://raw.githubusercontent.com/someone/their-plugin/main/pideck-plugin.json"]: { status: 200, body: rootManifest() },
	});
	const result = await searchHostPluginMarket({ keyword: "", fetchImpl });
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0].source, "github");
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /^registry: registry unreachable$/);
});

test("throws only when both sources fail", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl } = fakeFetch({
		[REGISTRY_URL]: { status: 503, body: null },
		[GITHUB_SEARCH_URL]: { status: 500, body: null },
	});
	await assert.rejects(() => searchHostPluginMarket({ keyword: "", fetchImpl }), /registry: registry HTTP 503/);
});

test("caches each source independently so repeated searches do not re-hit the network", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl, calls } = fakeFetch({
		[REGISTRY_URL]: { status: 200, body: registryPayload([{ id: "session-stats", name: "会话统计", repo: "ayuayue/pideck-plugins", subpath: "plugins/session-stats", author: "ayuayue", license: "MIT" }]) },
		[GITHUB_SEARCH_URL]: { status: 200, body: githubSearchPayload([githubItem()]) },
		["https://raw.githubusercontent.com/someone/their-plugin/main/pideck-plugin.json"]: { status: 200, body: rootManifest() },
	});
	await searchHostPluginMarket({ keyword: "session", fetchImpl });
	await searchHostPluginMarket({ keyword: "their", fetchImpl });
	await searchHostPluginMarket({ keyword: "", fetchImpl });
	assert.equal(countOf(calls, REGISTRY_URL), 1);
	assert.equal(countOf(calls, GITHUB_SEARCH_URL), 1);
	// manifest 探测也只在第一次拉取时发生。
	assert.equal(countOf(calls, "https://raw.githubusercontent.com/someone/their-plugin/main/pideck-plugin.json"), 1);
});

test("skips community repositories without a root manifest, and fork or archived ones entirely", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl, calls } = fakeFetch({
		[REGISTRY_URL]: { status: 200, body: registryPayload([]) },
		[GITHUB_SEARCH_URL]: {
			status: 200,
			body: githubSearchPayload([githubItem({ full_name: "someone/forked", fork: true }), githubItem({ full_name: "someone/archived", archived: true }), githubItem({ full_name: "someone/no-manifest" }), githubItem({ full_name: "someone/deep", description: "manifest lives in a subdirectory" })]),
		},
		["https://raw.githubusercontent.com/someone/no-manifest/main/pideck-plugin.json"]: { status: 404, body: null },
		// 单仓库多插件必须走 registry 的 subpath：根上没有 manifest 就搜不到。
		["https://raw.githubusercontent.com/someone/deep/main/pideck-plugin.json"]: { status: 404, body: null },
	});
	const result = await searchHostPluginMarket({ keyword: "", fetchImpl });
	assert.deepEqual(own(result.entries), []);
	// fork/archived 在探 manifest 之前就被排除，不该产生任何请求。
	assert.ok(!calls.some((call) => call.includes("someone/forked") || call.includes("someone/archived")));
});

test("treats NOASSERTION as no license and reads icon, permissions and stars off the root manifest", async () => {
	clearHostPluginMarketCache();
	const { fetchImpl } = fakeFetch({
		[REGISTRY_URL]: { status: 200, body: registryPayload([]) },
		[GITHUB_SEARCH_URL]: { status: 200, body: githubSearchPayload([githubItem({ license: { spdx_id: "NOASSERTION" }, stargazers_count: 42 })]) },
		["https://raw.githubusercontent.com/someone/their-plugin/main/pideck-plugin.json"]: {
			status: 200,
			body: rootManifest({
				permissions: ["sessions.read", "sessions.read.workspace"],
				contributes: {
					panels: [
						{ id: "main", title: "T", entry: "app.html", icon: "bar-chart", presentation: "page" },
						{ id: "side", title: "S", entry: "side.html", presentation: "popover" },
					],
					commands: [],
				},
			}),
		},
	});
	const result = await searchHostPluginMarket({ keyword: "", fetchImpl });
	const entry = result.entries[0];
	assert.equal(entry.license, undefined);
	assert.equal(entry.stars, 42);
	assert.equal(entry.icon, "bar-chart");
	assert.deepEqual(own(entry.permissions), ["sessions.read", "sessions.read.workspace"]);
	// 多面板形态去重后一起展示。
	assert.deepEqual(own(entry.presentations), ["page", "popover"]);
	assert.equal(entry.pushedAt, "2026-01-02T03:04:05Z");
});

test("parseRegistryEntries drops malformed entries instead of offering an install that cannot work", () => {
	const entries = parseRegistryEntries(
		registryPayload([
			{ id: "good", name: "Good", repo: "owner/repo", author: "a", license: "MIT" },
			{ name: "no id", repo: "owner/repo" },
			{ id: "no-repo" },
			{ id: "bad-repo", repo: "not-a-repo" },
			{ id: "bad-ref", repo: "owner/repo", ref: "bad ref" },
			{ id: "bad-subpath", repo: "owner/repo", subpath: "../escape" },
			{ id: "dot-segment", repo: "owner/repo", subpath: "plugins/./x" },
			{ id: "empty-segment", repo: "owner/repo", subpath: "plugins//x" },
			"not an object",
			null,
		]),
	);
	assert.deepEqual(
		own(entries).map((entry) => entry.id),
		["good"],
	);
	assert.equal(entries[0].name, "Good");
	assert.equal(entries[0].installUrl, "https://github.com/owner/repo");
	// 顶层形态不对时返回空数组而不是抛错。
	assert.deepEqual(own(parseRegistryEntries({ schemaVersion: 1 })), []);
	assert.deepEqual(own(parseRegistryEntries(null)), []);
	assert.deepEqual(parseRegistryEntries({ plugins: [{ id: "x", repo: "o/r", ref: "dev", subpath: "plugins/x" }] })[0].installUrl, "https://github.com/o/r/tree/dev/plugins/x");
});
