import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const { parseHostPluginManifest } = loadTsCommonJs("src/main/plugins/hostPluginManifest.ts");
const { parsePluginRequest, parsePluginContext, pluginAssetFromUrl, HOST_PLUGIN_CSP } = loadTsCommonJs("src/main/plugins/hostPluginPolicy.ts");
const { readHostPluginPackage, readApprovedPluginAsset } = loadTsCommonJs("src/main/plugins/hostPluginFiles.ts");
const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");
const { HostPluginStorage } = loadTsCommonJs("src/main/plugins/HostPluginStorage.ts");
const { HostPluginBroker } = loadTsCommonJs("src/main/plugins/HostPluginBroker.ts");
const { HostPluginSessions } = loadTsCommonJs("src/main/plugins/HostPluginSessions.ts");
const { HOST_PLUGIN_THEME_TOKENS } = loadTsCommonJs("src/renderer/src/hooks/plugins/hostPluginTokens.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
function manifest(permissions = ["sessions.read"]) {
	return { schemaVersion: 1, apiVersion: 1, id: "example.viewer", name: "Viewer", version: "1.0.0", permissions, contributes: { panels: [{ id: "context", title: "Context", entry: "app.html" }], commands: [{ id: "context.open", title: "Open", panelId: "context" }] } };
}
async function packageAt(directory, data = manifest()) {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "pideck-plugin.json"), JSON.stringify(data));
	await writeFile(join(directory, "app.html"), '<!doctype html><script src="app.js"></script>');
	await writeFile(join(directory, "app.js"), "document.body.textContent = 'viewer';");
}
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Public manifest/policy boundaries reject unknown capabilities instead of quietly broadening access.
test("host plugin manifests reject unknown permissions, missing panels and path traversal", () => {
	assert.equal(parseHostPluginManifest(manifest()).id, "example.viewer");
	assert.throws(() => parseHostPluginManifest(manifest(["filesystem.read"])), /unsupported-permission/);
	// 范围扩展不能单独成立：单声明它拿不到任何读取权，直接拒装。
	assert.throws(() => parseHostPluginManifest(manifest(["sessions.read.workspace"])), /unsupported-permission/);
	assert.deepEqual(plain(parseHostPluginManifest(manifest(["sessions.read", "sessions.read.workspace"])).permissions), ["sessions.read", "sessions.read.workspace"]);
	const value = manifest();
	value.contributes.panels[0].entry = "../outside.html";
	assert.throws(() => parseHostPluginManifest(value), /invalid-panel/);
	const missing = manifest();
	missing.contributes.commands[0].panelId = "missing";
	assert.throws(() => parseHostPluginManifest(missing), /invalid-command/);
});

test("host plugin manifest presentation accepts modal/page and rejects anything else", () => {
	const modal = manifest();
	modal.contributes.panels[0].presentation = "modal";
	assert.equal(parseHostPluginManifest(modal).contributes.panels[0].presentation, "modal");
	const page = manifest();
	page.contributes.panels[0].presentation = "page";
	assert.equal(parseHostPluginManifest(page).contributes.panels[0].presentation, "page");
	const bad = manifest();
	bad.contributes.panels[0].presentation = "window";
	assert.throws(() => parseHostPluginManifest(bad), /invalid-panel-presentation/);
});

test("host plugin panel icons are allowlisted: unknown names fail closed, missing is fine", () => {
	const withIcon = manifest();
	withIcon.contributes.panels[0].icon = "bar-chart";
	// 逐字段断言：loadTsCommonJs 的 vm realm 会让 deepEqual 误判引用不等。
	const parsed = parseHostPluginManifest(withIcon).contributes.panels[0];
	assert.equal(parsed.id, "context");
	assert.equal(parsed.icon, "bar-chart");
	const unknown = manifest();
	unknown.contributes.panels[0].icon = "Sparkles";
	assert.throws(() => parseHostPluginManifest(unknown), /invalid-panel-icon/);
	// 未声明 icon 的面板照常通过（渲染层用 Puzzle 兜底）。
	assert.equal(parseHostPluginManifest(manifest()).contributes.panels[0].icon, undefined);
});

