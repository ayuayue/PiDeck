/**
 * 引导安装 pi（全局 npm install）执行器的回归测试。
 *
 * 守的是 2026-09 用户报障：Windows 上引导步骤「点击即失败」。根因是 handler 用
 * `execFile("npm")` / `execFile("…\npm.cmd")` 直启 npm —— CreateProcess 不认 .cmd/.bat，
 * 结果是 ENOENT：exitCode -1、stdout/stderr 全空，界面只剩「✗ 安装失败：」没有原因，
 * 用户只能自己去终端敲命令。
 *
 * 因此这里锁定三件事：
 *   ① 启动规格必须来自 PiLocator（.cmd 垫片 → node 直启），handler 不得绕过；
 *   ② .cmd/.bat 永不直接进 execFile（兜底闸门，防回归）；
 *   ③ spawn 层失败必须把 error.message 带回（否则又是「失败但没原因」）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runPiGlobalInstall, isWindowsBatchShim, PI_GLOBAL_INSTALL_TIMEOUT_MS } = loadTsCommonJs("src/main/pi/piGlobalInstall.ts");

const NPM_ARGS = ["install", "-g", "@earendil-works/pi-coding-agent"];
const PREFIX_DIR = "C:\\Users\\tester\\AppData\\Roaming\\pi-desktop\\pi-runtime\\pi-global";

/** 记录 execFile 收到的启动参数，并让用例自己决定回调结果。 */
function fakeExecFile(onCall, { error = null, stdout = "", stderr = "" } = {}) {
	return (file, args, options, callback) => {
		onCall({ file, args: [...args], options });
		callback(error, stdout, stderr);
	};
}

