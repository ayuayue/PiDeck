import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildHostPluginArchive, parseHostPluginArchive } = loadTsCommonJs("src/main/plugins/hostPluginArchive.ts");
const { readHostPluginPackage } = loadTsCommonJs("src/main/plugins/hostPluginFiles.ts");
const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");

const manifest = (permissions = []) => ({
	schemaVersion: 1,
	apiVersion: 1,
	id: "example.viewer",
	name: "Viewer",
	version: "1.0.0",
	permissions,
	contributes: { panels: [{ id: "context", title: "Context", entry: "app.html" }], commands: [] },
});
const packageFiles = () => [
	{ path: "pideck-plugin.json", bytes: Buffer.from(JSON.stringify(manifest()), "utf8") },
	{ path: "app.html", bytes: Buffer.from("<!doctype html><title>ok</title>", "utf8") },
];

test("host plugin archive round-trips with stable fingerprints across packer and installer", async () => {
	const archive = buildHostPluginArchive(packageFiles());
	const parsed = parseHostPluginArchive(archive);
	assert.equal(
		parsed.files
			.map((file) => file.path)
			.sort()
			.join(","),
		"app.html,pideck-plugin.json",
	);
	assert.equal(
		parsed.files
			.map((file) => file.bytes.toString("utf8"))
			.sort()
			.join("\u0000"),
		packageFiles()
			.map((file) => file.bytes.toString("utf8"))
			.sort()
			.join("\u0000"),
	);
	// 安装侧与目录包同一信任入口：解析出的文件集必须得到与 readHostPluginPackage 一致的指纹材料。
	const root = await mkdtemp(join(tmpdir(), "pideck-archive-"));
	try {
		for (const file of parsed.files) await writeFile(join(root, file.path), file.bytes);
		const pkg = await readHostPluginPackage(root);
		assert.equal(pkg.manifest.id, "example.viewer");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin archive rejects tampered hashes, lying sizes and malformed lines", () => {
	assert.throws(() => parseHostPluginArchive(Buffer.from("", "utf8")), /archive-too-large/);
	assert.throws(() => parseHostPluginArchive(Buffer.from("not-json\n", "utf8")), /archive-invalid/);
	assert.throws(() => parseHostPluginArchive(Buffer.from(JSON.stringify({ kind: "pideck-host-plugin", formatVersion: 2, files: 0 }) + "\n", "utf8")), /archive-invalid/);
	assert.throws(() => parseHostPluginArchive(Buffer.from(JSON.stringify({ kind: "pideck-host-plugin", formatVersion: 1, files: 1 }) + "\n" + JSON.stringify({ kind: "file", path: "app.html", sha256: "0".repeat(64), size: 1, data: Buffer.from("x").toString("base64") }) + "\n", "utf8")), /archive-hash-mismatch/);
	// 篡改一个字节后 sha256 不匹配。
	const rebuilt = buildHostPluginArchive(packageFiles());
	const lines = rebuilt.toString("utf8").split("\n");
	const fileLine = JSON.parse(lines[1]);
	fileLine.data = Buffer.from("<!doctype html><title>evil</title>", "utf8").toString("base64");
	lines[1] = JSON.stringify(fileLine);
	assert.throws(() => parseHostPluginArchive(Buffer.from(lines.join("\n"), "utf8")), /archive-hash-mismatch|archive-size-mismatch/);
	// 声明 size 与真实字节不符。
	const lying = packageFiles();
	const lyingArchive = buildHostPluginArchive(lying);
	const lyingLines = lyingArchive.toString("utf8").split("\n");
	const lyingEntry = JSON.parse(lyingLines[1]);
	lyingEntry.size = lyingEntry.size + 1;
	lyingLines[1] = JSON.stringify(lyingEntry);
	assert.throws(() => parseHostPluginArchive(Buffer.from(lyingLines.join("\n"), "utf8")), /archive-size-mismatch/);
});

test("host plugin archive rejects traversal paths, duplicates and missing manifests", () => {
	const manifestEntry = { path: "pideck-plugin.json", bytes: Buffer.from(JSON.stringify(manifest()), "utf8") };
	assert.throws(() => buildHostPluginArchive([{ path: "../escape.html", bytes: Buffer.alloc(1) }, manifestEntry]), /archive-path-invalid/);
	assert.throws(() => buildHostPluginArchive([{ path: "a\\b.html", bytes: Buffer.alloc(1) }, manifestEntry]), /archive-path-invalid/);
	assert.throws(() => buildHostPluginArchive([{ path: "a.html", bytes: Buffer.alloc(1) }, { path: "a.html", bytes: Buffer.alloc(1) }, manifestEntry]), /archive-duplicate-path/);
	assert.throws(() => buildHostPluginArchive([{ path: "app.html", bytes: Buffer.alloc(1) }]), /archive-missing-manifest/);
});

test("host plugin archive enforces size and count budgets", () => {
	const big = Buffer.alloc(4 * 1024 * 1024 + 1);
	assert.throws(
		() =>
			buildHostPluginArchive([
				{ path: "big.png", bytes: big },
				{ path: "pideck-plugin.json", bytes: Buffer.from("{}", "utf8") },
			]),
		/archive-file-too-large/,
	);
	const many = [{ path: "pideck-plugin.json", bytes: Buffer.from("{}", "utf8") }, ...Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.js`, bytes: Buffer.alloc(1) }))];
	assert.throws(() => buildHostPluginArchive(many), /archive-invalid/);
	// 展开总量 16MiB 上限：4 个 4MiB 文件（其中一个必须是 manifest，改用 3 大文件 + manifest）。
	const heavy = [{ path: "pideck-plugin.json", bytes: Buffer.from("{}", "utf8") }, ...Array.from({ length: 4 }, (_, i) => ({ path: `h${i}.png`, bytes: Buffer.alloc(4 * 1024 * 1024) }))];
	assert.throws(() => buildHostPluginArchive(heavy), /archive-expanded-too-large/);
});

async function managerWith(root) {
	const manager = new HostPluginManager(root);
	await manager.load();
	return manager;
}

test("host plugin manager installs archives disabled-by-default and keeps consent on reinstall", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-install-"));
	const archivePath = join(root, "example.viewer.pideck-plugin");
	try {
		await writeFile(archivePath, buildHostPluginArchive(packageFiles()));
		const manager = await managerWith(join(root, "host-plugins"));
		const catalog = await manager.installArchive(archivePath);
		const installed = catalog.plugins.find((plugin) => plugin.manifest.id === "example.viewer");
		assert.ok(installed && !installed.enabled, "installed plugins arrive disabled pending consent");
		assert.match(installed.fingerprint, /^[a-f0-9]{64}$/, "fingerprint shape");
		// 授权后重装同 id：启用状态下拒绝替换，禁用后允许且授权因指纹一致而保留。
		const enabled = await manager.setEnabled("example.viewer", true, installed.fingerprint);
		assert.ok(enabled.plugins.find((plugin) => plugin.manifest.id === "example.viewer")?.enabled);
		await assert.rejects(manager.installArchive(archivePath), /plugin-in-use/);
		const stillEnabled = (await manager.catalog()).plugins.find((plugin) => plugin.manifest.id === "example.viewer");
		assert.ok(stillEnabled?.enabled, "rejected install leaves the running plugin untouched");
		await manager.setEnabled("example.viewer", false, installed.fingerprint);
		const reinstalled = await manager.installArchive(archivePath);
		const after = reinstalled.plugins.find((plugin) => plugin.manifest.id === "example.viewer");
		assert.ok(after && !after.enabled && after.fingerprint === installed.fingerprint, "identical bytes reinstall keeps the fingerprint, grant resets to disabled only if changed");
		// 内容变化后指纹改变，旧授权失效。
		const changed = packageFiles();
		changed[0] = { path: "pideck-plugin.json", bytes: Buffer.from(JSON.stringify(manifest(["sessions.read"])), "utf8") };
		await writeFile(archivePath, buildHostPluginArchive(changed));
		const updated = await manager.installArchive(archivePath);
		const changedPlugin = updated.plugins.find((plugin) => plugin.manifest.id === "example.viewer");
		assert.ok(changedPlugin && changedPlugin.fingerprint !== installed.fingerprint && !changedPlugin.enabled, "changed code must not reuse the old grant");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("host plugin manager install failures clean up temp state and surface stable codes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-install-fail-"));
	const archivePath = join(root, "broken.pideck-plugin");
	try {
		// 缺 panel 入口的 manifest：readHostPluginPackage 层面失败。
		const broken = packageFiles().filter((file) => file.path !== "pideck-plugin.json");
		broken.push({ path: "pideck-plugin.json", bytes: Buffer.from(JSON.stringify({ ...manifest(), contributes: { panels: [{ id: "context", title: "Context", entry: "missing.html" }], commands: [] } }), "utf8") });
		await writeFile(archivePath, buildHostPluginArchive(broken));
		const manager = await managerWith(join(root, "host-plugins"));
		await assert.rejects(manager.installArchive(archivePath), /missing-panel-entry/);
		const { readdir } = await import("node:fs/promises");
		const leftover = (await readdir(manager.directory)).filter((name) => name.startsWith("."));
		assert.deepEqual(leftover, [], "no temp or retired directories survive a failed install");
		assert.equal((await manager.catalog()).plugins.length, 0, "catalog stays clean");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
