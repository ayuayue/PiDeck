/**
 * 现场故障回归（2026-09）：项目工作目录不存在时，pi 的 spawn 失败被 libuv 报成
 * "spawn C:\Windows\system32\cmd.exe ENOENT"，而桌面端既没把它当失败、也没还原原因：
 * Node 对 spawn 失败只发 error、不发 exit，于是挂起的启动握手 get_state 只能等满
 * rpcTimeout（默认 600s / 10 分钟）——用户看到的就是「不返回失败，直接超时」，
 * 期间也不会触发任何扩展回退或诊断。
 *
 * 本文件锁死三条不变式：
 *   1. spawn 失败必须立刻终结 RPC（毫秒级失败，而不是等超时）；
 *   2. 失败后 isRunning() 必须为 false（否则回退策略误判「进程还活着」）、
 *      已停放扩展必须还原（exit 回调是另一个还原点，spawn 失败不会走到）；
 *   3. 错误必须还原成人话（工作目录不存在 / 找不到可执行文件），而不是甩 ENOENT。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");
const { describeSpawnFailure } = loadTsCommonJs(
	"src/main/pi/piSpawnFailure.ts",
);
const { decideExtensionFallback, describeExtensionFallbackSkip } =
	loadTsCommonJs("src/main/pi/extensionStartupFallback.ts");

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

/** spawn 失败形态的子进程：pid 永远是 undefined（Node 判定「从未起来」的依据）。 */
function createFailedSpawnChild() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.pid = undefined;
	child.kill = () => false;
	return child;
}

function loadPiProcess(child) {
	const counters = { unpark: 0 };
	const wslPathsSandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), wslPathsSandbox, {
		filename: "WslPaths.ts",
	});

	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process,
		require: (id) => {
			if (id === "node:child_process") {
				return {
					execFile: (_command, _args, _options, callback) => {
						callback(null, "0.81.1\n", "");
						return new EventEmitter();
					},
					spawn: () => child,
				};
			}
			// 用真实 PiRpcClient：本用例的核心就是「spawn 失败后挂起的请求如何被终结」，
			// fake client 会把这条链路测成空转。
			if (id === "./PiRpcClient") return { PiRpcClient };
			if (id === "./PiLocator") return { PiLocator: class {} };
			if (id === "./piSpawnFailure")
				return require("../src/main/pi/piSpawnFailure.ts");
			if (id === "../wsl/WslPaths") return wslPathsSandbox.exports;
			if (id === "./piExtensionFilter") {
				return {
					parkBlockedExtensionsInDir: () => [
						{ name: "codeisland", from: "a", to: "b" },
					],
					unparkBlockedExtensions: () => {
						counters.unpark += 1;
					},
				};
			}
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => [...args] };
			}
			if (id === "../extensions/extensionVersionGate") {
				return require("../src/main/extensions/extensionVersionGate.ts");
			}
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			if (id === "../sessions/sessionProxyPolicy")
				return { applyPiProxyMode: (env) => env };
			if (id === "../git/gitProcess")
				return require("../src/main/git/gitProcess.ts");
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, {
		filename: "PiProcess.ts",
	});
	return { PiProcess: sandbox.exports.PiProcess, counters };
}

function createLocator(command = "/missing/pi", windowsLaunch) {
	return {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({
			command,
			args: [...args],
			shell: false,
			windowsLaunch,
		}),
		createProcessEnv: () => ({}),
	};
}

/** 真实不存在的目录：describeSpawnFailure 的 cwd 判据要落到真实 fs 结果上。 */
const MISSING_CWD = join(
	process.cwd(),
	"__pideck_missing_cwd__",
	String(Date.now()),
);

test("spawn 失败立即终结挂起的 get_state（不再等满 rpcTimeout）", async () => {
	const child = createFailedSpawnChild();
	const { PiProcess, counters } = loadPiProcess(child);
	const pi = new PiProcess(MISSING_CWD, {}, createLocator("/missing/pi"));
	await pi.start();

	// 模拟 AgentManager 的启动握手：spawn 返回后立刻发 get_state，并吃用户配置的 600s 超时。
	const pending = pi.client.request({ type: "get_state" }, 600_000);
	const startedAt = Date.now();
	// Node 对 spawn 失败只发 error（没有 exit）：这一刻必须由 PiProcess 收尾。
	child.emit(
		"error",
		Object.assign(new Error("spawn C:\\WINDOWS\\system32\\cmd.exe ENOENT"), {
			code: "ENOENT",
		}),
	);

	const error = await pending.then(
		() => null,
		(reason) => reason,
	);
	const elapsedMs = Date.now() - startedAt;

	assert.ok(error, "spawn 失败后挂起的 get_state 必须 reject");
	assert.ok(elapsedMs < 500, `必须立即失败，实测 ${elapsedMs}ms`);
	assert.doesNotMatch(error.message, /timed out after/);
	assert.match(
		error.message,
		/项目工作目录不存在/,
		"错误必须还原成真实原因，而不是甩 ENOENT",
	);
	assert.match(error.message, /ENOENT/, "原始 errno 文本要保留，方便日志检索");

	// 进程从未起来：isRunning() 必须如实为 false，否则扩展回退会误判「进程还活着」而放弃重试。
	assert.equal(pi.isRunning(), false);
	assert.equal(pi.getDiagnostics()?.spawnFailed, true);
	assert.equal(pi.getDiagnostics()?.cwdMissing, true);
	assert.equal(pi.getDiagnostics()?.exitCode, -1);
	// 停放的扩展必须在 error 路径还原：exit 回调是另一个还原点，spawn 失败不会走到。
	assert.equal(counters.unpark, 1);
});

