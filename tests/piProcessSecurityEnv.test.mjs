import assert from "node:assert/strict";
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

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

/**
 * 沙箱加载 PiProcess：mock spawn 以捕获传入子进程的环境变量，mock locator 让 resolveCommand
 * 返回 "wsl://" 触发 WSL 分支，其余依赖（fs/extensions/logging）给最小桩，避免触碰真实文件系统。
 */
function loadPiProcess() {
	const wslPaths = loadWslPaths();
	/** spawn 收到的 env/args/windowsHide；mockSpawn 被调用时写入 */
	let captured = null;
	const mockSpawn = (_command, args, opts) => {
		captured = { env: opts?.env ?? null, args: args ?? null, windowsHide: opts?.windowsHide };
		// 返回一个最小 ChildProcess 形状：PiProcess 后续会 new PiRpcClient(proc.stdin/stdout)
		// 并注册 stderr/error/exit 监听，全部用 stream + noop 满足。
		return {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			on() {},
			kill() {},
			pid: 12345,
		};
	};
	class MockRpcClient {
		on() { return this; }
		close() {}
		request() { return Promise.resolve({ success: true, data: {} }); }
	}
	// locator 决定 command 是否进入 WSL 分支；createProcessEnv 给空 env 让注入逻辑可观测
	const mockLocator = {
		resolveCommand: () => "wsl://pi",
		createInvocation: (command, args) => ({
			command,
			args,
			shell: false,
			pathPrefix: "",
			wsl: true,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({}),
	};
	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process: { ...process, platform: "win32" },
		require: (id) => {
			if (id === "node:child_process") {
				return {
					spawn: mockSpawn,
					// ensureVersionCheck 异步探针：返回 0.82.1（≥ 白名单版本门槛 0.60），
					// 避免低版本触发白名单降级分支影响注入断言
					execFile: (_cmd, _args, _opts, cb) => {
						if (typeof cb === "function") cb(null, "0.82.1\n");
					},
				};
			}
			if (id === "node:events") return require("node:events");
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "node:path") return require("node:path").win32;
			if (id === "./PiRpcClient") return { PiRpcClient: MockRpcClient };
			if (id === "./PiLocator") return { PiLocator: class {} };
			if (id === "./piExtensionFilter") {
				return { parkBlockedExtensionsInDir: () => [], unparkBlockedExtensions: () => {} };
			}
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => args };
			}
			if (id === "../extensions/extensionVersionGate") {
				return require("../src/main/extensions/extensionVersionGate.ts");
			}
			if (id === "../logging/sharedLogger") return { getAppLogger: () => undefined };
			if (id === "../sessions/sessionProxyPolicy") {
				return { applyPiProxyMode: (env) => env };
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, { filename: "PiProcess.ts" });
	return { PiProcess: sandbox.exports.PiProcess, mockLocator, getCaptured: () => captured };
}

test("Windows 下启动 pi 进程时隐藏 cmd.exe 控制台窗口", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
	);

	await proc.start(undefined, undefined, true);

	assert.equal(getCaptured()?.windowsHide, true);
});

test("WSL 模式下 PIDECK_SESSION_ID（UUID 身份 key）原样注入，不经 Linux 路径转换", async () => {
	// 回归：临时会话 deckSessionId 是新生成的 UUID（无 sessionPath 兜底），
	// 旧代码把它当 Windows 路径喂给 toWslLinuxPath——UUID 既非 UNC/盘符/绝对 Linux 路径，
	// WslPaths 必抛 INVALID_WSL_PATH，导致 WSL 下临时会话起不来（spawn 之前就崩）。
	// 但 PIDECK_SESSION_ID 对扩展只是 sessionLevels 字典查表 key（不 fs 打开），
	// 任何模式都应原样注入；只有 securitySnapshotPath（真实 Windows 路径，扩展要 fs 读）才需要转换。
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const uuid = "550e8400-e29b-41d4-a716-446655440000";
	const snapshotPath = "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json";

	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoExtensions: true, piRpcOffline: true },
		mockLocator,
		{ securitySnapshotPath: snapshotPath, securitySessionId: uuid },
	);

	// noSession=true：临时会话不传 sessionPath，securitySessionId 仅剩 UUID（最易触发 bug 的路径）
	await proc.start(undefined, undefined, true);

	const captured = getCaptured();
	assert.ok(captured?.env, "spawn 应被调用并捕获到 env");
	// 身份 key 原样透传：扩展按它命中 sessionLevels 覆盖
	assert.equal(captured.env.PIDECK_SESSION_ID, uuid);
	// snapshotPath 是真实 Windows 路径（扩展需 fs 打开），WSL 下仍要转成 /mnt/c/...
	assert.equal(
		captured.env.PIDECK_SECURITY_CONFIG,
		"/mnt/c/Users/tester/AppData/Roaming/PiDeck-dev/security-policy.json",
	);
});

test("默认（未开启总开关）且存在禁用项时注入 --no-extensions + -e 白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
		{
			resolveEnabledExtensionPaths: () => ["C:\\ext\\a.ts", "C:\\ext\\b.ts"],
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-extensions");
	assert.ok(idx >= 0, "白名单模式应注入 --no-extensions");
	assert.equal(captured.args[idx + 1], "--extension");
	// WSL 模式：-e 后的扩展路径被转换为 distro 内 Linux 路径（最终交给 pi 在 distro 内加载）
	assert.equal(captured.args[idx + 2], "/mnt/c/ext/a.ts");
	assert.equal(captured.args[idx + 3], "--extension");
	assert.equal(captured.args[idx + 4], "/mnt/c/ext/b.ts");
});

test("自动标题设置以显式环境标志注入 pi 进程", async () => {
	const disabled = loadPiProcess();
	const disabledProc = new disabled.PiProcess(
		"C:\\proj",
		{ autoSessionTitle: false, wslEnabled: true, wslDistro: "Ubuntu", wslUser: "root" },
		disabled.mockLocator,
	);
	await disabledProc.start(undefined, undefined, true);
	assert.equal(disabled.getCaptured()?.env?.PIDECK_AUTO_SESSION_TITLE, "0");

	const enabled = loadPiProcess();
	const enabledProc = new enabled.PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "root" },
		enabled.mockLocator,
	);
	await enabledProc.start(undefined, undefined, true);
	assert.equal(enabled.getCaptured()?.env?.PIDECK_AUTO_SESSION_TITLE, "1");
});

test("白名单总开关 disableExtensionWhitelist=true 时不再注入 --no-extensions/-e", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	// resolver 返回白名单路径（模拟存在禁用项），但总开关开启时应整体忽略白名单
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", disableExtensionWhitelist: true },
		mockLocator,
		{
			resolveEnabledExtensionPaths: () => ["C:\\ext\\a.ts"],
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-extensions"), "总开关开启时不应注入 --no-extensions");
	assert.ok(!captured.args.includes("--extension"), "总开关开启时不应注入 --extension");
});
