import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseAtomGitPluginUrl, isAtomGitPluginUrl, downloadAtomGitPlugin } = loadTsCommonJs("src/main/plugins/hostPluginAtomGit.ts");
const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");

const API = "https://api.atomgit.com/api/v5/repos/ayuayue/pideck-plugins";

function manifest(overrides = {}) {
	return { schemaVersion: 1, apiVersion: 1, id: "example.viewer", name: "Viewer", version: "1.0.0", permissions: ["sessions.read"], contributes: { panels: [{ id: "context", title: "Context", entry: "app.html" }], commands: [] }, ...overrides };
}

/** 假 fetch：按 URL 精确路由；返回真实 Response，让代码走 headers/body 的真实路径。 */
function fakeFetch(routes) {
	const calls = [];
	const impl = async (url) => {
		calls.push(url);
		const route = routes[url];
		if (route === undefined) return new Response("", { status: 404 });
		if (route instanceof Error) throw route;
		if (route instanceof Response) return route;
		const body = typeof route.body === "string" || route.body instanceof Uint8Array ? route.body : JSON.stringify(route.body ?? null);
		return new Response(body, { status: route.status ?? 200, headers: route.headers });
	};
	impl.calls = calls;
	return impl;
}

const files = (paths) => ({ status: 200, body: paths });

function pluginRoutes(prefix, ref = "main", { extra = [] } = {}) {
	const paths = [`${prefix}/pideck-plugin.json`, `${prefix}/app.html`, `${prefix}/README.md`, ...extra];
	const routes = {
		[`${API}/file_list?ref_name=${encodeURIComponent(ref)}`]: files(paths),
		[`${API}/raw/${prefix}/pideck-plugin.json?ref=${encodeURIComponent(ref)}`]: { status: 200, body: JSON.stringify(manifest()) },
		[`${API}/raw/${prefix}/app.html?ref=${encodeURIComponent(ref)}`]: { status: 200, body: "<!doctype html><title>ok</title>" },
		[`${API}/raw/${prefix}/README.md?ref=${encodeURIComponent(ref)}`]: { status: 200, body: "# viewer" },
	};
	return routes;
}

test("atomgit plugin urls accept repo and tree links, reject other hosts and paths", () => {
	const source = (raw) => {
		const parsed = parseAtomGitPluginUrl(raw);
		return `${parsed.owner}/${parsed.repo}/${parsed.ref ?? ""}`;
	};
	assert.equal(source("https://atomgit.com/ayuayue/pideck-plugins"), "ayuayue/pideck-plugins/");
	assert.equal(source("  atomgit.com/ayuayue/pideck-plugins.git/  "), "ayuayue/pideck-plugins/");
	assert.equal(source("https://atomgit.com/a/b/tree/dev/plugins/x"), "a/b/dev/plugins/x");
	assert.equal(source("https://www.atomgit.com/a/b/tree"), "a/b/");
	assert.equal(isAtomGitPluginUrl("https://atomgit.com/a/b"), true);
	assert.equal(isAtomGitPluginUrl("https://github.com/a/b"), false);
	assert.equal(isAtomGitPluginUrl("http://atomgit.com/a/b"), false);
	for (const bad of ["", "http://atomgit.com/a/b", "https://api.atomgit.com/a/b", "https://gitlab.com/a/b", "https://atomgit.com/a", "https://atomgit.com/a/b/blob/main/pideck-plugin.json", "https://atomgit.com/a/b?tab=readme", "https://user:pw@atomgit.com/a/b", "https://atomgit.com/a/b/tree/../etc"]) {
		assert.throws(() => parseAtomGitPluginUrl(bad), /invalid-atomgit-url/, `应拒绝 ${bad}`);
	}
});

test("download resolves the default branch, lists files and fetches only the package root", async () => {
	const fetchImpl = fakeFetch({
		[`${API}/branches`]: {
			status: 200,
			body: [
				{ name: "main", default_branch: true },
				{ name: "dev", default_branch: false },
			],
		},
		...pluginRoutes("plugins/viewer", "main", { extra: ["plugins/other/app.html", "docs/readme.md"] }),
		// 包根之外的文件不该被请求：路由没配，请求到会返回 599 / download-failed。
	});
	const download = await downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins", { fetchImpl });
	assert.equal(download.ref, "main");
	assert.equal(download.subpath, undefined);
	assert.equal(
		download.files
			.map((file) => file.path)
			.sort()
			.join(","),
		"README.md,app.html,pideck-plugin.json",
	);
	assert.equal(JSON.parse(download.files.find((file) => file.path === "pideck-plugin.json").bytes.toString("utf8")).id, "example.viewer");
	// 只按包根下载：plugins/other 与 docs 的文件没有出现在请求里。
	assert.ok(!fetchImpl.calls.some((call) => call.includes("plugins/other") || call.includes("docs/")));
	assert.ok(fetchImpl.calls.includes(`${API}/branches`));
	assert.ok(fetchImpl.calls.includes(`${API}/file_list?ref_name=main`));
});

