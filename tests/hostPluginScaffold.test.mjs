/**
 * 宿主插件脚手架（设置页「新建插件…」）与新增插件 API 面的门禁测试。
 *
 * 覆盖三件事：
 *   1. 脚手架产物必须是真能装的包：manifest 过安装路径的解析、模板只用 window.pideck、语法可解析；
 *   2. 模板与 manifest 的 permissions 始终一致：没勾的权限不生成对应代码（否则示例一运行就报权限错）；
 *   3. 新 API（sessions.get/search、storage.keys/delete、workbench.openExternal、context 补全）的权限与范围门禁。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildHostPluginScaffold, createHostPluginScaffold } = loadTsCommonJs("src/main/plugins/hostPluginScaffold.ts");
const { parseHostPluginManifest } = loadTsCommonJs("src/main/plugins/hostPluginManifest.ts");
const { parsePluginRequest } = loadTsCommonJs("src/main/plugins/hostPluginPolicy.ts");
const { HostPluginSessions } = loadTsCommonJs("src/main/plugins/HostPluginSessions.ts");
const { HostPluginBroker } = loadTsCommonJs("src/main/plugins/HostPluginBroker.ts");
const { HostPluginStorage } = loadTsCommonJs("src/main/plugins/HostPluginStorage.ts");

const SCAFFOLD_FILES = ["pideck-plugin.json", "app.html", "app.js", "styles.css", "README.md"];
const ALL_PERMISSIONS = ["sessions.read", "workbench.navigate", "workbench.openExternal"];
const input = (over = {}) => ({ id: "demo.viewer", name: "Demo Viewer", permissions: ["sessions.read"], presentation: "modal", ...over });
/** 会话目录条目：只保留插件读取路径会用到的字段。 */
const catalogEntry = (over = {}) => ({ id: "history", projectId: "project-a", filePath: "C:/sessions/history.jsonl", environment: "native", title: "History", createdAt: 1, updatedAt: 2, ...over });
function manifestFor(permissions) {
	return { schemaVersion: 1, apiVersion: 1, id: "example.viewer", name: "Viewer", version: "1.0.0", permissions, contributes: { panels: [], commands: [] } };
}
/** broker 替身：只有 getEnabled 被用到，fingerprint 与 bind 时传的值保持一致。 */
function brokerFor(permissions, sessions, projectNameOf, storage = { get: () => null, set: async () => undefined }) {
	const broker = new HostPluginBroker({ getEnabled: (id) => (id === "example.viewer" ? { manifest: manifestFor(permissions), fingerprint: "f" } : undefined), onChanged: () => () => {} }, sessions, storage, projectNameOf);
	return broker;
}
const emptySessions = { list: () => ({ sessions: [], nextOffset: null }), entries: async () => ({ entries: [], nextCursor: null, truncated: false }), describe: (context) => context };

