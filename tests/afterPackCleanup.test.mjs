import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import { readFileSync } from "node:fs";
import { finished } from "node:stream/promises";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const afterPack = require("../scripts/after-pack-cleanup.js");
const afterPackCleanup = afterPack.default;
const unpackGlobFromFiles = afterPack.unpackGlobFromFiles;

function isUnpackedInHeader(archive, relativePath) {
	const parts = relativePath.replaceAll("\\", "/").replace(/^\//, "").split("/");
	let node = asar.getRawHeader(archive).header;
	for (const part of parts) {
		node = node?.files?.[part];
		if (!node) return false;
	}
	return node.unpacked === true;
}

async function put(path, content) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

/**
 * @electron/asar 返回写入流而不是完成 Promise；测试必须等待 close，
 * 否则 afterPack 可能在 archive 尚未落盘时开始 extract，得到空 fixture。
 */
async function createAsarPackage(...args) {
	const stream = await asar.createPackage(...args);
	await finished(stream);
}

async function createAsarPackageWithOptions(...args) {
	const stream = await asar.createPackageWithOptions(...args);
	await finished(stream);
}

function normalizedEntries(archive) {
	return asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
}

test("afterPack cleanup preserves the Lark SDK package main entry", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const packageDir = join(sourceDir, "node_modules", "@larksuiteoapi", "node-sdk");

		await put(join(packageDir, "package.json"), JSON.stringify({ main: "./lib/index.js" }));
		await put(join(packageDir, "lib", "index.js"), "module.exports = {};\n");
		await put(join(packageDir, "es", "index.js"), "export {};\n");
		await put(join(packageDir, "README.md"), "fixture documentation\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackage(sourceDir, archive);

		await afterPackCleanup({ appOutDir });

		const entries = normalizedEntries(archive);
		assert.ok(
			entries.includes("node_modules/@larksuiteoapi/node-sdk/lib/index.js"),
			"the package.json main entry must remain in the final asar",
		);
		assert.equal(
			entries.includes("node_modules/@larksuiteoapi/node-sdk/README.md"),
			false,
			"the fixture must exercise an asar repack through normal documentation cleanup",
		);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("repack unpack glob keeps native binaries and hostEntry, not every .js", () => {
	const glob = unpackGlobFromFiles([
		"out/main/hostEntry.js",
		"node_modules/node-pty/prebuilds/win32-x64/pty.node",
		"node_modules/sql.js/dist/sql-wasm.wasm",
		"node_modules/@img/sharp-win32-x64/lib/libvips-42.dll",
		"node_modules/@deepseek-ai/dsh-attachment-local/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3",
	]);
	assert.match(String(glob), /hostEntry\.js/);
	assert.match(String(glob), /\*\.node/);
	assert.match(String(glob), /\*\.wasm/);
	assert.match(String(glob), /\*\.dll/);
	assert.match(String(glob), /\*\.so\*/);
	assert.doesNotMatch(String(glob), /\*\.js/);
});

test("package.json unpacks node-pty so packaged terminal can load pty.node", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const unpack = pkg.build?.asarUnpack ?? [];
	assert.ok(
		unpack.includes("node_modules/node-pty/**"),
		"asarUnpack must list node-pty; otherwise terminal:ensure fails in the installed app (#154)",
	);
	assert.ok(
		unpack.includes("node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty/**"),
		"asarUnpack must list the nested DSH node-pty 1.2 prebuild used by dsh-subprocess-local",
	);
});

test("package.json unpacks sharp native packages for every dependency depth", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const unpack = pkg.build?.asarUnpack ?? [];
	assert.ok(
		unpack.includes("node_modules/**/@img/sharp-*/**"),
		"asarUnpack must cover nested sharp libvips packages; versioned .so files need a real disk path on Linux",
	);
});

/**
 * 交叉打包回归（issue #201）：在 x64 构建机上打 arm64 包时，
 * 必须按 electron-builder 传的 context.arch 过滤 prebuild，
 * 而不是按构建机的 process.arch —— 否则会保留 x64 二进制、
 * 删掉 arm64，产物的终端在目标机上直接不可用。
 */
test("afterPack cleanup keeps the target arch node-pty prebuild when cross-building", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-crossarch-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const prebuildsDir = join(
			appOutDir,
			"resources",
			"app.asar.unpacked",
			"node_modules",
			"node-pty",
			"prebuilds",
		);

		await put(join(sourceDir, "node_modules", "node-pty", "README.md"), "fixture documentation\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackage(sourceDir, archive);

		for (const archName of ["linux-x64", "linux-arm64", "darwin-x64", "win32-x64"]) {
			await put(join(prebuildsDir, archName, "pty.node"), "NATIVE");
		}

		// electronPlatformName + arch(3=arm64) 是 electron-builder AfterPackContext 的形状
		await afterPackCleanup({ appOutDir, electronPlatformName: "linux", arch: 3 });

		const remaining = (await readdir(prebuildsDir)).sort();
		assert.deepEqual(
			remaining,
			["linux-arm64"],
			"cross-building linux arm64 must keep only the arm64 prebuild; keeping the build host arch breaks the terminal",
		);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack cleanup falls back to host arch when context arch is absent", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-hostarch-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const prebuildsDir = join(
			appOutDir,
			"resources",
			"app.asar.unpacked",
			"node_modules",
			"node-pty",
			"prebuilds",
		);

		await put(join(sourceDir, "node_modules", "node-pty", "README.md"), "fixture documentation\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackage(sourceDir, archive);

		for (const archName of ["linux-x64", "win32-x64"]) {
			await put(join(prebuildsDir, archName, "pty.node"), "NATIVE");
		}

		// 不传 arch/electronPlatformName：退化为构建机平台，保持旧行为不崩
		await afterPackCleanup({ appOutDir });

		const remaining = await readdir(prebuildsDir);
		assert.equal(
			remaining.length,
			1,
			"without an explicit target arch the cleanup must still keep exactly one prebuild",
		);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack cleanup keeps versioned libvips shared objects unpacked", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-libvips-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const libvipsPath = join(
			sourceDir,
			"node_modules",
			"@deepseek-ai",
			"dsh-attachment-local",
			"node_modules",
			"@img",
			"sharp-libvips-linux-x64",
			"lib",
			"libvips-cpp.so.8.18.3",
		);
		await put(libvipsPath, "ELF_SHARED_LIBRARY");
		await put(join(dirname(libvipsPath), "README.md"), "fixture documentation that forces a repack\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackageWithOptions(sourceDir, archive, { unpack: "*.so*" });

		const relativeLibvipsPath = "node_modules/@deepseek-ai/dsh-attachment-local/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3";
		assert.equal(
			isUnpackedInHeader(archive, relativeLibvipsPath),
			true,
			"fixture must start with libvips outside app.asar",
		);

		await afterPackCleanup({ appOutDir });

		assert.equal(
			isUnpackedInHeader(archive, relativeLibvipsPath),
			true,
			"repacking asar must preserve versioned ELF libraries outside app.asar",
		);
		assert.equal(
			normalizedEntries(archive).includes("node_modules/@deepseek-ai/dsh-attachment-local/node_modules/@img/sharp-libvips-linux-x64/lib/README.md"),
			false,
			"the fixture must exercise a real afterPack cleanup and repack",
		);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack cleanup keeps node-pty unpacked after asar repack", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-pty-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const ptyDir = join(sourceDir, "node_modules", "node-pty");
		await put(join(ptyDir, "lib", "utils.js"), "module.exports = {};\n");
		await put(join(ptyDir, "prebuilds", "win32-x64", "pty.node"), "NATIVE");
		await put(join(sourceDir, "out", "main", "hostEntry.js"), "module.exports = {};\n");
		await put(join(sourceDir, "out", "main", "index.js"), "module.exports = {};\n");
		await put(join(ptyDir, "README.md"), "fixture documentation that forces a repack\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackageWithOptions(sourceDir, archive, {
			unpack: "{**/*.node,hostEntry.js}",
		});

		assert.equal(
			isUnpackedInHeader(archive, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
			true,
			"fixture must start with an unpacked pty.node so the test exercises the regression",
		);
		assert.equal(
			isUnpackedInHeader(archive, "out/main/hostEntry.js"),
			true,
			"fixture must start with unpacked hostEntry.js like electron-builder asarUnpack",
		);

		await afterPackCleanup({ appOutDir });

		assert.equal(
			isUnpackedInHeader(archive, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
			true,
			"repacking asar must keep pty.node unpacked so Electron maps require() to app.asar.unpacked",
		);
		assert.equal(
			isUnpackedInHeader(archive, "out/main/hostEntry.js"),
			true,
			"repacking asar must keep hostEntry.js unpacked for utilityProcess",
		);
		assert.equal(
			isUnpackedInHeader(archive, "out/main/index.js"),
			false,
			"repacking must not unpack every .js just because hostEntry.js is unpacked",
		);
		assert.equal(
			normalizedEntries(archive).includes("node_modules/node-pty/README.md"),
			false,
			"the fixture must still exercise an asar repack through documentation cleanup",
		);
		const { existsSync } = await import("node:fs");
		assert.equal(
			existsSync(join(appOutDir, "resources", "app.asar.tmp")),
			false,
			"repack must not leave app.asar.tmp in the shipped app directory",
		);
		assert.equal(
			existsSync(join(appOutDir, "resources", "app.asar.tmp.unpacked")),
			false,
			"repack must not leave app.asar.tmp.unpacked; portable NSIS extracts it before the window appears",
		);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});
