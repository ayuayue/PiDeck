import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const baseline = require("../scripts/linux-native-baseline.js");

/**
 * 真实证据：node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty/
 * prebuilds/linux-arm64/pty.node 的 objdump -T 片段（v1.1.0 官方 arm64 预编译产物，
 * 需求 GLIBC_2.17/2.28、GLIBCXX 最高 3.4.22 → 能在 glibc 2.28 的发行版上加载）。
 */
const BASELINE_ARM64_OBJDUMP = `node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty/prebuilds/linux-arm64/pty.node:     file format elf64-little

DYNAMIC SYMBOL TABLE:
0000000000003470 l    d  .init\t0000000000000000              .init
0000000000000000      DF *UND*\t0000000000000000 (GLIBCXX_3.4) _Znam
0000000000000000      D  *UND*\t0000000000000000  Base        napi_call_threadsafe_function
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.17) memcpy
0000000000000000      DO *UND*\t0000000000000000 (GLIBC_2.17) __environ
0000000000000000      DF *UND*\t0000000000000000 (GLIBCXX_3.4.21) _ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE6resizeEmc
0000000000000000      DF *UND*\t0000000000000000 (GLIBCXX_3.4.14) _ZSt25__throw_bad_function_callv
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.28) stat
`;

/**
 * 问题现场：v0.8.0 的 arm64 包内 pty.node（在 ubuntu-24.04-arm / glibc 2.39 上现编）
 * 需求 GLIBC_2.34 —— openpty/forkpty 自 glibc 2.34 起从 libutil.so.1 并入 libc.so.6，
 * 于是统信 UOS 20 / 麒麟 V10（glibc 2.28）dlopen 失败。
 */
const UBUNTU_2404_ARM64_OBJDUMP = `opt/PiDeck/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node:     file format elf64-littleaarch64

DYNAMIC SYMBOL TABLE:
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.34) openpty
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.34) forkpty
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.32) pthread_sigmask
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.28) fcntl
0000000000000000      DF *UND*\t0000000000000000 (GLIBCXX_3.4.29) _ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE6appendEPKc
`;

async function createTempTree(relativePaths) {
	const root = await mkdtemp(join(tmpdir(), "pideck-native-baseline-"));
	for (const relativePath of relativePaths) {
		const full = join(root, ...relativePath.split("/"));
		if (relativePath.endsWith("/")) {
			await mkdir(full, { recursive: true });
			continue;
		}
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, "");
	}
	return root;
}

test("parseRequiredVersions reads GLIBC and GLIBCXX tags from objdump output", () => {
	const versions = baseline.parseRequiredVersions(BASELINE_ARM64_OBJDUMP);
	assert.deepEqual(versions.glibc, ["2.17", "2.28"]);
	assert.deepEqual(versions.glibcxx, ["3.4", "3.4.14", "3.4.21"]);
});

test("parseRequiredVersions does not swallow GLIBCXX tags into GLIBC", () => {
	const versions = baseline.parseRequiredVersions(UBUNTU_2404_ARM64_OBJDUMP);
	assert.deepEqual(versions.glibc, ["2.28", "2.32", "2.34"]);
	assert.deepEqual(versions.glibcxx, ["3.4.29"]);
});

test("compareVersions compares numerically, not lexicographically", () => {
	assert.equal(baseline.compareVersions("2.9", "2.28"), -1);
	assert.equal(baseline.compareVersions("3.4", "3.4.25"), -1);
	assert.equal(baseline.compareVersions("2.28", "2.28"), 0);
	assert.equal(baseline.compareVersions("2.34", "2.28"), 1);
});

test("evaluateBaseline accepts the official arm64 prebuild as within the Debian 10 baseline", () => {
	const verdict = baseline.evaluateBaseline(baseline.parseRequiredVersions(BASELINE_ARM64_OBJDUMP));
	assert.equal(verdict.ok, true);
	assert.deepEqual(verdict.offenders, []);
	assert.equal(verdict.glibcCeiling, "2.28");
});

test("evaluateBaseline flags GLIBC_2.34 and GLIBCXX_3.4.29 built on a newer baseline", () => {
	const verdict = baseline.evaluateBaseline(baseline.parseRequiredVersions(UBUNTU_2404_ARM64_OBJDUMP));
	assert.equal(verdict.ok, false);
	assert.deepEqual(verdict.offenders, ["GLIBC_2.32", "GLIBC_2.34", "GLIBCXX_3.4.29"]);
});

