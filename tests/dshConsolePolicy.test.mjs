import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decideDshHostConsolePolicy } = loadTsCommonJs("src/main/dsh/hideChildConsoles.ts");

test("decideDshHostConsolePolicy：非 win32 不注入、不改写", () => {
	const policy = decideDshHostConsolePolicy({ platform: "linux", sidecarPath: "/usr/bin/node" });
	assert.equal(policy.allocHostConsole, false);
	assert.equal(policy.injectWindowsHide, false);
	assert.equal(policy.rewriteRunnerToSidecar, false);
});

test("decideDshHostConsolePolicy：win32 永不 AllocConsole，子进程走 CREATE_NO_WINDOW", () => {
	const withoutSidecar = decideDshHostConsolePolicy({ platform: "win32" });
	assert.equal(withoutSidecar.allocHostConsole, false);
	assert.equal(withoutSidecar.injectWindowsHide, true);
	assert.equal(withoutSidecar.rewriteRunnerToSidecar, false);
	const withSidecar = decideDshHostConsolePolicy({ platform: "win32", sidecarPath: "C:\\app\\node.exe" });
	assert.equal(withSidecar.allocHostConsole, false);
	assert.equal(withSidecar.injectWindowsHide, true);
	assert.equal(withSidecar.rewriteRunnerToSidecar, true);
	assert.equal(decideDshHostConsolePolicy({ platform: "win32", sidecarPath: "   " }).rewriteRunnerToSidecar, false, "空白 sidecar 不算可用");
});

test("hideChildConsoles 源码不得再调用 AllocConsole（策略回归）", () => {
	const source = readFileSync("src/main/dsh/hideChildConsoles.ts", "utf8");
	assert.equal(source.includes("AllocConsole("), false, "host 侧 AllocConsole 会异步弹出 conhost；只允许 runnerConsolePreload 兜底路径使用");
});