test("host plugin protocol and requests cannot select foreign origins, files or runtime commands", () => {
	const id = "instance";
	assert.equal(pluginAssetFromUrl("pideck-plugin://instance/js/app.mjs", id), "js/app.mjs");
	for (const url of ["https://example.invalid/app.js", "file:///tmp/secret", "pideck-plugin://other/app.js", "pideck-plugin://instance/%2e%2e%2fsecret", "pideck-plugin://instance/app.js?file=secret"]) assert.equal(pluginAssetFromUrl(url, id), undefined);
	assert.throws(() => parsePluginRequest({ method: "runtime.send" }), /unsupported-method/);
	assert.throws(() => parsePluginRequest({ method: "sessions.list", offset: -1 }), /invalid-request/);
	assert.throws(() => parsePluginRequest({ method: "sessions.entries", sessionId: "one", cursor: { before: 1.5, version: "v1" } }), /invalid-request/);
	assert.throws(() => parsePluginContext({ locale: "en-US", theme: "dark", tokens: { "--color-bg": "red; background:url(secret)" } }), /invalid-context/);
	assert.match(HOST_PLUGIN_CSP, /connect-src 'none'/);
	assert.match(HOST_PLUGIN_CSP, /script-src 'self';/);
});

test("plugin context accepts a full font stack but still rejects CSS injection and oversized values", () => {
	// 面板要跟随宿主自定义字体，默认字体栈约 200 字符；上限从 160 放宽到 400 后必须仍然不可注入。
	const fontStack = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';
	assert.ok(fontStack.length > 160 && fontStack.length <= 400);
	const parsed = parsePluginContext({ locale: "zh-CN", theme: "light", tokens: { "--font-family-base": fontStack, "--color-bg-app": "#fff", "--radius-md": "8px", "--font-family-mono": "ui-monospace, Menlo, monospace" } });
	assert.equal(parsed.tokens["--font-family-base"], fontStack);
	// 数字与字母开头的合法值不能被控制字符范围误伤（曾把 \u0000 写成 \\u0000）。
	assert.equal(parsed.tokens["--radius-md"], "8px");
	assert.equal(parsed.tokens["--font-family-mono"], "ui-monospace, Menlo, monospace");
	assert.throws(() => parsePluginContext({ locale: "zh-CN", theme: "light", tokens: { "--font-family-base": "a".repeat(401) } }), /invalid-context/);
	assert.throws(() => parsePluginContext({ locale: "zh-CN", theme: "light", tokens: { "--font-family-base": "serif} body{display:none" } }), /invalid-context/);
});

test("plugin theme token set stays inside the context contract (≤40 names, policy-safe names)", () => {
	assert.ok(HOST_PLUGIN_THEME_TOKENS.length > 0 && HOST_PLUGIN_THEME_TOKENS.length <= 40, `${HOST_PLUGIN_THEME_TOKENS.length} tokens`);
	for (const name of HOST_PLUGIN_THEME_TOKENS) assert.match(name, /^--[a-z-]{1,60}$/);
	// 插件面板的字体与交互底色依赖这些 token；缺一个就会退回插件自带色板，和宿主脱节。
	for (const name of ["--font-family-base", "--font-family-mono", "--color-bg-hover", "--color-bg-active", "--radius-md", "--control-height-md"]) {
		assert.ok(HOST_PLUGIN_THEME_TOKENS.includes(name), name);
	}
});

