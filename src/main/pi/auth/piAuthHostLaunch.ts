/**
 * 认证助手（`resources/pi-auth-host.mjs`）的启动参数解析。
 *
 * 助手必须跑在「用户自己那一套 pi」上：从当前 pi 命令反推出 pi 包的 JS 入口
 * （`<pkg>/dist/index.js` —— 导出 `ModelRuntime`，也就是认证 API 的所在），
 * 并用 pi 同款环境变量（`PiLocator.createProcessEnv`）启动。这样登录写下的凭据
 * 才会落在 pi 自己读的那份 `auth.json` 上，而不是另写一份。
 *
 * 本模块是纯函数式的：不 import electron，宿主（PiAuthService）把 app 路径与
 * settings 传进来，因此可以在 node --test 里直接跑真实文件系统断言。
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { AppSettings } from "../../../shared/types/settings";
import type { PiCommandInvocation, PiLocator } from "../PiLocator";
import { stripBom } from "../../config/piConfigFileStore";
import { applyPiProxyModeWithProvider, computeGenProxyKey } from "../../sessions/sessionProxyPolicy";
import { piRuntimeNodeBinDir, piRuntimeNodeExePath } from "../runtimeNodeInstall";

/** pi 包的 npm 包名；用于确认「往上找到的包根」确实是 pi 而不是同名目录。 */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** 助手进程名（打包时用 extraResources 铺到 resources 根，见 package.json）。 */
export const PI_AUTH_HOST_FILENAME = "pi-auth-host.mjs";

/** 解析所需的最小设置子集：pi 命令位置、WSL 与代理（代理与模型名单要透传给助手进程）。 */
export type PiAuthHostSettings = Pick<AppSettings, "customPiPath" | "wslEnabled" | "wslDistro" | "wslUser" | "piProxyEnabled" | "piProxyUrl" | "piProxyBypass" | "piProxyProviders" | "piProxyModels">;

/** 解析失败时给渲染层的分类；文案在 i18n 层，主进程只给原因。 */
export type PiAuthHostLaunchFailureReason =
	/** pi 跑在 WSL 里：宿主侧无法用同一套凭据目录启动助手。 */
	| "wsl"
	/** 找不到 pi 的 JS 入口（bun 编译版单文件、垫片形态异常等）。 */
	| "no-pi-entry"
	/** 随包资源缺失（打包漏配 extraResources）。 */
	| "helper-missing";

export type PiAuthHostLaunch =
	| {
			ok: true;
			/** node 可执行文件；node-direct 通道下是 pi 跑同一个 node。 */
			nodeExe: string;
			helperPath: string;
			/** pi 的 dist/index.js 绝对路径，作为 `PIDECK_PI_SDK_ENTRY` 传入助手。 */
			sdkEntry: string;
			env: NodeJS.ProcessEnv;
			/**
			 * 本次注入的代理 env 指纹。常驻助手进程的 env 在 spawn 时就固定，宿主靠它判断
			 * 「现有进程还能不能复用」：代理开关/地址/绕过列表或模型名单一旦改变，指纹就变，
			 * 调用方据此重建进程（否则用户改了代理设置却仍是旧出口）。
			 */
			proxyKey: string;
	  }
	| { ok: false; reason: PiAuthHostLaunchFailureReason /** 诊断细节（日志与「查看详情」用） */; detail?: string };

/** 助手脚本路径：与 skills/xueprompts.db 同一约定（dev 读 appPath/resources，打包读 resourcesPath）。 */
export function resolvePiAuthHostPath(input: { appPath: string; resourcesPath: string; isPackaged: boolean; filename?: string }): string {
	const filename = input.filename ?? PI_AUTH_HOST_FILENAME;
	return input.isPackaged ? join(input.resourcesPath, filename) : join(input.appPath, "resources", filename);
}

function tryRealpath(target: string): string | undefined {
	try {
		return realpathSync(target);
	} catch {
		// 路径不存在/无权限：退回原路径继续尝试，不把异常抛给调用方。
		return undefined;
	}
}

