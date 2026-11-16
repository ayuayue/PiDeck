/**
 * F（Phase B）服务接线行为测试：文件树 / 名字搜索 / 内容搜索只消费 ProjectServices。
 *
 * 这里不渲染 DOM，用确定性 React 宿主加载生产 hook，假 ProjectServices 记录真实调用：
 * - 目录页只走 files.listDirectory，同代事实与连接换代都能重读；
 * - 事实订阅走共享的 acquireProjectFactSubscription，卸载必须释放；
 * - 搜索走 files.searchFiles / files.searchContent，代次作废迟到结果；
 * - 服务异常按稳定码落态，不吞、不猜。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function entry(relativePath, type = "file", hasChildren = false) {
	return { target: { projectId: "p1", relativePath }, relativePath, type, hasChildren: type === "directory" ? hasChildren : undefined };
}

function page(dir, entries, generation = "g1", extras = {}) {
	return { entries: entries.map((item) => (typeof item === "string" ? entry(item) : item)), truncated: false, revision: 1, generation, ...extras };
}

/** 目录树 hook 宿主：假 services + 可观察的共享事实订阅。 */
function treeHarness() {
	const host = quickMessageHookHost();
	const subscriptions = [];
	let releases = 0;
	const { useRemoteFileTree } = loadTsCommonJs("src/renderer/src/hooks/useRemoteFileTree.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi: {} },
			"../services/projectServiceFactSubscription": {
				acquireProjectFactSubscription: (_project, _api, handlers) => {
					subscriptions.push(handlers);
					return () => {
						releases += 1;
					};
				},
			},
		},
	});
	const project = { id: "p1", name: "p1", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p1" } };
	let view = null;
	let calls = [];
	let read = async () => page("", []);
	const services = (generation = "ssh:h:0:g1") => ({
		projectId: "p1",
		kind: "remote",
		generation,
		capabilities: { files: {} },
		/** The first directory page may trigger the production hook's one-time helper-facts refresh. */
		facts: {},
		refresh: async () => undefined,
		files: {
			listDirectory: async (target, options) => {
				calls.push({ relativePath: target.relativePath, force: options?.force === true, projectId: target.projectId });
				return read(target.relativePath, options?.force === true);
			},
		},
	});
	const render = (generation) => {
		const active = services(generation);
		view = host.render(() => useRemoteFileTree(project, active));
		return active;
	};
	return {
		host,
		render,
		view: () => view,
		setRead: (next) => {
			read = next;
		},
		calls: () => calls,
		resetCalls: () => {
			calls = [];
		},
		subscriptions,
		releases: () => releases,
	};
}

test("目录树只经 services.files.listDirectory 读页，并保留过滤/未知 children/截断事实", async () => {
	const h = treeHarness();
	h.setRead(async (dir) => {
		if (dir === "") return page("", [entry("src", "directory", "unknown"), entry("node_modules", "directory", "unknown"), entry(".git", "directory", "unknown"), entry("a.txt")]);
		return page(dir, [entry(dir + "/x.ts")]);
	});
	const active = h.render();
	await flush();
	h.render();
	assert.deepEqual(
		h.calls().map((call) => [call.relativePath, call.force, call.projectId]),
		[["", false, "p1"]],
	);
	const state = h.view();
	assert.equal(state.listed, true);
	assert.equal(state.error, null);
	assert.deepEqual(
		state.nodes.map((node) => node.name),
		["src", "a.txt"],
	);
	assert.equal(state.nodes[0].hasChildren, true, "远端 directory 的 hasChildren=unknown 不能伪装成 false");
	assert.equal(h.subscriptions.length, 1, "事实订阅只建立一次");
	h.host.unmount();
	assert.equal(h.releases(), 1, "卸载必须释放共享订阅");
	void active;
});

test("同代目录事实只重读已加载目录；换代由 services.generation 触发整树重读", async () => {
	const h = treeHarness();
	h.setRead(async (dir, force) => page(dir, dir === "" ? [entry("src", "directory", "unknown")] : [entry("src/x.ts")], force ? "g1" : "g1"));
	h.render("ssh:h:0:g1");
	await flush();
	h.render("ssh:h:0:g1");
	h.view().toggle("src");
	await flush();
	h.render("ssh:h:0:g1");
	assert.deepEqual(
		h.calls().map((call) => [call.relativePath, call.force]),
		[
			["", false],
			["src", false],
		],
	);

	// 同代事实：只重读已加载的 src（force）。
	h.resetCalls();
	h.subscriptions[0].onFactsChange({ projectId: "p1", generation: "g1", scopes: [{ kind: "dir", path: "src" }] });
	await flush();
	h.render("ssh:h:0:g1");
	assert.deepEqual(
		h.calls().map((call) => [call.relativePath, call.force]),
		[["src", true]],
	);

	// 换代：新 services 的 generation 变化 → 用新实例重读根层与已加载目录。
	h.resetCalls();
	h.setRead(async (dir) => page(dir, dir === "" ? [entry("src", "directory", "unknown")] : [entry("src/y.ts")], "g2"));
	h.render("ssh:h:1:g2");
	await flush();
	h.render("ssh:h:1:g2");
	assert.deepEqual(
		h
			.calls()
			.map((call) => [call.relativePath, call.force])
			.sort(),
		[
			["", true],
			["src", true],
		],
	);
	assert.equal(h.view().nodes[0].children[0].name, "y.ts");
	h.host.unmount();
});

