import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** vm 沙箱与宿主不同 realm，strict deepEqual 会比原型；统一转成宿主纯值再比。 */
function eqDeep(actual, expected) {
	assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
}

const require = createRequire(import.meta.url);

const PI_LOCATOR_DIR = "src/main/pi";

/**
 * 在沙箱里加载一个项目内 TS 模块。
 * PiLocator 现在依赖 ../wsl/wslPiProbe 与 ../wsl/wslExe，相对导入必须一并解析，
 * 否则测试里 require 直接抛 MODULE_NOT_FOUND。
 */
function loadTsFile(filePath, sandboxExtra = {}) {
	const { outputText } = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.startsWith(".")) {
				return loadTsFile(join(dirname(filePath), id + ".ts"), sandboxExtra);
			}
			return require(id);
		},
		Buffer,
		TextDecoder,
		process,
		console,
		...sandboxExtra,
	};
	sandbox.global = sandbox;
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function loadPiLocatorModule(
	platform = process.platform,
	envOverrides = {},
	homePath = tmpdir(),
	moduleOverrides = {},
	sandboxExtra = {},
) {
	const filePath = join(PI_LOCATOR_DIR, "PiLocator.ts");
	const { outputText } = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		Buffer,
		TextDecoder,
		exports: {},
		process: {
			...process,
			env: { ...process.env, ...envOverrides },
			platform,
		},
		require: (id) => {
			if (id in moduleOverrides) return moduleOverrides[id];
			if (id === "electron") {
				return { app: { getPath: () => homePath } };
			}
			// 相对依赖（../wsl/wslPiProbe、../wsl/wslExe）用同一套沙箱环境加载
			if (id.startsWith(".")) {
				return loadTsFile(join(PI_LOCATOR_DIR, id + ".ts"), {
					process: sandbox.process,
					require: (nested) => (nested in moduleOverrides ? moduleOverrides[nested] : require(nested)),
				});
			}
			return require(id);
		},
		...sandboxExtra,
	};
	sandbox.global = sandbox;
	// 宿主开发机可能已设置 MISE_DATA_DIR 等变量（如 D:\mise-data），
	// 未显式覆盖时剔除，保证每个用例从“干净环境”出发验证默认路径逻辑。
	if (!("MISE_DATA_DIR" in envOverrides)) delete sandbox.process.env.MISE_DATA_DIR;
	if (!("MISE_INSTALL_PATH" in envOverrides)) delete sandbox.process.env.MISE_INSTALL_PATH;
	// 非 win32 用例不应看到宿主的 APPDATA/LOCALAPPDATA：PiLocator 会用它们拼
	// %APPDATA%\npm 候选目录，Windows 开发机上真实 npm 全局会提前命中（环境泄漏）。
	if (platform !== "win32" && !("APPDATA" in envOverrides)) delete sandbox.process.env.APPDATA;
	if (platform !== "win32" && !("LOCALAPPDATA" in envOverrides)) delete sandbox.process.env.LOCALAPPDATA;
	vm.runInNewContext(outputText, sandbox, {
		filename: "PiLocator.ts",
	});
	return sandbox.exports;
}

