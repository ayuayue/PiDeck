import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

function createChildProcess() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

function loadPiProcess(spawnCalls) {
	class FakeRpcClient extends EventEmitter {
		close() {}
	}
	class FakePiLocator {}
	// spawn 替身捕获本次调用的 command/args/options（含 child），随用例变化，
	// 所以每次加载都新建沙箱实例。未打桩的相对 import（LocalPiRuntimeLauncher、PiSpawnHandle、
	// WslPaths、piExtensionFilter、piSpawnFailure、gitProcess…）由加载器按**源文件目录**解析。
	const load = createTsSandbox({
		stubs: {
			"node:child_process": {
				execFile: (_command, _args, _options, callback) => {
					callback(null, "0.81.1\n", "");
					return new EventEmitter();
				},
				spawn: (command, args, options) => {
					const child = createChildProcess();
					// args 由沙箱 realm 的启动器复制后传入（`[...plan.args]`）：跨 realm 数组让
					// deepStrictEqual 因原型不同而失败。在捕获点归一为本 realm 副本（内容/长度不变），
					// 断言保持不变。
					spawnCalls.push({ command, args: Array.from(args), options, child });
					return child;
				},
			},
			"./PiRpcClient": { PiRpcClient: FakeRpcClient },
			"./PiLocator": { PiLocator: FakePiLocator },
			// 不触达真实 ~/.pi 扩展目录：停放/还原在本用例无断言对象。
			"./piExtensionFilter": { parkBlockedExtensionsInDir: () => [], unparkBlockedExtensions: () => {} },
			// 25fd516 起 PiProcess 引入内置扩展参数拼接；WSL 测试只关心路径转换，按原样透传。
			"../extensions/builtInExtensions": { appendBuiltInExtensionArgs: (args) => [...args] },
			// sharedLogger 未注册时 getAppLogger 返回 null，PiProcess 埋点静默跳过。
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../sessions/sessionProxyPolicy": { applyPiProxyMode: (env) => env },
		},
		globals: { console: { log() {}, warn() {}, error() {} } },
	});
	return load("src/main/pi/PiProcess.ts");
}

function createLocator(invocationCalls) {
	return {
		resolveCommand: () => "wsl://Ubuntu-24.04/root/pi",
		createInvocation: (_command, args, options = {}) => {
			invocationCalls.push({ args: [...args], options: { ...options } });
			return {
				command: "wsl.exe",
				args: ["-d", "Ubuntu-24.04", "-u", "root", ...(options.wslCwd ? ["--cd", options.wslCwd] : []), "pi", ...args],
				shell: false,
				wsl: { distro: "Ubuntu-24.04", user: "root", piCommand: "pi" },
			};
		},
		createProcessEnv: () => ({}),
	};
}

/** Windows UNC 路径：用 charCode 拼反斜杠，避免测试源码里的多层转义。 */
const wslUncSkillPath = ["", "", "wsl$", "Ubuntu-24.04", "root", ".pi", "agent", "pideck-skills", "pideck"].join(String.fromCharCode(92));

const settings = {
	wslEnabled: true,
	wslDistro: "Ubuntu-24.04",
	wslUser: "root",
	piProxyEnabled: false,
	piProxyUrl: "",
	piProxyBypass: "",
};

test("starts WSL pi with Linux cwd/session while keeping a Windows-accessible spawn cwd", async () => {
	const spawnCalls = [];
	const invocationCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const process = new PiProcess("//wsl.localhost/Ubuntu-24.04/root/ba_cli", settings, createLocator(invocationCalls));

	await process.start("\\\\wsl$\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl");

	assert.equal(invocationCalls[0].options.wslCwd, "/root/ba_cli");
	assert.deepEqual(invocationCalls[0].args, ["--mode", "rpc", "--no-themes", "--offline", "--session", "/root/.pi/agent/sessions/session.jsonl"]);
	assert.equal(spawnCalls[0].options.cwd, "\\\\wsl.localhost\\Ubuntu-24.04\\root\\ba_cli");
	assert.deepEqual(spawnCalls[0].args, ["-d", "Ubuntu-24.04", "-u", "root", "--cd", "/root/ba_cli", "pi", "--mode", "rpc", "--no-themes", "--offline", "--session", "/root/.pi/agent/sessions/session.jsonl"]);
	assert.equal(process.getDiagnostics().cwd, "/root/ba_cli");
});

test("rejects a project UNC from another distro before spawning pi", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const process = new PiProcess("\\\\wsl.localhost\\Debian\\root\\ba_cli", settings, createLocator([]));

	await assert.rejects(process.start(), (error) => error.code === "WSL_DISTRO_MISMATCH");
	assert.equal(spawnCalls.length, 0);
});

test("injects bundled skills via --skill and converts them to Linux paths under WSL", async () => {
	const spawnCalls = [];
	const invocationCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const process = new PiProcess("//wsl.localhost/Ubuntu-24.04/root/ba_cli", settings, createLocator(invocationCalls), {
		bundledSkillPaths: [wslUncSkillPath],
	});

	await process.start();

	assert.deepEqual(invocationCalls[0].args, ["--mode", "rpc", "--no-themes", "--offline", "--skill", "/root/.pi/agent/pideck-skills/pideck"]);
});

test("skips --skill injection when the no-skills diagnostic switch is on", async () => {
	const spawnCalls = [];
	const invocationCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const process = new PiProcess("//wsl.localhost/Ubuntu-24.04/root/ba_cli", { ...settings, piRpcNoSkills: true }, createLocator(invocationCalls), {
		bundledSkillPaths: [wslUncSkillPath],
	});

	await process.start();

	assert.deepEqual(invocationCalls[0].args, ["--mode", "rpc", "--no-themes", "--offline", "--no-skills"]);
});
