#!/usr/bin/env node
/**
 * Windows 真机 smoke：pi 启动 / 自更新链路的 Windows 形态端到端验证（人工触发，不进 node --test）。
 *
 * 为什么需要它（2026-10 复审遗留项）：bun / WSL 更新通道的修复（65764d3ed 代跑 bun、473a71094
 * bun 本体探测、b5d2a138d 自定义 BUN_INSTALL 细化）此前只有 Linux 侧真 bun 与单测夹具证据，
 * 这几件事必须真 Windows 才能证伪：
 *   1) pi.exe shim：bun 在 Windows 把全局 shim 落成 `<root>\bin\pi.exe`（POSIX 是 pi 软链），原生 exe 走 `cmd.exe /d /s /c`（windowsVerbatimArguments）而不是 node 直启；
 *   2) 自定义 BUN_INSTALL：GUI 启动读不到 shell rc，必须把安装根传给 bun，否则装进默认 `~/.bun`、选中的安装原地不动（用户报「更新完版本没变」的根因）；
 *   3) cmd 包裹：含空格 / 引号 / `&` 的参数经 cmd.exe 后必须原样到达目标程序；
 *   4) UNC：`\\wsl.localhost\...` 不得被当成本地安装（宿主包管理器不能去装发行版里的 pi）；
 *   5) portable-prefix：旧引导前缀副本在 Windows 必须带 `--prefix` 代跑 npm（pi 自身不推断 Windows 前缀）。
 *
 * 隔离：全部在 `os.tmpdir()/pideck win smoke` 内完成（路径刻意带空格，顺带验证引号路径）；不写系统目录、不动 `~/.bun`、不更新 WSL 里的 pi（只跑 `--version` 读版本）。
 *
 * 用法（`node scripts/smoke-pi-windows-launch.mjs`；`--clean` 先清空临时根重新下载装包，第二次起复用临时根与 bun 缓存）：
 *   PIDECK_SMOKE_BUN=C:\path\bun.exe node scripts/smoke-pi-windows-launch.mjs  # 指定已有 bun，跳过下载
 */
import assert from "node:assert/strict";
import { execFile as nodeExecFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

const SCRATCH = win32.join(tmpdir(), "pideck win smoke");
const CACHE = win32.join(tmpdir(), "pideck-win-smoke-cache");
const BUN_VERSION = "1.4.3";
const BUN_ZIP_URL = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip`;
/** 旧版：小于当前 pi.dev 最新版，才能走「有更新 → 代跑 → 版本核验」的正路。 */
const OLD_PI_VERSION = "1.1.0";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_LATEST_URL = "https://pi.dev/api/latest-version";
const SYSTEM_ROOT = process.env.SystemRoot || "C:/Windows";
const TAR = win32.join(SYSTEM_ROOT, "System32", "tar.exe");
const CURL = win32.join(SYSTEM_ROOT, "System32", "curl.exe");
const WSL = win32.join(SYSTEM_ROOT, "System32", "wsl.exe");
const BS = String.fromCharCode(92);

const results = [];
const log = (line = "") => console.log(line);
function record(name, ok, detail) {
	results.push({ name, ok, detail });
	log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
async function step(name, fn) {
	try {
		const detail = await fn();
		record(name, true, detail);
		return true;
	} catch (error) {
		record(name, false, error instanceof Error ? error.message : String(error));
		return false;
	}
}

function execFileAsync(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		nodeExecFile(command, args, { windowsHide: true, timeout: 600_000, ...options }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stdout}\n${stderr}`.trim()));
				return;
			}
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** 生产 invocation 的真实执行：PiProcess / PiLocator 走的就是这三个字段。 */
async function runInvocation(invocation, timeoutMs = 120_000) {
	return execFileAsync(invocation.command, invocation.args, {
		env: { ...process.env },
		shell: invocation.shell,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		encoding: "utf8",
		timeout: timeoutMs,
	});
}

