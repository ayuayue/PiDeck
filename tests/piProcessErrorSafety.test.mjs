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
	const paths = (() => {
		const sandbox = { exports: {}, require };
		vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, {
			filename: "WslPaths.ts",
		});
		return sandbox.exports;
	})();

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
			if (id === "../wsl/WslPaths") return paths;
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

	assert.deepEqual(seen, ["spawn EACCES"]);
});

test("AgentManager attaches lifecycle listeners before process.start", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /attachPiProcessLifecycle\(/);
	assert.match(source, /buildStartupFailureMessage\(/);
	// createUnlocked：先 attach，再 await process.start
	const createBlock = source.slice(
		source.indexOf("private async createUnlocked"),
		source.indexOf("async rename("),
	);
	const attachAt = createBlock.indexOf("this.attachPiProcessLifecycle");
	const startAt = createBlock.indexOf("await process.start");
	assert.ok(attachAt >= 0 && startAt > attachAt, "lifecycle must be attached before start()");
});

test("macOS search dirs include Homebrew prefixes for Dock-launched PATH gaps", () => {
	const source = readFileSync("src/main/pi/PiLocator.ts", "utf8");
	assert.match(source, /\/opt\/homebrew\/bin/);
	assert.match(source, /\/usr\/local\/bin/);
	assert.match(source, /platform === "darwin"/);
});