test("目录页失败按稳定码展示，不把读失败当成空目录", async () => {
	const h = treeHarness();
	h.setRead(async () => {
		throw Object.assign(new Error("REMOTE_FILE_NOT_TEXT"), { code: "REMOTE_FILE_NOT_TEXT" });
	});
	h.render();
	await flush();
	h.render();
	assert.equal(h.view().listed, false);
	assert.equal(h.view().error, "REMOTE_FILE_NOT_TEXT");
	assert.equal(h.view().nodes.length, 0);
	h.host.unmount();
});

/** 名字/内容搜索 hook 宿主：同一份假 services 记录调用。 */
function searchHarness(options = {}) {
	const host = quickMessageHookHost();
	const calls = { names: [], contents: [] };
	const services = {
		projectId: options.projectId ?? "p1",
		generation: options.generation ?? "ssh:h:0:g1",
		kind: "remote",
		capabilities: { files: { contentSearch: options.contentSearch !== false } },
		files: {
			searchFiles: (query) => {
				const call = { query };
				calls.names.push(call);
				call.promise = new Promise((resolve, reject) => {
					call.resolve = resolve;
					call.reject = reject;
				});
				return call.promise;
			},
			searchContent: (query) => {
				const call = { query };
				calls.contents.push(call);
				call.promise = new Promise((resolve, reject) => {
					call.resolve = resolve;
					call.reject = reject;
				});
				return call.promise;
			},
		},
	};
	const loaded = loadTsCommonJs("src/renderer/src/hooks/useRemoteProjectSearch.ts", { stubs: { react: host.react } });
	const contentLoaded = loadTsCommonJs("src/renderer/src/hooks/useRemoteContentSearch.ts", { stubs: { react: host.react } });
	let search = null;
	let content = null;
	const render = (activeServices = services) => {
		search = host.render(() => loaded.useRemoteProjectSearch(activeServices));
		return search;
	};
	const renderContent = (supported, activeServices = services) => {
		content = host.render(() => contentLoaded.useRemoteContentSearch({ services: activeServices, supported }));
		return content;
	};
	return { host, services, calls, render, renderContent, search: () => search, content: () => content };
}

const NAME_ROWS = { results: [{ name: "a.ts", relativePath: "src/a.ts", type: "file" }], scanned: 10, truncated: true };

test("名字搜索经 services.files.searchFiles 落地，truncated/scanned 原样保留", async () => {
	const h = searchHarness();
	h.render();
	const pending = h.search().run("a");
	await flush();
	assert.deepEqual(
		h.calls.names.map((call) => call.query),
		["a"],
	);
	h.calls.names[0].resolve(NAME_ROWS);
	await pending;
	h.render();
	const state = h.search().state;
	assert.equal(state.phase, "results");
	assert.equal(state.errorCode, null);
	assert.equal(state.truncated, true);
	assert.equal(state.scanned, 10);
	assert.deepEqual(plain(state.entries), [{ path: "src/a.ts", name: "a.ts", kind: "file" }]);
	h.host.unmount();
});

test("名字搜索迟到结果按代次丢弃；服务失败给出稳定码", async () => {
	const h = searchHarness();
	h.render();
	const first = h.search().run("a");
	await flush();
	const second = h.search().run("b");
	await flush();
	h.calls.names[1].resolve(NAME_ROWS);
	await second;
	h.calls.names[0].resolve({ results: [{ name: "old.ts", relativePath: "old.ts", type: "file" }], scanned: 1, truncated: false });
	await first;
	h.render();
	assert.deepEqual(plain(h.search().state.entries.map((item) => item.name)), ["a.ts"]);
	const failed = h.search().run("c");
	await flush();
	h.calls.names[2].reject(Object.assign(new Error("SSH_HOST_DISCONNECTED"), { code: "SSH_HOST_DISCONNECTED" }));
	await failed;
	h.render();
	assert.equal(h.search().state.phase, "error");
	assert.equal(h.search().state.errorCode, "SSH_HOST_DISCONNECTED");
	h.host.unmount();
});

