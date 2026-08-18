import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// .mjs 没有 CJS require；vm 沙箱内的 fallback require 必须显式创建。
const require = createRequire(import.meta.url);

function loadTranspiledModule(filePath, customRequire = require) {
	const { outputText } = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	});
	const sandbox = { exports: {}, require: customRequire };
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function loadTerminalSessionManagerModule() {
	const source = readFileSync(
		"src/main/terminal/TerminalSessionManager.ts",
		"utf8",
	);
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	});
	const sandbox = {
		exports: {},
		require: (name) => {
			if (name === "node-pty") return {};
			if (name === "node:crypto") return { randomUUID: () => "id" };
			if (name === "../../shared/ipc") return { ipcChannels: {} };
			// shell 检测依赖宿主环境（git-bash 路径、wsl.exe），桩掉以保证候选列表断言可复现；
			// existsSync=false / execSync 抛错 = 宿主未安装可选 shell 的最小环境。
			if (name === "node:fs") return { existsSync: () => false };
			if (name === "node:child_process") {
				return { execSync: () => { throw new Error("not available in test sandbox"); } };
			}
			if (name === "../wsl/WslPaths") {
				return loadTranspiledModule("src/main/wsl/WslPaths.ts");
			}
			if (name === "../wsl/wslExe") {
				return { getWslExe: () => ({ command: "wsl.exe", shell: false }) };
			}
			return require(name);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "TerminalSessionManager.ts",
	});
	return sandbox.exports;
}

test("uses the macOS user shell as a login shell", () => {
	const { getTerminalShellCandidates } = loadTerminalSessionManagerModule();

	const candidates = getTerminalShellCandidates("darwin", {
		SHELL: "/bin/zsh",
		PATH: "/usr/bin:/bin",
	});

	assert.deepEqual(plain(candidates[0]), {
		shell: "zsh",
		command: "/bin/zsh",
		args: ["-l"],
	});
});

test("keeps Windows shell candidates unchanged", () => {
	const { getTerminalShellCandidates } = loadTerminalSessionManagerModule();

	const candidates = getTerminalShellCandidates("win32", {});

	assert.deepEqual(
		plain(candidates.map((candidate) => candidate.command)),
		["pwsh.exe", "powershell.exe", "cmd.exe"],
	);
	assert.deepEqual(
		plain(candidates.map((candidate) => candidate.args)),
		[[], [], []],
	);
});

// ── owner 隔离（项目/agent 终端不串台） ────────────────────────────

function loadWithPty() {
	const source = readFileSync(
		"src/main/terminal/TerminalSessionManager.ts",
		"utf8",
	);
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	});
	const spawns = [];
	const ptyStub = {
		spawn: (command, args, opts) => {
			const pty = {
				cols: 80,
				rows: 24,
				kill: () => {},
				write: () => {},
				resize: () => {},
				onData: () => {},
				onExit: () => {},
			};
			spawns.push({ command, args, cwd: opts.cwd });
			return pty;
		},
	};
	const sandbox = {
		exports: {},
		process: { platform: "win32", env: {} },
		require: (name) => {
			if (name === "node-pty") return ptyStub;
			if (name === "node:crypto") return { randomUUID: () => `id-${spawns.length}` };
			if (name === "../../shared/ipc") return { ipcChannels: {} };
			if (name === "node:fs") return { existsSync: () => false };
			if (name === "node:child_process") {
				return { execSync: () => { throw new Error("not available in test sandbox"); } };
			}
			if (name === "../wsl/WslPaths") {
				return loadTranspiledModule("src/main/wsl/WslPaths.ts");
			}
			if (name === "../wsl/wslExe") {
				return { getWslExe: () => ({ command: "wsl.exe", shell: false }) };
			}
			return require(name);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "TerminalSessionManager.ts" });
	return { manager: sandbox.exports.TerminalSessionManager, spawns };
}

function agentTarget(agentId, sessionId = "s1") {
	return { kind: "agent", sessionId, agentId, runtimeGeneration: 1 };
}

function projectTarget(cwd, projectId = "p1") {
	return { kind: "project", projectId, cwd };
}

test("owner key normalizes agent id and project cwd for isolation", () => {
	const { manager, spawns } = loadWithPty();
	const instance = new manager((agentId) => `C:/agents/${agentId}`, () => {});

	// 同一项目路径的不同写法（大小写/分隔符/尾斜杠）必须归一为同一个隔离键
	const a = instance.create(projectTarget("C:\\Users\\Me\\Proj"));
	const b = instance.create(projectTarget("c:/users/me/proj/"));
	const tabs = instance.list(projectTarget("C:/USERS/Me/Proj"));
	assert.equal(tabs.length, 2);
	assert.equal(a.ownerKey, "cwd:c:/users/me/proj");
	assert.equal(b.ownerKey, "cwd:c:/users/me/proj");

	// agent 终端与项目终端绝不共用桶
	const agentTab = instance.create(agentTarget("agentA"));
	assert.equal(agentTab.ownerKey, "agent:agentA");
	assert.equal(instance.list(agentTarget("agentA")).length, 1);
	assert.equal(instance.list(projectTarget("C:\\Users\\Me\\Proj")).length, 2);
});

test("project terminals are spawned in the project cwd, agent terminals in agent cwd", () => {
	const { manager, spawns } = loadWithPty();
	const instance = new manager((agentId) => `C:/agents/${agentId}`, () => {});

	instance.create(projectTarget("D:/work/proj"));
	instance.create(agentTarget("agentB"));

	assert.equal(spawns[0].cwd, "D:/work/proj");
	assert.equal(spawns[1].cwd, "C:/agents/agentB");
});

test("configured WSL terminals use the Linux cwd inside the selected distro", () => {
	const { manager, spawns } = loadWithPty();
	const instance = new manager(
		(agentId) => `C:/agents/${agentId}`,
		() => {},
		() => ({ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "dev" }),
	);

	const tab = instance.create(projectTarget("D:/work/proj"), "wsl");

	assert.equal(tab.shell, "wsl");
	assert.equal(spawns[0].command, "wsl.exe");
	assert.deepEqual(plain(spawns[0].args), [
		"-d",
		"Ubuntu-24.04",
		"-u",
		"dev",
		"--cd",
		"/mnt/d/work/proj",
	]);
	assert.equal(spawns[0].cwd, "D:\\work\\proj");
});

test("closing an agent leaves project terminal buckets intact", () => {
	const { manager } = loadWithPty();
	const instance = new manager((agentId) => `C:/agents/${agentId}`, () => {});

	instance.create(projectTarget("D:/work/proj"));
	instance.create(agentTarget("agentC"));
	instance.closeAgent("agentC");

	assert.equal(instance.list(projectTarget("D:/work/proj")).length, 1);
	assert.equal(instance.list(agentTarget("agentC")).length, 0);
});

test("ensure returns existing tabs for the same owner instead of duplicating", () => {
	const { manager, spawns } = loadWithPty();
	const instance = new manager((agentId) => `C:/agents/${agentId}`, () => {});

	const first = instance.ensure(projectTarget("E:/repo"));
	assert.equal(first.length, 1);
	const second = instance.ensure(projectTarget("E:/repo"));
	assert.equal(second.length, 1);
	assert.equal(spawns.length, 1);
});
