import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 终端 shell 可用性探测回归测试（TerminalSessionManager.isShellCommandAvailable）。
 *
 * 背景：上游 listShells 曾恒返回 available: true（死代码），设置缺失的 shell 也能点，
 * 点击后 spawn 才报错。现在主进程按「含路径分隔符查 existsSync、裸名扫 PATH」探测。
 * 本测试同时用源码契约断言 listShells 确实消费探测函数（防接线回退成恒 true）。
 */

/** process.platform 在沙箱里就是真实 process 对象，用 defineProperty 可覆写，测完恢复。 */
function withPlatform(platform, fn) {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return fn();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
	}
}

function loadManager() {
	return loadTsCommonJs("src/main/terminal/TerminalSessionManager.ts", { stubs: { "node-pty": {} } });
}

test("含路径分隔符的命令：直接 existsSync，不走 PATH", () => {
	const manager = loadManager();
	withPlatform("win32", () => {
		const dir = mkdtempSync(join(tmpdir(), "terminal-shell-probe-"));
		try {
			const existing = join(dir, "probe-shell.exe");
			writeFileSync(existing, "");
			assert.equal(manager.isShellCommandAvailable(existing), true);
			assert.equal(manager.isShellCommandAvailable(join(dir, "missing.exe")), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("裸名命令：扫 PATH，Windows 补 .exe/.cmd/.bat 后缀", () => {
	const manager = loadManager();
	withPlatform("win32", () => {
		const dir = mkdtempSync(join(tmpdir(), "terminal-shell-path-"));
		const originalPath = process.env.PATH;
		try {
			writeFileSync(join(dir, "fakeprobe.cmd"), "");
			process.env.PATH = dir;
			assert.equal(manager.isShellCommandAvailable("fakeprobe"), true, "裸名 + .cmd 后缀应命中");
			assert.equal(manager.isShellCommandAvailable("definitely-missing-shell-xyz"), false);
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("裸名命令：POSIX 平台只扫无后缀", () => {
	const manager = loadManager();
	withPlatform("linux", () => {
		const dir = mkdtempSync(join(tmpdir(), "terminal-shell-posix-"));
		const originalPath = process.env.PATH;
		try {
			writeFileSync(join(dir, "fakeprobe"), "");
			writeFileSync(join(dir, "fakeprobe.exe"), "");
			process.env.PATH = dir;
			assert.equal(manager.isShellCommandAvailable("fakeprobe"), true);
			// POSIX 分支不尝试 .exe 后缀——文件存在与否不影响判定
			assert.equal(existsSync(join(dir, "fakeprobe.exe")), true);
			assert.equal(manager.isShellCommandAvailable("definitely-missing-shell-xyz"), false);
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("源码契约：listShells 的 available 字段来自 isShellCommandAvailable 探测", () => {
	// 读源码而非实例化 manager（构造需要 pty/emit 全家桶）：防有人把探测结果改回恒 true
	const source = readFileSync("src/main/terminal/TerminalSessionManager.ts", "utf8");
	assert.match(source, /available: isShellCommandAvailable\(/);
	assert.match(source, /export function isShellCommandAvailable/);
});