test("内容搜索只看 supported 与查询词：不支持/太短零调用，支持时经 services 并作废迟到结果", async () => {
	const h = searchHarness();
	h.renderContent(false);
	await h.content().run("needle");
	assert.equal(h.calls.contents.length, 0, "能力关闭时不得发内容检索");
	h.renderContent(true);
	await h.content().run("a");
	assert.equal(h.calls.contents.length, 0, "单字符不扫内容");
	const first = h.content().run("needle");
	await flush();
	const second = h.content().run("needle2");
	await flush();
	const late = { hits: [], matchedFiles: 0, scannedFiles: 0, scannedBytes: 0, truncated: false };
	h.calls.contents[1].resolve({ ...late, scannedFiles: 2 });
	await second;
	h.calls.contents[0].resolve({ ...late, scannedFiles: 9 });
	await first;
	h.renderContent(true);
	assert.equal(h.content().results.scannedFiles, 2, "迟到内容结果不得覆盖新代状态");
	assert.equal(h.content().isSearching, false);
	h.host.unmount();
});

test("连接换代清空内容态：旧代在途结果不写回", async () => {
	const h = searchHarness();
	h.renderContent(true);
	const pending = h.content().run("needle");
	await flush();
	const next = { ...h.services, generation: "ssh:h:0:g2" };
	h.renderContent(true, next);
	h.calls.contents[0].resolve({ hits: [], matchedFiles: 0, scannedFiles: 7, scannedBytes: 0, truncated: false });
	await pending;
	h.renderContent(true, next);
	assert.equal(h.content().results, null);
	h.host.unmount();
});
test("Phase B 接线守卫：面板与 F hooks 不再直连被服务接管的读写通道", () => {
	const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
	assert.match(panel, /useProjectServices\(project\)/);
	assert.doesNotMatch(panel, /onProjectFactsChanged/);
	assert.doesNotMatch(panel, /statProjectEntry|openProjectText|saveProjectText|createProjectFile|createProjectDirectory|renameProjectEntry|deleteProjectEntry|searchProject/);

	const tree = readFileSync("src/renderer/src/hooks/useRemoteFileTree.ts", "utf8");
	assert.match(tree, /services\.files\.listDirectory\(/);
	assert.match(tree, /acquireProjectFactSubscription\(/);
	assert.doesNotMatch(tree, /files\.directoryPage\(/);
	assert.doesNotMatch(tree, /onProjectFactsChanged\(/);

	const draft = readFileSync("src/renderer/src/hooks/useRemoteFileDraft.ts", "utf8");
	assert.match(draft, /services\.files\.readText\(/);
	assert.match(draft, /services\.files\.writeText\(/);
	assert.doesNotMatch(draft, /remoteHosts\.(openProjectText|saveProjectText|statProjectEntry)/);

	const entries = readFileSync("src/renderer/src/hooks/useRemoteProjectEntries.ts", "utf8");
	assert.match(entries, /services\.files\.createEntry\(/);
	assert.match(entries, /services\.files\.renameEntry\(/);
	assert.match(entries, /services\.files\.moveEntry\(/);
	assert.match(entries, /services\.files\.deleteEntry\(/);
	assert.doesNotMatch(entries, /statProjectEntry|renameProjectEntry/, "移动/改名不再由渲染层持有 entry 令牌");
	// 仅回收站列表/恢复/清空仍是契约薄壳直连 preload。
	assert.match(entries, /回收站列表\/恢复\/清空/);

	const localTree = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	assert.match(localTree, /active\.files\.listDirectory\(/);
	assert.doesNotMatch(localTree, /api\.files\.list\(/);

	const app = rendererAppSource;
	assert.match(app, /useProjectServices\(localFileTreeProject\)/);
	assert.match(app, /services: localFileTreeServices/);

	const editor = readFileSync("src/renderer/src/components/workspace/RemoteFileEditor.tsx", "utf8");
	assert.match(editor, /useRemoteFileDraft\(props\.services, props\.path\)/);
});
test("首读被旧代围栏拒绝后，新 services 的换代 effect 必须重读恢复（不能永久停在错误态）", async () => {
	const h = treeHarness();
	let rejectOld;
	h.setRead(
		() =>
			new Promise((_resolve, reject) => {
				rejectOld = reject;
			}),
	);
	h.render("ssh:h:0:unprovisioned");
	await flush();
	// runtime 完成事实采集：新代 services 已就绪，旧读尚未返回。
	h.setRead(async (dir) => page(dir, dir === "" ? [entry("src", "directory", "unknown")] : [], "g1"));
	h.render("ssh:h:0:g1");
	await flush();
	rejectOld(Object.assign(new Error("PROJECT_SERVICE_GENERATION_STALE"), { code: "PROJECT_SERVICE_GENERATION_STALE" }));
	await flush();
	h.render("ssh:h:0:g1");
	assert.equal(h.view().listed, true);
	assert.equal(h.view().error, null);
	assert.deepEqual(plain(h.view().nodes.map((node) => node.name)), ["src"]);
	assert.ok(
		h.calls().some((call) => call.relativePath === "" && call.force === true),
		"换代后必须用新实例重读根层",
	);
	h.host.unmount();
});