test("uses the pi shim bin directory as PATH prefix on macOS when node is beside the shim", () => {
	const root = join(tmpdir(), `pi-desktop-locator-${process.pid}-${Date.now()}`);
	const binDir = join(root, ".nvm", "versions", "node", "v22.22.1", "bin");
	mkdirSync(binDir, { recursive: true });
	const piPath = join(binDir, "pi");
	writeFileSync(piPath, "#!/usr/bin/env node\n", "utf8");
	writeFileSync(join(binDir, "node"), "", "utf8");

	try {
		const { PiLocator } = loadPiLocatorModule("darwin");
		const invocation = new PiLocator().createInvocation(piPath, ["--version"]);

		assert.equal(invocation.command, piPath);
		assert.deepEqual(invocation.args, ["--version"]);
		assert.equal(invocation.shell, false);
		assert.equal(invocation.pathPrefix, binDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("uses the pi cmd shim bin directory as PATH prefix on Windows when node.exe is beside the shim", () => {
	const root = join(tmpdir(), `pi-desktop-locator-win-${process.pid}-${Date.now()}`);
	const binDir = join(root, "nvm", "v22.22.1");
	mkdirSync(binDir, { recursive: true });
	const piPath = join(binDir, "pi.cmd");
	writeFileSync(piPath, "@echo off\r\nnode \"%~dp0\\node_modules\\pi\\bin.js\" %*\r\n", "utf8");
	writeFileSync(join(binDir, "node.exe"), "", "utf8");

	try {
		const { PiLocator } = loadPiLocatorModule("win32");
		const locator = new PiLocator();
		const invocation = locator.createInvocation(piPath, ["--version"]);

		assert.match(invocation.command.toLowerCase(), /cmd\.exe$/);
		assert.equal(JSON.stringify(invocation.args.slice(0, 3)), JSON.stringify(["/d", "/s", "/c"]));
		assert.equal(invocation.shell, false);
		assert.equal(invocation.pathPrefix, binDir);
		assert.equal(invocation.windowsVerbatimArguments, true);

		// Windows cmd 读 Path；createProcessEnv 必须把 pathPrefix 同步进 PATH/Path
		const env = locator.createProcessEnv(undefined, invocation.pathPrefix);
		assert.equal(typeof env.PATH, "string");
		assert.ok(String(env.PATH).startsWith(binDir));
		assert.equal(env.Path, env.PATH);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// 回归 #169：Linux 下部分用户通过 alias "node /path/pi.js" 直接运行 JS 源文件（而非 npm shim）。
// createInvocation 必须把指向真实 .js 文件的路径改用 node 启动（无 shebang/可执行位不能直接 execve），
// 同时不能误拦裸命令名 "pi"（existsSync 对相对路径返回 false）。
test("createInvocation routes a .js pi entry through node on Linux", () => {
	const root = join(tmpdir(), `pi-desktop-locator-js-${process.pid}-${Date.now()}`);
	const jsPath = join(root, "pi.js");
	mkdirSync(root, { recursive: true });
	writeFileSync(jsPath, "#!/usr/bin/env node\nconsole.log('hi')\n", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule("linux", {}, root);
		const invocation = new PiLocator().createInvocation(jsPath, ["--version"]);
		assert.equal(invocation.command, "node", "JS source must run via node, not direct execve");
		// VM 跨 realm：args 是沙箱内 Array，与宿主 Array 原型不同，用 JSON 文本比较。
		assert.equal(JSON.stringify(invocation.args), JSON.stringify([jsPath, "--version"]));
		assert.equal(invocation.shell, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createInvocation leaves bare pi command alone (no .js routing without a real file)", () => {
	const { PiLocator } = loadPiLocatorModule("linux", {}, tmpdir());
	const invocation = new PiLocator().createInvocation("pi", ["--version"]);
	assert.equal(invocation.command, "pi", "bare pi must not be rerouted to node");
	assert.equal(JSON.stringify(invocation.args), JSON.stringify(["--version"]));
});

test("createInvocation routes a .js pi entry through node.exe on Windows", () => {
	const root = join(tmpdir(), `pi-desktop-locator-js-win-${process.pid}-${Date.now()}`);
	const jsPath = join(root, "pi.js");
	mkdirSync(root, { recursive: true });
	writeFileSync(jsPath, "console.log('hi')", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		const invocation = new PiLocator().createInvocation(jsPath, ["--version"]);
		assert.equal(invocation.command, "node.exe");
		assert.equal(JSON.stringify(invocation.args), JSON.stringify([jsPath, "--version"]));
		assert.equal(invocation.shell, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// 自动发现：Linux 下若没有标准 pi shim，扫描应回退到 pi.js/mjs/cjs（#169 的 alias-JS 场景）；
// 存在标准 pi 时仍优先命中 pi，不被同名 JS 误拦。
test("resolveCommand auto-detects pi.js on Linux when no pi shim exists", () => {
	const root = join(tmpdir(), `pi-desktop-locator-jsdetect-${process.pid}-${Date.now()}`);
	const npmGlobal = join(root, ".npm-global", "bin");
	mkdirSync(npmGlobal, { recursive: true });
	writeFileSync(join(npmGlobal, "pi.js"), "console.log('pi')", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule("linux", { PATH: "" }, root);
		const resolved = new PiLocator().resolveCommand(undefined, false, undefined, undefined);
		assert.equal(resolved, join(npmGlobal, "pi.js"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveCommand prefers a real pi shim over a sibling pi.js on Linux", () => {
	const root = join(tmpdir(), `pi-desktop-locator-shimprio-${process.pid}-${Date.now()}`);
	const npmGlobal = join(root, ".npm-global", "bin");
	mkdirSync(npmGlobal, { recursive: true });
	writeFileSync(join(npmGlobal, "pi"), "#!/bin/sh\nexec node x\n", "utf8");
	writeFileSync(join(npmGlobal, "pi.js"), "console.log('pi')", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule("linux", { PATH: "" }, root);
		const resolved = new PiLocator().resolveCommand(undefined, false, undefined, undefined);
		assert.equal(resolved, join(npmGlobal, "pi"), "standard shim must win over pi.js");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSearchDirs honors MISE_DATA_DIR and MISE_INSTALL_PATH on Windows", () => {
	const root = join(tmpdir(), `pi-desktop-locator-mise-${process.pid}-${Date.now()}`);
	const miseData = join(root, "mise-data");
	const miseInstalls = join(root, "custom-installs");
	const installDir = join(miseInstalls, "node", "v24.0.0");
	mkdirSync(installDir, { recursive: true });
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{
				MISE_DATA_DIR: miseData,
				MISE_INSTALL_PATH: miseInstalls,
				LOCALAPPDATA: join(root, "Local"),
				APPDATA: join(root, "Roaming"),
			},
			root,
		);
		const dirs = new PiLocator().getSearchDirs();
		// 自定义数据目录生效，且不再依赖 %LOCALAPPDATA%\mise 默认位置
		assert.ok(dirs.includes(join(miseData, "shims")));
		assert.ok(dirs.includes(installDir));
		assert.ok(!dirs.includes(join(root, "Local", "mise", "shims")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSearchDirs falls back to %LOCALAPPDATA%\\mise without MISE_DATA_DIR (Windows)", () => {
	const root = join(tmpdir(), `pi-desktop-locator-mise-default-${process.pid}-${Date.now()}`);
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{ LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") },
			root,
		);
		const dirs = new PiLocator().getSearchDirs();
		assert.ok(dirs.includes(join(root, "Local", "mise", "shims")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSearchDirs scans fnm node-versions and scoop dirs on Windows", () => {
	const root = join(tmpdir(), `pi-desktop-locator-fnm-${process.pid}-${Date.now()}`);
	const fnmInstall = join(root, "Local", "fnm", "node-versions", "v22.0.0", "installation");
	mkdirSync(fnmInstall, { recursive: true });
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{ LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") },
			root,
		);
		const dirs = new PiLocator().getSearchDirs();
		assert.ok(dirs.includes(fnmInstall));
		assert.ok(dirs.includes(join(root, "scoop", "shims")));
		assert.ok(dirs.includes(join(root, "scoop", "apps", "nodejs", "current")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSearchDirs uses ~/.local/share/mise on darwin and linux", () => {
	for (const platform of ["darwin", "linux"]) {
		const root = join(tmpdir(), `pi-desktop-locator-mise-${platform}-${process.pid}-${Date.now()}`);
		try {
			const { PiLocator } = loadPiLocatorModule(platform, {}, root);
			const dirs = new PiLocator().getSearchDirs();
			assert.ok(
				dirs.includes(join(root, ".local", "share", "mise", "shims")),
				`${platform} should scan ~/.local/share/mise`,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("createProcessEnv prepends search dirs to PATH/Path without pathPrefix (npm check path)", () => {
	const root = join(tmpdir(), `pi-desktop-locator-npm-env-${process.pid}-${Date.now()}`);
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{ LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") },
			root,
		);
		const env = new PiLocator().createProcessEnv();
		// npm 检测（piCheckNpm）直接复用该 env 执行 npm --version
		// 模块可能在 Linux 宿主上模拟 win32，不断言宿主分隔符。
		assert.ok(String(env.PATH).includes(join(root, "Local", "pnpm")));
		assert.equal(env.Path, env.PATH);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── WSL 探测（nvm/fnm 等非登录 shell 场景）──────────────────────

const FNM_PI = "/home/dev/.local/share/fnm/node-versions/v24.20.0/installation/bin/pi";
const FNM_NODE_BIN = FNM_PI.slice(0, FNM_PI.lastIndexOf("/"));
const FNM_PROBE_OUTPUT = `PIDECK_PI=${FNM_PI}\nPIDECK_NODE_BIN=${FNM_NODE_BIN}\n`;

/** 探测调用的特征：-e <shell> -lic <script>，脚本里带 PIDECK_PI= 输出键。 */
function isWslProbeArgs(args) {
	return (
		Array.isArray(args) &&
		args.includes("-lic") &&
		typeof args[args.length - 1] === "string" &&
		args[args.length - 1].includes("PIDECK_PI=")
	);
}

/** 统计探测次数的 mock：TTL 用例要区分「命中缓存」与「真的又打了一次」。 */
function countingProbe(onProbe, probeOutput, version = "0.85.1") {
	const base = mockWslProbe({ probeOutput, version });
	return {
		execFile: (command, args, options, callback) => {
			if (isWslProbeArgs(args)) onProbe();
			base.execFile(command, args, options, callback);
		},
		execFileSync: () => "",
	};
}

function mockWslProbe({ probeOutput, version = "0.85.1" }) {
	return {
		execFile: (_command, args, _options, callback) => {
			if (isWslProbeArgs(args)) {
				callback(null, probeOutput, "");
				return;
			}
			callback(null, `${version}\n`, "");
		},
		execFileSync: () => "",
	};
}

test("places an explicit WSL cwd before the pi command", () => {
	const { PiLocator } = loadPiLocatorModule("win32");
	const invocation = new PiLocator().createInvocation(
		"wsl://Ubuntu-24.04/root/pi",
		["--mode", "rpc"],
		{ wslCwd: "/root/ba cli" },
	);

	assert.deepEqual(
		Array.from(invocation.args),
		["-d", "Ubuntu-24.04", "-u", "root", "--cd", "/root/ba cli", "pi", "--mode", "rpc"],
	);
	assert.equal(invocation.wsl.distro, "Ubuntu-24.04");
});

test("keeps a validated Linux custom path as the persisted WSL setting", async () => {
	const { PiLocator } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{
			"node:child_process": {
				execFile: (_command, _args, _options, callback) => callback(null, "0.80.0\n", ""),
				execFileSync: () => "",
			},
		},
	);
	const locator = new PiLocator();

	assert.equal(
		locator.resolveCommand("/opt/pi", true, "Ubuntu-24.04", "dev"),
		"wsl://Ubuntu-24.04/dev//opt/pi",
	);
	const result = await locator.validateCustomPath("/opt/pi", true, "Ubuntu-24.04", "dev");

	assert.equal(result.installed, true);
	assert.equal(result.command, "/opt/pi");
});

// ── customPiPath 失效回退 ────────────────────────────────────────────────

test("resolveCommand falls back to auto-detection when customPiPath is stale (file gone)", () => {
	const root = join(tmpdir(), `pi-desktop-locator-stale-${process.pid}-${Date.now()}`);
	const pathDir = join(root, "path-bin");
	mkdirSync(pathDir, { recursive: true });
	writeFileSync(join(pathDir, "pi.cmd"), "@echo off\r\n", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{
				// PATH 里有一个真实候选（模拟 mise/nvm 目录），customPiPath 指向已删除的旧路径
				PATH: pathDir,
				LOCALAPPDATA: join(root, "Local"),
				APPDATA: join(root, "Roaming"),
			},
			root,
		);
		const locator = new PiLocator();
		const stale = join(root, "old-version", "pi.cmd"); // 文件不存在
		const resolved = locator.resolveCommand(stale, false, undefined, undefined);
		// 必须回退到自动扫描找到的候选，而不是把失效路径原样返回
		assert.equal(resolved, join(pathDir, "pi.cmd"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveCommand keeps a valid customPiPath (still takes priority)", () => {
	const root = join(tmpdir(), `pi-desktop-locator-valid-${process.pid}-${Date.now()}`);
	const customDir = join(root, "custom");
	mkdirSync(customDir, { recursive: true });
	writeFileSync(join(customDir, "pi.cmd"), "@echo off\r\n", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { PATH: join(root, "path-bin") }, root);
		const custom = join(customDir, "pi.cmd");
		const resolved = new PiLocator().resolveCommand(custom, false, undefined, undefined);
		assert.equal(resolved, custom);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("normalizeCustomPath keeps wsl:// markers intact (not treated as local files)", () => {
	const { PiLocator } = loadPiLocatorModule("win32", { PATH: "" }, tmpdir());
	// wsl:// 是标记串而非文件路径：Windows 补全 .cmd/.exe 必须跳过它，existsSync 检查也不得误伤
	assert.equal(
		new PiLocator().normalizeCustomPath("wsl://Ubuntu-24.04/root/pi"),
		"wsl://Ubuntu-24.04/root/pi",
	);
});

test("resolveCommand falls back for unsupported .ps1 shims even when the file exists", () => {
	const root = join(tmpdir(), `pi-desktop-locator-ps1-${process.pid}-${Date.now()}`);
	const pathDir = join(root, "path-bin");
	mkdirSync(pathDir, { recursive: true });
	writeFileSync(join(pathDir, "pi.cmd"), "@echo off\r\n", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule(
			"win32",
			{ PATH: pathDir, LOCALAPPDATA: join(root, "Local"), APPDATA: join(root, "Roaming") },
			root,
		);
		const ps1 = join(root, "pi.ps1");
		writeFileSync(ps1, "# shim\n", "utf8");
		const resolved = new PiLocator().resolveCommand(ps1, false, undefined, undefined);
		assert.equal(resolved, join(pathDir, "pi.cmd"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── WSL which 不得同步卡住主进程 ─────────────────────────────────

test("resolveCommand never calls execFileSync to probe WSL which pi", () => {
	let syncCalls = 0;
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{ PATH: "", Path: "" },
		tmpdir(),
		{
			"node:child_process": {
				execFile: (_command, _args, _options, callback) => callback(null, "/usr/bin/pi\n", ""),
				execFileSync: () => {
					syncCalls += 1;
					return "";
				},
			},
		},
	);
	resetWslCommandCache();
	const resolved = new PiLocator().resolveCommand(undefined, true, "Ubuntu-24.04", "dev");
	assert.equal(syncCalls, 0);
	// 缓存未预热时不得同步 which，但仍必须保持 WSL 边界，不能回退到宿主机 pi。
	assert.equal(resolved, "wsl://Ubuntu-24.04/dev/pi");
});

test("warmWslCommand caches the absolute linux pi path reported by the probe", async () => {
	let syncCalls = 0;
	let probeCalls = 0;
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{
			"node:child_process": {
				execFile: (_command, args, _options, callback) => {
					if (isWslProbeArgs(args)) {
						probeCalls += 1;
						callback(null, FNM_PROBE_OUTPUT, "");
						return;
					}
					callback(null, "0.80.0\n", "");
				},
				execFileSync: () => {
					syncCalls += 1;
					return "";
				},
			},
		},
	);
	resetWslCommandCache();
	const locator = new PiLocator();
	const warmed = await locator.warmWslCommand("Ubuntu-24.04", "dev");
	// 缓存的必须是探测到的绝对路径，而不是裸 `pi`：启动时同样不依赖 PATH
	assert.equal(warmed, `wsl://Ubuntu-24.04/dev/${FNM_PI}`);
	assert.equal(locator.resolveCommand(undefined, true, "Ubuntu-24.04", "dev"), warmed);
	await locator.warmWslCommand("Ubuntu-24.04", "dev");
	assert.equal(probeCalls, 1, "第二次 warm 应命中缓存");
	assert.equal(syncCalls, 0, "探测不得走同步子进程");
});

test("wsl invocation execs the absolute pi path with node bin injected into PATH", async () => {
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{ "node:child_process": mockWslProbe({ probeOutput: FNM_PROBE_OUTPUT }) },
	);
	resetWslCommandCache();
	const locator = new PiLocator();
	const command = await locator.warmWslCommand("Ubuntu-24.04", "dev");
	const invocation = locator.createInvocation(command, ["--mode", "rpc"], { wslCwd: "/home/dev/my project" });

	// wsl.exe 由 resolveWslExe 定位（System32 / Sysnative / PATH 回退），这里只断言落在 wsl.exe 上
	assert.match(invocation.command, /wsl(\.exe)?$/i);
	// -e：不让 wsl.exe 把参数拼成命令行交给默认 shell 二次解析（空格/引号安全）
	const execIndex = invocation.args.indexOf("-e");
	assert.ok(execIndex > 0, "缺少 -e exec 分隔符");
	eqDeep(invocation.args.slice(execIndex, execIndex + 2), ["-e", "/usr/bin/env"]);
	assert.ok(
		invocation.args[execIndex + 2].startsWith(`PATH=${FNM_NODE_BIN}:`),
		`PATH 注入缺失：${invocation.args[execIndex + 2]}`,
	);
	eqDeep(invocation.args.slice(-3), [FNM_PI, "--mode", "rpc"]);
	eqDeep(invocation.args.slice(0, 7), [
		"-d",
		"Ubuntu-24.04",
		"-u",
		"dev",
		"--cd",
		"/home/dev/my project",
		"-e",
	]);
});

test("wsl pi check uses exactly the same exec args as the launch path", async () => {
	const captured = [];
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{
			"node:child_process": {
				execFile: (command, args, _options, callback) => {
					captured.push(args);
					if (isWslProbeArgs(args)) {
						callback(null, FNM_PROBE_OUTPUT, "");
						return;
					}
					callback(null, "0.85.1\n", "");
				},
				execFileSync: () => "",
			},
		},
	);
	resetWslCommandCache();
	const locator = new PiLocator();
	const status = await locator.check(undefined, true, "Ubuntu-24.04", "dev");

	assert.equal(status.installed, true);
	assert.equal(status.version, "0.85.1");
	// 探测后紧跟的那次 --version 校验，参数结构必须与 createInvocation 一致
	const checkArgs = captured[captured.length - 1];
	eqDeep(checkArgs, [
		"-d",
		"Ubuntu-24.04",
		"-u",
		"dev",
		"-e",
		"/usr/bin/env",
		`PATH=${FNM_NODE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
		FNM_PI,
		"--version",
	]);
	// 同一份参数也能由 createInvocation 产出：探测通过 == 可启动
	eqDeep(locator.createInvocation(`wsl://Ubuntu-24.04/dev/${FNM_PI}`, ["--version"]).args, checkArgs);
	// 诊断展示用 command 带上绝对路径，用户能直接复制到 WSL 终端验证
	assert.equal(status.command, `wsl -d Ubuntu-24.04 -u dev ${FNM_PI}`);
});

test("a windows interop probe hit is not treated as a wsl installation", async () => {
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{ "node:child_process": mockWslProbe({ probeOutput: "PIDECK_PI=/mnt/c/Users/dev/AppData/Roaming/npm/pi\n" }) },
	);
	resetWslCommandCache();
	const locator = new PiLocator();
	const warmed = await locator.warmWslCommand("Ubuntu-24.04", "dev");
	// /mnt/* 是 appendWindowsPath 带进来的宿主机 shim，不能当 WSL pi 用
	assert.equal(warmed, undefined);
	assert.equal(locator.resolveCommand(undefined, true, "Ubuntu-24.04", "dev"), "wsl://Ubuntu-24.04/dev/pi");
});

test("negative wsl probe is cached until the ttl expires", async () => {
	let probeCalls = 0;
	let now = 1_000;
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{ "node:child_process": countingProbe(() => (probeCalls += 1), "PIDECK_MISS=1\n") },
		{ Date: { now: () => now } },
	);
	resetWslCommandCache();
	const locator = new PiLocator();

	assert.equal(await locator.warmWslCommand("Ubuntu-24.04", "dev"), undefined);
	assert.equal(probeCalls, 1);
	// TTL 内重复 warm：命中负缓存，不再打 wsl.exe
	assert.equal(await locator.warmWslCommand("Ubuntu-24.04", "dev"), undefined);
	assert.equal(probeCalls, 1, "负缓存 TTL 内不得重复探测");

	// 超过负缓存 TTL：用户可能刚在 WSL 里装完 pi，必须能自动恢复
	now += 61_000;
	assert.equal(await locator.warmWslCommand("Ubuntu-24.04", "dev"), undefined);
	assert.equal(probeCalls, 2, "负缓存过期后应重新探测");
});

test("force re-probes wsl even when a positive result is cached", async () => {
	let probeCalls = 0;
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{
			"node:child_process": {
				execFile: (_command, args, _options, callback) => {
					if (isWslProbeArgs(args)) {
						probeCalls += 1;
						callback(null, FNM_PROBE_OUTPUT, "");
						return;
					}
					callback(null, "0.85.1\n", "");
				},
				execFileSync: () => "",
			},
		},
	);
	resetWslCommandCache();
	const locator = new PiLocator();
	await locator.warmWslCommand("Ubuntu-24.04", "dev");
	await locator.warmWslCommand("Ubuntu-24.04", "dev");
	assert.equal(probeCalls, 1);

	// 设置页显式重检 / 切换 distro 后保存：忽略正缓存重新探测
	await locator.warmWslCommand("Ubuntu-24.04", "dev", { force: true });
	assert.equal(probeCalls, 2);
});

test("a custom wsl pi path derives its own node bin dir instead of inheriting the probe cache", async () => {
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{ "node:child_process": mockWslProbe({ probeOutput: FNM_PROBE_OUTPUT }) },
	);
	resetWslCommandCache();
	const locator = new PiLocator();
	await locator.warmWslCommand("Ubuntu-24.04", "dev");

	// 用户手动指定了另一个 node 版本下的 pi：不得把探测缓存的 node 目录前置到 PATH
	const invocation = locator.createInvocation("wsl://Ubuntu-24.04/dev//opt/other-node/bin/pi", [
		"--version",
	]);
	const execIndex = invocation.args.indexOf("-e");
	assert.ok(invocation.args[execIndex + 2].startsWith("PATH=/opt/other-node/bin:"), invocation.args[execIndex + 2]);
});

test("checkWslInstallation reports the resolved linux path for the settings page", async () => {
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{ "node:child_process": mockWslProbe({ probeOutput: FNM_PROBE_OUTPUT }) },
	);
	resetWslCommandCache();
	const status = await new PiLocator().checkWslInstallation("Ubuntu-24.04", "dev", { force: true });
	assert.equal(status.installed, true);
	assert.equal(status.piPath, FNM_PI);
	assert.equal(status.version, "0.85.1");
});

test("checkWslInstallation reports not-installed when the probe finds nothing", async () => {
	const { PiLocator, resetWslCommandCache } = loadPiLocatorModule(
		"win32",
		{},
		tmpdir(),
		{ "node:child_process": mockWslProbe({ probeOutput: "PIDECK_MISS=1\n" }) },
	);
	resetWslCommandCache();
	const status = await new PiLocator().checkWslInstallation("Ubuntu-24.04", "dev");
	assert.equal(status.installed, false);
	assert.equal(status.piPath, undefined);
});

// ── Windows .cmd 垫片：还原成 node + JS 入口直启 ──────────────────────────
//
// 经 cmd.exe /c 启动 npm 垫片有三个硬伤（实测确认）：
//   1) 命令行上限 8191 字符（CreateProcess 的 1/4），技能白名单逐条 --skill 注入时超长起不来；
//   2) 参数里的 %VAR% 会被 cmd 展开，路径被静默改写（加双引号也挡不住）；
//   3) 子进程树多一层 cmd.exe，kill() 只杀 cmd，真正的 pi(node) 变孤儿继续跑。
// 还原 entry 后 spawn 直接按 CreateProcess 规则传参，三点同时消除。

/** 真实 npm 生成的 pi.cmd 形态（取自 @earendil-works/pi-coding-agent 的全局安装）。 */
const NPM_PI_CMD = [
	"@ECHO off",
	"GOTO start",
	":find_dp0",
	"SET dp0=%~dp0",
	"EXIT /b",
	":start",
	"SETLOCAL",
	"CALL :find_dp0",
	"",
	'IF EXIST "%dp0%\\node.exe" (',
	'  SET "_prog=%dp0%\\node.exe"',
	") ELSE (",
	'  SET "_prog=node"',
	"  SET PATHEXT=%PATHEXT:;.JS;=;%",
	")",
	"",
	// eslint-disable-next-line no-useless-concat
	'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
	"",
].join("\r\n");

/** 造一个「垫片 + 同目录 node.exe + node_modules 入口」的完整假安装。 */
function makeNpmShimInstall(shimBody = NPM_PI_CMD, entryRel = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js") {
	const root = join(tmpdir(), `pi-desktop-locator-shim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const binDir = join(root, "npm");
	mkdirSync(join(binDir, dirname(entryRel)), { recursive: true });
	const piCmd = join(binDir, "pi.cmd");
	writeFileSync(piCmd, shimBody, "utf8");
	writeFileSync(join(binDir, "node.exe"), "", "utf8");
	writeFileSync(join(binDir, entryRel), "console.log('pi')", "utf8");
	return { root, binDir, piCmd, entry: join(binDir, entryRel), nodeExe: join(binDir, "node.exe") };
}

test("Windows npm .cmd shim is launched via node + entry instead of cmd.exe", () => {
	const { root, binDir, piCmd, entry, nodeExe } = makeNpmShimInstall();
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		const invocation = new PiLocator().createInvocation(piCmd, ["--mode", "rpc"]);

		// 关键：不再经过 cmd.exe，proc.kill() 直接命中 pi 本体
		assert.ok(!/cmd\.exe$/i.test(invocation.command), `仍走了 cmd：${invocation.command}`);
		assert.equal(invocation.command, nodeExe, "应优先用与 pi 同目录的 node.exe");
		eqDeep(invocation.args, [entry, "--mode", "rpc"]);
		assert.equal(invocation.shell, false);
		// cmd 专属的引号包装必须整体消失：参数由 spawn 按 CreateProcess 规则转义
		assert.equal(invocation.windowsVerbatimArguments, undefined);
		assert.equal(invocation.pathPrefix, binDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Windows shim falls back to bare node.exe when no sibling node exists", () => {
	const { root, binDir, piCmd, entry } = makeNpmShimInstall();
	rmSync(join(binDir, "node.exe"), { force: true });
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		const invocation = new PiLocator().createInvocation(piCmd, ["--version"]);
		// 与垫片自身的 ELSE 分支一致：同目录无 node.exe 时回退到 PATH 上的 node
		assert.equal(invocation.command, "node.exe");
		eqDeep(invocation.args, [entry, "--version"]);
		assert.equal(invocation.pathPrefix, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Windows shim falls back to cmd.exe when the referenced entry is missing", () => {
	const { root, piCmd, entry } = makeNpmShimInstall();
	rmSync(entry, { force: true });
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		const invocation = new PiLocator().createInvocation(piCmd, ["--version"]);
		// 入口不存在说明垫片形态与预期不符：必须原样回到改动前的 cmd 行为，不能盲启
		assert.match(invocation.command.toLowerCase(), /cmd\.exe$/);
		assert.equal(invocation.windowsVerbatimArguments, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Windows shim falls back to cmd.exe for a hand-written wrapper", () => {
	const body = "@echo off\r\npowershell -File \"%~dp0\\pi.ps1\" %*\r\n";
	const { root, piCmd } = makeNpmShimInstall(body);
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		const invocation = new PiLocator().createInvocation(piCmd, ["--version"]);
		assert.match(invocation.command.toLowerCase(), /cmd\.exe$/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Windows shim rejects an entry pointing outside the shim directory", () => {
	// 垫片来自用户磁盘，属于不可信输入：node_modules 之外的路径必须拒绝。
	const body = '@echo off\r\nnode "%dp0%\\node_modules\\..\\..\\evil.js" %*\r\n';
	const { root, binDir, piCmd } = makeNpmShimInstall(body);
	writeFileSync(join(binDir, "..", "evil.js"), "console.log('nope')", "utf8");
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		const invocation = new PiLocator().createInvocation(piCmd, ["--version"]);
		assert.match(invocation.command.toLowerCase(), /cmd\.exe$/, "逃逸路径不得被接管");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a 30k-char skill whitelist no longer rides on a cmd command line", () => {
	const { root, piCmd } = makeNpmShimInstall();
	try {
		const { PiLocator } = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		// 复刻技能白名单注入：--no-skills + 逐条 --skill <路径>
		const args = ["--no-skills"];
		for (let i = 0; i < 300; i += 1) args.push("--skill", `C:\\skills\\skill-${i}\\SKILL.md`);
		const invocation = new PiLocator().createInvocation(piCmd, args);
		const total = invocation.args.reduce((n, a) => n + a.length + 1, 0);

		assert.ok(total > 8191, `构造的场景应超过 cmd 上限，实际 ${total}`);
		// 走 node 直启：8191 上限不再适用，且没有 windowsVerbatimArguments 的手工引号路径
		assert.equal(invocation.windowsVerbatimArguments, undefined);
		assert.equal(invocation.shell, false);
		assert.equal(invocation.args.length, args.length + 1, "JS 入口 + 原参数应完整保留");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveArgCharBudget follows the actual launch channel instead of a worst-case constant", () => {
	// 各通道的命令行上限差 4 倍，预算必须跟随实际通道。一刀切取最坏值（cmd.exe 8191）
	// 会在技能数刚过百时就关掉「禁用技能」，而 npm/pnpm 用户实际走的是 node 直启（32767）。
	const { root, binDir, piCmd, entry } = makeNpmShimInstall();
	try {
		const win = loadPiLocatorModule("win32", { APPDATA: join(root, "Roaming") }, root);
		const locator = new win.PiLocator();

		// npm .cmd 垫片会被还原成 node 直启 → 按 CreateProcess 上限给预算
		assert.equal(locator.resolveArgCharBudget(piCmd), win.CREATE_PROCESS_ARG_CHAR_BUDGET);
		assert.ok(
			win.CREATE_PROCESS_ARG_CHAR_BUDGET >= 20000,
			`node 直启预算应能容纳几百个技能，实际 ${win.CREATE_PROCESS_ARG_CHAR_BUDGET}`,
		);
		// 回归防线：预算若被改回「统一按 cmd.exe 取」，这条会失败
		assert.ok(
			win.CREATE_PROCESS_ARG_CHAR_BUDGET > win.CMD_EXE_ARG_CHAR_BUDGET * 3,
			"node 直启预算必须显著高于 cmd.exe，否则又回到一刀切误拦",
		);

		// 手写包装（垫片形态不符预期）→ 回退 cmd.exe，预算同步坍缩
		const wrapper = join(binDir, "pi-wrapper.cmd");
		writeFileSync(wrapper, "@echo off\r\npowershell -File \"%~dp0\\pi.ps1\" %*\r\n", "utf8");
		assert.equal(locator.resolveArgCharBudget(wrapper), win.CMD_EXE_ARG_CHAR_BUDGET);

		// 裸命令名（PATH 解析而非文件路径）同样落到 cmd.exe
		assert.equal(locator.resolveArgCharBudget("pi"), win.CMD_EXE_ARG_CHAR_BUDGET);

		// 直接跑 JS 源文件：由 node 启动，走 CreateProcess
		assert.equal(locator.resolveArgCharBudget(entry), win.CREATE_PROCESS_ARG_CHAR_BUDGET);

		// WSL：wsl.exe 同样由 CreateProcess 拉起，受同一上限约束
		assert.equal(
			locator.resolveArgCharBudget("wsl://Ubuntu-24.04/root/pi"),
			win.CREATE_PROCESS_ARG_CHAR_BUDGET,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	// 非 Windows 走 execve，上限是系统 ARG_MAX（Linux ≥2MB / macOS ≥1MB），实际不限制
	for (const platform of ["linux", "darwin"]) {
		const mod = loadPiLocatorModule(platform);
		assert.equal(
			new mod.PiLocator().resolveArgCharBudget("/usr/local/bin/pi"),
			mod.UNLIMITED_ARG_CHAR_BUDGET,
			`${platform} 不应受 Windows 命令行上限约束`,
		);
	}
});

