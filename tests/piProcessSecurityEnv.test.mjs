import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
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
function loadPiProcess(versionResult = { output: "0.82.1\n" }, options = { parkedExtensions: [] }) {
	const wslPaths = loadWslPaths();
	/** piExtensionFilter 收到的目录，用于验证 denied trust 不触碰项目资源。 */
	const parkedDirectories = [];
	/** spawn 收到的 env/args/windowsHide；mockSpawn 被调用时写入 */
	let captured = null;
	let unparkCalls = 0;
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
		on() {
			return this;
		}
		close() {}
		request() {
			return Promise.resolve({ success: true, data: {} });
		}
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
		// 模拟 Windows 上 .cmd 垫片被还原成 node 直启后的通道预算
		// （对应 PiLocator.CREATE_PROCESS_ARG_CHAR_BUDGET）。各通道真实取值由
		// piLocator.test.mjs 覆盖，这里只用于驱动 PiProcess 的「超预算时跳过注入」分支。
		resolveArgCharBudget: () => 26000,
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
						if (typeof cb !== "function") return;
						queueMicrotask(() => {
							if (versionResult.error) cb(versionResult.error, "");
							else cb(null, versionResult.output);
						});
					},
				};
			}
			if (id === "node:events") return require("node:events");
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "node:path") return require("node:path").win32;
			if (id === "./PiRpcClient") return { PiRpcClient: MockRpcClient };
			if (id === "./PiLocator") return { PiLocator: class {} };
			if (id === "./piExtensionFilter") {
				return {
					parkBlockedExtensionsInDir: (directory) => {
						parkedDirectories.push(directory);
						return options.parkedExtensions;
					},
					unparkBlockedExtensions: () => {
						unparkCalls += 1;
					},
				};
			}
			if (id === "../wsl/WslPaths") return wslPaths;
			// PiProcess 的 spawn 失败归因模块：vm 沙箱按 tests/ 相对路径解析，需显式登记。
			if (id === "./piSpawnFailure") return require("../src/main/pi/piSpawnFailure.ts");
			// killProcessTree（stop() 在 Windows 上的整树强杀）：PiProcess 一直直接 import
			// gitProcess，但本文件没跟上登记 → 整个文件报 MODULE_NOT_FOUND（既有缺口，与本次改动无关）。
			if (id === "../git/gitProcess") return require("../src/main/git/gitProcess.ts");
			if (id === "../extensions/builtInExtensions") {
				// 真实语义（非 no-op）：noExtensions 或空列表原样返回，否则追加 --extension <path>。
				// 曾是 (args) => args 的 no-op，掩盖了内置扩展注入；A5 契约测试要求真实行为。
				return {
					appendBuiltInExtensionArgs: (args, extensionPaths, options = {}) => {
						if (options.noExtensions || !extensionPaths || extensionPaths.length === 0) return [...args];
						const next = [...args];
						for (const extensionPath of extensionPaths) {
							const trimmed = extensionPath?.trim();
							if (trimmed) next.push("--extension", trimmed);
						}
						return next;
					},
				};
			}
			if (id === "../extensions/extensionVersionGate") {
				return loadTsCommonJs("src/main/extensions/extensionVersionGate.ts");
			}
			if (id === "../logging/sharedLogger") return { getAppLogger: () => undefined };
			if (id === "../sessions/sessionProxyPolicy") {
				return { applyPiProxyMode: (env) => env };
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, { filename: "PiProcess.ts" });
	return {
		PiProcess: sandbox.exports.PiProcess,
		mockLocator,
		getCaptured: () => captured,
		getParkedDirectories: () => parkedDirectories,
		getUnparkCalls: () => unparkCalls,
	};
}

test("Windows 下启动 pi 进程时隐藏 cmd.exe 控制台窗口", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator);

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

	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoExtensions: true, piRpcOffline: true }, mockLocator, { securitySnapshotPath: snapshotPath, securitySessionId: uuid });

	// noSession=true：临时会话不传 sessionPath，securitySessionId 仅剩 UUID（最易触发 bug 的路径）
	await proc.start(undefined, undefined, true);

	const captured = getCaptured();
	assert.ok(captured?.env, "spawn 应被调用并捕获到 env");
	// 身份 key 原样透传：扩展按它命中 sessionLevels 覆盖
	assert.equal(captured.env.PIDECK_SESSION_ID, uuid);
	// snapshotPath 是真实 Windows 路径（扩展需 fs 打开），WSL 下仍要转成 /mnt/c/...
	assert.equal(captured.env.PIDECK_SECURITY_CONFIG, "/mnt/c/Users/tester/AppData/Roaming/PiDeck-dev/security-policy.json");
});

