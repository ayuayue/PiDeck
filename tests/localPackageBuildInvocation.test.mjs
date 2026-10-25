/**
 * 交叉打包时 file: 本地包构建调用方式的回归测试。
 *
 * 2026-09-22 事故：v0.7.7 补发时 6 个平台全挂在 `'tsc' 不是内部或外部命令`（此前
 * 一次是全挂 `ERR_MODULE_NOT_FOUND: tar`）。第二次的真因不是缺包，而是 npm run 的
 * PATH 按「脚本 cwd」逐级向上拼 node_modules/.bin：交叉模式下闭包入口是临时工作区
 * 里的符号链接 <tmp>/node_modules/dsh-tool-pwsh-persistent → <repo>/packages/...，
 * 这条逻辑路径的祖先里没有仓库 .bin，构建脚本 tsc 就找不到。修法 = cwd 用真实路径，
 * 本文件把这个行为钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localPackageBuildInvocation } from "../scripts/local-package-build.mjs";

/** 造一个 <tmp>/link/node_modules/pkg → <tmp>/real/pkg 的目录链接；环境不允许建链接时返回 null。 */
function makeSymlinkedPackage() {
	const root = mkdtempSync(join(tmpdir(), "local-pkg-build-"));
	const realDir = join(root, "real", "pkg");
	const linkDir = join(root, "link", "node_modules");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(linkDir, { recursive: true });
	const linkPath = join(linkDir, "pkg");
	try {
		// Windows 上 'dir' 需要开发者模式/管理员权限，junction 不需要；两者 realpathSync 都会解析到目标。
		symlinkSync(realDir, linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch {
		rmSync(root, { recursive: true, force: true });
		return null;
	}
	return { root, realDir, linkPath };
}

test("符号链接目录：cwd 用真实路径（交叉模式找不到 tsc 的回归守卫）", (t) => {
	const fixture = makeSymlinkedPackage();
	if (!fixture) {
		t.skip("当前环境不允许创建目录链接，跳过");
		return;
	}
	const { root, realDir, linkPath } = fixture;
	try {
		// 前提校验：这确实是一条逻辑路径 ≠ 真实路径的链接（否则本测试没有意义）
		assert.notEqual(realpathSync(linkPath), resolve(linkPath));
		const invocation = localPackageBuildInvocation(linkPath);
		assert.equal(invocation.cwd, realpathSync(realDir), "构建 cwd 必须是包的真实目录，npm 才能沿祖先链找到仓库 node_modules/.bin");
		assert.notEqual(invocation.cwd, resolve(linkPath), "绝不能用符号链接的逻辑路径当 cwd");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("真实目录：cwd 与传入路径一致（native 模式行为不变）", () => {
	const root = mkdtempSync(join(tmpdir(), "local-pkg-build-"));
	try {
		mkdirSync(join(root, "pkg"), { recursive: true });
		const invocation = localPackageBuildInvocation(join(root, "pkg"));
		assert.equal(invocation.cwd, realpathSync(join(root, "pkg")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("路径不可解析：退回逻辑路径，不抛错（交给 npm 报更直观的错）", () => {
	const missing = join(tmpdir(), "local-pkg-build-missing-dir");
	const invocation = localPackageBuildInvocation(missing);
	assert.equal(invocation.cwd, missing);
});

test("命令形态：win32 走 cmd.exe shim，其余平台直接 npm", () => {
	assert.deepEqual(localPackageBuildInvocation("C:\\pkg", { platform: "win32" }), {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", "npm", "run", "build"],
		cwd: "C:\\pkg",
	});
	assert.deepEqual(localPackageBuildInvocation("/pkg", { platform: "linux" }), { command: "npm", args: ["run", "build"], cwd: "/pkg" });
});

test("参数非法：抛 TypeError", () => {
	assert.throws(() => localPackageBuildInvocation(""), TypeError);
	assert.throws(() => localPackageBuildInvocation(undefined), TypeError);
});