test("host plugin package consent is bound to exact files and revoked after rescan", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-consent-"));
	const manager = new HostPluginManager(root);
	try {
		const directory = join(root, "host-plugins", "viewer");
		await packageAt(directory);
		await manager.load();
		const initial = manager.catalog().plugins[0];
		assert.equal(initial.enabled, false);
		assert.equal(initial.requiresConsent, true);
		await manager.setEnabled(initial.manifest.id, true, initial.fingerprint);
		assert.ok(manager.getEnabled(initial.manifest.id));
		const approved = await readHostPluginPackage(directory);
		await appendFile(join(directory, "app.js"), " // changed without a version bump");
		await assert.rejects(readApprovedPluginAsset(approved, "app.js"), /plugin-code-changed/);
		await manager.rescan();
		assert.equal(manager.getEnabled(initial.manifest.id), undefined);
		await assert.rejects(manager.setEnabled(initial.manifest.id, true, initial.fingerprint), /plugin-changed/);
		const reload = new HostPluginManager(root);
		await reload.load();
		assert.equal(reload.catalog().plugins[0].enabled, false);
		reload.dispose();
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("旧状态文件里的 seeded 记录被忽略：授权照常生效，卸载不再有内置例外", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-state-"));
	const manager = new HostPluginManager(root);
	try {
		const directory = join(root, "host-plugins", "viewer");
		await packageAt(directory);
		const approved = await readHostPluginPackage(directory);
		// 旧版本把「内置示例落位指纹」也写在同一个文件里；现在只有 grants 有读者（无需迁移分支）。
		await writeFile(join(root, "host-plugin-state.json"), JSON.stringify({ version: 1, grants: { "example.viewer": { fingerprint: approved.fingerprint, enabled: true } }, seeded: { "billion-context": "a".repeat(64) } }));
		await manager.load();
		const catalog = manager.catalog();
		assert.deepEqual(Array.from(catalog.plugins, (plugin) => plugin.manifest.id), ["example.viewer"]);
		assert.equal(catalog.plugins[0].enabled, true);
		assert.deepEqual(plain((await manager.remove("example.viewer")).plugins), []);
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin package rejects directory symlinks and missing entry assets", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-path-"));
	try {
		const directory = join(root, "viewer");
		await packageAt(directory);
		const bad = manifest();
		bad.contributes.panels[0].entry = "missing.html";
		await writeFile(join(directory, "pideck-plugin.json"), JSON.stringify(bad));
		await assert.rejects(readHostPluginPackage(directory), /missing-panel-entry/);
		await writeFile(join(directory, "pideck-plugin.json"), JSON.stringify(manifest()));
		try {
			await symlink(directory, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (error.code === "EPERM") {
				t.diagnostic("OS disallows symlink creation; missing-entry assertion passed");
				return;
			}
			throw error;
		}
		await assert.rejects(readHostPluginPackage(join(root, "linked")), /symlink-not-allowed/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin storage stays in its own namespace, enforces quota and revocation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-storage-"));
	try {
		const storage = new HostPluginStorage(join(root, "storage"));
		await storage.set("viewer.one", "layout", { mode: "dna" }, () => true);
		assert.deepEqual(plain(await storage.get("viewer.one", "layout")), { mode: "dna" });
		assert.equal(await storage.get("viewer.two", "layout"), null);
		await assert.rejects(
			storage.set("viewer.one", "layout", "changed", () => false),
			/plugin-revoked/,
		);
		// 配额按插件包计：单文件 1 MiB（MAX_STORE_BYTES）、最多 200 个键（MAX_STORE_KEYS）。
		await assert.rejects(
			storage.set("viewer.one", "large", "x".repeat(1_200_000), () => true),
			/storage-too-large/,
		);
		// 已有 layout 一个键，再写到满 200 个键；接下来的新增一律 storage-full。
		for (let index = 0; index < 199; index += 1) await storage.set("viewer.one", `k${index}`, index, () => true);
		await assert.rejects(
			storage.set("viewer.one", "overflow", 1, () => true),
			/storage-full/,
		);
		// 已存在的键仍然可写：上限只拦新增键。
		await storage.set("viewer.one", "k0", 1, () => true);
		await assert.rejects(storage.get("../outside", "layout"), /invalid-plugin-id/);
		await assert.rejects(
			storage.set("viewer.one", "__proto__", {}, () => true),
			/invalid-storage-key/,
		);
		const stored = JSON.parse(await readFile(join(root, "storage", "viewer.one.json"), "utf8"));
		assert.equal(stored.layout.mode, "dna");
		assert.equal(Object.keys(stored).length, 200);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("卸载清私有 storage：等排队写入落定后删文件，缺失时不报错且不碰别的插件", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-storage-"));
	try {
		const directory = join(root, "storage");
		const storage = new HostPluginStorage(directory);
		await storage.set("viewer.one", "layout", { mode: "dna" }, () => true);
		await storage.set("viewer.two", "layout", { mode: "dna" }, () => true);
		// 与在途写并发：purge 先等该插件的队列落定再删，不留下晩到的正式文件。
		const pending = storage.set("viewer.one", "theme", "dark", () => true);
		await storage.purge("viewer.one");
		await pending.catch(() => undefined);
		assert.deepEqual((await readdir(directory)).sort(), ["viewer.two.json"]);
		assert.equal(await storage.get("viewer.one", "layout"), null);
		// 再清一次也不报错（force），别人的 store 不受影响。
		await storage.purge("viewer.one");
		assert.deepEqual(plain(await storage.get("viewer.two", "layout")), { mode: "dna" });
		await assert.rejects(() => storage.purge("../outside"), /invalid-plugin-id/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin storage aborts rename retry after revocation and never replaces the official file", async () => {
	// 回归：首次 rename 被 Windows 瞬态锁（EBUSY）拒绖后，退避窗口内插件被禁用/页面被卸载。
	// 每次尝试前的授权复查必须中止提交，绝不能让重试继续覆盖正式 storage 文件。
	const renames = [];
	const writes = [];
	const { HostPluginStorage } = createTsSandbox({
		stubs: {
			"node:fs/promises": {
				mkdir: async () => undefined,
				open: async () => {
					throw Object.assign(new Error("not found"), { code: "ENOENT" });
				},
				writeFile: async (path) => void writes.push(path),
				rename: async (from, to) => {
					renames.push(to);
					throw Object.assign(new Error("busy"), { code: "EBUSY" });
				},
			},
		},
	})("src/main/plugins/HostPluginStorage.ts");
	const storage = new HostPluginStorage("C:/fake/storage");
	// 授权在首次 rename 尝试后即被撤销（模拟退避窗口内禁用）。
	await assert.rejects(
		storage.set("viewer.one", "layout", { mode: "dna" }, () => renames.length === 0),
		/plugin-revoked/,
	);
	assert.equal(renames.length, 1, "first rename attempt happened, retry was cut short by revocation");
	assert.ok(
		writes.every((path) => String(path).endsWith(".tmp")),
		"only the temporary file was ever written",
	);
});

function brokerFixture(permissions = ["sessions.read"]) {
	let enabled = { manifest: manifest(permissions), fingerprint: "f" };
	const pending = deferred();
	const broker = new HostPluginBroker({ getEnabled: () => enabled, onChanged: () => () => {} }, { list: (context) => ({ sessions: [{ id: context.projectId }], nextOffset: null }), entries: () => pending.promise, describe: (context) => context }, { get: () => null, set: async () => undefined });
	broker.bind(10, "example.viewer", "f", { projectId: "project-a", locale: "en-US", theme: "dark" });
	return {
		broker,
		pending,
		disable: () => {
			enabled = undefined;
		},
	};
}

test("host plugin broker binds capabilities to the sender and checks permissions", async () => {
	const { broker } = brokerFixture([]);
	assert.equal((await broker.request(11, true, { method: "context.get" })).code, "plugin-not-authorized");
	assert.equal((await broker.request(10, false, { method: "context.get" })).code, "plugin-not-authorized");
	assert.equal((await broker.request(10, true, { method: "sessions.list" })).code, "permission-denied");
	assert.equal((await broker.request(10, true, { method: "context.get", pluginId: "another" })).value.projectId, "project-a");
	broker.dispose();
});

test("host plugin broker discards in-flight results on scope switch and disable", async () => {
	for (const mode of ["scope", "disable"]) {
		const { broker, pending, disable } = brokerFixture();
		const result = broker.request(10, true, { method: "sessions.entries", sessionId: "history" });
		if (mode === "scope") broker.update(10, { projectId: "project-b", locale: "en-US", theme: "dark" });
		else disable();
		pending.resolve({ entries: [{ sensitive: true }] });
		assert.equal((await result).code, "plugin-revoked");
		broker.dispose();
	}
});

test("host plugin broker gates workbench navigation by permission and project ownership", async () => {
	const navigated = [];
	const make = (permissions) => {
		const broker = new HostPluginBroker(
			{ getEnabled: () => ({ manifest: manifest(permissions), fingerprint: "f" }), onChanged: () => () => {} },
			{
				list: () => ({ sessions: [], nextOffset: null }),
				entries: async () => ({ entries: [], nextCursor: null, truncated: false }),
				resolveNavigation: (context, id) => (context.projectId === "project-a" && id === "history" ? { projectId: "project-a", sessionId: "history" } : undefined),
				describe: (context) => context,
			},
			{ get: () => null, set: async () => undefined },
		);
		broker.bind(10, "example.viewer", "f", { projectId: "project-a", locale: "en-US", theme: "dark" });
		return broker;
	};
	const denied = make(["sessions.read"]);
	assert.equal((await denied.request(10, true, { method: "workbench.navigate", sessionId: "history", entryId: "m1" })).code, "permission-denied");
	denied.dispose();
	const allowed = make(["sessions.read", "workbench.navigate"]);
	allowed.onNavigate((target) => void navigated.push(target));
	assert.equal((await allowed.request(10, true, { method: "workbench.navigate", sessionId: "foreign", entryId: "m1" })).code, "session-not-authorized");
	assert.ok((await allowed.request(10, true, { method: "workbench.navigate", sessionId: "history", entryId: "m1" })).ok);
	assert.ok((await allowed.request(10, true, { method: "workbench.navigate", sessionId: "history" })).ok);
	assert.equal(
		JSON.stringify(navigated),
		JSON.stringify([
			{ projectId: "project-a", sessionId: "history", entryId: "m1" },
			{ projectId: "project-a", sessionId: "history", entryId: undefined },
		]),
	);
	allowed.dispose();
});

test("host plugin broker navigates to the session's own project under workspace scope", async () => {
	// 工作区范围下目标可以是其他项目：导航的 projectId 取自会话归属，不看插件传入的当前项目。
	const navigated = [];
	const broker = new HostPluginBroker(
		{ getEnabled: () => ({ manifest: manifest(["sessions.read", "sessions.read.workspace", "workbench.navigate"]), fingerprint: "f" }), onChanged: () => () => {} },
		{
			list: () => ({ sessions: [], nextOffset: null }),
			entries: async () => ({ entries: [], nextCursor: null, truncated: false }),
			resolveNavigation: (context, id) => (id === "history" ? { projectId: "project-b", sessionId: "history" } : undefined),
			describe: (context, permissions) => ({ ...context, scope: permissions.includes("sessions.read.workspace") ? "workspace" : "project" }),
		},
		{ get: () => null, set: async () => undefined },
	);
	broker.onNavigate((target) => void navigated.push(target));
	broker.bind(10, "example.viewer", "f", { projectId: "project-a", locale: "en-US", theme: "dark" });
	assert.ok((await broker.request(10, true, { method: "workbench.navigate", sessionId: "history", entryId: "m1" })).ok);
	assert.deepEqual(plain(navigated), [{ projectId: "project-b", sessionId: "history", entryId: "m1" }]);
	broker.dispose();
});

test("host plugin reads and navigation cover sessions without a JSONL history", async () => {
	// 回归：DSH/ACP 会话没有 filePath，旧实现要求「有可读历史」才允许跳转，点一下必报 session-not-authorized。
	const piEntry = { id: "pi", projectId: "project-a", filePath: "/p/a.jsonl", environment: "native", title: "Pi", createdAt: 1, updatedAt: 3 };
	const dshEntry = { id: "dsh", projectId: "project-a", backend: "dsh", title: "DSH", createdAt: 1, updatedAt: 2 };
	const acpEntry = { id: "acp", projectId: "project-a", backend: "acp", title: "ACP", createdAt: 1, updatedAt: 1 };
	const list = [piEntry, dshEntry, acpEntry];
	const sessions = new HostPluginSessions({ listEntries: () => list, get: (id) => list.find((item) => item.id === id) }, (projectId) => ({ name: projectId, directory: `D:/repos/${projectId}` }));
	const context = { projectId: "project-a", locale: "en-US", theme: "dark" };
	assert.deepEqual(
		Array.from(sessions.list(context).sessions, (item) => [item.id, item.backend, item.readable]),
		[
			["pi", undefined, true],
			["dsh", "dsh", false],
			["acp", "acp", false],
		],
	);
	assert.deepEqual(plain(sessions.resolveNavigation(context, "dsh")), { projectId: "project-a", sessionId: "dsh" });
	assert.equal(sessions.get(context, "dsh").directory, "D:/repos/project-a");
	await assert.rejects(sessions.entries(context, "dsh"), /history-unavailable/);
	// project 范围仍然不跨项目
	list.push({ ...piEntry, id: "foreign", projectId: "project-b" });
	assert.equal(sessions.resolveNavigation(context, "foreign"), undefined);
	assert.throws(() => sessions.get(context, "foreign"), /session-not-authorized/);
});

test("host plugin workspace scope comes from the manifest and widens reads plus navigation", () => {
	const entries = [
		{ id: "a1", projectId: "project-a", title: "A one", createdAt: 1, updatedAt: 2 },
		{ id: "b1", projectId: "project-b", backend: "dsh", title: "B one", createdAt: 1, updatedAt: 3 },
	];
	const sessions = new HostPluginSessions({ listEntries: () => entries, get: (id) => entries.find((item) => item.id === id) }, (projectId) => ({ name: projectId, directory: `D:/repos/${projectId}` }));
	const workspaceContext = sessions.describe({ projectId: "project-a", locale: "en-US", theme: "dark", scope: "workspace" }, ["sessions.read", "sessions.read.workspace"]);
	// scope 只由权限决定：渲染层传上来的 scope 在 describe 里被覆盖
	assert.equal(workspaceContext.scope, "workspace");
	assert.deepEqual(
		Array.from(sessions.list(workspaceContext).sessions, (item) => item.id),
		["b1", "a1"],
	);
	assert.deepEqual(plain(sessions.resolveNavigation(workspaceContext, "b1")), { projectId: "project-b", sessionId: "b1" });
	assert.equal(sessions.get(workspaceContext, "b1").directory, "D:/repos/project-b");
	// 没有 workspace 权限：即使上下文伪造 scope 也按项目隔离
	const forged = sessions.describe({ projectId: "project-a", locale: "en-US", theme: "dark", scope: "workspace" }, ["sessions.read"]);
	assert.equal(forged.scope, "project");
	assert.deepEqual(
		Array.from(sessions.list(forged).sessions, (item) => item.id),
		["a1"],
	);
	assert.equal(sessions.resolveNavigation(forged, "b1"), undefined);
});

test("host plugin broker limits concurrent requests", async () => {
	const { broker, pending } = brokerFixture();
	const first = broker.request(10, true, { method: "sessions.entries", sessionId: "history" });
	const second = broker.request(10, true, { method: "sessions.entries", sessionId: "history" });
	assert.equal((await broker.request(10, true, { method: "sessions.entries", sessionId: "history" })).code, "rate-limited");
	pending.resolve({ entries: [] });
	assert.ok((await first).ok && (await second).ok);
	broker.dispose();
});

test("host plugin sessions read saved active-branch history without a pi runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-history-"));
	const path = join(root, "session.jsonl");
	const entries = [
		{ id: "header", type: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/private/project" },
		{
			id: "first",
			type: "message",
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "active" },
					{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" },
				],
			},
		},
		{ id: "detached", type: "message", parentId: "first", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: "other branch" } },
		{ id: "last", type: "message", parentId: "first", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", content: "chosen branch" } },
	];
	const catalogEntry = { id: "history", projectId: "project-a", filePath: path, environment: "native", title: "History", createdAt: 1, updatedAt: 2 };
	const sessions = new HostPluginSessions({ listEntries: () => [catalogEntry, { ...catalogEntry, id: "foreign", projectId: "project-b" }, { ...catalogEntry, id: "dsh", backend: "dsh" }], get: (id) => (id === "history" ? catalogEntry : undefined) });
	const context = { projectId: "project-a", locale: "en-US", theme: "dark" };
	try {
		await writeFile(path, entries.map(JSON.stringify).join("\n") + "\n");
		assert.equal(sessions.list({ locale: "en-US", theme: "dark" }).sessions.length, 0);
		assert.deepEqual(
			Array.from(sessions.list(context).sessions, (item) => [item.id, item.readable]),
			[
				["dsh", false],
				["history", true],
			],
		);
		const page = await sessions.entries(context, "history");
		assert.deepEqual(
			Array.from(page.entries, (entry) => entry.id),
			["first", "last"],
		);
		assert.ok(!JSON.stringify(page).includes("PRIVATE_IMAGE"));
		await assert.rejects(sessions.entries({ ...context, projectId: "project-b" }, "history"), /session-not-authorized/);
		await assert.rejects(sessions.entries(context, "missing"), /session-not-authorized/);
		await appendFile(path, JSON.stringify({ id: "new", parentId: "last", type: "message", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: "new" } }) + "\n");
		await assert.rejects(sessions.entries(context, "history", { before: 1, version: page.version }), /stale-cursor/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin session revision diff separates catalog changes from live appends", async () => {
	// 粒度推送回归：活跃文件追加 → 只报 sessionId；目录级变化 → catalogChanged；首次拉取/切上下文不报。
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-revision-"));
	const path = join(root, "live.jsonl");
	try {
		await writeFile(path, `${JSON.stringify({ id: "first", type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hi" } })}\n`);
		let title = "v1";
		let updatedAt = 2;
		const entry = { id: "live", projectId: "project-a", filePath: path, environment: "native", title, createdAt: 1, updatedAt };
		const catalog = { listEntries: () => [entry], get: (id) => (id === "live" ? entry : undefined) };
		const sessions = new HostPluginSessions(catalog);
		const context = { projectId: "project-a", sessionId: "live", locale: "en-US", theme: "dark" };
		// 首次拉取：无 previous，不产生事件。
		const first = await sessions.changeSince(context);
		assert.equal(JSON.stringify(first.detail), JSON.stringify({ catalogChanged: false }));
		// 活跃文件追加（catalog 未变）：定向事件。
		await appendFile(path, `${JSON.stringify({ id: "second", type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "reply" } })}\n`);
		const appended = await sessions.changeSince(context, first.revision);
		assert.equal(JSON.stringify(appended.detail), JSON.stringify({ catalogChanged: false, sessionId: "live" }));
		// 目录级变化（title/updatedAt）：catalogChanged。
		entry.title = "v2";
		entry.updatedAt = ++updatedAt;
		const rescan = await sessions.changeSince(context, appended.revision);
		assert.equal(JSON.stringify(rescan.detail), JSON.stringify({ catalogChanged: true }));
		// 同签名重复拉取：无事件。
		const again = await sessions.changeSince(context, rescan.revision);
		assert.equal(JSON.stringify(again.detail), JSON.stringify({ catalogChanged: false }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin sessions reject oversized history with a stable error instead of scanning it all", async () => {
	// 预算机制回归：生成超过条目上限（100_000）的会话文件，断言拒绝而非全量扫描。
	// 用 100k+ 小行触发 maxEntries 维度；byte 维度共用同一 charge 路径，不重复生成 64MiB 文件。
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-budget-"));
	const path = join(root, "huge.jsonl");
	try {
		const lines = [JSON.stringify({ id: "header", type: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/p" })];
		for (let index = 0; index < 100_001; index += 1) lines.push(JSON.stringify({ id: `m${index}`, parentId: index === 0 ? null : `m${index - 1}`, type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "x" } }));
		await writeFile(path, lines.join("\n") + "\n");
		const catalogEntry = { id: "huge", projectId: "project-a", filePath: path, environment: "native", title: "Huge", createdAt: 1, updatedAt: 2 };
		const sessions = new HostPluginSessions({ listEntries: () => [catalogEntry], get: (id) => (id === "huge" ? catalogEntry : undefined) });
		await assert.rejects(sessions.entries({ projectId: "project-a", locale: "en-US", theme: "dark" }, "huge"), /history-too-large/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin fork ancestors are merged only when they belong to the same project", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-fork-"));
	try {
		const parentPath = join(root, "parent.jsonl");
		const childPath = join(root, "child.jsonl");
		await writeFile(parentPath, [JSON.stringify({ id: "pheader", type: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/p" }), JSON.stringify({ id: "pmsg", type: "message", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "parent message" } })].join("\n") + "\n");
		await writeFile(
			childPath,
			[JSON.stringify({ id: "cheader", type: "session", parentSession: parentPath, timestamp: "2026-01-01T00:01:00Z", cwd: "/p" }), JSON.stringify({ id: "cmsg", type: "message", parentId: null, timestamp: "2026-01-01T00:01:01Z", message: { role: "user", content: "child message" } })].join("\n") + "\n",
		);
		const child = { id: "child", projectId: "project-a", filePath: childPath, environment: "native", title: "Child", createdAt: 1, updatedAt: 2 };
		const parent = (projectId) => ({ id: "parent", projectId, filePath: parentPath, environment: "native", title: "Parent", createdAt: 1, updatedAt: 2 });
		const context = { projectId: "project-a", locale: "en-US", theme: "dark" };
		// 同项目祖先：合并后能看到父会话消息。
		const same = new HostPluginSessions({ listEntries: () => [child, parent("project-a")], get: (id) => (id === "child" ? child : id === "parent" ? parent("project-a") : undefined) });
		const merged = await same.entries(context, "child");
		assert.ok(JSON.stringify(merged).includes("parent message"), "same-project ancestor messages are merged");
		// 跨项目祖先：授权拒绝，降级单文件读，绝不合并外部项目消息。
		const foreign = new HostPluginSessions({ listEntries: () => [child, parent("project-b")], get: (id) => (id === "child" ? child : id === "parent" ? parent("project-b") : undefined) });
		const isolated = await foreign.entries(context, "child");
		assert.ok(!JSON.stringify(isolated).includes("parent message"), "foreign-project ancestors are never merged");
		assert.ok(JSON.stringify(isolated).includes("child message"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
