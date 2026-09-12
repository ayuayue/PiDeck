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
function loadPiProcess(
	versionResult = { output: "0.82.1\n" },
	options = { parkedExtensions: [] },
) {
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

test("存在禁用技能时注入 --no-skills + 逐条 --skill 白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
		{
			// 模拟技能白名单解析器：存在禁用项 → 返回启用技能路径
			resolveEnabledSkillPaths: () => ["C:\\Users\\tester\\skills\\a\\SKILL.md", "C:\\Users\\tester\\skills\\b\\SKILL.md"],
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-skills");
	assert.ok(idx >= 0, "技能白名单模式应注入 --no-skills");
	assert.equal(captured.args[idx + 1], "--skill");
	// WSL 模式：--skill 后的路径同样被转换为 distro 内 Linux 路径
	assert.equal(captured.args[idx + 2], "/mnt/c/Users/tester/skills/a/SKILL.md");
	assert.equal(captured.args[idx + 3], "--skill");
	assert.equal(captured.args[idx + 4], "/mnt/c/Users/tester/skills/b/SKILL.md");
});

test("WSL 家目录的 --skill 白名单路径（UNC）转换为 distro 内 Linux 路径", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
		{
			// 模拟 WSL 场景：解析器经 \\wsl.localhost 扫到 Linux 家目录技能（issue #203）
			resolveEnabledSkillPaths: () => [
				"\\\\wsl.localhost\\Ubuntu-24.04\\root\\.agents\\skills\\wsl-skill\\SKILL.md",
				"\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\skills\\wsl-pi-skill\\SKILL.md",
			],
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-skills");
	assert.ok(idx >= 0, "技能白名单模式应注入 --no-skills");
	assert.equal(captured.args[idx + 1], "--skill");
	// UNC（\\wsl.localhost\<distro>\...）必须转成 distro 内原生 Linux 路径，
	// 否则 WSL 里的 pi 打不开 Windows UNC 形式的技能文件
	assert.equal(captured.args[idx + 2], "/root/.agents/skills/wsl-skill/SKILL.md");
	assert.equal(captured.args[idx + 3], "--skill");
	assert.equal(captured.args[idx + 4], "/root/.pi/agent/skills/wsl-pi-skill/SKILL.md");
});

test("无禁用技能（resolver 返回 null）时不注入 --no-skills/--skill", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
		{
			resolveEnabledSkillPaths: () => null,
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-skills"), "无禁用项时不应注入 --no-skills");
	assert.ok(!captured.args.includes("--skill"), "无禁用项时不应注入 --skill");
});

test("存在禁用模板时注入 --no-prompt-templates + 逐条 --prompt-template 白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
		{
			// 模拟模板白名单解析器：存在禁用项 → 返回启用模板路径
			resolveEnabledPromptPaths: () => ["C:\\Users\\tester\\prompts\\a.md", "C:\\Users\\tester\\prompts\\b.md"],
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-prompt-templates");
	assert.ok(idx >= 0, "模板白名单模式应注入 --no-prompt-templates");
	assert.equal(captured.args[idx + 1], "--prompt-template");
	// WSL 模式：--prompt-template 后的路径同样被转换为 distro 内 Linux 路径
	assert.equal(captured.args[idx + 2], "/mnt/c/Users/tester/prompts/a.md");
	assert.equal(captured.args[idx + 3], "--prompt-template");
	assert.equal(captured.args[idx + 4], "/mnt/c/Users/tester/prompts/b.md");
});

test("无禁用模板（resolver 返回 null）时不注入 --no-prompt-templates/--prompt-template", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
		{
			resolveEnabledPromptPaths: () => null,
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-prompt-templates"), "无禁用项时不应注入 --no-prompt-templates");
	assert.ok(!captured.args.includes("--prompt-template"), "无禁用项时不应注入 --prompt-template");
});

test("piRpcNoSkills 总开关开启时不注入技能白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoSkills: true },
		mockLocator,
		{
			resolveEnabledSkillPaths: () => ["C:\\Users\\tester\\skills\\a\\SKILL.md"],
			securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
		},
	);
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	// piRpcNoSkills 分支已注入 --no-skills（总开关）；技能白名单不应再注入 --skill
	assert.ok(captured.args.includes("--no-skills"), "总开关应注入 --no-skills");
	assert.ok(!captured.args.includes("--skill"), "总开关开启时不应注入 --skill");
});

test("resolver failure before spawn restores temporarily parked extensions", async () => {
	const parked = [{
		dir: "C:\\Users\\tester\\.pi\\agent\\extensions",
		name: "codeisland.ts",
		originalPath: "C:\\Users\\tester\\.pi\\agent\\extensions\\codeisland.ts",
		parkedPath: "C:\\Users\\tester\\.pi\\agent\\extensions\\codeisland.ts.pideck-disabled",
	}];
	const { PiProcess, mockLocator, getCaptured, getUnparkCalls } = loadPiProcess(
		{ output: "0.82.1\n" },
		{ parkedExtensions: parked },
	);
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
		{ resolveEnabledExtensionPaths: () => { throw new Error("resolver failed"); } },
	);
	await assert.rejects(proc.start(undefined, undefined, true), /resolver failed/);
	assert.equal(getCaptured(), null);
	assert.equal(getUnparkCalls(), 1);
});

test("--no-approve 会通知所有资源 resolver 排除项目层并传给受支持的 pi", async () => {
	const { PiProcess, mockLocator, getCaptured, getParkedDirectories } = loadPiProcess();
	const observed = [];
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", disableExtensionWhitelist: true },
		mockLocator,
		{
			resolveBuiltInExtensionPaths: (_settings, includeProjectResources) => {
				observed.push(["built-in", includeProjectResources]);
				return [];
			},
			resolveEnabledExtensionPaths: (_settings, _cwd, includeProjectResources) => {
				observed.push(["extension", includeProjectResources]);
				return [];
			},
			resolveEnabledSkillPaths: (_settings, _cwd, includeProjectResources) => {
				observed.push(["skill", includeProjectResources]);
				return [];
			},
			resolveEnabledPromptPaths: (_settings, _cwd, includeProjectResources) => {
				observed.push(["prompt", includeProjectResources]);
				return [];
			},
		},
	);
	await proc.start(undefined, "no-approve", true);
	assert.ok(getCaptured()?.args?.includes("--no-approve"));
	assert.ok(getCaptured()?.args?.includes("--no-extensions"), "denied trust overrides the whitelist diagnostic switch");
	assert.deepEqual(getParkedDirectories(), ["C:\\Users\\tester\\.pi\\agent\\extensions"]);
	assert.deepEqual(observed, [
		["extension", false],
		["built-in", false],
		["skill", false],
		["prompt", false],
	]);
});

test("拒绝 trust 时版本探测失败会阻止 spawn", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ error: new Error("missing pi") });
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
	);
	await assert.rejects(
		proc.start(undefined, "no-approve", true),
		/Cannot start an untrusted project safely/,
	);
	assert.equal(getCaptured(), null, "版本不可验证时绝不能启动可能加载项目代码的进程");
});

test("拒绝 trust 时旧版 pi 会阻止 spawn", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ output: "0.78.0\n" });
	const proc = new PiProcess(
		"C:\\proj",
		{ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" },
		mockLocator,
	);
	await assert.rejects(
		proc.start(undefined, "no-approve", true),
		/Cannot start an untrusted project safely/,
	);
	assert.equal(getCaptured(), null);
});
