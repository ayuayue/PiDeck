import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * PiLocator.listInstallations 的行为契约。
 *
 * 背景（2026-09 用户报障）：官方安装器（install.sh / install.ps1）把 pi 装在
 * `~/.pi/agent/bin/pi` + `<agentDir>/install/releases/<ver>`，并且只把 PATH 写进
 * 当前 shell 的 rc（bash → ~/.bashrc）。PiDeck 的自动检测既没扫那个目录、登录 shell
 * 探测又是非交互的 `/bin/sh -lc`，于是「终端里 pi 好使、PiDeck 说没装」并引导用户
 * 又装了一份 npm 全局副本。这些用例锁住：官方安装必须被认出来（managed）、
 * 多份安装要全部列出来让用户选，且默认解析优先级不能被悄悄改掉。
 */

const PI_LOCATOR = "src/main/pi/PiLocator.ts";

/** 一次探测到的版本按入口路径给（默认 1.0.0）。 */
const MANAGED_MARKER = { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1", entrypoint: { type: "script", path: "" } };

/**
 * @param {object} options
 * @param {Record<string,string>} options.versions  入口路径 → `--version` 输出（可随时追加）
 * @param {string} [options.shellPi]  交互式登录 shell 里 `command -v pi` 的输出
 * @param {string[]} [options.failing] 这些入口跑 --version 直接失败（可随时追加）
 * @param {NodeJS.Platform} [options.platform]  模拟的目标平台（默认宿主）
 * @param {Record<string,string>} [options.env]  额外环境变量（如 PNPM_HOME）
 */
function createHarness(options) {
	options.versions = options.versions ?? {};
	options.failing = options.failing ?? [];
	const root = join(tmpdir(), `pideck-pi-installs-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	const home = join(root, "home");
	const userData = options.userData ?? join(root, "userData");
	mkdirSync(home, { recursive: true });
	mkdirSync(userData, { recursive: true });

	/** 每个入口的 mkdir 记录，供断言拼路径用 */
	const spawns = [];
	const execFile = (command, args, _opts, callback) => {
		spawns.push({ command, args });
		const last = String(args[args.length - 1] ?? "");
		if (last.includes("command -v pi")) {
			callback(null, options.shellPi ?? "", "");
			return;
		}
		// createInvocation 会把探测改写成启动形态：Windows 上是 cmd.exe /d /s /c "<入口> --version"
		// （或垫片还原后的 node.exe <入口> --version）；posix 直跑时 command 就是入口。
		// 从 invocation 形态还原出探测入口，versions/failing 才能继续以入口路径为键。
		let probeEntry = command;
		if (/cmd\.exe$/i.test(String(command)) && args.includes("/c")) {
			probeEntry = last.replace(/\s*--version\s*$/, "").replace(/^"|"$/g, "");
		} else if (/node(\.exe)?$/i.test(String(command)) && args[args.length - 1] === "--version") {
			probeEntry = args[0];
		}
		const version = options.versions?.[probeEntry] ?? "1.0.0";
		if (options.failing?.includes(probeEntry)) {
			callback(Object.assign(new Error("boom"), { code: "ENOENT" }), "", "no such file");
			return;
		}
		callback(null, version, "");
	};

	const load = createTsSandbox({
		stubs: {
			electron: { app: { getPath: (name) => (name === "home" ? home : name === "userData" ? userData : join(root, name)) } },
			"node:child_process": { execFile },
		},
		globals: {
			process: { platform: options.platform ?? process.platform, env: { PATH: "", SHELL: "/bin/bash", ...(options.env ?? {}) } },
		},
	});

	const locatorModule = load(PI_LOCATOR);
	return { root, home, userData, spawns, options, locatorModule, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 写一个"能执行"的 pi 入口（内容无关，探测被 stub 掉）。 */
function writeEntry(path) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\n", "utf8");
	return path;
}

/**
 * 登录 shell 反查用例在 Windows 宿主上也要能跑：probeLoginShellPi 只接受以 / 开头
 * 且 existsSync 的路径（posix 假设）。把宿主路径转成无盘符正斜杠形式
 * （C:\a\b → /a/b，Node 在 Windows 上解析回当前盘同路径），两者都满足。
 */
function toPosixProbePath(path) {
	return path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
}

// 探测文件所在目录必须与 process.cwd() 同盘：/x/y 形式在 Windows 上解析回「当前盘」的同路径，
// CI runner 的 cwd（D:\a\...）与 %TEMP%（C:\...）不同盘时，落在 C: 的临时文件永远「不存在」。
// node_modules 在 .gitignore 内且必然存在，适合放这种同盘探针。
function posixProbeTempDir(tag) {
	return join(process.cwd(), "node_modules", `.tmp-pi-probe-${tag}-${process.pid}-${Date.now()}`);
}

function writeManagedInstall(home, version = "1.2.3") {
	const agentDir = join(home, ".pi", "agent");
	writeEntry(join(agentDir, "bin", "pi"));
	mkdirSync(join(agentDir, "install"), { recursive: true });
	writeFileSync(join(agentDir, "install", "managed-install.json"), JSON.stringify(MANAGED_MARKER), "utf8");
	writeFileSync(join(agentDir, "install", "current-version"), `${version}\n`, "utf8");
	return join(agentDir, "bin", "pi");
}

test("searchDirs 包含官方安装器落点 ~/.pi/agent/bin（macOS/Linux 与 Windows 对称）", () => {
	const harness = createHarness({});
	try {
		const { PiLocator } = harness.locatorModule;
		const dirs = new PiLocator().getSearchDirs();
		assert.ok(dirs.includes(join(harness.home, ".pi", "agent", "bin")), `getSearchDirs 漏了官方安装目录：${dirs.join(", ")}`);
	} finally {
		harness.cleanup();
	}
});

test("官方安装被标为 managed，包管理器全局那份被标为 package-manager，当前使用项唯一", async () => {
	const harness = createHarness({});
	try {
		const managed = writeManagedInstall(harness.home);
		const nvm = writeEntry(join(harness.home, ".nvm", "versions", "node", "v24.0.0", "bin", "pi"));
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "");

		assert.equal(installations.length, 2);
		const byPath = new Map(installations.map((item) => [item.path, item]));
		assert.equal(byPath.get(managed)?.source, "managed");
		assert.equal(byPath.get(managed)?.managedRoot, join(harness.home, ".pi", "agent", "install"));
		assert.equal(byPath.get(nvm)?.source, "package-manager");
		// 默认解析优先级不变：env PATH 为空时，nvm 目录仍在 ~/.pi/agent/bin 之前
		assert.equal(installations.filter((item) => item.isActive).length, 1);
		assert.equal(byPath.get(nvm)?.isActive, true);
	} finally {
		harness.cleanup();
	}
});

test("入口是 ~/.local/bin 里指向官方启动器的软链时，只列一条且归为 managed", async (t) => {
	const harness = createHarness({});
	try {
		const managed = writeManagedInstall(harness.home);
		const linkDir = join(harness.home, ".local", "bin");
		mkdirSync(linkDir, { recursive: true });
		const link = join(linkDir, "pi");
		try {
			symlinkSync(managed, link);
		} catch (error) {
			// Windows 未开开发者模式/非管理员时创建符号链接被系统拒绝（EPERM）——
			// 环境限制而非行为回归，跳过；有权限的环境上仍然锁住软链去重语义。
			if (process.platform === "win32" && error.code === "EPERM") {
				t.skip("Windows 符号链接权限不足（EPERM）");
				return;
			}
			throw error;
		}

		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "");

		assert.equal(installations.length, 1, `软链入口与启动器是同一份安装，必须去重：${installations.map((item) => item.path).join(", ")}`);
		assert.equal(installations[0].source, "managed");
		assert.equal(installations[0].realPath, managed);
	} finally {
		harness.cleanup();
	}
});

test("标记文件缺失或字段不符时不算 managed 安装", async () => {
	const harness = createHarness({});
	try {
		const agentDir = join(harness.home, ".pi", "agent");
		writeEntry(join(agentDir, "bin", "pi"));
		mkdirSync(join(agentDir, "install"), { recursive: true });
		writeFileSync(join(agentDir, "install", "managed-install.json"), JSON.stringify({ kind: "something-else" }), "utf8");

		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "");

		assert.equal(installations.length, 1);
		assert.equal(installations[0].source, "path", "标记不合法时不能宣称是官方安装");
		assert.equal(installations[0].managedRoot, undefined);
	} finally {
		harness.cleanup();
	}
});

test("版本探测失败的安装仍然列出来并带上原因（不让它从列表里消失）", async () => {
	const harness = createHarness({ shellPi: "" });
	try {
		const broken = writeEntry(join(harness.home, ".npm-global", "bin", "pi"));
		harness.options.failing.push(broken);
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "", { forceShellProbe: true });

		assert.equal(installations.length, 1);
		assert.equal(installations[0].path, broken);
		assert.equal(installations[0].version, undefined);
		assert.ok(installations[0].versionError, "跑不起来的入口必须带上原因");
	} finally {
		harness.cleanup();
	}
});

test("版本更高的那份被标 isNewest；同版本时都不标", async () => {
	const harness = createHarness({ shellPi: "" });
	try {
		const managed = writeManagedInstall(harness.home);
		const nvm = writeEntry(join(harness.home, ".nvm", "versions", "node", "v24.0.0", "bin", "pi"));
		harness.options.versions[managed] = "2.0.0";
		harness.options.versions[nvm] = "1.0.0";

		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "", { forceShellProbe: true });
		assert.equal(installations.find((item) => item.path === managed)?.isNewest, true);
		assert.equal(installations.find((item) => item.path === nvm)?.isNewest, undefined);

		// 同版本时不标「更新」：另起一份 harness，两个入口都返回默认 1.0.0
		const even = createHarness({ shellPi: "" });
		try {
			const managedEven = writeManagedInstall(even.home);
			const nvmEven = writeEntry(join(even.home, ".nvm", "versions", "node", "v24.0.0", "bin", "pi"));
			const module = even.locatorModule;
			const list = await new module.PiLocator().listInstallations("", false, "", "", { forceShellProbe: true });
			assert.equal(list.length, 2);
			assert.equal(list.find((item) => item.path === managedEven)?.isNewest, undefined);
			assert.equal(list.find((item) => item.path === nvmEven)?.isNewest, undefined);
		} finally {
			even.cleanup();
		}
	} finally {
		harness.cleanup();
	}
});

test("目录扫描已命中时不启动交互式 shell；一份都没扫到才跑一次兜底反查", async () => {
	// 登录 shell 探测是 posix 语义（读 rc 文件；Windows 合并环境不走 rc，生产代码直接短路），
	// 且候选 shell 要真实存在（existsSync 过滤）——用宿主 node 可执行文件充当 $SHELL。
	const withScan = createHarness({ platform: "linux", env: { SHELL: process.execPath }, shellPi: "/tmp/should-not-be-asked\n" });
	try {
		writeEntry(join(withScan.home, ".npm-global", "bin", "pi"));
		const { PiLocator } = withScan.locatorModule;
		await new PiLocator().listInstallations("", false, "", "");
		const shellCalls = withScan.spawns.filter((call) => String(call.args[call.args.length - 1]).includes("command -v pi"));
		assert.equal(shellCalls.length, 0, "扫描已经命中时不应为一次常规检测去加载用户 rc");
	} finally {
		withScan.cleanup();
	}

	const empty = createHarness({ platform: "linux", env: { SHELL: process.execPath }, shellPi: "" });
	try {
		const { PiLocator } = empty.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "");
		const shellCalls = empty.spawns.filter((call) => String(call.args[call.args.length - 1]).includes("command -v pi"));
		// 没扫到任何 pi 时必须兜底问 shell；不同 shell 会依次尝试（该机器上 bash/sh 都存在），
		// 这里只锁定「真的问了」，具体尝试几个 shell 由 loginShellCandidates 决定。
		assert.ok(shellCalls.length >= 1, "扫描不到任何 pi 时必须兜底问一次登录 shell");
		assert.deepEqual(JSON.parse(JSON.stringify(installations)), []);
	} finally {
		empty.cleanup();
	}

	// 第一个 shell 就能报出路径时必须立即停下（不把每个 shell 都跑一遍）
	const shellDir = posixProbeTempDir("shell");
	// 探测输出用 posix 形式（probeLoginShellPi 只认 / 开头）；#318 起返回值会过
	// safeRealpath（防 fnm 会话级软链失效），Windows 宿主上归一成本盘原生绝对路径。
	// 隔离 worktree 的 node_modules 可能是 junction，断言同样按真实文件路径比较。
	const shellPi = toPosixProbePath(writeEntry(join(shellDir, "pi")));
	const shellPiNative = realpathSync(join(shellDir, "pi"));
	const fallback = createHarness({ platform: "linux", env: { SHELL: process.execPath }, shellPi: `${shellPi}\n` });
	try {
		const { PiLocator } = fallback.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "");
		const shellCalls = fallback.spawns.filter((call) => String(call.args[call.args.length - 1]).includes("command -v pi"));
		assert.equal(shellCalls.length, 1, "第一个 shell 报出路径后不应继续尝试其它 shell");
		assert.equal(installations[0]?.path, shellPiNative);
	} finally {
		fallback.cleanup();
		rmSync(shellDir, { recursive: true, force: true });
	}
});

test("交互式登录 shell 解析出的 pi 会补进列表并标 shellDefault（即使在扫描目录之外）", async () => {
	const customDir = posixProbeTempDir("custom");
	// 同上：登录 shell 反查只在 posix 语义下发生，测试需显式指定平台与可用的 $SHELL；
	// 探测输出用 posix 形式（probeLoginShellPi 只认 / 开头且存在的路径）；#318 起返回值
	// 过 safeRealpath 归一到本机真实绝对路径，断言也解析 junction/软链后的真实落点。
	const customPi = toPosixProbePath(writeEntry(join(customDir, "pi")));
	const customPiNative = realpathSync(join(customDir, "pi"));
	const harness = createHarness({ platform: "linux", env: { SHELL: process.execPath }, shellPi: `${customPi}\n` });
	try {
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "", { forceShellProbe: true });

		const fromShell = installations.find((item) => item.path === customPiNative);
		assert.ok(fromShell, `登录 shell 反查到的 pi 必须出现在列表里：${installations.map((item) => item.path).join(", ")}`);
		assert.equal(fromShell.shellDefault, true);
	} finally {
		harness.cleanup();
		rmSync(customDir, { recursive: true, force: true });
	}
});

test("官方推荐的各安装方式落点都在扫描目录里（curl/powershell、npm、pnpm、yarn、bun）", () => {
	const harness = createHarness({ env: { PNPM_HOME: "/opt/pnpm-home", APPDATA: "/opt/appdata", LOCALAPPDATA: "/opt/localappdata" } });
	try {
		const { PiLocator } = harness.locatorModule;
		const dirs = new PiLocator().getSearchDirs();
		const home = harness.home;

		// curl / powershell 安装器 → managed：启动器在 <agentDir>/bin，实体在 <agentDir>/install
		assert.ok(dirs.includes(join(home, ".pi", "agent", "bin")), "官方安装器的启动器目录必须被扫描");
		// npm -g → 平台 npm 全局 bin
		assert.ok(dirs.includes(join("/opt/appdata", "npm")), "npm 全局目录必须被扫描");
		// pnpm add -g → PNPM_HOME（未设时是平台默认目录）
		assert.ok(dirs.includes("/opt/pnpm-home"), "PNPM_HOME 必须被扫描");
		assert.ok(dirs.includes(join("/opt/localappdata", "pnpm")), "pnpm 平台默认目录必须被扫描");
		// yarn global → classic 的 bin 目录
		assert.ok(dirs.includes(join(home, ".yarn", "bin")), "yarn 全局 bin 必须被扫描");
		assert.ok(dirs.includes(join(home, ".config", "yarn", "global", "bin")), "yarn 全局 npm 目录必须被扫描");
		// bun add -g
		assert.ok(dirs.includes(join(home, ".bun", "bin")), "bun 全局 bin 必须被扫描");
	} finally {
		harness.cleanup();
	}
});

test("用户自己指定的路径不在扫描目录里时也进列表，来源标 custom 且是当前使用项", async () => {
	const customDir = join(tmpdir(), `pideck-pi-custom-pick-${process.pid}-${Date.now()}`);
	const customPi = writeEntry(join(customDir, "pi"));
	const harness = createHarness({ shellPi: "" });
	try {
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations(customPi, false, "", "");

		assert.equal(installations.length, 1, `自定义路径必须出现在列表里：${installations.map((item) => item.path).join(", ")}`);
		assert.equal(installations[0].path, customPi);
		assert.equal(installations[0].source, "custom");
		assert.equal(installations[0].isActive, true);
	} finally {
		harness.cleanup();
		rmSync(customDir, { recursive: true, force: true });
	}
});

test("自定义路径同时落在已知目录里时按目录归类（不误标成 custom）", async () => {
	const harness = createHarness({ shellPi: "" });
	try {
		const managed = writeManagedInstall(harness.home);
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations(managed, false, "", "");

		assert.equal(installations.length, 1, "自定义路径与扫描结果重合时不能重复列出");
		assert.equal(installations[0].source, "managed");
	} finally {
		harness.cleanup();
	}
});

test("PiDeck 引导安装的便携 pi/node 目录能被扫到（POSIX 带 bin 层）", () => {
	// 回归（2026-09-30）：引导装完 pi 后 PiDeck 自己看不到它（少一层 bin/），
	// 表现为「点重新检测还是没装 -> 又引导你再装一遍」。
	const harness = createHarness({ shellPi: "" });
	try {
		const { PiLocator } = harness.locatorModule;
		const dirs = new PiLocator().getSearchDirs();
		const userData = harness.userData;
		const segments = process.platform === "win32" ? ["pi-runtime", "pi-global"] : ["pi-runtime", "pi-global", "bin"];
		assert.ok(dirs.includes(join(userData, ...segments)), `便携 pi 入口目录必须被扫描：${dirs.filter((d) => d.includes("pi-runtime")).join(", ")}`);
		const nodeSegments = process.platform === "win32" ? ["pi-runtime", "node"] : ["pi-runtime", "node", "bin"];
		assert.ok(dirs.includes(join(userData, ...nodeSegments)), "便携 node 目录必须进 PATH 前缀（pi 的 shim 靠 env node 拉起）");
	} finally {
		harness.cleanup();
	}
});

test("引导安装的便携 pi 会作为 portable 来源出现在列表里且可被选中", async () => {
	const harness = createHarness({ shellPi: "" });
	try {
		const binDir = process.platform === "win32" ? join(harness.userData, "pi-runtime", "pi-global") : join(harness.userData, "pi-runtime", "pi-global", "bin");
		const portablePi = writeEntry(join(binDir, process.platform === "win32" ? "pi.cmd" : "pi"));
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "");
		const found = installations.find((item) => item.path === portablePi);
		assert.ok(found, `便携 pi 应出现在候选列表：${installations.map((item) => item.path).join(", ")}`);
		assert.equal(found.source, "portable");
	} finally {
		harness.cleanup();
	}
});

test("用户添加的路径进列表并标 userAdded；不存在的路径也保留（missing）", async () => {
	const customDir = join(tmpdir(), `pideck-pi-missing-${process.pid}-${Date.now()}`);
	const present = writeEntry(join(customDir, "pi"));
	const gone = join(customDir, "removed", "pi");
	const harness = createHarness({ shellPi: "" });
	try {
		// 不存在的路径在真实环境下探测必然失败，让桩也这样回答：
		harness.options.failing.push(gone);
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "", { customPaths: [present, gone] });
		const byPath = new Map(installations.map((item) => [item.path, item]));

		assert.equal(byPath.get(present)?.userAdded, true, "添加的路径必须带“我添加的”标记");
		assert.equal(byPath.get(present)?.missing, undefined);
		// 关键：文件没了也不能静默消失，否则用户看不到那行、无法修也不能删
		assert.ok(byPath.has(gone), `不存在的自定义路径也要列出来：${installations.map((item) => item.path).join(", ")}`);
		assert.equal(byPath.get(gone)?.missing, true);
		assert.equal(byPath.get(gone)?.userAdded, true);
		assert.equal(byPath.get(gone)?.version, undefined);
		assert.ok(byPath.get(gone)?.versionError, "不存在的路径要带上探测失败原因，而不是显示一个假版本号");
	} finally {
		harness.cleanup();
		rmSync(customDir, { recursive: true, force: true });
	}
});

test("同一份安装既在扫描目录里又是用户添加时，只占一行且带 userAdded", async () => {
	const harness = createHarness({ shellPi: "" });
	try {
		const managed = writeManagedInstall(harness.home);
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", false, "", "", { customPaths: [managed] });

		assert.equal(installations.length, 1, "同一份安装不能既算自动发现又算自定义而出现两行");
		assert.equal(installations[0].source, "managed");
		assert.equal(installations[0].userAdded, true);
	} finally {
		harness.cleanup();
	}
});

test("WSL 模式不返回宿主候选（改由设置页 WSL 分区管理）", async () => {
	// WSL 只存在于 Windows：用 win32 沙箱跑，否则这条用例在 Linux 开发机上验不到那个早返回
	const harness = createHarness({ platform: "win32" });
	try {
		writeManagedInstall(harness.home);
		const { PiLocator } = harness.locatorModule;
		const installations = await new PiLocator().listInstallations("", true, "Ubuntu", "root");
		assert.deepEqual(JSON.parse(JSON.stringify(installations)), []);
	} finally {
		harness.cleanup();
	}
});

test("列表结果短时间缓存；forceShellProbe 绕过缓存重新探测", async () => {
	const harness = createHarness({ shellPi: "" });
	try {
		writeManagedInstall(harness.home);
		const { PiLocator } = harness.locatorModule;
		const locator = new PiLocator();

		await locator.listInstallations("", false, "", "");
		const afterFirst = harness.spawns.length;
		await locator.listInstallations("", false, "", "");
		assert.equal(harness.spawns.length, afterFirst, "TTL 内不应重复 spawn 版本探测");

		await locator.listInstallations("", false, "", "", { forceShellProbe: true });
		assert.ok(harness.spawns.length > afterFirst, "forceShellProbe 必须绕开缓存");
	} finally {
		harness.cleanup();
	}
});