test("自动标题设置以显式环境标志注入 pi 进程", async () => {
	const disabled = loadPiProcess();
	const disabledProc = new disabled.PiProcess("C:\\proj", { autoSessionTitle: false, wslEnabled: true, wslDistro: "Ubuntu", wslUser: "root" }, disabled.mockLocator);
	await disabledProc.start(undefined, undefined, true);
	assert.equal(disabled.getCaptured()?.env?.PIDECK_AUTO_SESSION_TITLE, "0");

	const enabled = loadPiProcess();
	const enabledProc = new enabled.PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "root" }, enabled.mockLocator);
	await enabledProc.start(undefined, undefined, true);
	assert.equal(enabled.getCaptured()?.env?.PIDECK_AUTO_SESSION_TITLE, "1");
});

test("无禁用技能（resolver 返回 null）时不注入 --no-skills/--skill", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledSkillPaths: () => null,
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-skills"), "无禁用项时不应注入 --no-skills");
	assert.ok(!captured.args.includes("--skill"), "无禁用项时不应注入 --skill");
});

test("拒绝 trust 时版本探测失败会阻止 spawn", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ error: new Error("missing pi") });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator);
	await assert.rejects(proc.start(undefined, "no-approve", true), /Cannot start an untrusted project safely/);
	assert.equal(getCaptured(), null, "版本不可验证时绝不能启动可能加载项目代码的进程");
});

test("拒绝 trust 时旧版 pi 会阻止 spawn", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ output: "0.78.0\n" });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator);
	await assert.rejects(proc.start(undefined, "no-approve", true), /Cannot start an untrusted project safely/);
	assert.equal(getCaptured(), null);
});

// ---------------------------------------------------------------------------
// pi 0.99 内置扩展（built-in extensions）注入：--no-extensions 语义扩大后
// 必须用 `-e builtin:<name>` 把 mcp / llama.cpp / codemode / tool-search 四个都带回来
// （见 appendBuiltInExtensionSpecifierArgs；codemode 是 MCP 默认 exposure 的硬依赖）。
// ---------------------------------------------------------------------------

const BUILT_IN_SPECIFIER_ARGS = ["--extension", "builtin:mcp", "--extension", "builtin:llama.cpp", "--extension", "builtin:codemode", "--extension", "builtin:tool-search"];

// ---------------------------------------------------------------------------
// 白名单机制移除后的启动形态契约（计划 A5；替代已删除的白名单降级测试）
// ---------------------------------------------------------------------------

test("正常启动不注入 --no-extensions/--no-skills：启停由 pi 原生过滤规则决定", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ output: "1.0.0\n" });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveBuiltInExtensionPaths: () => ["C:\\app\\resources\\extensions\\pi-deck-session-title.ts"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start();
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-extensions"), `不应有 --no-extensions，实际: ${JSON.stringify(captured.args)}`);
	assert.ok(!captured.args.includes("--no-skills"), `不应有 --no-skills，实际: ${JSON.stringify(captured.args)}`);
	assert.ok(!captured.args.includes("--no-prompt-templates"), `不应有 --no-prompt-templates，实际: ${JSON.stringify(captured.args)}`);
	// PiDeck 自带扩展仍以 -e 附加（与白名单机制无关）。WSL 模式下 C:\ 路径会被
	// 转成 /mnt/c/... 形式，断言 basename 即可。
	assert.ok(
		captured.args.some((arg) => arg.includes("pi-deck-session-title.ts")),
		`自带扩展应随 -e 附加，实际: ${JSON.stringify(captured.args)}`,
	);
	assert.ok(captured.args.includes("--extension"), "-e 注入应存在");
});

test("piRpcNoExtensions 诊断开关开启时不注入任何扩展（含自带）", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ output: "1.0.0\n" });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoExtensions: true }, mockLocator, {
		resolveBuiltInExtensionPaths: () => ["C:\\app\\resources\\extensions\\pi-deck-session-title.ts"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start();
	const captured = getCaptured();
	assert.ok(captured?.args?.includes("--no-extensions"), "诊断开关应注入 --no-extensions");
	assert.ok(!captured.args.includes("pi-deck-session-title.ts"), "诊断模式下自带扩展不应注入");
});

test("piRpcNoExtensions 诊断开关开启时不注入 builtin: specifier（诊断路径必须干净）", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ output: "0.99.1\n" });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoExtensions: true }, mockLocator, {
		resolveEnabledExtensionPaths: () => [],
		resolveBuiltInExtensionPaths: () => [],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start();
	const captured = getCaptured();
	assert.ok(captured?.args?.includes("--no-extensions"), "诊断开关应注入 --no-extensions");
	assert.ok(!captured.args.includes("builtin:mcp"), "诊断路径要求 pi 一个扩展都不加载");
	assert.ok(!captured.args.includes("builtin:llama.cpp"));
	assert.ok(!captured.args.includes("builtin:codemode"));
	assert.ok(!captured.args.includes("builtin:tool-search"));
});
