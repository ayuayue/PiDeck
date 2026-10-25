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

		await afterPackCleanup({ appOutDir, verifyNodePtyRuntime: false });

		const entries = normalizedEntries(archive);
		assert.ok(entries.includes("node_modules/@larksuiteoapi/node-sdk/lib/index.js"), "the package.json main entry must remain in the final asar");
		assert.equal(entries.includes("node_modules/@larksuiteoapi/node-sdk/README.md"), false, "the fixture must exercise an asar repack through normal documentation cleanup");
		assert.equal(entries.includes("node_modules/@larksuiteoapi/node-sdk/es/index.js"), false, "asar must drop the ESM copy; CJS main is lib/index.js");
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
	assert.ok(unpack.includes("node_modules/node-pty/**"), "asarUnpack must list node-pty; otherwise terminal:ensure fails in the installed app (#154)");
	assert.ok(unpack.includes("node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty/**"), "asarUnpack must list the nested DSH node-pty 1.2 prebuild used by dsh-subprocess-local");
});

test("package.json unpacks koffi platform packages for all build targets", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const unpack = pkg.build?.asarUnpack ?? [];
	// koffi 3.x 的平台二进制拆在 @koromix/koffi-<os>-<arch> 可选依赖里，npm 只装宿主
	// 平台的包。显式条目曾被删导致 0.7.8 linux 回归（7f72fa98a 恢复）；交叉打包产物
	//（arm64 runner 打 x64 mac 包，issue #313）不能依赖 smart-unpack 兜底，这里固化契约。
	for (const entry of ["node_modules/@koromix/koffi-win32-x64/**", "node_modules/@koromix/koffi-linux-x64/**", "node_modules/@koromix/koffi-linux-arm64/**", "node_modules/@koromix/koffi-darwin-arm64/**", "node_modules/@koromix/koffi-darwin-x64/**"]) {
		assert.ok(unpack.includes(entry), `asarUnpack must list ${entry}; koffi .node can only dlopen from a real filesystem path`);
	}
});