function loadProduction(records) {
	const stubs = {
		electron: { app: { getPath: (name) => (name === "home" ? homedir() : win32.join(homedir(), "AppData", "Roaming", "PiDeck")) } },
		// PiSelfUpdateRunner 依赖：spawn 装配与日志留在管理器侧，smoke 只需桩掉。
		"./PiProcess": { PiProcess: { invalidateVersionCache: () => {} } },
		"../logging/sharedLogger": { getAppLogger: () => null },
		"node:child_process": {
			// 记录真实 argv/env（BUN_INSTALL 断言与证据输出都靠它），再交给真 execFile。
			execFile: (command, args, options, callback) => {
				records.push({ command, args: Array.from(args), env: options?.env ? { BUN_INSTALL: options.env.BUN_INSTALL } : undefined });
				return nodeExecFile(command, args, options, callback);
			},
		},
	};
	return {
		PiLocator: loadTsCommonJs("src/main/pi/PiLocator.ts", { stubs }).PiLocator,
		PiSelfUpdateRunner: loadTsCommonJs("src/main/pi/piSelfUpdateRunner.ts", { stubs }).PiSelfUpdateRunner,
		...loadTsCommonJs("src/main/pi/piSelfUpdateChannel.ts"),
	};
}

/** Windows 自带的解压/下载工具；缺失就直接报错，不做隐式回退。 */
function extractZip(zip, destination) {
	mkdirSync(destination, { recursive: true });
	const result = spawnSync(TAR, ["-xf", zip, "-C", destination], { encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error(`tar 解压失败：${result.stderr || result.error?.message}`);
}
function download(url, file) {
	mkdirSync(win32.dirname(file), { recursive: true });
	for (let attempt = 1; attempt <= 3; attempt++) {
		const result = spawnSync(CURL, ["-sSL", "--max-time", "600", "-o", file, url], { encoding: "utf8", windowsHide: true });
		if (result.status === 0 && existsSync(file)) return;
		rmSync(file, { force: true });
		if (attempt === 3) throw new Error(`下载失败：${url}（${result.stderr || result.error?.message}）`);
		log(`  下载第 ${attempt}/3 次失败，重试：${result.stderr || result.error?.message}`);
	}
}

/** 取 JSON：真机网络偶发 TLS 中断（schannel close_notify），重试三次再判失败。 */
async function fetchJsonWithRetry(url, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const { stdout } = await execFileAsync(CURL, ["-sS", "--max-time", "30", url], { encoding: "utf8" });
			return JSON.parse(stdout);
		} catch (error) {
			lastError = error;
			if (attempt < attempts) {
				log(`  取 ${url} 第 ${attempt}/${attempts} 次失败，${attempt * 2}s 后重试`);
				await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
			}
		}
	}
	throw lastError;
}

async function readPiVersion(piPath, env) {
	const result = await execFileAsync(piPath, ["--version"], { encoding: "utf8", env: { ...process.env, ...env } });
	return result.stdout.trim();
}

/** 全局包版本：bun 自定义根在 `<root>\install\global\node_modules`，npm 前缀副本在 `<prefix>\node_modules`。 */
function readPackageVersion(prefixDir) {
	for (const base of [prefixDir, win32.join(prefixDir, "install", "global")]) {
		try {
			return JSON.parse(readFileSync(win32.join(base, "node_modules", ...PI_PACKAGE.split("/"), "package.json"), "utf8")).version;
		} catch {
			// 换下一种布局
		}
	}
	return undefined;
}

/** `~/.bun` 快照：BUN_INSTALL 传错时 bun 会在这里落一份，快照必须前后一致。 */
function snapshotDotBun() {
	const dir = win32.join(homedir(), ".bun");
	if (!existsSync(dir)) return { exists: false, entries: [] };
	return { exists: true, entries: readdirSync(dir).sort() };
}

function assertSameDotBun(before, label) {
	const after = snapshotDotBun();
	assert.equal(after.exists, before.exists, `${label}：~/.bun 存在性被改变（BUN_INSTALL 没传给子进程？）`);
	assert.deepEqual(after.entries, before.entries, `${label}：~/.bun 内容被改变（bun 装进了默认根）`);
}

/** `where` 找一个可被 CreateProcess 直接启动的路径（.cmd/.exe），供 setup 阶段调 npm。 */
function findExecutable(name) {
	const lines = (spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true }).stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.find((line) => /\.(cmd|exe)$/i.test(line)) ?? lines[0];
}

