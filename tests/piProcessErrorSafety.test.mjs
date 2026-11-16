import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { piLocatorSource } from "./helpers/piLocatorSources.mjs";

function createChildProcess() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

class FakeRpcClient extends EventEmitter {
	close() {}
}
class FakePiLocator {}

function loadPiProcess(spawnImpl) {
	// spawn 替身随用例变化（固定 child / 记录调用），所以每次加载都新建沙箱实例：
	// 实例自带模块缓存，两两之间不共享求值结果。未打桩的相对 import（LocalPiRuntimeLauncher、
	// PiSpawnHandle、piSpawnFailure、WslPaths、piExtensionFilter…）由加载器按**源文件目录**解析。
	const load = createTsSandbox({
		stubs: {
			"node:child_process": {
				execFile: (_command, _args, _options, callback) => {
					callback(null, "0.81.1\n", "");
					return new EventEmitter();
				},
				spawn: spawnImpl,
			},
			"./PiRpcClient": { PiRpcClient: FakeRpcClient },
			"./PiLocator": { PiLocator: FakePiLocator },
			// 不触达真实 ~/.pi 扩展目录：停放/还原在本用例无断言对象。
			"./piExtensionFilter": { parkBlockedExtensionsInDir: () => [], unparkBlockedExtensions: () => {} },
			// 25fd516 起 PiProcess 引入内置扩展参数拼接；本测试只关心 spawn 错误转发，按原样透传。
			"../extensions/builtInExtensions": { appendBuiltInExtensionArgs: (args) => [...args] },
			// 日志共享实例未注册时返回 null，PiProcess 埋点静默跳过（避免测试里拉真实日志模块）。
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../sessions/sessionProxyPolicy": { applyPiProxyMode: (env) => env },
		},
		globals: { console: { log() {}, warn() {}, error() {} } },
	});
	return load("src/main/pi/PiProcess.ts");
}

function createLocator(command = "/opt/homebrew/bin/pi") {
	return {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({
			command,
			args: [...args],
			shell: false,
		}),
		createProcessEnv: () => ({}),
	};
}

test("PiProcess keeps a default error sink so spawn ENOENT does not become uncaught", async () => {
	const child = createChildProcess();
	const { PiProcess } = loadPiProcess(() => child);
	const pi = new PiProcess("/tmp/project", {}, createLocator("/missing/pi"));

	// 关键：没有业务 listener 时，异步 error 也不应变成 uncaughtException。
	await pi.start();

	let uncaught = null;
	const onUncaught = (error) => {
		uncaught = error;
	};
	process.once("uncaughtException", onUncaught);
	child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
	// 给 EventEmitter 一个 tick 升级 uncaught 的机会
	await new Promise((resolve) => setImmediate(resolve));
	process.off("uncaughtException", onUncaught);

	assert.equal(uncaught, null);
	assert.equal(pi.getDiagnostics()?.exitCode, -1);
	assert.match(pi.getDiagnostics()?.stderr.join("") ?? "", /ENOENT/);
});

test("PiProcess forwards spawn error to business listeners after start returns", async () => {
	const child = createChildProcess();
	const { PiProcess } = loadPiProcess(() => child);
	const pi = new PiProcess("/tmp/project", {}, createLocator("/missing/pi"));
	await pi.start();

	const seen = [];
	pi.on("error", (error) => seen.push(error.message));
	child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
	await new Promise((resolve) => setImmediate(resolve));

	// 转发契约不变（业务侧仍能收到 error），但 spawn 失败会附加可读原因；
	// 原始 errno 文本必须保留在里面，日志/Issue 仍可按 EACCES/ENOENT 检索。
	assert.equal(seen.length, 1);
	assert.match(seen[0], /spawn EACCES/);
	assert.match(seen[0], /没有权限启动/);
	assert.equal(pi.isRunning(), false);
});

test("AgentManager attaches lifecycle listeners before process.start", () => {
	const source = agentManagerSource;
	assert.match(source, /attachPiProcessLifecycle\(/);
	assert.match(source, /buildStartupFailureMessage\(/);
	// spawnAndGetState：先 attach，再 await process.start（create/reattach 共用握手）
	const spawnBlock = source.slice(source.indexOf("private async spawnAndGetState"), source.indexOf("private toSessionHostPath"));
	const attachAt = spawnBlock.indexOf("this.attachPiProcessLifecycle");
	const startAt = spawnBlock.indexOf("await process.start");
	assert.ok(attachAt >= 0 && startAt > attachAt, "lifecycle must be attached before start()");
	assert.match(source, /handshakePiProcess\(/);
	assert.match(source, /shouldRetryWithoutExtensions\(/);
});

test("macOS search dirs include Homebrew prefixes for Dock-launched PATH gaps", () => {
	const source = piLocatorSource;
	assert.match(source, /\/opt\/homebrew\/bin/);
	assert.match(source, /\/usr\/local\/bin/);
	assert.match(source, /platform === "darwin"/);
});
