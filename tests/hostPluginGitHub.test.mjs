import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseGitHubPluginUrl, readTarFiles, selectGitHubPackage, extractGitHubPackage, downloadGitHubPlugin } = loadTsCommonJs("src/main/plugins/hostPluginGitHub.ts");
const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");

function manifest() {
	return { schemaVersion: 1, apiVersion: 1, id: "example.viewer", name: "Viewer", version: "1.0.0", permissions: ["sessions.read"], contributes: { panels: [{ id: "context", title: "Context", entry: "app.html" }], commands: [] } };
}

/** 手搓 tar 头：GitHub 的 tar.gz 是 ustar + 可选 pax，测试只需要常规文件与一个符号链接。 */
function tarHeader(name, size, type = "0") {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\0", 100, 8, "ascii");
	header.write("0000000\0", 108, 8, "ascii");
	header.write("0000000\0", 116, 8, "ascii");
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
	header.write("00000000000\0", 136, 12, "ascii");
	header.write("        ", 148, 8, "ascii");
	header.write(type, 156, 1, "ascii");
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return header;
}

function tarFile(name, content, type = "0") {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
	const body = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
	bytes.copy(body);
	return Buffer.concat([tarHeader(name, bytes.length, type), body]);
}

/** 把 [路径, 内容] 列表打包成 GitHub 形态的 tar.gz（最外层 `<repo>-<ref>/` 由调用方写进路径）。 */
function tarball(entries) {
	return gzipSync(Buffer.concat([...entries.map(([name, content]) => tarFile(name, content)), Buffer.alloc(1024)]));
}

function pluginEntries(prefix) {
	return [
		[`${prefix}/pideck-plugin.json`, JSON.stringify(manifest())],
		[`${prefix}/app.html`, "<!doctype html><title>ok</title>"],
	];
}

/** [路径, 内容] 元组 → 未压缩 tar（含结尾零块）。 */
function pack(entries) {
	return Buffer.concat([...entries.map(([name, content]) => tarFile(name, content)), Buffer.alloc(1024)]);
}

/** 假 fetch：api.github.com 返回默认分支，codeload 返回给定 tar.gz，其余 404。 */
function fakeFetch(body, { defaultBranch = "main", codeloadStatus = 200 } = {}) {
	const calls = [];
	const impl = async (url) => {
		calls.push(url);
		if (url.startsWith("https://api.github.com/")) {
			return defaultBranch ? new Response(JSON.stringify({ default_branch: defaultBranch }), { status: 200 }) : new Response("", { status: 404 });
		}
		if (url.startsWith("https://codeload.github.com/")) return new Response(body, { status: codeloadStatus });
		return new Response("", { status: 404 });
	};
	impl.calls = calls;
	return impl;
}

test("github plugin urls accept repo and tree links, reject everything else", () => {
	// 沙箱返回的对象原型与宿主不同，逐字段比较（deepEqual 会因原型判定失败）。
	const source = (raw) => {
		const parsed = parseGitHubPluginUrl(raw);
		return `${parsed.owner}/${parsed.repo}/${parsed.ref ?? ""}`;
	};
	assert.equal(source("https://github.com/ayuayue/PiDeck"), "ayuayue/PiDeck/");
	assert.equal(source("  github.com/ayuayue/PiDeck.git/  "), "ayuayue/PiDeck/");
	// tree/<ref>/<subpath>：整条尾巴先当 ref，下载阶段再逐步缩短（分支名本身可能带斜杠）。
	assert.equal(source("https://github.com/a/b/tree/dev/plugins/x"), "a/b/dev/plugins/x");
	assert.equal(source("https://github.com/a/b/tree"), "a/b/");
	for (const bad of ["", "http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/blob/main/pideck-plugin.json", "https://github.com/a/b?tab=readme", "https://user:pw@github.com/a/b", "https://github.com/a/b/tree/../etc"]) {
		assert.throws(() => parseGitHubPluginUrl(bad), /invalid-github-url/, `应拒绝 ${bad}`);
	}
});

test("tarball extraction strips the repo prefix and finds the package root", () => {
	const files = extractGitHubPackage(tarball(pluginEntries("PiDeck-main")));
	assert.equal(
		files
			.map((file) => file.path)
			.sort()
			.join(","),
		"app.html,pideck-plugin.json",
	);
	assert.equal(JSON.parse(files.find((file) => file.path === "pideck-plugin.json").bytes.toString("utf8")).id, "example.viewer");
});

test("tarball extraction follows a subdirectory and ignores symlinks", () => {
	const entries = [...pluginEntries("PiDeck-main/plugins/viewer"), ["PiDeck-main/README.md", "# repo"], ["PiDeck-main/plugins/viewer/link.html", "../../etc/passwd"]];
	const tar = gzipSync(Buffer.concat([...entries.map(([name, content], index) => tarFile(name, content, index === entries.length - 1 ? "2" : "0")), Buffer.alloc(1024)]));
	// 未指定子目录时两个目录都参与判定：README 不是包，包只有一个 → 自动定位。
	assert.equal(
		extractGitHubPackage(tar)
			.map((file) => file.path)
			.sort()
			.join(","),
		"app.html,pideck-plugin.json",
	);
	assert.throws(() => extractGitHubPackage(tar, "plugins/missing"), /missing-manifest/);
});

test("ambiguous and missing manifests fail with actionable codes", () => {
	assert.throws(() => extractGitHubPackage(tarball([["repo-main/README.md", "# no plugin"]])), /missing-manifest/);
	const two = gzipSync(pack([...pluginEntries("repo-main/a"), ...pluginEntries("repo-main/b")]));
	assert.throws(() => extractGitHubPackage(two, undefined), /plugin-manifest-ambiguous/);
	// 指定子目录后歧义消失。
	assert.equal(
		extractGitHubPackage(two, "b")
			.map((file) => file.path)
			.sort()
			.join(","),
		"app.html,pideck-plugin.json",
	);
});

