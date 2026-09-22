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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { AppSettings } from "../../../shared/types/settings";
import type { PiCommandInvocation, PiLocator } from "../PiLocator";
import { piRuntimeNodeExePath } from "../runtimeNodeInstall";

/** pi 包的 npm 包名；用于确认「往上找到的包根」确实是 pi 而不是同名目录。 */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** 助手进程名（打包时用 extraResources 铺到 resources 根，见 package.json）。 */
export const PI_AUTH_HOST_FILENAME = "pi-auth-host.mjs";

/** 解析所需的最小设置子集：pi 命令位置、WSL 与代理（代理要透传给助手进程）。 */
export type PiAuthHostSettings = Pick<AppSettings, "customPiPath" | "wslEnabled" | "wslDistro" | "wslUser" | "piProxyEnabled" | "piProxyUrl" | "piProxyBypass">;

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
	  }
	| { ok: false; reason: PiAuthHostLaunchFailureReason /** 诊断细节（日志与「查看详情」用） */; detail?: string };

/** 助手脚本路径：与 skills/xueprompts.db 同一约定（dev 读 appPath/resources，打包读 resourcesPath）。 */
export function resolvePiAuthHostPath(input: { appPath: string; resourcesPath: string; isPackaged: boolean }): string {
	return input.isPackaged ? join(input.resourcesPath, PI_AUTH_HOST_FILENAME) : join(input.appPath, "resources", PI_AUTH_HOST_FILENAME);
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
 * - 用户自定义路径直接指向包内某个 JS 文件。
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
 * 选 node：node-direct 通道下 pi 已经用某个 node 在跑，直接用同一个最稳；
 * 否则退回 PiDeck 便携 node（机器上没有 node 时 pi 正是靠它启动），最后才是 PATH 上的 node。
 */
function resolveNodeExe(invocation: PiCommandInvocation, userDataPath: string): string {
	if (invocation.windowsLaunch?.channel === "node-direct" && !isBareCommand(invocation.command)) return invocation.command;
	const portableNode = piRuntimeNodeExePath(userDataPath);
	if (existsSync(portableNode)) return portableNode;
	return process.platform === "win32" ? "node.exe" : "node";
}

/**
 * 组装助手的启动参数。失败时返回分类原因，由渲染层翻成可读提示（通常是
 * 「请在终端里执行 pi 然后 /login」）——绝不静默失败，否则用户只会看到没反应。
 */
export function resolvePiAuthHostLaunch(input: { settings: PiAuthHostSettings; locator: PiLocator; userDataPath: string; appPath: string; resourcesPath: string; isPackaged: boolean }): PiAuthHostLaunch {
	const helperPath = resolvePiAuthHostPath(input);
	if (!existsSync(helperPath)) {
		return { ok: false, reason: "helper-missing", detail: helperPath };
	}

	const piCommand = input.locator.resolveCommand(input.settings.customPiPath, input.settings.wslEnabled, input.settings.wslDistro, input.settings.wslUser);
	if (piCommand.startsWith("wsl://")) {
		// WSL 模式下 pi 的凭据目录在 distro 内，宿主侧拉起的助手读不到同一份 auth.json。
		return { ok: false, reason: "wsl", detail: piCommand };
	}

	const invocation = input.locator.createInvocation(piCommand, []);
	const candidate = pickPiEntryCandidate(invocation, piCommand);
	const sdkEntry = candidate ? resolvePiSdkEntry(candidate) : undefined;
	if (!sdkEntry) {
		// cmd-shim 回退原因（垫片形态不符/入口缺失）一并带出，便于排查装的是什么形态的 pi。
		return { ok: false, reason: "no-pi-entry", detail: invocation.windowsLaunch?.reason ?? candidate ?? piCommand };
	}

	return {
		ok: true,
		nodeExe: resolveNodeExe(invocation, input.userDataPath),
		helperPath,
		sdkEntry,
		env: buildChildEnv(input.locator.createProcessEnv(input.settings, invocation.pathPrefix, invocation.wsl), sdkEntry),
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
