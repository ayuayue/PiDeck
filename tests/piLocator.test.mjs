import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadPiLocatorModule(platform = process.platform, envOverrides = {}, homePath = tmpdir(), moduleOverrides = {}) {
	const source = readFileSync("src/main/pi/PiLocator.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
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
			return require(id);
		},
	};
	sandbox.global = sandbox;
	// 宿主开发机可能已设置 MISE_DATA_DIR 等变量（如 D:\mise-data），
	// 未显式覆盖时剔除，保证每个用例从“干净环境”出发验证默认路径逻辑。
	if (!("MISE_DATA_DIR" in envOverrides)) delete sandbox.process.env.MISE_DATA_DIR;
	if (!("MISE_INSTALL_PATH" in envOverrides)) delete sandbox.process.env.MISE_INSTALL_PATH;
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
		// The module is executed in a Linux test process while simulating win32;
		// assert the injected directory without depending on the host path delimiter.
		assert.ok(String(env.PATH).includes(join(root, "Local", "pnpm")));
		assert.equal(env.Path, env.PATH);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

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