/**
 * 从任意 JS 文件路径向上找 pi 包根，返回 `<pkg>/dist/index.js`。
 *
 * 覆盖三种真实形态：
 * - npm/pnpm 垫片还原出的 `.../@earendil-works/pi-coding-agent/dist/cli.js`；
 * - `node_modules/.bin/pi` 符号链接（先 realpath 再向上）；
 * - 用户自定义路径直接指向包内某个 JS 文件；
 * - 官方安装器 managed 布局（`~/.pi/agent/bin/pi(.cmd)` 垫片 + `install/releases/<ver>`）。
 *
 * `maxDepth` 限深是为了避免在异常路径下一路走到磁盘根。
 */
/** 校验某个目录是不是 pi 包根并返回其 dist/index.js；不是就返回 undefined。 */
function piSdkEntryIn(packageRootDir: string): string | undefined {
	const packageJsonPath = join(packageRootDir, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
		if (parsed.name !== PI_PACKAGE_NAME) return undefined;
	} catch {
		// package.json 损坏：当作「不是 pi 包」继续向上找，交给上层出提示。
		return undefined;
	}
	const distEntry = join(packageRootDir, "dist", "index.js");
	return existsSync(distEntry) ? distEntry : undefined;
}

export function resolvePiSdkEntry(entryJsPath: string, maxDepth = 5): string | undefined {
	const start = tryRealpath(entryJsPath) ?? entryJsPath;
	let dir = dirname(resolve(start));
	for (let depth = 0; depth < maxDepth; depth += 1) {
		const direct = piSdkEntryIn(dir);
		if (direct) return direct;
		// 垫片目录（npm 全局前缀、用户自定义 bin 目录）本身不是包根，但常与 node_modules 同级。
		const nested = piSdkEntryIn(join(dir, "node_modules", PI_PACKAGE_NAME));
		if (nested) return nested;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/** 官方安装器（managed install）的 install 根标记文件；内容与 pi 安装器 `releases-v1` 布局对齐。 */
const MANAGED_INSTALL_MARKER = "managed-install.json";

/** release 版本号形态：与 pi 安装器的 MANAGED_RELEASE_VERSION_RE 对齐，同时避免把 current-version 内容拼进任意路径。 */
const MANAGED_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 解析官方安装器（managed install）布局下 pi 的 SDK 入口。
 *
 * 官方安装器放在 `~/.pi/agent/bin/pi(.cmd)` 的只是转发到 pi-launcher.js 的小垫片：
 * 不是 npm 垫片形态，向上也找不到 node_modules，因此 resolvePiSdkEntry 必然失败。
 * 真正的包在 `<agentDir>/install/releases/<ver>/node_modules/<pkg>`，`install/current-version`
 * 指向当前激活版本（语义与 pi 安装器的 activateManagedRelease 对齐：写 tmp 后 rename，原子生效）。
 *
 * current-version 缺失或指向不完整 release（更新中断）时，退到 releases 下版本号最大的完整
 * release，保证「能解析到一个可用入口」优先于「严格跟随指针」。
 */
export function resolveManagedPiSdkEntry(commandPath: string): string | undefined {
	const realCommand = tryRealpath(commandPath) ?? commandPath;
	// 入口可能是软链（如 ~/.local/bin/pi → ~/.pi/agent/bin/pi），realpath 后与原路径各试一次。
	const agentDirs = [dirname(dirname(commandPath)), dirname(dirname(realCommand))];
	for (const agentDir of [...new Set(agentDirs)]) {
		const installRoot = join(agentDir, "install");
		if (!isManagedInstallRoot(installRoot)) continue;
		const entry = resolveReleaseSdkEntry(installRoot);
		if (entry) return entry;
	}
	return undefined;
}

/** 标记文件合法性：kind/schemaVersion/layout 三个字段都必须是安装器写入的值。 */
function isManagedInstallRoot(installRoot: string): boolean {
	try {
		// BOM 必须先剥：Windows PowerShell 5.1 重写 managed-install.json 时会写 BOM。
		// 裸 JSON.parse 会让官方安装被误判成非 managed，`pi-auth` / `pi-enhance` 侧车解析不到 SDK 入口。
		const marker = JSON.parse(stripBom(readFileSync(join(installRoot, MANAGED_INSTALL_MARKER), "utf8"))) as { kind?: unknown; schemaVersion?: unknown; layout?: unknown };
		return marker.kind === "pi-managed-install" && marker.schemaVersion === 1 && marker.layout === "releases-v1";
	} catch {
		// 无标记/损坏 JSON：不是 managed 安装，交给其它解析路径。
		return false;
	}
}

/** 从 install 根解析当前 release 的 SDK 入口；current-version 优先，缺失时取版本号最大的完整 release。 */
function resolveReleaseSdkEntry(installRoot: string): string | undefined {
	const releasesDir = join(installRoot, "releases");
	let currentVersion: string | undefined;
	try {
		const raw = readFileSync(join(installRoot, "current-version"), "utf8").trim();
		if (MANAGED_RELEASE_VERSION_RE.test(raw)) currentVersion = raw;
	} catch {
		// current-version 不存在：走 releases 目录回退。
	}
	if (currentVersion) {
		const entry = piSdkEntryIn(join(releasesDir, currentVersion, "node_modules", PI_PACKAGE_NAME));
		if (entry) return entry;
	}
	let fallback: { version: string; numbers: [number, number, number]; entry: string } | undefined;
	let releaseNames: string[] = [];
	try {
		releaseNames = readdirSync(releasesDir);
	} catch {
		return undefined;
	}
	for (const name of releaseNames) {
		if (!MANAGED_RELEASE_VERSION_RE.test(name)) continue;
		const numbers = releaseVersionNumbers(name);
		if (!numbers) continue;
		const entry = piSdkEntryIn(join(releasesDir, name, "node_modules", PI_PACKAGE_NAME));
		if (!entry) continue;
		// 数值比较 major.minor.patch；基线相同（预发版差异）时用字符串序保证结果确定。
		if (!fallback || compareReleaseVersion(numbers, name, fallback.numbers, fallback.version) > 0) fallback = { version: name, numbers, entry };
	}
	return fallback?.entry;
}

/** mise 数据目录下的垫片目录名：`<data>/shims/pi`、`<data>/shims/pi.exe`。 */
const MISE_SHIMS_DIRNAME = "shims";

/**
 * 解析 mise 垫片背后的 pi 包。
 *
 * mise 的垫片是编译出来的转发器（Windows 是 .exe，POSIX 是二进制/脚本）：realpath
 * 拿不到 npm 包，向上也找不到 node_modules。于是用户能正常启动会话，但增强/认证侧车
 * 解析不到 SDK 入口，表现为「输入预测/提示词增强/登录全部 sdk-unavailable」
 * （线上案例：`%LOCALAPPDATA%\mise\shims\pi.exe`，2026-11）。
 *
 * mise 的 npm 后端把全局包装在 `<installs>/node/<ver>/node_modules`，与 node.exe 同目录。
 * 垫片在运行时才按 .tool-versions 决定用哪个版本，宿主侧拿不到那个决定，因此多版本
 * 并存时取版本号最大的可用包——解析到一个能用的入口，好过整条通道不可用。
 */
export function resolveMiseShimSdkEntry(commandPath: string): string | undefined {
	const shimDir = dirname(resolve(tryRealpath(commandPath) ?? commandPath));
	if (basename(shimDir) !== MISE_SHIMS_DIRNAME) return undefined;
	// MISE_INSTALL_PATH 可整体覆盖 installs 目录（与 PiLocator 的搜索口径一致）。
	const installsRoot = process.env.MISE_INSTALL_PATH || join(dirname(shimDir), "installs");
	let nodeVersions: string[];
	try {
		nodeVersions = readdirSync(join(installsRoot, "node"));
	} catch {
		// 垫片目录但没有任何 node 安装：不是可解析的 mise 布局，交给上层出提示。
		return undefined;
	}
	let best: { version: string; numbers: [number, number, number]; entry: string } | undefined;
	for (const version of nodeVersions) {
		const numbers = releaseVersionNumbers(version);
		if (!numbers) continue;
		const entry = piSdkEntryIn(join(installsRoot, "node", version, "node_modules", PI_PACKAGE_NAME));
		if (!entry) continue;
		if (!best || compareReleaseVersion(numbers, version, best.numbers, best.version) > 0) best = { version, numbers, entry };
	}
	return best?.entry;
}

/** bun 全局安装的包目录层级：`<BUN_INSTALL>/install/global/node_modules`。 */
const BUN_GLOBAL_NODE_MODULES = ["install", "global", "node_modules"] as const;

/**
 * 解析 bun 全局安装（`bun install -g @earendil-works/pi-coding-agent`）背后的 pi 包。
 *
 * Windows 的 bun 全局命令是 `<BUN_INSTALL>\bin\pi.exe`：bun 把 bun.exe 复制成同名的
 * 启动器垫片，真实入口写在旁边的 `pi.exe.bunx`（bun 私有二进制格式，不可解析），
 * 因此它既不是 npm 的 .cmd 垫片、realpath 也还原不出 JS 入口，向上找 node_modules 更
 * 不可能（`<BUN_INSTALL>\bin` 的上一层只有 `install\`）。结果是增强/认证侧车解析不到
 * SDK 入口，表现为「输入预测/提示词增强/登录全部 sdk-unavailable」
 * （线上案例：`C:\Users\<user>\.bun\bin\pi.exe` → no-pi-entry，2026-12）。
 *
 * bun 的全局包目录固定是 `<root>/install/global/node_modules`，而垫片目录固定是
 * `<root>/bin`，所以 `<root>` 由垫片路径反推即可（默认 `~/.bun`、自定义 `BUN_INSTALL`、
 * Homebrew/scoop 装的 bun 本体在别处都成立——它们的 shim 仍写在 `<root>/bin`）。
 * POSIX 的 `~/.bun/bin/pi` 是软链，已被 resolvePiSdkEntry 覆盖，这里对它是无害的空转。
 */
export function resolveBunShimSdkEntry(commandPath: string): string | undefined {
	const realCommand = tryRealpath(commandPath) ?? commandPath;
	// realpath 后仍是同一个 exe（Windows 垫片是副本），两种情况都试一次以兼容软链形态。
	for (const command of new Set([commandPath, realCommand])) {
		const root = dirname(dirname(resolve(command)));
		const entry = piSdkEntryIn(join(root, ...BUN_GLOBAL_NODE_MODULES, PI_PACKAGE_NAME));
		if (entry) return entry;
	}
	return undefined;
}

function releaseVersionNumbers(name: string): [number, number, number] | undefined {
	const [major, minor, patch] = name.split(".");
	// 目录名不一定三段（mise 的 node 目录里可能有 lts/别名）；缺段直接判为不可比。
	if (patch === undefined) return undefined;
	const parsed = [Number(major), Number(minor), Number(patch.split("-")[0].split("+")[0])];
	return parsed.every((n) => Number.isInteger(n)) ? ([parsed[0], parsed[1], parsed[2]] as [number, number, number]) : undefined;
}

function compareReleaseVersion(aNum: [number, number, number], aName: string, bNum: [number, number, number], bName: string): number {
	for (let i = 0; i < 3; i += 1) {
		if (aNum[i] !== bNum[i]) return aNum[i] - bNum[i];
	}
	return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/** 裸命令名（靠 PATH 解析）与绝对路径的区分：后者才包含路径分隔符。 */
function isBareCommand(command: string): boolean {
	return !command.includes("/") && !command.includes("\\");
}

/** 沿 PATH 找 pi 可执行文件（含 Windows 垫片后缀），返回命中的绝对路径。 */
function findCommandOnPath(commandName: string): string | undefined {
	const pathValue = process.env.PATH;
	if (!pathValue) return undefined;
	const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe", ".ps1"] : [""];
	for (const candidateDir of pathValue.split(delimiter)) {
		if (!candidateDir) continue;
		for (const suffix of suffixes) {
			const candidate = join(candidateDir, `${commandName}${suffix}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * 取「pi 的 JS 入口候选路径」：优先垫片还原结果，其次把命令路径本身当 JS 文件，
 * 最后按 PATH 解析裸命令名。
 */
function pickPiEntryCandidate(invocation: PiCommandInvocation, piCommand: string): string | undefined {
	if (invocation.windowsLaunch?.entry) return invocation.windowsLaunch.entry;
	if (/\.(?:m?js|cjs)$/i.test(piCommand) && existsSync(piCommand)) return piCommand;
	if (isBareCommand(piCommand)) {
		// 裸命令名：PATH 上命中的可能是垫片/符号链接，resolvePiSdkEntry 会先 realpath 再向上找。
		return findCommandOnPath(piCommand);
	}
	return existsSync(piCommand) ? piCommand : undefined;
}

/**
 * 选助手运行时：优先用户自己的那套，PiDeck 便携 node 只作最后兜底。
 *
 * 助手只要求「能加载 pi SDK 的 node 兼容运行时」，所以顺序按「离用户实际环境多近」排：
 * 1. node-direct 通道：pi 就是被这个 node 拉起的，等价于用户在终端里的行为，最稳；
 * 2. pi 是 bun 全局安装：pi 本身就跑在这个 bun 上（Windows 的 `pi.exe` 就是 bun.exe 的副本），
 *    同一运行时是「这份 SDK 能加载」的最强证据，也是用户自己的环境——`bun install -g` 的机器
 *    上常常压根没有 node（2026-12 线上：`.bun/bin/pi.exe` 的机器侧车全不可用）；
 * 3. PATH 上的 node：跳过 PiDeck 便携目录，否则下一档永远轮不到（便携目录也在 PATH 尾部）；
 * 4. PATH 上的 bun：非 bun 布局但只有 bun、没有 node 的机器；
 * 5. PiDeck 便携 node：既没 node 也没 bun 时的兜底（引导安装自带的那份）；
 * 6. 裸命令名：交给 spawn 报 ENOENT，错误信息仍可诊断。
 */
function resolveHelperRuntimeExe(invocation: PiCommandInvocation, input: { piCommand: string; userDataPath: string; pathValue: string | undefined; bunInstalled: boolean }): string {
	if (invocation.windowsLaunch?.channel === "node-direct" && !isBareCommand(invocation.command)) return invocation.command;
	if (input.bunInstalled) {
		// 同目录的 bun 与 pi 是同一份安装；PATH 上的 bun 兜底 scoop/Homebrew 把本体装到别处的机器。
		const bun = findPiBunExe(input.piCommand) ?? findRuntimeOnPath("bun", input.pathValue);
		if (bun) return bun;
	}
	const userNode = findRuntimeOnPath("node", input.pathValue, piRuntimeNodeBinDir(input.userDataPath));
	if (userNode) return userNode;
	const bun = findRuntimeOnPath("bun", input.pathValue);
	if (bun) return bun;
	const portableNode = piRuntimeNodeExePath(input.userDataPath);
	if (existsSync(portableNode)) return portableNode;
	return process.platform === "win32" ? "node.exe" : "node";
}

/** 运行时可执行名后缀：spawn 不经 shell，Windows 不会展开 PATHEXT（`node.cmd` 本来也启动不了）。 */
const RUNTIME_EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";

/**
 * 按 PATH 找运行时可执行文件（返回绝对路径）；`skipDir` 用于跳过 PiDeck 便携目录。
 * 返回绝对路径而不是裸名：日志里好直接看出助手实际跑在哪个 node/bun 上。
 */
function findRuntimeOnPath(programName: string, pathValue: string | undefined, skipDir?: string): string | undefined {
	if (!pathValue) return undefined;
	const fileName = `${programName}${RUNTIME_EXE_SUFFIX}`;
	// Windows 路径不区分大小写；逐项比较前统一小写，避免同一个目录因盘符写法不同被当成两个。
	const skip = skipDir ? resolve(skipDir).toLowerCase() : undefined;
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) continue;
		const normalizedDir = resolve(dir);
		if (skip && normalizedDir.toLowerCase() === skip) continue;
		const candidate = join(normalizedDir, fileName);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** bun 全局安装时 pi 自己的 bun 本体：与垫片同目录（`<root>/bin/bun[.exe]`）。 */
function findPiBunExe(piCommand: string): string | undefined {
	const candidate = join(dirname(dirname(resolve(piCommand))), "bin", `bun${RUNTIME_EXE_SUFFIX}`);
	return existsSync(candidate) ? candidate : undefined;
}

/**
 * 组装助手的启动参数。失败时返回分类原因，由渲染层翻成可读提示（通常是
 * 「请在终端里执行 pi 然后 /login」）——绝不静默失败，否则用户只会看到没反应。
 */
export function resolvePiAuthHostLaunch(input: {
	settings: PiAuthHostSettings;
	/**
	 * 本次调用要用的模型：助手按「一次调用一个模型」复用同一个常驻进程，而代理 env 在
	 * spawn 时定格，所以名单只能在这里落地。缺省时不按名单过滤（跟随全局开关），
	 * 与 pi 会话 spawn 的语义一致。
	 */
	proxyModel?: { provider?: string; modelId?: string };
	locator: PiLocator;
	userDataPath: string;
	appPath: string;
	resourcesPath: string;
	isPackaged: boolean;
	/** 复用同套解析逻辑的其它助手脚本文件名（如提示词增强助手）；缺省为认证助手。 */
	helperFilename?: string;
}): PiAuthHostLaunch {
	const helperPath = resolvePiAuthHostPath({ ...input, filename: input.helperFilename ?? PI_AUTH_HOST_FILENAME });
	if (!existsSync(helperPath)) {
		return { ok: false, reason: "helper-missing", detail: helperPath };
	}

	const piCommand = input.locator.resolveCommand(input.settings.customPiPath);
	if (piCommand.startsWith("wsl://")) {
		// WSL 模式下 pi 的凭据目录在 distro 内，宿主侧拉起的助手读不到同一份 auth.json。
		return { ok: false, reason: "wsl", detail: piCommand };
	}

	const invocation = input.locator.createInvocation(piCommand, []);
	const candidate = pickPiEntryCandidate(invocation, piCommand);
	// managed 安装：pi.cmd/pi 只是转发到 pi-launcher.js 的小垫片，垫片还原与向上找包根都到不了
	// node_modules，此时按 install/current-version → releases/<ver> 直取包根（issue #335）。
	// mise 垫片同理：垫片是编译产物，真实包在 installs/node/<ver>/node_modules 下。
	// bun 全局安装同理：Windows 垫片是 bun.exe 的副本，真实包在 <root>/install/global/node_modules 下。
	const bunSdkEntry = resolveBunShimSdkEntry(piCommand);
	const sdkEntry = (candidate ? resolvePiSdkEntry(candidate) : undefined) ?? resolveManagedPiSdkEntry(piCommand) ?? resolveMiseShimSdkEntry(piCommand) ?? bunSdkEntry;
	if (!sdkEntry) {
		// cmd-shim 回退原因（垫片形态不符/入口缺失）一并带出，便于排查装的是什么形态的 pi。
		return { ok: false, reason: "no-pi-entry", detail: invocation.windowsLaunch?.reason ?? candidate ?? piCommand };
	}

	// 与 pi 会话 spawn 同一套语义：名单内强制开启（复用全局 URL，即使全局关也一样）、
	// 名单外强制直连（只改 enabled 位），名单未启用时跟随全局开关。
	const effectiveSettings = applyPiProxyModeWithProvider(input.settings, undefined, input.proxyModel?.provider, input.proxyModel?.modelId);

	// env 先算：它的 PATH 顺序就是助手 spawn 时看到的顺序，运行时也必须从同一份 PATH 里挑，
	// 否则日志里写的 node 与实际执行的可能不是同一个。
	const env = buildChildEnv(input.locator.createProcessEnv(effectiveSettings, invocation.pathPrefix, invocation.wsl), sdkEntry);

	return {
		ok: true,
		nodeExe: resolveHelperRuntimeExe(invocation, { piCommand, userDataPath: input.userDataPath, pathValue: env.PATH ?? env.Path, bunInstalled: Boolean(bunSdkEntry) }),
		helperPath,
		sdkEntry,
		env,
		// 指纹与 git 摘要等其它常驻进程共用同一实现（settings + 名单 → 实际生效的代理状态），
		// 两处各写一份会在名单语义调整后静默漂移。
		proxyKey: computeGenProxyKey(input.settings, input.proxyModel?.provider, input.proxyModel?.modelId),
	};
}

/**
 * 组装助手的环境变量。
 *
 * 去掉值为 undefined 的键：Node 对 env 里 undefined 的处理在各版本间不一致，
 * 显式剔除比赌版本行为稳。`PIDECK_PI_SDK_ENTRY` 是助手唯一的必需输入。
 */
function buildChildEnv(base: NodeJS.ProcessEnv, sdkEntry: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		env[key] = value;
	}
	env.PIDECK_PI_SDK_ENTRY = sdkEntry;
	return env;
}