test("explicit tree links try the longest ref first, then shorten it into a subdirectory", async () => {
	const routes = {
		[`${API}/file_list?ref_name=${encodeURIComponent("feature/x/plugins/viewer")}`]: files([]),
		...pluginRoutes("plugins/viewer", "feature/x"),
	};
	const fetchImpl = fakeFetch(routes);
	const download = await downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/feature/x/plugins/viewer", { fetchImpl });
	assert.equal(download.ref, "feature/x");
	assert.equal(download.subpath, "plugins/viewer");
	assert.equal(
		download.files
			.map((file) => file.path)
			.sort()
			.join(","),
		"README.md,app.html,pideck-plugin.json",
	);
	assert.equal(fetchImpl.calls[0], `${API}/file_list?ref_name=${encodeURIComponent("feature/x/plugins/viewer")}`);
});

test("falls back to main/master when branches are unavailable", async () => {
	const fetchImpl = fakeFetch({
		[`${API}/branches`]: { status: 500, body: null },
		[`${API}/file_list?ref_name=main`]: files([]),
		...pluginRoutes("plugins/viewer", "master"),
	});
	const download = await downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins", { fetchImpl });
	assert.equal(download.ref, "master");
});

test("missing repo or empty file lists become plugin-not-found", async () => {
	const fetchImpl = fakeFetch({
		[`${API}/branches`]: { status: 404, body: null },
		[`${API}/file_list?ref_name=main`]: { status: 404, body: null },
		[`${API}/file_list?ref_name=master`]: files([]),
	});
	await assert.rejects(() => downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins", { fetchImpl }), /plugin-not-found/);
});

test("ambiguous manifests and missing manifests fail with actionable codes", async () => {
	const duplicate = fakeFetch({ [`${API}/file_list?ref_name=main`]: files(["a/pideck-plugin.json", "b/pideck-plugin.json"]) });
	await assert.rejects(() => downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/main", { fetchImpl: duplicate }), /plugin-manifest-ambiguous/);
	const missing = fakeFetch({ [`${API}/file_list?ref_name=main`]: files(["README.md", "docs/app.html"]) });
	await assert.rejects(() => downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/main", { fetchImpl: missing }), /missing-manifest/);
	// 路径穿越的文件不参与包根判定。
	const escape = fakeFetch({ [`${API}/file_list?ref_name=main`]: files(["../outside/pideck-plugin.json", "app.html"]) });
	await assert.rejects(() => downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/main", { fetchImpl: escape }), /missing-manifest/);
});

test("package budgets stop oversized packages before downloading every file", async () => {
	const many = Array.from({ length: 120 }, (_, index) => `assets/${index}.html`);
	const fetchImpl = fakeFetch({ [`${API}/file_list?ref_name=main`]: files(["pideck-plugin.json", ...many]) });
	await assert.rejects(() => downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/main", { fetchImpl }), /package-too-large/);
	assert.ok(fetchImpl.calls.every((call) => !call.includes("/raw/")));

	const tooBig = fakeFetch({
		[`${API}/file_list?ref_name=main`]: files(["pideck-plugin.json", "huge.html"]),
		[`${API}/raw/pideck-plugin.json?ref=main`]: { status: 200, body: JSON.stringify(manifest()) },
		[`${API}/raw/huge.html?ref=main`]: { status: 200, body: "", headers: { "content-length": String(4 * 1024 * 1024 + 1) } },
	});
	await assert.rejects(() => downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/main", { fetchImpl: tooBig }), /asset-too-large/);
});

test("raw failures become download-failed instead of silently skipping files", async () => {
	const fetchImpl = fakeFetch({
		[`${API}/file_list?ref_name=main`]: files(["pideck-plugin.json", "app.html"]),
		[`${API}/raw/pideck-plugin.json?ref=main`]: { status: 200, body: JSON.stringify(manifest()) },
		[`${API}/raw/app.html?ref=main`]: { status: 503, body: null },
	});
	await assert.rejects(() => downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/main", { fetchImpl }), /download-failed/);
});

test("installs AtomGit packages through the same trust path as archives and GitHub", async () => {
	const fetchImpl = fakeFetch({
		[`${API}/file_list?ref_name=main`]: files(["plugins/viewer/pideck-plugin.json", "plugins/viewer/app.html"]),
		[`${API}/raw/plugins/viewer/pideck-plugin.json?ref=main`]: { status: 200, body: JSON.stringify(manifest()) },
		[`${API}/raw/plugins/viewer/app.html?ref=main`]: { status: 200, body: "<!doctype html><title>ok</title>" },
	});
	const download = await downloadAtomGitPlugin("https://atomgit.com/ayuayue/pideck-plugins/tree/main/plugins/viewer", { fetchImpl });
	const root = await mkdtemp(join(tmpdir(), "pideck-atomgit-"));
	const manager = new HostPluginManager(root);
	try {
		const catalog = await manager.installFiles(download.files);
		assert.equal(catalog.plugins.length, 1);
		assert.equal(catalog.plugins[0].manifest.id, "example.viewer");
		// 与归档/目录/GitHub 安装同权：默认禁用、需重新授权。
		assert.equal(catalog.plugins[0].enabled, false);
		assert.equal(catalog.plugins[0].requiresConsent, true);
		assert.deepEqual(await readdir(join(catalog.directory, "example.viewer")), ["app.html", "pideck-plugin.json"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