/** 模拟 PiLocator 的 Windows .cmd 垫片通道：还原成 node + 垫片内的 JS 入口。 */
function nodeDirectLauncher({ entry = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js", pathPrefix = "C:\\Users\\tester\\AppData\\Roaming\\npm" } = {}) {
	return {
		createInvocation: (command, args) => ({
			command: "C:\\Program Files\\nodejs\\node.exe",
			args: [entry, ...args],
			shell: false,
			pathPrefix,
			windowsLaunch: { channel: "node-direct", entry },
		}),
		createProcessEnv: (received) => ({ PATH: `${received ?? ""}|system`, pathPrefixSeen: received }),
	};
}

test("isWindowsBatchShim 只认 .cmd/.bat（.exe 与裸命令名不算）", () => {
	assert.equal(isWindowsBatchShim("C:\\Users\\t\\AppData\\Roaming\\npm\\npm.cmd"), true);
	assert.equal(isWindowsBatchShim("NPM.CMD"), true);
	assert.equal(isWindowsBatchShim("install.bat"), true);
	assert.equal(isWindowsBatchShim("npm.exe"), false);
	assert.equal(isWindowsBatchShim("npm"), false);
	assert.equal(isWindowsBatchShim("C:\\Program Files\\nodejs\\node.exe"), false);
});

test("Windows npm 垫片走 node 直启：execFile 拿到 node.exe + npm-cli.js，而不是 npm.cmd", async () => {
	const calls = [];
	const outcome = await runPiGlobalInstall({
		npmCommand: "C:\\Users\\tester\\AppData\\Roaming\\npm\\npm.cmd",
		npmArgs: [...NPM_ARGS, "--registry=https://registry.npmmirror.com"],
		prefixDir: PREFIX_DIR,
		launcher: nodeDirectLauncher(),
		cwd: "C:\\Users\\tester",
		execFileImpl: fakeExecFile((call) => calls.push(call), { stdout: "added 1 package\n" }),
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, "C:\\Program Files\\nodejs\\node.exe");
	// 最后一个参数是 --prefix，保证 pi 装进 userData 前缀而不是系统全局目录。
	assert.deepEqual(calls[0].args, ["C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js", ...NPM_ARGS, "--registry=https://registry.npmmirror.com", `--prefix=${PREFIX_DIR}`]);
	assert.equal(calls[0].options.shell, false);
	assert.equal(calls[0].options.timeout, PI_GLOBAL_INSTALL_TIMEOUT_MS);
	// 便携 node / 垫片目录必须前置进 PATH，否则 node 直启后 npm 找不到同目录 node。
	assert.equal(calls[0].options.env.pathPrefixSeen, "C:\\Users\\tester\\AppData\\Roaming\\npm");
	assert.equal(outcome.success, true);
	assert.equal(outcome.launchCommand, "C:\\Program Files\\nodejs\\node.exe");
	assert.equal(outcome.launchChannel, "node-direct");
	// 只有 PiInstallExecResult 字段回给渲染层（诊断字段由 handler 记日志后丢弃）。
	assert.equal(outcome.launchChannel, "node-direct");
	assert.equal(outcome.launchFallbackReason, undefined);
});

test("兜底闸门：启动规格若仍是 .cmd/.bat，直接拒绝且不调用 execFile", async () => {
	let called = false;
	const outcome = await runPiGlobalInstall({
		npmCommand: "C:\\Users\\tester\\AppData\\Roaming\\npm\\npm.cmd",
		npmArgs: NPM_ARGS,
		prefixDir: PREFIX_DIR,
		// 回归形态：locator 未解析垫片，把 .cmd 原样返回（= 报障时的行为）。
		launcher: {
			createInvocation: (command, args) => ({ command, args, shell: false }),
			createProcessEnv: () => ({ PATH: "stub" }),
		},
		cwd: "C:\\Users\\tester",
		execFileImpl: fakeExecFile(() => {
			called = true;
		}),
	});

	assert.equal(called, false);
	assert.equal(outcome.success, false);
	assert.equal(outcome.exitCode, null);
	assert.match(outcome.stderr, /refusing to launch batch shim directly: .*npm\.cmd/);
});

test("spawn 层失败（ENOENT）把 error.message 带回 stderr，不再是无原因的空串", async () => {
	const enoent = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
	const outcome = await runPiGlobalInstall({
		npmCommand: "npm",
		npmArgs: NPM_ARGS,
		prefixDir: PREFIX_DIR,
		launcher: {
			createInvocation: (command, args) => ({ command, args, shell: false }),
			createProcessEnv: () => ({ PATH: "stub" }),
		},
		cwd: "C:\\Users\\tester",
		execFileImpl: fakeExecFile(() => {}, { error: enoent }),
	});

	assert.equal(outcome.success, false);
	assert.equal(outcome.exitCode, -1);
	assert.equal(outcome.stderr, "spawn npm ENOENT");
});

test("cmd.exe 回退通道：verbatim 标志与 npm 自己的 stderr 原样透传", async () => {
	const calls = [];
	const outcome = await runPiGlobalInstall({
		npmCommand: "npm",
		npmArgs: NPM_ARGS,
		prefixDir: PREFIX_DIR,
		launcher: {
			// 裸命令名 + 形态不符时的真实回退形态（createInvocation 的 cmd-shim 通道）。
			createInvocation: (command, args) => ({
				command: "C:\\Windows\\System32\\cmd.exe",
				args: ["/d", "/s", "/c", [command, ...args].join(" ")],
				shell: false,
				windowsVerbatimArguments: true,
				windowsLaunch: { channel: "cmd-shim", reason: "not-cmd" },
			}),
			createProcessEnv: () => ({ PATH: "stub" }),
		},
		cwd: "C:\\Users\\tester",
		execFileImpl: fakeExecFile((call) => calls.push(call), { error: Object.assign(new Error("Command failed: npm"), { code: 1 }), stderr: "npm ERR! code E404\n" }),
	});

	// cmd /c 的末位参数是整条命令行：Node 不能再转义一次，否则带空格的路径会被改坏。
	assert.equal(calls[0].options.windowsVerbatimArguments, true);
	assert.equal(calls[0].options.shell, false);
	assert.equal(calls[0].args[0], "/d");
	assert.deepEqual(outcome.launchFallbackReason, "not-cmd");
	assert.equal(outcome.exitCode, 1);
	// npm 自己跑了并有输出时，必须原样透传（渲染层就是拿这段文本给用户看原因的）。
	assert.equal(outcome.stderr, "npm ERR! code E404\n");
});

test("真全局安装：省略 prefixDir 时不拼 --prefix（npm 落用户自己的全局目录）", async () => {
	const calls = [];
	const outcome = await runPiGlobalInstall({
		npmCommand: "npm",
		npmArgs: [...NPM_ARGS],
		launcher: nodeDirectLauncher(),
		cwd: "C:\\Users\\tester",
		execFileImpl: fakeExecFile((c) => calls.push(c), { stdout: "added 1 package" }),
	});
	assert.equal(outcome.success, true);
	assert.equal(outcome.exitCode, 0);
	assert.equal(calls.length, 1);
	// 启动规格是 node.exe + npm-cli.js + install 参数；绝不能出现 --prefix=...（那会把 pi
	// 装回 PiDeck 私有前缀，正是 2026-10 要改掉的默认形态）。
	assert.ok(
		calls[0].args.every((arg) => !arg.startsWith("--prefix")),
		`unexpected prefix arg: ${calls[0].args.join(" ")}`,
	);
	assert.deepEqual(calls[0].args.slice(1), NPM_ARGS);
});

test("成功路径：exitCode 0、stdout 经渲染层可见字段返回", async () => {
	const outcome = await runPiGlobalInstall({
		npmCommand: "npm",
		npmArgs: NPM_ARGS,
		prefixDir: PREFIX_DIR,
		launcher: nodeDirectLauncher(),
		cwd: "C:\\Users\\tester",
		execFileImpl: fakeExecFile(() => {}, { stdout: "added 1 package in 3s\n" }),
	});

	assert.deepEqual({ success: outcome.success, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr }, { success: true, exitCode: 0, stdout: "added 1 package in 3s\n", stderr: "" });
});