test("spawn 失败且 cwd/pi 路径都正常时，报「找不到可执行文件」而不是 ENOENT", async () => {
	const child = createFailedSpawnChild();
	const { PiProcess } = loadPiProcess(child);
	// pi 路径必须真实存在，否则会走「pi 路径不存在」分支（那是另一种、更常见的失效）
	const piPath = join(tmpdir(), `pideck-pi-${process.pid}-${Date.now()}.cmd`);
	writeFileSync(piPath, "@echo off\r\n", "utf8");
	try {
		const pi = new PiProcess(process.cwd(), {}, createLocator(piPath));
		await pi.start();

		const pending = pi.client.request({ type: "get_state" }, 600_000);
		child.emit(
			"error",
			Object.assign(new Error("spawn something.exe ENOENT"), { code: "ENOENT" }),
		);
		const error = await pending.then(
			() => null,
			(reason) => reason,
		);

		assert.match(error.message, /找不到可执行文件/);
		assert.equal(pi.getDiagnostics()?.cwdMissing, false);
	} finally {
		rmSync(piPath, { force: true });
	}
});

test("spawn 失败且 pi 路径失效时，直接指出路径而不是「找不到 cmd.exe」", async () => {
	const child = createFailedSpawnChild();
	const { PiProcess } = loadPiProcess(child);
	const missingPi = join(
		tmpdir(),
		`pideck-missing-${process.pid}-${Date.now()}`,
		"pi.cmd",
	);
	const pi = new PiProcess(process.cwd(), {}, createLocator(missingPi));
	await pi.start();

	const pending = pi.client.request({ type: "get_state" }, 600_000);
	child.emit(
		"error",
		Object.assign(new Error("spawn C:\\Windows\\system32\\cmd.exe ENOENT"), {
			code: "ENOENT",
		}),
	);
	const error = await pending.then(
		() => null,
		(reason) => reason,
	);

	assert.match(error.message, /pi 路径不存在/);
	assert.doesNotMatch(error.message, /找不到可执行文件/);
});

test("describeSpawnFailure 只对可归因的 errno 给结论", () => {
	const base = {
		error: {
			code: "ENOENT",
			message: "spawn C:\\Windows\\system32\\cmd.exe ENOENT",
		},
		spawnedCommand: "C:\\Windows\\system32\\cmd.exe",
		piCommand: "C:\\nvm4w\\nodejs\\pi.cmd",
		cwd: "C:\\kaifa\\uts开发项目\\小说",
		cwdExists: true,
		cwdIsDirectory: true,
		piCommandExists: true,
		isWindows: true,
	};

	// cwd 不存在：实测复现的那条误导性 ENOENT（且此时不能顺带说 pi 路径有问题）
	assert.match(
		describeSpawnFailure({ ...base, cwdExists: false, cwdIsDirectory: false }),
		/项目工作目录不存在/,
	);
	assert.match(
		describeSpawnFailure({ ...base, cwdExists: false, cwdIsDirectory: false }),
		/误报成 spawn <cmd\.exe> ENOENT/,
	);

	// cwd 正常但 pi 路径丢了（nvm 切版本后典型）：必须指出 pi 路径，而不是「找不到 cmd.exe」
	const missingPi = describeSpawnFailure({ ...base, piCommandExists: false });
	assert.match(missingPi, /pi 路径不存在：C:\\nvm4w\\nodejs\\pi\.cmd/);
	assert.doesNotMatch(missingPi, /找不到可执行文件/);

	// cwd 正常、pi 路径也在：只能归因到「要 spawn 的程序本身找不到」
	const missingBinary = describeSpawnFailure({
		...base,
		spawnedCommand: "node.exe",
	});
	assert.match(missingBinary, /找不到可执行文件/);

	// 无法归因时不编原因，保持原始错误（调用方行为不变）。
	assert.equal(
		describeSpawnFailure({
			...base,
			error: { code: "EMFILE", message: "spawn EMFILE" },
		}),
		null,
	);
});

