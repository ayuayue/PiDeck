import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function createChildProcess() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

function loadPiProcess(spawnImpl) {
	// vm 沙箱内加载 transpile 后的 CommonJS 源码模块；
	// 新增拆分出的内部依赖时需要在此同步登记，否则 require 会落到真实文件系统解析失败。
	const loadSandboxed = (filePath, name) => {
		const sandbox = { exports: {}, require };
		vm.runInNewContext(transpile(filePath), sandbox, { filename: name });
		return sandbox.exports;
	};
	const paths = loadSandboxed("src/main/wsl/WslPaths.ts", "WslPaths.ts");
	const extensionFilter = loadSandboxed("src/main/pi/piExtensionFilter.ts", "piExtensionFilter.ts");

	class FakeRpcClient extends EventEmitter {
		close() {}
	}
	class FakePiLocator {}

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
					spawn: spawnImpl,
				};
			}
			if (id === "./PiRpcClient") return { PiRpcClient: FakeRpcClient };
			if (id === "./PiLocator") return { PiLocator: FakePiLocator };
			// PiProcess 的 spawn 失败归因模块（cwd 不存在会被误报成 cmd.exe ENOENT）：
			// vm 沙箱不会自动解析相对模块，新增拆分模块必须在这里登记。
			if (id === "./piSpawnFailure") return require("../src/main/pi/piSpawnFailure.ts");
			if (id === "../wsl/WslPaths") return paths;
			if (id === "./piExtensionFilter") return extensionFilter;
			// 25fd516 起 PiProcess 引入内置扩展参数拼接；本测试只关心 spawn 错误转发，
			// mock 为原样透传，避免 vm sandbox 的 require 按 tests/ 相对路径误解析。
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => [...args] };
			}
			if (id === "../extensions/extensionVersionGate") {
				return loadTsCommonJs("src/main/extensions/extensionVersionGate.ts");
			}
			// 日志共享实例未注册时返回 null，PiProcess 埋点静默跳过；
			// 这里 mock 掉 sharedLogger，避免沙箱 require 按 tests/ 相对路径误解析。
			if (id === "../logging/sharedLogger") {
				return { getAppLogger: () => null };
			}
			if (id === "../sessions/sessionProxyPolicy") {
				return { applyPiProxyMode: (env) => env };
			}
			// killProcessTree（子代理整树终止）：gitProcess.ts 是纯 Node 模块，可直接加载。
			if (id === "../git/gitProcess") {
				return require("../src/main/git/gitProcess.ts");
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, {
		filename: "PiProcess.ts",
	});
	return sandbox.exports;
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
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
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
	const source = readFileSync("src/main/pi/PiLocator.ts", "utf8");
	assert.match(source, /\/opt\/homebrew\/bin/);
	assert.match(source, /\/usr\/local\/bin/);
	assert.match(source, /platform === "darwin"/);
});