test("host plugin scaffold writes a package the real loader accepts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-scaffold-"));
	try {
		const directory = await createHostPluginScaffold(root, input({ permissions: ALL_PERMISSIONS, presentation: "page" }));
		assert.equal(directory, join(root, "demo.viewer"));
		const manifest = parseHostPluginManifest(JSON.parse(await readFile(join(directory, "pideck-plugin.json"), "utf8")));
		assert.equal(manifest.id, "demo.viewer");
		assert.deepEqual(manifest.permissions, ALL_PERMISSIONS);
		const panel = manifest.contributes.panels[0];
		assert.equal(panel.entry, "app.html");
		assert.equal(panel.presentation, "page");
		assert.equal(manifest.contributes.commands[0].panelId, panel.id);
		for (const file of SCAFFOLD_FILES) assert.ok((await stat(join(directory, file))).size > 0, `${file} 不该是空文件`);
		const app = await readFile(join(directory, "app.js"), "utf8");
		// 模板只走 window.pideck：没有 CDN、没有 node/electron、没有注入点。
		assert.match(app, /const pideck = window\.pideck/);
		assert.doesNotMatch(app, /\brequire\(|from "(?:node|electron)|innerHTML|fetch\(|https?:\/\/(?!github\.com)/);
		assert.doesNotMatch(await readFile(join(directory, "app.html"), "utf8"), /<script[^>]*src="https?:/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin scaffold only emits code for the permissions it declares", () => {
	const withoutSessions = buildHostPluginScaffold(input({ permissions: [] }));
	assert.doesNotMatch(withoutSessions.get("app.js"), /pideck\.sessions\./);
	assert.doesNotMatch(withoutSessions.get("app.html"), /id="search"/);
	assert.match(withoutSessions.get("app.js"), /pideck\.context\.get\(\)/);
	// 没有声明跳转/外链时，对应按钮与函数都不生成。
	assert.doesNotMatch(withoutSessions.get("app.html"), /id="guide"/);
	assert.doesNotMatch(withoutSessions.get("app.js"), /pideck\.workbench\./);
	const full = buildHostPluginScaffold(input({ permissions: ALL_PERMISSIONS }));
	assert.match(full.get("app.html"), /id="search"/);
	assert.match(full.get("app.html"), /id="guide"/);
	assert.match(full.get("app.js"), /pideck\.workbench\.navigate\(/);
	assert.match(full.get("app.js"), /pideck\.workbench\.openExternal\(/);
	// 每种组合生成的脚本都必须是能解析的（模板拼接最容易在这里出问题）。
	for (const permissions of [[], ["sessions.read"], ["sessions.read", "workbench.navigate"], ALL_PERMISSIONS]) {
		const files = buildHostPluginScaffold(input({ permissions }));
		assert.doesNotThrow(() => new Function(files.get("app.js")), `app.js 语法必须合法：${permissions.join("+") || "无权限"}`);
		assert.doesNotThrow(() => parseHostPluginManifest(JSON.parse(files.get("pideck-plugin.json"))));
	}
	// README 与包内容同源：作者照它做就能跑起来。
	const readme = full.get("README.md");
	for (const permission of ALL_PERMISSIONS) assert.match(readme, new RegExp(`\`${permission.replace(".", "\\.")}\``));
	assert.match(readme, /pack-host-plugin\.mjs/);
});

test("network scaffolds preserve declared grants and never issue requests before a click", () => {
	const declarations = [
		{ permissions: ["network.https"], network: { httpsOrigins: ["https://api.example.com/"] } },
		{ permissions: ["network.local"], network: { localPorts: [4187] } },
		{ permissions: [...ALL_PERMISSIONS, "network.https", "network.local"], network: { httpsOrigins: ["https://api.example.com"], localPorts: [4187] } },
	];
	for (const declaration of declarations) {
		const files = buildHostPluginScaffold(input(declaration));
		const manifest = parseHostPluginManifest(JSON.parse(files.get("pideck-plugin.json")));
		assert.equal(manifest.network?.httpsOrigins?.[0], declaration.network.httpsOrigins?.[0]?.replace(/\/$/, ""));
		assert.equal(manifest.network?.localPorts?.[0], declaration.network.localPorts?.[0]);
		assert.match(files.get("app.html"), /id="network-request"/);
		assert.match(files.get("app.js"), /pideck\.network\.request\(/);
		assert.match(files.get("app.js"), /addEventListener\("click",[^\n]*requestNetworkDemo/);
		assert.doesNotMatch(files.get("app.js"), /\bfetch\(|XMLHttpRequest|innerHTML/);
		assert.doesNotThrow(() => new Function(files.get("app.js")));
		assert.match(files.get("README.md"), /network\.request/);
	}
	const offline = buildHostPluginScaffold(input({ permissions: [] }));
	assert.doesNotMatch(offline.get("app.html"), /id="network-request"/);
	assert.doesNotMatch(offline.get("app.js"), /pideck\.network\.request/);
});

test("invalid network declarations leave no partial scaffold", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-scaffold-network-"));
	try {
		for (const over of [{ permissions: ["network.https"] }, { permissions: [], network: { localPorts: [4187] } }, { permissions: ["network.local"], network: { localPorts: [0] } }]) {
			await assert.rejects(createHostPluginScaffold(root, input(over)), /invalid-network/);
		}
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin scaffold refuses to overwrite an existing folder or an unsafe id", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-scaffold-guard-"));
	try {
		await createHostPluginScaffold(root, input({ id: "demo.viewer" }));
		await assert.rejects(() => createHostPluginScaffold(root, input({ id: "demo.viewer", name: "Second" })), /already-exists/);
		for (const id of ["Demo", "demo_1", "-demo", "demo.", ".demo", "demo/escape", ""]) {
			await assert.rejects(() => createHostPluginScaffold(root, input({ id })), /invalid-plugin-id/, `${id} 不该被接受`);
		}
		// 拒绝的请求不留任何痕迹：目录里只有第一次成功的那一个包。
		assert.deepEqual(await readdir(root), ["demo.viewer"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin context is filled with desktop-owned names only", async () => {
	const entries = [catalogEntry(), catalogEntry({ id: "other", projectId: "project-b", title: "Foreign" })];
	const sessions = new HostPluginSessions({ listEntries: () => entries, get: (id) => entries.find((entry) => entry.id === id) });
	const broker = brokerFor(["sessions.read"], sessions, (projectId) => (projectId === "project-a" ? "PiDeck" : undefined));
	// 渲染层传上来的 projectName/sessionTitle 一律被桌面侧覆盖。
	broker.bind(10, "example.viewer", "f", { projectId: "project-a", sessionId: "history", projectName: "伪造", sessionTitle: "伪造", locale: "zh-CN", theme: "dark" });
	const context = (await broker.request(10, true, { method: "context.get" })).value;
	assert.equal(context.projectName, "PiDeck");
	assert.equal(context.sessionTitle, "History");
	// 不属于本项目（或不存在）的会话不给标题：拿不到就不给，不泄露其他项目。
	broker.update(10, { projectId: "project-a", sessionId: "other", locale: "zh-CN", theme: "dark" });
	assert.equal((await broker.request(10, true, { method: "context.get" })).value.sessionTitle, undefined);
	broker.dispose();
});

test("host plugin session reads stay inside the bound project", async () => {
	const entries = [catalogEntry(), catalogEntry({ id: "other", projectId: "project-b", title: "Foreign session" })];
	const sessions = new HostPluginSessions({ listEntries: () => entries, get: (id) => entries.find((entry) => entry.id === id) });
	const broker = brokerFor(["sessions.read"], sessions);
	broker.bind(10, "example.viewer", "f", { projectId: "project-a", locale: "zh-CN", theme: "dark" });
	const got = await broker.request(10, true, { method: "sessions.get", sessionId: "history" });
	assert.equal(got.value.projectId, "project-a");
	assert.equal((await broker.request(10, true, { method: "sessions.get", sessionId: "other" })).code, "session-not-authorized");
	const found = await broker.request(10, true, { method: "sessions.search", query: "foreign" });
	assert.deepEqual(found.value, []);
	assert.equal((await broker.request(10, true, { method: "sessions.search", query: "history", limit: 0 })).code, "invalid-request");
	broker.dispose();
});

test("host plugin storage keys and delete stay inside the plugin namespace", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-storage-"));
	const storage = new HostPluginStorage(root);
	try {
		await storage.set("example.viewer", "a", 1, () => true);
		await storage.set("other.plugin", "b", 2, () => true);
		const broker = brokerFor(["sessions.read"], emptySessions, undefined, storage);
		broker.bind(10, "example.viewer", "f", { projectId: "project-a", locale: "zh-CN", theme: "dark" });
		// 沙箱（vm）里造的数组不是本 realm 的 Array：先搬进本 realm 再比较。
		assert.deepEqual(Array.from((await broker.request(10, true, { method: "storage.keys" })).value), ["a"]);
		assert.ok((await broker.request(10, true, { method: "storage.delete", key: "a" })).ok);
		assert.deepEqual(Array.from(await storage.keys("example.viewer")), []);
		// 删除只作用于自己的命名空间，别的插件数据不动。
		assert.deepEqual(Array.from(await storage.keys("other.plugin")), ["b"]);
		assert.equal((await broker.request(10, true, { method: "storage.delete", key: "../escape" })).code, "invalid-request");
		broker.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin external links need the permission and stay https-only", async () => {
	for (const url of ["http://example.com", "file:///C:/secret.txt", "https://user:pw@example.com", "javascript:alert(1)", "pideck-plugin://instance/app.html"]) {
		assert.throws(() => parsePluginRequest({ method: "workbench.openExternal", url }), /invalid-request/, `${url} 不该被接受`);
	}
	assert.equal(parsePluginRequest({ method: "workbench.openExternal", url: "https://example.com/a?b=1" }).url, "https://example.com/a?b=1");
	const denied = brokerFor(["sessions.read"], emptySessions);
	denied.bind(10, "example.viewer", "f", { projectId: "project-a", locale: "zh-CN", theme: "dark" });
	assert.equal((await denied.request(10, true, { method: "workbench.openExternal", url: "https://example.com" })).code, "permission-denied");
	denied.dispose();
	const opened = [];
	const allowed = brokerFor(["workbench.openExternal"], emptySessions);
	allowed.onOpenExternal((url) => opened.push(url));
	allowed.bind(10, "example.viewer", "f", { projectId: "project-a", locale: "zh-CN", theme: "dark" });
	assert.ok((await allowed.request(10, true, { method: "workbench.openExternal", url: "https://example.com/guide" })).ok);
	assert.deepEqual(opened, ["https://example.com/guide"]);
	allowed.dispose();
});