test("package.json unpacks sharp native packages for every dependency depth", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const unpack = pkg.build?.asarUnpack ?? [];
	assert.ok(unpack.includes("node_modules/**/@img/sharp-*/**"), "asarUnpack must cover nested sharp libvips packages; versioned .so files need a real disk path on Linux");
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
		const ptyDir = join(sourceDir, "node_modules", "node-pty");
		const prebuildsDir = join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");

		await put(join(ptyDir, "README.md"), "fixture documentation\n");
		for (const archName of ["linux-x64", "linux-arm64", "darwin-x64", "win32-x64"]) {
			await put(join(ptyDir, "prebuilds", archName, "pty.node"), "NATIVE");
		}
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackageWithOptions(sourceDir, archive, { unpack: "*.node" });

		// electronPlatformName + arch(3=arm64) 是 electron-builder AfterPackContext 的形状
		await afterPackCleanup({ appOutDir, electronPlatformName: "linux", arch: 3 });

		const remaining = (await readdir(prebuildsDir)).sort();
		assert.deepEqual(remaining, ["linux-arm64"], "cross-building linux arm64 must keep only the arm64 prebuild; keeping the build host arch breaks the terminal");
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack cleanup falls back to host arch when context arch is absent", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-hostarch-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const ptyDir = join(sourceDir, "node_modules", "node-pty");
		const prebuildsDir = join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds");

		await put(join(ptyDir, "README.md"), "fixture documentation\n");
		for (const archName of ["linux-x64", "win32-x64"]) {
			await put(join(ptyDir, "prebuilds", archName, "pty.node"), "NATIVE");
		}
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackageWithOptions(sourceDir, archive, { unpack: "*.node" });

		// 不传 arch/electronPlatformName：退化为构建机平台，保持旧行为不崩
		await afterPackCleanup({ appOutDir });

		const remaining = await readdir(prebuildsDir);
		assert.equal(remaining.length, 1, "without an explicit target arch the cleanup must still keep exactly one prebuild");
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack cleanup keeps versioned libvips shared objects unpacked", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-libvips-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const libvipsPath = join(sourceDir, "node_modules", "@deepseek-ai", "dsh-attachment-local", "node_modules", "@img", "sharp-libvips-linux-x64", "lib", "libvips-cpp.so.8.18.3");
		await put(libvipsPath, "ELF_SHARED_LIBRARY");
		await put(join(dirname(libvipsPath), "README.md"), "fixture documentation that forces a repack\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackageWithOptions(sourceDir, archive, { unpack: "*.so*" });

		const relativeLibvipsPath = "node_modules/@deepseek-ai/dsh-attachment-local/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3";
		assert.equal(isUnpackedInHeader(archive, relativeLibvipsPath), true, "fixture must start with libvips outside app.asar");

		await afterPackCleanup({ appOutDir, verifyNodePtyRuntime: false });

		assert.equal(isUnpackedInHeader(archive, relativeLibvipsPath), true, "repacking asar must preserve versioned ELF libraries outside app.asar");
		assert.equal(normalizedEntries(archive).includes("node_modules/@deepseek-ai/dsh-attachment-local/node_modules/@img/sharp-libvips-linux-x64/lib/README.md"), false, "the fixture must exercise a real afterPack cleanup and repack");
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack preserves Linux source-built node-pty when no target prebuild exists", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-linux-pty-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const ptyDir = join(sourceDir, "node_modules", "node-pty");
		const ptyNodeRel = "node_modules/node-pty/build/Release/pty.node";

		await put(join(ptyDir, "lib", "index.js"), "module.exports = {};\n");
		await put(join(ptyDir, "build", "Release", "pty.node"), "NATIVE_BUILD");
		await put(join(ptyDir, "README.md"), "fixture documentation that forces a repack\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackageWithOptions(sourceDir, archive, { unpack: "*.node" });

		await afterPackCleanup({ appOutDir, electronPlatformName: "linux", arch: 1 });

		const { existsSync } = await import("node:fs");
		const unpackedPty = join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty");
		assert.equal(isUnpackedInHeader(archive, ptyNodeRel), true, "repacking must keep Linux build/Release/pty.node unpacked");
		assert.equal(existsSync(join(unpackedPty, "build", "Release", "pty.node")), true, "without a linux prebuild, build/Release/pty.node is the only loadable runtime artifact");
		assert.equal(normalizedEntries(archive).includes("node_modules/node-pty/README.md"), false, "the fixture must exercise an asar repack");
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack fails closed when node-pty has no loadable native artifact", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-missing-pty-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const ptyDir = join(sourceDir, "node_modules", "node-pty");

		await put(join(ptyDir, "lib", "index.js"), "module.exports = {};\n");
		await put(join(ptyDir, "README.md"), "fixture documentation that forces a repack\n");
		await mkdir(dirname(archive), { recursive: true });
		await createAsarPackage(sourceDir, archive);

		await assert.rejects(() => afterPackCleanup({ appOutDir, electronPlatformName: "linux", arch: 1 }), /node-pty runtime artifact missing for linux-x64/);
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack cleanup removes node-pty build only when a target prebuild remains", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-pty-"));
	try {
		const sourceDir = join(appOutDir, "fixture");
		const archive = join(appOutDir, "resources", "app.asar");
		const ptyDir = join(sourceDir, "node_modules", "node-pty");
		// 不传 electronPlatformName 时 keepPrefix = 构建机平台；写死 win32-x64 会在 Linux CI 被删掉。
		const hostPrebuild = `${process.platform}-${process.arch}`;
		const ptyNodeRel = `node_modules/node-pty/prebuilds/${hostPrebuild}/pty.node`;
		await put(join(ptyDir, "lib", "utils.js"), "module.exports = {};\n");
		await put(join(ptyDir, "src", "index.ts"), "export {};\n");
		await put(join(ptyDir, "third_party", "conpty", "README.md"), "sources\n");
		await put(join(ptyDir, "build", "Release", "pty.node"), "NATIVE_BUILD");
		await put(join(ptyDir, "deps", "winpty", "README.md"), "winpty sources\n");
		await put(join(ptyDir, "scripts", "post-install.js"), "// compile-time\n");
		await put(join(ptyDir, "prebuilds", hostPrebuild, "pty.node"), "NATIVE");
		await put(join(ptyDir, "prebuilds", hostPrebuild, "conpty", "conpty.dll"), "DLL");
		await put(join(sourceDir, "out", "main", "hostEntry.js"), "module.exports = {};\n");
		await put(join(sourceDir, "out", "main", "index.js"), "module.exports = {};\n");
		await put(join(ptyDir, "README.md"), "fixture documentation that forces a repack\n");
		await mkdir(dirname(archive), { recursive: true });
		// 生产 asarUnpack 是 node-pty/**；这里用后缀匹配把 .node/.dll 标 unpacked。
		await createAsarPackageWithOptions(sourceDir, archive, {
			unpack: "{**/*.node,**/*.dll,hostEntry.js}",
		});
		const unpackedPty = join(appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty");
		// asarUnpack 影子目录：源码树也会出现在 unpacked，afterPack 必须两边都清。
		await put(join(unpackedPty, "lib", "utils.js"), "module.exports = {};\n");
		await put(join(unpackedPty, "src", "index.ts"), "export {};\n");
		await put(join(unpackedPty, "third_party", "conpty", "README.md"), "sources\n");
		await put(join(unpackedPty, "build", "Release", "pty.node"), "NATIVE_BUILD");
		await put(join(unpackedPty, "deps", "winpty", "README.md"), "winpty sources\n");
		await put(join(unpackedPty, "scripts", "post-install.js"), "// compile-time\n");

		assert.equal(isUnpackedInHeader(archive, ptyNodeRel), true, "fixture must start with an unpacked pty.node so the test exercises the regression");
		assert.equal(isUnpackedInHeader(archive, "out/main/hostEntry.js"), true, "fixture must start with unpacked hostEntry.js like electron-builder asarUnpack");

		await afterPackCleanup({ appOutDir });

		assert.equal(isUnpackedInHeader(archive, ptyNodeRel), true, "repacking asar must keep pty.node unpacked so Electron maps require() to app.asar.unpacked");
		assert.equal(isUnpackedInHeader(archive, "out/main/hostEntry.js"), true, "repacking asar must keep hostEntry.js unpacked for utilityProcess");
		assert.equal(isUnpackedInHeader(archive, "out/main/index.js"), false, "repacking must not unpack every .js just because hostEntry.js is unpacked");
		assert.equal(normalizedEntries(archive).includes("node_modules/node-pty/README.md"), false, "the fixture must still exercise an asar repack through documentation cleanup");
		const { existsSync } = await import("node:fs");
		assert.equal(existsSync(join(appOutDir, "resources", "app.asar.tmp")), false, "repack must not leave app.asar.tmp in the shipped app directory");
		assert.equal(existsSync(join(appOutDir, "resources", "app.asar.tmp.unpacked")), false, "repack must not leave app.asar.tmp.unpacked; portable NSIS extracts it before the window appears");
		assert.equal(normalizedEntries(archive).includes("node_modules/node-pty/src/index.ts"), false, "asar copy of node-pty src/ is compile-time only");
		assert.equal(existsSync(join(unpackedPty, "src")), false, "unpacked node-pty src/ must go");
		assert.equal(existsSync(join(unpackedPty, "third_party")), false, "unpacked node-pty third_party/ must go");
		assert.equal(existsSync(join(unpackedPty, "build")), false, "a target prebuild lets afterPack remove unpacked node-pty build/");
		assert.equal(existsSync(join(unpackedPty, "deps")), false, "unpacked node-pty deps/ is winpty source, not required at runtime");
		assert.equal(existsSync(join(unpackedPty, "scripts")), false, "unpacked node-pty scripts/ is compile-time only");
		assert.equal(normalizedEntries(archive).includes("node_modules/node-pty/deps/winpty/README.md"), false, "asar copy of node-pty deps/ must go with the unpacked tree");
		assert.equal(normalizedEntries(archive).includes("node_modules/node-pty/lib/utils.js"), true, "asar copy of node-pty lib/ is the JS runtime");
		assert.equal(existsSync(join(unpackedPty, "lib", "utils.js")), true, "unpacked node-pty lib/ is the JS runtime; afterPack must keep it");
		assert.equal(existsSync(join(unpackedPty, "prebuilds", hostPrebuild, "pty.node")), true, "current-platform prebuild must remain");
		assert.equal(existsSync(join(unpackedPty, "prebuilds", hostPrebuild, "conpty", "conpty.dll")), true, "conpty.dll lives beside the .node; afterPack must not sweep files inside the kept prebuild");
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

test("afterPack cleanup drops unused Electron shader DLLs but keeps ffmpeg/vulkan/ANGLE", async () => {
	const appOutDir = await mkdtemp(join(tmpdir(), "pideck-after-pack-dll-"));
	try {
		await writeFile(join(appOutDir, "dxcompiler.dll"), "x".repeat(100), "utf8");
		await writeFile(join(appOutDir, "dxil.dll"), "x".repeat(100), "utf8");
		await writeFile(join(appOutDir, "vk_swiftshader.dll"), "x".repeat(100), "utf8");
		await writeFile(join(appOutDir, "vk_swiftshader_icd.json"), "{}", "utf8");
		await writeFile(join(appOutDir, "ffmpeg.dll"), "keep", "utf8");
		await writeFile(join(appOutDir, "vulkan-1.dll"), "keep", "utf8");
		await writeFile(join(appOutDir, "libEGL.dll"), "keep", "utf8");
		await writeFile(join(appOutDir, "libGLESv2.dll"), "keep", "utf8");
		await writeFile(join(appOutDir, "d3dcompiler_47.dll"), "keep", "utf8");

		await afterPackCleanup({ appOutDir });

		const { existsSync } = await import("node:fs");
		assert.equal(existsSync(join(appOutDir, "dxcompiler.dll")), false);
		assert.equal(existsSync(join(appOutDir, "dxil.dll")), false);
		assert.equal(existsSync(join(appOutDir, "vk_swiftshader.dll")), false);
		assert.equal(existsSync(join(appOutDir, "vk_swiftshader_icd.json")), false);
		assert.equal(existsSync(join(appOutDir, "ffmpeg.dll")), true, "ffmpeg is media playback, keep");
		assert.equal(existsSync(join(appOutDir, "vulkan-1.dll")), true, "vulkan-1 is GPU path, keep");
		assert.equal(existsSync(join(appOutDir, "libEGL.dll")), true, "ANGLE must stay");
		assert.equal(existsSync(join(appOutDir, "libGLESv2.dll")), true, "ANGLE must stay");
		assert.equal(existsSync(join(appOutDir, "d3dcompiler_47.dll")), true, "ANGLE must stay");
	} finally {
		await rm(appOutDir, { recursive: true, force: true });
	}
});

/**
 * #257 的实际根因不是「打包漏了原生模块」，而是 runner（ubuntu-24.04 系，glibc 2.39）现编的
 * pty.node 需要 GLIBC_2.34，国产发行版（glibc 2.28）上无法 dlopen。打包门禁因此除了
 * 「产物在包里」还要核对符号基线。
 */
const { assertLinuxNativeBaseline } = require("../scripts/after-pack-node-pty.js");

function fakeAddon(overrides) {
	return { file: "/pkg/node-pty/build/Release/pty.node", format: "elf64-x86-64", arch: "x64", glibc: [], glibcxx: [], ...overrides };
}

test("afterPack baseline gate rejects a Linux pty.node built on a newer glibc", () => {
	const describe = () => fakeAddon({ glibc: ["2.2.5", "2.28", "2.32", "2.34"], glibcxx: ["3.4.22"] });
	assert.throws(() => assertLinuxNativeBaseline("/pkg/pty.node", { describeAddon: describe }), /超出 glibc 2\.28 基线：GLIBC_2\.32 GLIBC_2\.34/);
});

test("afterPack baseline gate accepts a pty.node rebuilt on the glibc 2.28 baseline", () => {
	const describe = () => fakeAddon({ glibc: ["2.2.5", "2.28"], glibcxx: ["3.4.22"] });
	const verdict = assertLinuxNativeBaseline("/pkg/pty.node", { describeAddon: describe });
	assert.equal(verdict.ok, true);
});

test("afterPack baseline gate rejects a pty.node requiring a newer libstdc++", () => {
	const describe = () => fakeAddon({ glibc: ["2.28"], glibcxx: ["3.4.25", "3.4.29"] });
	assert.throws(() => assertLinuxNativeBaseline("/pkg/pty.node", { describeAddon: describe }), /GLIBCXX_3\.4\.29/);
});

test("afterPack baseline gate degrades when objdump is unavailable but not when the artifact is unreadable", () => {
	const missingObjdump = () => {
		throw new Error("无法执行 objdump: spawnSync objdump ENOENT");
	};
	assert.equal(assertLinuxNativeBaseline("/pkg/pty.node", { describeAddon: missingObjdump }), null, "本地缺 binutils 不该阻断打包");

	const nonElf = () => fakeAddon({ skipped: true, format: "pe", arch: "非 ELF" });
	assert.equal(assertLinuxNativeBaseline("/pkg/pty.node", { describeAddon: nonElf }), null);

	const broken = () => {
		throw new Error("objdump -T 失败（1）: bad object");
	};
	assert.throws(() => assertLinuxNativeBaseline("/pkg/pty.node", { describeAddon: broken }), /objdump -T 失败/, "其它解析失败必须 fail-closed");
});

test("afterPack cleanup wires the glibc baseline gate for Linux targets only", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "scripts", "after-pack-cleanup.js"), "utf8");
	assert.match(source, /CURRENT_PLATFORM\s*\.startsWith\("linux"\)\s*\)\s*assertLinuxNativeBaseline\(/, "打包 Linux 目标时必须核对原生模块 glibc 基线");
});