test("spawn 失败不触发扩展回退，并给出原因（扩展尚未加载）", () => {
	const input = {
		alreadyNoExtensions: false,
		stderr: "spawn C:\\WINDOWS\\system32\\cmd.exe ENOENT",
		errorMessage: "项目工作目录不存在：C:\\kaifa\\uts开发项目\\小说",
		exitCode: -1,
		processStillRunning: false,
		spawnFailed: true,
	};
	const decision = decideExtensionFallback(input);
	assert.equal(decision.retry, false);
	assert.match(decision.skipReason, /spawn 阶段失败/);
	assert.match(describeExtensionFallbackSkip(input), /与加载了哪些扩展无关/);

	// 回归保护：错误文本被改写成人话后，仍要靠 spawnFailed 判据认出「与扩展无关」。
	assert.equal(
		decideExtensionFallback({
			...input,
			stderr: "",
			errorMessage: "项目工作目录不存在",
		}).retry,
		false,
	);
});

test("扩展加载失败仍然回退（原有能力不受影响）", () => {
	const decision = decideExtensionFallback({
		alreadyNoExtensions: false,
		stderr:
			'Error: Failed to load extension "x.ts": Cannot find module "@earendil-works/pi-ai"',
		errorMessage: "pi exited: code=1, signal=null",
		exitCode: 1,
	});
	assert.equal(decision.retry, true);
	assert.equal(decision.skipReason, null);
});

test("close 后的 PiRpcClient 立即拒绝新请求（不再空等超时）", async () => {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const client = new PiRpcClient(stdin, stdout);
	client.close(new Error("pi process not started: boom"));

	const error = await client.request({ type: "get_state" }, 600_000).then(
		() => null,
		(reason) => reason,
	);
	assert.ok(error, "closed client 的请求必须立即 reject");
	assert.match(error.message, /boom/);
	assert.match(error.message, /RPC command not sent/);
	// 管道已销毁的进程不能再被写：写入会以未监听的 stream error 冒泡成未捕获异常。
	assert.doesNotThrow(() => client.sendRaw({ type: "abort" }));
});

test("PiProcess 诊断里带上 Windows 启动通道与 cmd.exe 回退原因", async () => {
	const child = createFailedSpawnChild();
	const { PiProcess } = loadPiProcess(child);
	const reason =
		"垫片引用的 JS 入口不存在：C:\\nvm4w\\nodejs\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";
	const pi = new PiProcess(
		process.cwd(),
		{},
		createLocator("C:\\nvm4w\\nodejs\\pi.cmd", { channel: "cmd-shim", reason }),
	);
	await pi.start();

	// 命令行里出现 cmd.exe 时必须能回答「为什么没走 node 直启」，否则会被当成启动方式回归。
	assert.equal(pi.getDiagnostics()?.launch?.channel, "cmd-shim");
	assert.equal(pi.getDiagnostics()?.launch?.reason, reason);
});

test("AgentManager 把 spawn 失败判据和启动握手超时接进启动链路", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// 启动握手不吃用户给长任务的 rpcTimeout（默认 600s），否则「进程活着但不就绪」静默等 10 分钟。
	assert.match(
		source,
		/client\.request\(\s*\{ type: "get_state" \},\s*this\.startupHandshakeTimeoutMs,\s*\)/,
	);
	assert.match(source, /STARTUP_HANDSHAKE_TIMEOUT_MS = 90_000/);
	assert.match(source, /spawnFailed: diag\?\.spawnFailed === true/);
	// 不回退也要说明原因，否则用户以为「自动禁用扩展」失效。
	assert.match(source, /describeExtensionFallbackSkip\(/);
	assert.match(source, /Pi start failed; extension fallback skipped/);
	// 诊断卡结论先行：工作目录不存在时不能把用户支去查 cmd.exe/PATH。
	assert.match(source, /diag\.cwdMissing/);
	assert.match(source, /扩展回退/);
	// 「版本检测: ✗ 失败」只在真探过时成立：没探过就说没探过，别引导用户重装 pi。
	assert.match(source, /versionCheckProbed/);
	assert.match(source, /未拿到 pi --version 结果/);
	// 启动通道（node 直启 / cmd.exe 回退 + 原因）要进诊断卡，否则会被误判成「没改成 node 启动」。
	assert.match(source, /diag\.launch && diag\.launch\.channel === "cmd-shim"/);
	assert.match(source, /启动通道: cmd\.exe 回退/);
	const piProcessSource = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.match(piProcessSource, /versionCheckProbed/);
	assert.match(piProcessSource, /launch: invocation\.windowsLaunch/);
});
