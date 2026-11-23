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
	assert.equal(policy.injectRunnerPreloadEnv, false);
});

test("decideDshHostConsolePolicy：win32 永不 AllocConsole，有 sidecar 时不注入 NODE_OPTIONS preload", () => {
	const withoutSidecar = decideDshHostConsolePolicy({ platform: "win32" });
	assert.equal(withoutSidecar.allocHostConsole, false);
	assert.equal(withoutSidecar.injectWindowsHide, true);
	assert.equal(withoutSidecar.rewriteRunnerToSidecar, false);
	assert.equal(withoutSidecar.injectRunnerPreloadEnv, true);
	const withSidecar = decideDshHostConsolePolicy({ platform: "win32", sidecarPath: "C:\\app\\node.exe" });
	assert.equal(withSidecar.allocHostConsole, false);
	assert.equal(withSidecar.injectWindowsHide, true);
	assert.equal(withSidecar.rewriteRunnerToSidecar, true);
	assert.equal(withSidecar.injectRunnerPreloadEnv, false);
	const blankSidecar = decideDshHostConsolePolicy({ platform: "win32", sidecarPath: "   " });
	assert.equal(blankSidecar.rewriteRunnerToSidecar, false, "空白 sidecar 不算可用");
	assert.equal(blankSidecar.injectRunnerPreloadEnv, true);
});

test("hideChildConsoles 源码不得再调用 AllocConsole（策略回归）", () => {
	const source = readFileSync("src/main/dsh/hideChildConsoles.ts", "utf8");
	assert.equal(source.includes("AllocConsole("), false, "host 侧 AllocConsole 会异步弹出 conhost；只允许 runnerConsolePreload 兜底路径使用");
});
