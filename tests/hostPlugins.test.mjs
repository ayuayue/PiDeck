import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, symlink } from "node:fs/promises";
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
	const value = manifest();
	value.contributes.panels[0].entry = "../outside.html";
	assert.throws(() => parseHostPluginManifest(value), /invalid-panel/);
	const missing = manifest();
	missing.contributes.commands[0].panelId = "missing";
	assert.throws(() => parseHostPluginManifest(missing), /invalid-command/);
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
		await assert.rejects(
			storage.set("viewer.one", "large", "x".repeat(70_000), () => true),
			/storage-too-large/,
		);
		await assert.rejects(storage.get("../outside", "layout"), /invalid-plugin-id/);
		await assert.rejects(
			storage.set("viewer.one", "__proto__", {}, () => true),
			/invalid-storage-key/,
		);
		assert.deepEqual(JSON.parse(await readFile(join(root, "storage", "viewer.one.json"), "utf8")), { layout: { mode: "dna" } });
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
	const broker = new HostPluginBroker({ getEnabled: () => enabled }, { list: (context) => ({ sessions: [{ id: context.projectId }], nextOffset: null }), entries: () => pending.promise }, { get: () => null, set: async () => undefined });
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
			{ getEnabled: () => ({ manifest: manifest(permissions), fingerprint: "f" }) },
			{ list: () => ({ sessions: [], nextOffset: null }), entries: async () => ({ entries: [], nextCursor: null, truncated: false }), navigable: (context, id) => context.projectId === "project-a" && id === "history" },
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
