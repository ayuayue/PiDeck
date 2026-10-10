import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");

function manifest(entry = "app.html") {
	return { schemaVersion: 1, apiVersion: 1, id: "example.viewer", name: "Viewer", version: "1.0.0", permissions: ["sessions.read"], contributes: { panels: [{ id: "context", title: "Context", entry }], commands: [] } };
}

/** 落一个可安装的目录包；默认入口在根，可传嵌套 entry 验证子目录资产。 */
async function packageAt(directory, entry = "app.html") {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "pideck-plugin.json"), JSON.stringify(manifest(entry)));
	await mkdir(join(directory, ...entry.split("/").slice(0, -1)), { recursive: true });
	await writeFile(join(directory, ...entry.split("/")), '<!doctype html><script src="app.js"></script>');
	await writeFile(join(directory, "app.js"), "document.body.textContent = 'viewer';");
}

/** 安装目录包必须与归档导入同权：落位、指纹、授权门禁都走同一条路径。 */
test("host plugin installs from a local directory and keeps the consent gate", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-dir-"));
	const manager = new HostPluginManager(root);
	try {
		// 真实开发树：VCS 目录、依赖树、文档、源码都与包共处一室，不该阻止安装。
		const source = join(root, "workspace", "viewer");
		await packageAt(source);
		await mkdir(join(source, ".git", "objects"), { recursive: true });
		await writeFile(join(source, ".git", "objects", "blob"), "history");
		await mkdir(join(source, "node_modules", "dep"), { recursive: true });
		await writeFile(join(source, "node_modules", "dep", "index.js"), "module.exports = 1;");
		await mkdir(join(source, "src"), { recursive: true });
		await writeFile(join(source, "src", "main.ts"), "export {};");
		await writeFile(join(source, "README.md"), "# Viewer");
		await writeFile(join(source, "LICENSE"), "MIT");

		const catalog = await manager.installDirectory(source);
		assert.equal(catalog.plugins.length, 1);
		const [plugin] = catalog.plugins;
		assert.equal(plugin.manifest.id, "example.viewer");
		assert.equal(plugin.enabled, false);
		assert.equal(plugin.requiresConsent, true);
		// 来源目录只作为来源：落位目录里只有这一个包，且是常规包目录。
		assert.deepEqual(await readdir(catalog.directory), ["example.viewer"]);
		const installed = (await readdir(join(catalog.directory, "example.viewer"))).sort();
		// VCS/依赖目录不进包（手工放置时它们会占用 100 文件预算）；其余可接受文件与
		// 手工放置/归档导入一样照搬 —— 包括开发噪声，这样两个安装入口得到的包内容一致。
		assert.ok(!installed.includes(".git") && !installed.includes("node_modules"));
		assert.deepEqual(installed, ["LICENSE", "README.md", "app.html", "app.js", "pideck-plugin.json", "src"]);
		await manager.setEnabled(plugin.manifest.id, true, plugin.fingerprint);
		assert.equal(manager.getEnabled(plugin.manifest.id).fingerprint, plugin.fingerprint);
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin directory install keeps nested assets and refuses to swap code under a running plugin", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-dir-nested-"));
	const manager = new HostPluginManager(root);
	try {
		const source = join(root, "viewer");
		await packageAt(source, "assets/app.html");
		const catalog = await manager.installDirectory(source);
		const plugin = catalog.plugins[0];
		assert.deepEqual(await readdir(join(catalog.directory, "example.viewer", "assets")), ["app.html"]);
		await manager.setEnabled(plugin.manifest.id, true, plugin.fingerprint);
		// 启用中重装：先禁用，避免运行中被换血；失败不能留下半更新状态。
		await writeFile(join(source, "app.js"), "document.body.textContent = 'v2';");
		await assert.rejects(manager.installDirectory(source), /plugin-in-use/);
		assert.equal(manager.getEnabled(plugin.manifest.id).fingerprint, plugin.fingerprint);
		assert.deepEqual(await readdir(catalog.directory), ["example.viewer"]);
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin directory install rejects symlinks anywhere inside the source tree", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-dir-link-"));
	const manager = new HostPluginManager(root);
	try {
		const source = join(root, "viewer");
		await packageAt(source);
		const outside = join(root, "outside");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret.js"), "secret");
		try {
			await symlink(outside, join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (error.code === "EPERM") {
				t.diagnostic("OS disallows symlink creation; symlink guard covered by readHostPluginPackage test");
				return;
			}
			throw error;
		}
		await assert.rejects(manager.installDirectory(source), /symlink-not-allowed/);
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin directory install rejects junk sources and leaves no staging residue", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-dir-junk-"));
	const manager = new HostPluginManager(root);
	try {
		await assert.rejects(manager.installDirectory(join(root, "missing")), /not-a-directory/);
		// 未转换的上游目录（例如把 pi 扩展源码目录指了过来）：带不出 manifest，就报缺 manifest。
		const raw = join(root, "raw");
		await mkdir(join(raw, "src"), { recursive: true });
		await writeFile(join(raw, "src", "index.ts"), "export default function () {}");
		await assert.rejects(manager.installDirectory(raw), /missing-manifest/);
		// 入口资产缺失：与归档导入同一个 readHostPluginPackage 判定。
		const broken = join(root, "broken");
		await packageAt(broken);
		await rm(join(broken, "app.html"));
		await assert.rejects(manager.installDirectory(broken), /missing-panel-entry/);
		// 三次失败都不留隐藏暂存目录，也不产生任何已安装包。
		assert.deepEqual(await readdir(join(root, "host-plugins")), []);
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin directory install enforces the same package budgets as archive import", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-plugin-dir-budget-"));
	const manager = new HostPluginManager(root);
	try {
		const many = join(root, "many");
		await packageAt(many);
		for (let index = 0; index < 100; index += 1) await writeFile(join(many, `asset-${index}.js`), "1");
		await assert.rejects(manager.installDirectory(many), /invalid-package-file/);
		// 单文件上限（4MiB）复用的是安装后读资产时的同一判定。
		const big = join(root, "big");
		await packageAt(big);
		await writeFile(join(big, "huge.js"), "x".repeat(4 * 1024 * 1024 + 1));
		await assert.rejects(manager.installDirectory(big), /asset-too-large/);
		assert.deepEqual(await readdir(join(root, "host-plugins")), []);
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