/** 更新执行器：真 locator + 真网络版本检查（裸 Node 没有 Electron net.fetch，用系统 curl 取同一个接口）。 */
function createUpdateRunner(prod, locator, customPiPath) {
	const settings = { customPiPath, wslEnabled: false, wslDistro: "", wslUser: "" };
	const runner = new prod.PiSelfUpdateRunner({
		locator,
		getSettings: () => settings,
		translate: (key, params) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}`,
		sanitizeCommandOutput: (value) => value,
		runPi: async () => {
			throw new Error("代跑通道不应调用 runPi（pi update --self）");
		},
		resetVersionProbeCache: () => {},
		homeDir: () => homedir(),
	});
	runner.fetchLatestVersion = async () => {
		const payload = await fetchJsonWithRetry(PI_LATEST_URL);
		assert.ok(payload.version, `pi.dev 未返回版本：${JSON.stringify(payload)}`);
		return { version: String(payload.version), ...(payload.packageName ? { packageName: String(payload.packageName) } : {}) };
	};
	return runner;
}

// ─── A. cmd 包裹：node 直启 / cmd.exe 回退 / 参数 verbatim ─────────────────────

function findNpmPiShim() {
	const fromWhere = spawnSync("where.exe", ["pi"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
	const candidates = [...fromWhere.split(/\r?\n/).filter((line) => line.trim()), win32.join(process.env.APPDATA ?? win32.join(homedir(), "AppData", "Roaming"), "npm", "pi.cmd"), win32.join("D:", "nodejs", "npm-global", "pi.cmd")];
	return candidates.find((candidate) => /\.cmd$/i.test(candidate) && existsSync(candidate));
}

const TRICKY_ARGS = ["--provider", "a b c", 'a"b', "m&calc", "中文 供应商", "x(y)z", "sem;icolon", "a=b", "foo[bar]", "bang!", "caret^"];

async function smokeCommandWrapping(prod) {
	const locator = new prod.PiLocator((key) => key);

	const npmPi = findNpmPiShim();
	if (!npmPi) {
		log("SKIP  npm pi.cmd（本机没有 npm 全局安装的 pi；node-direct 通道未覆盖）");
	} else {
		await step("npm pi.cmd 走 node-direct（不经 cmd.exe）并真跑 --version", async () => {
			const invocation = locator.createInvocation(npmPi, ["--version"]);
			assert.equal(invocation.windowsLaunch?.channel, "node-direct", `期望 node-direct，实际 ${invocation.windowsLaunch?.channel}`);
			assert.match(invocation.command.toLowerCase(), /node\.exe$/);
			assert.ok(invocation.windowsLaunch.entry?.endsWith(".js"), "直启入口应是 JS 文件");
			assert.equal(locator.resolveArgCharBudget(npmPi), 26000, "node 直启走 CreateProcess 上限");
			const { stdout } = await runInvocation(invocation, 30_000);
			assert.match(stdout.trim(), /^\d+\.\d+\.\d+/, `pi.cmd --version 输出异常：${JSON.stringify(stdout)}`);
			return `${npmPi} → ${stdout.trim()}`;
		});
	}

	// 非 npm 结构的 .cmd 一定会落到 cmd.exe 回退：用它验证引号与 verbatim 参数传递。
	const wrapDir = win32.join(SCRATCH, "cmd wrap");
	mkdirSync(wrapDir, { recursive: true });
	writeFileSync(win32.join(wrapDir, "argv-dump.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
	writeFileSync(win32.join(wrapDir, "wrapper.cmd"), '@echo off\r\nnode "%~dp0argv-dump.js" %*\r\n', "utf8");
	const wrapper = win32.join(wrapDir, "wrapper.cmd");

	await step("非 npm .cmd 回退 cmd.exe 通道，含空格/引号/& 的参数原样到达", async () => {
		const invocation = locator.createInvocation(wrapper, TRICKY_ARGS);
		assert.equal(invocation.windowsLaunch?.channel, "cmd-shim");
		assert.equal(invocation.windowsVerbatimArguments, true, "cmd 命令行必须禁止 Node 二次转义");
		assert.equal(invocation.shell, false);
		assert.match(invocation.command.toLowerCase(), /cmd\.exe$/);
		assert.equal(locator.resolveArgCharBudget(wrapper), 5000, "cmd.exe /c 命令行上限 8191，预算取 5000");
		const { stdout } = await runInvocation(invocation, 30_000);
		assert.deepEqual(JSON.parse(stdout), TRICKY_ARGS, `参数未原样到达：${stdout}`);
		return `${TRICKY_ARGS.length} 个参数完全一致`;
	});
}

// ─── B. pi.exe shim + 自定义 BUN_INSTALL 端到端 ───────────────────────────────

async function ensureBun(bunOverride) {
	const derived = win32.join(SCRATCH, "bin", "bun.exe");
	if (bunOverride) return bunOverride;
	if (existsSync(derived)) return derived;
	const zip = win32.join(CACHE, `bun-v${BUN_VERSION}-windows-x64.zip`);
	if (!existsSync(zip)) {
		log(`  下载 bun ${BUN_VERSION}（约 43MB）→ ${zip}`);
		download(BUN_ZIP_URL, zip);
	}
	const unpacked = win32.join(CACHE, "unpacked");
	const unpackedBun = win32.join(unpacked, "bun-windows-x64", "bun.exe");
	if (!existsSync(unpackedBun)) extractZip(zip, unpacked);
	mkdirSync(win32.dirname(derived), { recursive: true });
	copyFileSync(unpackedBun, derived);
	rmSync(unpacked, { recursive: true, force: true });
	return derived;
}

async function smokeCustomBunInstall(prod, bunOverride) {
	const root = SCRATCH;
	const bun = await ensureBun(bunOverride);
	const env = { BUN_INSTALL: root };
	const piExe = win32.join(root, "bin", "pi.exe");

	await step(`bun ${BUN_VERSION} 就位（<root>\\bin\\bun.exe）`, async () => {
		const { stdout } = await execFileAsync(bun, ["--version"], { encoding: "utf8", env: { ...process.env, ...env } });
		assert.equal(stdout.trim(), BUN_VERSION);
		return bun;
	});

	await step(`自定义 BUN_INSTALL 装出 pi.exe + 全局包目录（pi@${OLD_PI_VERSION}）`, async () => {
		const current = existsSync(piExe) ? await readPiVersion(piExe, env) : undefined;
		if (current !== OLD_PI_VERSION) {
			if (current) log(`  现有 pi.exe 是 ${current}，重装 ${OLD_PI_VERSION} 以走更新正路（约 1–2 分钟）`);
			await execFileAsync(bun, ["add", "-g", "--ignore-scripts", `${PI_PACKAGE}@${OLD_PI_VERSION}`], { encoding: "utf8", env: { ...process.env, ...env } });
		}
		assert.ok(existsSync(piExe), `<root>\\bin\\pi.exe 未生成`);
		assert.equal(readPackageVersion(root), OLD_PI_VERSION, "全局包目录里的版本不对");
		return `${root}${BS}bin${BS}pi.exe`;
	});

	await step("PiLocator.normalizeCustomPath：无扩展名路径补成 pi.exe 并真跑 check", async () => {
		const locator = new prod.PiLocator((key) => key);
		assert.equal(locator.normalizeCustomPath(win32.join(root, "bin", "pi")), piExe);
		const status = await locator.check(piExe, false, "", "");
		assert.equal(status.installed, true, `check 失败：${status.error}`);
		assert.equal(status.version, OLD_PI_VERSION);
		return `pi.exe --version → ${status.version}`;
	});

	await step("通道：<root>\\bin\\pi.exe 先归 pi-self，再由磁盘布局细化为 bun-global（自定义根）", async () => {
		const locator = new prod.PiLocator((key) => key);
		const invocation = locator.createInvocation(piExe, ["--version"]);
		assert.equal(invocation.windowsLaunch?.channel, "cmd-shim", "原生 .exe 无垫片可解析，应走 cmd.exe 回退");
		assert.equal(locator.resolveArgCharBudget(piExe), 5000, "cmd.exe /c 命令行上限 8191，预算取 5000");
		const base = prod.resolvePiSelfUpdateChannel(piExe, "win32");
		assert.equal(base.kind, "pi-self");
		const refined = prod.refineChannelForCustomBunRoot(base, piExe, existsSync, "win32");
		assert.equal(refined.kind, "bun-global", "存在 <root>\\install\\global\\node_modules 时应细化成 bun-global");
		assert.equal(refined.bunInstallRoot, root);
		assert.equal(refined.bunCommand, win32.join(root, "bin", "bun.exe"));
		return JSON.stringify(refined);
	});

	await step("PiSelfUpdateRunner.update()：真调 pi.dev 最新版 → bun 代跑（BUN_INSTALL）→ 版本核验", async () => {
		const locator = new prod.PiLocator((key) => key);
		const runner = createUpdateRunner(prod, locator, piExe);
		const latest = await runner.fetchLatestVersion(OLD_PI_VERSION);
		assert.ok(latest.version !== OLD_PI_VERSION, `pi.dev 最新版仍是 ${OLD_PI_VERSION}，无法验证更新`);
		const dotBunBefore = snapshotDotBun();
		const result = await runner.update();
		assert.equal(result.updated, true, `update 未完成：${result.output}`);
		const installCall = records.find((call) => call.env?.BUN_INSTALL === root && call.args.join(" ").includes("install -g"));
		assert.ok(installCall, "没有捕获到带 BUN_INSTALL 的 bun install 代跑");
		const commandLine = installCall.args.join(" ");
		assert.ok(commandLine.includes("--minimum-release-age=0"), `bun ≥ 1.3 应带年龄门开关：${commandLine}`);
		assert.ok(commandLine.includes(`${PI_PACKAGE}@${latest.version}`), `安装目标版本不对：${commandLine}`);
		const after = await readPiVersion(piExe, env);
		assert.equal(after, latest.version, `更新后版本未变：${after}`);
		assert.equal(readPackageVersion(root), latest.version);
		assertSameDotBun(dotBunBefore, "更新期间");
		return `${OLD_PI_VERSION} → ${latest.version}；argv：${installCall.args.at(-1)}`;
	});
}

// ─── C. portable-prefix：旧引导前缀副本（Windows 上 pi 不推断 npm 前缀，必须 --prefix） ───

async function smokePortablePrefix(prod) {
	const prefix = win32.join(SCRATCH, "pi-runtime", "pi-global");
	const piCmd = win32.join(prefix, "pi.cmd");
	const locator = new prod.PiLocator((key) => key);
	const npm = findExecutable("npm");
	assert.ok(npm, "本机没有 npm，无法验证 portable-prefix 通道");

	await step(`旧引导前缀：npm --prefix 装出 pi@${OLD_PI_VERSION}`, async () => {
		if (readPackageVersion(prefix) !== OLD_PI_VERSION) {
			// 垫片是 .cmd：不能直接 execFile（Windows 上会 EINVAL），用生产 invocation 启动。
			const args = ["install", "-g", "--ignore-scripts", "--min-release-age=0", `${PI_PACKAGE}@${OLD_PI_VERSION}`, "--prefix", prefix];
			await runInvocation(locator.createInvocation(npm, args), 600_000);
		}
		assert.ok(existsSync(piCmd), `<prefix>\\pi.cmd 未生成`);
		assert.equal(readPackageVersion(prefix), OLD_PI_VERSION);
		return piCmd;
	});

	await step("portable-prefix 通道：真跑 npm 代跑（--prefix）→ 前缀副本原地更新", async () => {
		assert.ok(existsSync(piCmd), `setup 未装出 ${piCmd}（否则 check 会静默回退到自动检测的其它 pi）`);
		const channel = prod.resolvePiSelfUpdateChannel(piCmd, "win32");
		assert.equal(channel.kind, "portable-prefix", JSON.stringify(channel));
		assert.equal(channel.prefixDir, prefix);
		const runner = createUpdateRunner(prod, locator, piCmd);
		const latest = await runner.fetchLatestVersion(OLD_PI_VERSION);
		assert.ok(latest.version !== OLD_PI_VERSION, `pi.dev 最新版仍是 ${OLD_PI_VERSION}，无法验证更新`);
		const result = await runner.update();
		assert.equal(result.updated, true, `update 未完成：${result.output}`);
		const commandLine = records.map((call) => call.args.join(" ")).find((line) => line.includes("install -g") && line.includes("--prefix"));
		assert.ok(commandLine, "没有捕获到带 --prefix 的 npm 代跑");
		assert.ok(commandLine.includes(`${PI_PACKAGE}@${latest.version}`), `安装目标版本不对：${commandLine}`);
		assert.ok(commandLine.includes(prefix), `--prefix 没指向前缀目录：${commandLine}`);
		const status = await locator.check(piCmd, false, "", "");
		assert.equal(status.installed, true, `check 失败：${status.error}`);
		assert.equal(status.version, latest.version, `前缀副本版本未变：${status.version}`);
		assert.equal(readPackageVersion(prefix), latest.version);
		return `${OLD_PI_VERSION} → ${latest.version}；${commandLine}`;
	});
}

// ─── D. WSL / UNC：目标路由不落到宿主包管理器 ────────────────────────────────

function decodeWslOutput(buffer) {
	const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""));
	// wsl.exe 在新版 Windows 上输出 UTF-16LE（每个 ASCII 字符后夹 0x00）。
	return raw.length > 1 && raw[1] === 0 ? raw.toString("utf16le") : raw.toString("utf8");
}

async function smokeWslTarget(prod) {
	const listed = spawnSync(WSL, ["-l", "-q"], { encoding: "buffer", windowsHide: true });
	const distros = decodeWslOutput(listed.stdout)
		.split(/\r?\n/)
		.map((name) => name.replace(/\0/g, "").trim())
		.filter(Boolean);
	if (distros.length === 0) {
		log("SKIP  WSL：本机没有可用发行版");
		return;
	}
	const distro = distros[0];
	const whoami = spawnSync(WSL, ["-d", distro, "-e", "/usr/bin/whoami"], { encoding: "utf8", windowsHide: true });
	const user = (whoami.stdout ?? "").trim();
	if (whoami.status !== 0 || !user) {
		log(`SKIP  WSL ${distro}：取用户失败（${whoami.stderr || whoami.error?.message}）`);
		return;
	}
	const locator = new prod.PiLocator((key) => key);

	await step(`WSL ${distro}/${user}：真实探测 + wsl.exe 启动（只读 --version）`, async () => {
		const status = await locator.check(undefined, true, distro, user, { forceWslProbe: true });
		assert.equal(status.installed, true, `WSL pi 未探测到：${status.error}`);
		assert.match(status.version ?? "", /^\d+\.\d+\.\d+/, `版本异常：${status.version}`);
		const marker = await locator.warmWslCommand(distro, user, { force: true });
		assert.ok(marker?.startsWith(`wsl://${distro}/${user}/`), `marker 异常：${marker}`);
		const invocation = locator.createInvocation(marker, ["--version"]);
		assert.equal(invocation.command, WSL);
		const { stdout } = await runInvocation(invocation, 30_000);
		assert.equal(stdout.trim(), status.version, "wsl.exe 启动输出与探测版本不一致");
		return `${status.command} → ${status.version}`;
	});

	await step("WSL 目标（运行时召唤串与 UNC 形态）一律归 pi-self，不落宿主 bun", async () => {
		const status = await locator.check(undefined, true, distro, user);
		assert.equal(prod.resolvePiSelfUpdateChannel(status.command ?? "", "win32").kind, "pi-self", status.command);
		const uncPi = `${BS}${BS}wsl.localhost${BS}${distro}${BS}home${BS}dev${BS}.bun${BS}bin${BS}pi`;
		const uncDollar = `${BS}${BS}wsl$${BS}${distro}${BS}home${BS}dev${BS}.bun${BS}bin${BS}pi`;
		assert.equal(prod.resolvePiSelfUpdateChannel(uncPi, "win32").kind, "pi-self", uncPi);
		assert.equal(prod.resolvePiSelfUpdateChannel(uncDollar, "win32").kind, "pi-self", uncDollar);
		return "runtime / \\\\wsl.localhost\\ / \\\\wsl$\\ → pi-self";
	});
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