test("package budgets reject too many files before anything is written", () => {
	const many = [...pluginEntries("repo-main"), ...Array.from({ length: 120 }, (_, index) => [`repo-main/assets/${index}.html`, "x"])];
	assert.throws(() => extractGitHubPackage(tarball(many)), /package-too-large/);
});

test("readTarFiles keeps only regular files and preserves subdirectories", () => {
	const files = readTarFiles(Buffer.concat([tarFile("repo-main/pideck-plugin.json", JSON.stringify(manifest())), tarFile("repo-main/assets/app.html", "<html></html>"), tarFile("repo-main/empty", ""), Buffer.alloc(1024)]));
	// 跨 vm 沙箱的数组原型不同，deepEqual 会因原型判定失败：统一按字符串比较。
	assert.equal(files.map((file) => file.path).join(","), "repo-main/pideck-plugin.json,repo-main/assets/app.html,repo-main/empty");
});

test("download resolves the default branch and installs through the shared trust path", async () => {
	const body = tarball(pluginEntries("PiDeck-main"));
	const fetchImpl = fakeFetch(body);
	const download = await downloadGitHubPlugin("https://github.com/ayuayue/PiDeck", { fetchImpl });
	assert.equal(download.ref, "main");
	assert.equal(download.files.length, 2);
	assert.ok(fetchImpl.calls.some((url) => url.startsWith("https://api.github.com/repos/ayuayue/PiDeck")));
	assert.ok(fetchImpl.calls.includes("https://codeload.github.com/ayuayue/PiDeck/tar.gz/main"));

	const root = await mkdtemp(join(tmpdir(), "pideck-github-"));
	const manager = new HostPluginManager(root);
	try {
		const catalog = await manager.installFiles(download.files);
		assert.equal(catalog.plugins.length, 1);
		// 与归档/目录安装同权：默认禁用、需重新授权，落位目录里只有这个包。
		assert.equal(catalog.plugins[0].manifest.id, "example.viewer");
		assert.equal(catalog.plugins[0].enabled, false);
		assert.equal(catalog.plugins[0].requiresConsent, true);
		assert.deepEqual(await readdir(catalog.directory), ["example.viewer"]);
		assert.deepEqual((await readdir(join(catalog.directory, "example.viewer"))).sort(), ["app.html", "pideck-plugin.json"]);
		assert.equal(await readFile(join(catalog.directory, "example.viewer", "app.html"), "utf8"), "<!doctype html><title>ok</title>");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("download falls back to main/master when repository metadata is unavailable", async () => {
	const body = tarball(pluginEntries("PiDeck-master"));
	const fetchImpl = fakeFetch(body, { defaultBranch: null });
	const seen = [];
	const impl = async (url) => {
		seen.push(url);
		// 只让 master 存在：main 返回 404，master 返回真实 tar.gz。
		if (url.includes("/tar.gz/main")) return new Response("", { status: 404 });
		return fetchImpl(url);
	};
	const download = await downloadGitHubPlugin("https://github.com/ayuayue/PiDeck", { fetchImpl: impl });
	assert.equal(download.ref, "master");
	assert.ok(seen.includes("https://codeload.github.com/ayuayue/PiDeck/tar.gz/master"));
});

test("download reports plugin-not-found when no branch yields a tarball", async () => {
	const impl = fakeFetch(Buffer.alloc(0), { defaultBranch: "dev", codeloadStatus: 404 });
	await assert.rejects(() => downloadGitHubPlugin("https://github.com/ayuayue/PiDeck", { fetchImpl: impl }), /plugin-not-found/);
});

test("explicit tree links try the longest ref first, then shorten it into a subdirectory", async () => {
	const body = tarball(pluginEntries("PiDeck-feature-x/plugins/viewer"));
	const seen = [];
	// 精确匹配 URL 结尾：子串匹配会让 "/tar.gz/feature/x" 误命中 "/tar.gz/feature/x/plugins"。
	const impl = async (url) => {
		seen.push(url);
		if (url.endsWith("/tar.gz/feature/x")) return new Response(body, { status: 200 });
		return new Response("", { status: 404 });
	};
	const download = await downloadGitHubPlugin("https://github.com/ayuayue/PiDeck/tree/feature/x/plugins/viewer", { fetchImpl: impl });
	assert.equal(download.ref, "feature/x");
	assert.equal(download.subpath, "plugins/viewer");
	assert.equal(
		download.files
			.map((file) => file.path)
			.sort()
			.join(","),
		"app.html,pideck-plugin.json",
	);
	// 先试最长 ref（整串当分支名），失败后逐步缩短把尾巴降级为子目录。
	assert.equal(seen[0], "https://codeload.github.com/ayuayue/PiDeck/tar.gz/feature/x/plugins/viewer");
	assert.ok(seen.includes("https://codeload.github.com/ayuayue/PiDeck/tar.gz/feature/x"));
});

test("settings page exposes the GitHub install entry and the compact list row", () => {
	const tab = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "src", "config", "HostPluginsTab.tsx"), "utf8");
	assert.match(tab, /hostPlugins\.installGitHub/);
	assert.match(tab, /hostPlugins\.githubTitle/);
	assert.match(tab, /installGitHub\(url\)/);
	assert.match(tab, /<HostPluginRow/);
	const row = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "src", "config", "HostPluginRow.tsx"), "utf8");
	// 行内只放短标签：完整目的地/风险提示必须在授权弹窗里，不能塞进列表行。
	assert.match(row, /HOST_PLUGIN_PERMISSION_CHIP_KEYS/);
	assert.doesNotMatch(row, /networkDestinations/);
});
