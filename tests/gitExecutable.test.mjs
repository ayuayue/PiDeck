/**
 * gitExecutable 单测 —— 路径解析与探测的纯策略部分。
 *
 * 只覆盖纯函数与「配置无效」的降级路径：不依赖真实 git 存在与否，
 * 避免 CI / 未装 git 的机器上出现环境相关的假红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	gitPathCandidates,
	resolveGitExecutable,
	parseGitVersion,
	detectGitExecutable,
} from "../src/main/git/gitExecutable.ts";

test("Windows 候选路径优先官方外部调用入口 cmd\\git.exe", () => {
	const candidates = gitPathCandidates("win32", undefined);
	assert.equal(candidates[0], "C:\\Program Files\\Git\\cmd\\git.exe");
});

test("Windows 候选路径包含 mingw64 与 x86 安装位置", () => {
	const candidates = gitPathCandidates("win32", undefined);
	assert.ok(candidates.includes("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"));
	assert.ok(candidates.includes("C:\\Program Files (x86)\\Git\\cmd\\git.exe"));
});

test("Windows 用户级安装位置随 LOCALAPPDATA 拼出", () => {
	const candidates = gitPathCandidates("win32", "C:\\Users\\tester\\AppData\\Local");
	assert.ok(candidates.includes("C:\\Users\\tester\\AppData\\Local\\Programs\\Git\\cmd\\git.exe"));
});

test("无 LOCALAPPDATA 时不产生 undefined 路径", () => {
	const candidates = gitPathCandidates("win32", undefined);
	assert.ok(!candidates.some((p) => p.includes("undefined")));
});

test("macOS 候选路径覆盖 Xcode CLT 与 Homebrew 两个芯片架构", () => {
	const candidates = gitPathCandidates("darwin");
	assert.equal(candidates[0], "/usr/bin/git");
	assert.ok(candidates.includes("/opt/homebrew/bin/git"));
	assert.ok(candidates.includes("/usr/local/bin/git"));
});

test("Linux 候选路径覆盖系统与 snap 安装", () => {
	const candidates = gitPathCandidates("linux");
	assert.equal(candidates[0], "/usr/bin/git");
	assert.ok(candidates.includes("/snap/bin/git"));
});

test("未配置时回落到字面量 git（走 PATH）", () => {
	assert.equal(resolveGitExecutable(""), "git");
	assert.equal(resolveGitExecutable(undefined), "git");
	assert.equal(resolveGitExecutable(null), "git");
});

test("脏数据（非字符串）也回落到 PATH，不把错误类型传给 spawn", () => {
	assert.equal(resolveGitExecutable(123), "git");
	assert.equal(resolveGitExecutable({}), "git");
});

test("配置值去空白后原样使用", () => {
	assert.equal(
		resolveGitExecutable("  C:\\Program Files\\Git\\cmd\\git.exe  "),
		"C:\\Program Files\\Git\\cmd\\git.exe",
	);
});

test("纯空白配置等同未配置", () => {
	assert.equal(resolveGitExecutable("   "), "git");
});

test("版本解析剥离 git version 前缀与平台后缀", () => {
	assert.equal(parseGitVersion("git version 2.53.0.windows.4"), "2.53.0");
	assert.equal(parseGitVersion("git version 2.39.1\n"), "2.39.1");
});

test("两段版本号补齐为三段", () => {
	assert.equal(parseGitVersion("git version 2.39"), "2.39.0");
});

test("非版本号输入返回空串（调用方据此判定探测失败）", () => {
	assert.equal(parseGitVersion(""), "");
	assert.equal(parseGitVersion("not a version"), "");
});

test("配置路径不可执行时标记为 not-found 并保留原值供 UI 回显", async () => {
	const bogus = "__definitely_not_a_git_binary__";
	const info = await detectGitExecutable(bogus);
	assert.equal(info.source, "not-found");
	assert.equal(info.executable, bogus);
	assert.equal(info.version, "");
	assert.ok(info.error);
});