test("evaluateBaseline honours custom ceilings", () => {
	const verdict = baseline.evaluateBaseline(baseline.parseRequiredVersions(BASELINE_ARM64_OBJDUMP), { glibcCeiling: "2.17" });
	assert.equal(verdict.ok, false);
	assert.deepEqual(verdict.offenders, ["GLIBC_2.28"]);
});

test("readElfMachine reads e_machine without relying on objdump", async () => {
	const root = await createTempTree([]);
	const arm64File = join(root, "arm64.node");
	const header = Buffer.alloc(20);
	header.write("\u007fELF", 0, "binary");
	header.writeUInt16LE(183, 18);
	await writeFile(arm64File, header);
	assert.equal(baseline.readElfMachine(arm64File), "arm64");

	const notElf = join(root, "not-elf.node");
	await writeFile(notElf, "MZ\u0000\u0000");
	assert.equal(baseline.readElfMachine(notElf), null);
	assert.equal(baseline.readElfMachine(join(root, "missing.node")), null);
	await rm(root, { recursive: true, force: true });
});

test("findNodePtyDirs only walks npm node_modules layout", async () => {
	const root = await createTempTree([
		"node_modules/node-pty/package.json",
		"node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty/package.json",
		"node_modules/other-pkg/node_modules/node-pty/package.json",
		"release/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/package.json",
		".tmp-asar/node_modules/node-pty/package.json",
	]);
	const dirs = baseline.findNodePtyDirs(root);
	assert.deepEqual(
		dirs.map((dir) => dir.slice(root.length + 1).replaceAll("\\", "/")),
		["node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty", "node_modules/node-pty", "node_modules/other-pkg/node_modules/node-pty"],
	);
	await rm(root, { recursive: true, force: true });
});

test("needsRebuild is false only when the target platform prebuild exists", async () => {
	const root = await createTempTree(["with-prebuild/prebuilds/linux-arm64/pty.node", "without-prebuild/package.json"]);
	assert.equal(baseline.needsRebuild(join(root, "with-prebuild"), "linux-arm64"), false);
	assert.equal(baseline.needsRebuild(join(root, "with-prebuild"), "linux-x64"), true);
	assert.equal(baseline.needsRebuild(join(root, "without-prebuild"), "linux-arm64"), true);
	await rm(root, { recursive: true, force: true });
});

test("resolveNodePtyArtifact follows node-pty's own loader order", async () => {
	const root = await createTempTree(["build/Release/pty.node", "prebuilds/linux-x64/pty.node"]);
	assert.equal(baseline.resolveNodePtyArtifact(root, "linux-x64"), join(root, "build", "Release", "pty.node"));
	await rm(join(root, "build"), { recursive: true, force: true });
	assert.equal(baseline.resolveNodePtyArtifact(root, "linux-x64"), join(root, "prebuilds", "linux-x64", "pty.node"));
	assert.equal(baseline.resolveNodePtyArtifact(root, "linux-arm64"), null);
	await rm(root, { recursive: true, force: true });
});

test("buildBusterScript points at archived Debian 10 sources and container paths", () => {
	const script = baseline.buildBusterScript(["/home/runner/work/PiDeck/PiDeck/node_modules/node-pty"], { rootDir: "/home/runner/work/PiDeck/PiDeck", uid: 1001, gid: 121 });
	assert.match(script, /archive\.debian\.org\/debian/);
	assert.match(script, /Acquire::Check-Valid-Until=false/);
	assert.match(script, new RegExp(baseline.CONTAINER_GYP.replaceAll(".", "\\.")));
	assert.match(script, /cd \/w\/node_modules\/node-pty &&/);
	assert.match(script, /chown -R 1001:121 \/w\/node_modules\/node-pty\/build/);
	assert.doesNotMatch(script, /\/home\/runner/);
	assert.doesNotMatch(script, /\r/);
});

test("buildBusterScript skips chown when the caller runs as root", () => {
	const script = baseline.buildBusterScript(["/w/node_modules/node-pty"], { rootDir: "/w", uid: 0, gid: 0 });
	assert.doesNotMatch(script, /chown/);
});

test("listNativeAddons collects .node files and reports truncation", async () => {
	const root = await createTempTree(["node_modules/a/native.node", "node_modules/b/lib/other.node", "node_modules/b/lib/notes.txt"]);
	const result = baseline.listNativeAddons(root);
	assert.equal(result.capped, false);
	assert.deepEqual(
		result.files.map((file) => file.slice(root.length + 1).replaceAll("\\", "/")),
		["node_modules/a/native.node", "node_modules/b/lib/other.node"],
	);
	assert.equal(baseline.listNativeAddons(root, { maxDirs: 0 }).capped, true);
	await rm(root, { recursive: true, force: true });
});