if (process.platform !== "win32") {
	log("SKIP  smoke-pi-windows-launch 只在 Windows 上运行");
	process.exit(0);
}
if (process.argv.includes("--clean")) {
	log(`清理临时根 ${SCRATCH}`);
	rmSync(SCRATCH, { recursive: true, force: true });
}
log(`临时根：${SCRATCH}（bun 缓存 ${CACHE}）`);
log();

const { loadTsCommonJs } = await import(pathToFileURL(win32.join(import.meta.dirname, "..", "tests", "helpers", "loadTsCommonJs.mjs")).href);
const records = [];
const prod = loadProduction(records);
const bunOverrideIndex = process.argv.indexOf("--bun");
const bunOverride = bunOverrideIndex >= 0 ? process.argv[bunOverrideIndex + 1] : process.env.PIDECK_SMOKE_BUN;

log("A. cmd 包裹（真实 cmd.exe）");
await smokeCommandWrapping(prod);
log();
log("B. pi.exe shim + 自定义 BUN_INSTALL 端到端（真下载 / 真安装）");
await smokeCustomBunInstall(prod, bunOverride);
log();
log("C. portable-prefix（旧引导前缀副本，真跑 npm --prefix）");
await smokePortablePrefix(prod);
log();
log("D. WSL / UNC 目标路由（只读）");
await smokeWslTarget(prod);
log();

const failed = results.filter((item) => !item.ok);
log(`—— 结果：${results.length - failed.length}/${results.length} 通过 ——`);
for (const item of failed) log(`FAIL  ${item.name}\n      ${item.detail}`);
process.exitCode = failed.length > 0 ? 1 : 0;
