import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { app } from "electron";
import type { PiInstallation, PiInstallationSource, PiInstallStatus } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { compareVersions } from "../utils/versionCompare";
import { WSL_PI_NEGATIVE_CACHE_TTL_MS, WSL_PI_PROBE_TIMEOUT_MS, buildWslCommandMarker, buildWslPiExecArgs, buildWslPiProbeScript, parseWslCommandMarker, parseWslPiProbeOutput, type WslPiProbeResult } from "../wsl/wslPiProbe";
import { decodeWslOutput } from "../wsl/wslExe";
import { stripBom } from "../config/piConfigFileStore";
import { describeCmdShimFallback, needsCmdQuote, quoteCmdArgument, resolveCmdExe, resolveWindowsCmdShim, resolveWindowsCmdShimDetailed } from "./piLocator/piWindowsShim";
import { isDrivelessLinuxPathOnWindows, isUnsupportedPowerShellShim, normalizeCustomPath, toWslCustomPath } from "./piLocator/piCustomPath";
import { createPiProcessEnv, getCommandBinDir, sanitizePiChildEnv, type PiProxySettings } from "./piLocator/piLaunchEnv";
import { getCandidates, getSearchDirs, searchDirEntries, warmLoginShellPath } from "./piLocator/piSearchDirs";
import { cleanExecError, composeCheckFailure, runPiVersionCheck } from "./piLocator/piVersionCheck";

// 拆分后的域符号仍从本文件导出：下游只认 PiLocator.ts，不追 piLocator/ 子模块。
export { describeCmdShimFallback } from "./piLocator/piWindowsShim";
export type { CmdShimResolution } from "./piLocator/piWindowsShim";

/**
 * 进程级 WSL pi 探测缓存。
 * - command：`wsl://<distro>/<user>/<pi 绝对路径>` 标记；null = 已探测且未找到（负缓存）。
 * - nodeBinDir：与该 pi 配套的 node bin 目录；启动时前置注入 PATH，供 `#!/usr/bin/env node` 使用。
 * - at：写入时间。负缓存按 TTL 过期，避免「用户装完 pi 不重启应用就永远检测不到」。
 */
type WslCommandCacheEntry = {
	command: string | null;
	nodeBinDir: string;
	at: number;
};

const wslCommandCache = new Map<string, WslCommandCacheEntry>();
const wslCommandInflight = new Map<string, Promise<string | null>>();

/** 交互式登录 shell 反查到的 pi 路径（null = 查过但没找到）。 */
type ShellPiProbeCacheEntry = { path: string | null; at: number };
let shellPiProbeCache: ShellPiProbeCacheEntry | undefined;
let shellPiProbeInflight: Promise<string | null> | undefined;

/**
 * 安装列表的进程级短缓存。
 * 每次列举都要 spawn 全部候选的 `--version`（并行，单条几百毫秒），
 * 启动检测与设置页检测会连续调用，没有缓存就白跑一轮。
 * 设置变更/引导装完后由 invalidatePiInstallationCache() 主动失效。
 */
const INSTALLATION_LIST_TTL_MS = 10_000;
let installationListCache: { key: string; at: number; value: PiInstallation[] } | undefined;

/** 交互式 shell 探测超时：要加载用户 rc，比非交互探测宽松，但不能拖住检测按钮。 */
const LOGIN_SHELL_PI_PROBE_TIMEOUT_MS = 5_000;
/** 没找到时的负缓存：用户装完 pi 后点「从终端再找一次」或下次超过 TTL 自动重试。 */
const LOGIN_SHELL_PI_NEGATIVE_TTL_MS = 60_000;

/** 官方安装器（install.sh / install.ps1）的安装标记文件名，两侧布局一致。 */
const MANAGED_INSTALL_MARKER = "managed-install.json";

/** 安装来源的展示优先级：官方安装 > 包管理器全局 > PiDeck 便携副本 > 用户自选 > 其余 PATH 目录；WSL 单独一行不参与排序（列表只有它一条）。 */
const INSTALLATION_SOURCE_RANK: Record<PiInstallationSource, number> = { managed: 0, "package-manager": 1, portable: 2, custom: 3, path: 4, wsl: 5 };

/**
 * 各启动通道下单条命令行的安全字符预算，供技能/提示词白名单这类 O(N) 参数注入做兜底。
 *
 * 按通道分别取值而不是统一取最坏值：Windows 上 npm/pnpm 装的 `.cmd` 垫片已被
 * resolveWindowsCmdShim 还原成 node 直启，绝大多数用户走的是 32767 那条通道；
 * 用 8191 的预算去卡他们，会在技能数刚过百时就无谓地关掉「禁用技能」功能。
 */
/** CreateProcess lpCommandLine 上限 32767；扣除 pi 启动 base 参数（最坏 2k~3k）后取 26000。 */
export const CREATE_PROCESS_ARG_CHAR_BUDGET = 26000;
/** cmd.exe /d /s /c 命令行上限 8191；扣除 base 与引号膨胀余量后取 5000。 */
export const CMD_EXE_ARG_CHAR_BUDGET = 5000;
/** 非 Windows 走 execve，受系统 ARG_MAX 限制（Linux ≥2MB / macOS ≥1MB），实际等同于不限制。 */
export const UNLIMITED_ARG_CHAR_BUDGET = 1_000_000;

function wslCommandCacheKey(distro: string, user: string): string {
	return `${distro}\0${user}`;
}

/**
 * realpath 容错版：路径不存在/软链断裂时回退原值（候选已由 existsSync 过滤，这里只用结果做去重与比较）。
 */
function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * 标记版本最高的那份安装（用于列表里的「较新」徒章）。
 * 只在确实比其他人高时才标记：全部同版本时不标记，避免把「一样新」说成「更新」。
 */
function markNewestInstallation(installations: PiInstallation[]): void {
	const versioned = installations.filter((item) => item.version);
	if (versioned.length < 2) return;
	const newest = versioned.reduce((best, current) => (compareVersions(current.version ?? "0.0.0", best.version ?? "0.0.0") > 0 ? current : best));
	const higher = versioned.some((item) => item !== newest && compareVersions(newest.version ?? "0.0.0", item.version ?? "0.0.0") > 0);
	if (higher) newest.isNewest = true;
}

/**
 * 列表排序：当前使用项 → 终端默认项 → 来源优先级 → 路径字典序。
 * 末尾用 path 兜底保证顺序稳定（UI 列表不会在两次检测之间乱跳）。
 */
function compareInstallations(a: PiInstallation, b: PiInstallation): number {
	return Number(b.isActive) - Number(a.isActive) || Number(Boolean(b.shellDefault)) - Number(Boolean(a.shellDefault)) || INSTALLATION_SOURCE_RANK[a.source] - INSTALLATION_SOURCE_RANK[b.source] || a.path.localeCompare(b.path);
}

/** 测试用：每个 VM 用例自带一份模块，生产路径不要调用。 */
export function resetWslCommandCache(): void {
	wslCommandCache.clear();
	wslCommandInflight.clear();
}

/**
 * 清掉安装列表缓存。
 * 设置里的自定义路径、WSL 开关变化，或引导安装写完 pi 之后必须调用，
 * 否则用户在 TTL 内点「重新检测」看到的仍是旧列表。
 */
export function invalidatePiInstallationCache(): void {
	installationListCache = undefined;
}

/** 测试用：连交互式 shell 反查缓存一并清掉。 */
export function resetPiInstallationCaches(): void {
	installationListCache = undefined;
	shellPiProbeCache = undefined;
	shellPiProbeInflight = undefined;
}

type PiLocatorCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

export type PiCommandInvocation = {
	command: string;
	args: string[];
	shell: boolean;
	pathPrefix?: string;
	/**
	 * Windows 下通过 cmd.exe /c 启动 .cmd shim 时，命令行里已经手动完成引号包装。
	 * 必须禁止 Node 再次转义参数，否则路径中含空格会被 cmd 误解析为不存在的路径。
	 */
	windowsVerbatimArguments?: boolean;
	/**
	 * 当 pi 位于 WSL 中时，command 固定为 wsl.exe，args 会携带 distro/user/pi 参数。
	 * 下游 PiProcess 需要用此标志决定是否把 Windows cwd 转为 Linux 路径。
	 */
	wsl?: {
		distro: string;
		user: string;
		piCommand: string;
	};
	/**
	 * Windows 启动通道（诊断用）。
	 *
	 * `node-direct` = 已把 .cmd 垫片还原成 node + JS 入口直启（没有 cmd.exe 层）；
	 * `cmd-shim` = 退回 `cmd.exe /d /s /c "<整条命令行>"`，附原因。
	 * 之前这条回退是静默的：用户只看到「启动走 cmd.exe」，无从知道为什么没走 node 直启——
	 * 现场正是拿这一点误判成「PiDeck 根本没改成 node 启动」。
	 */
	windowsLaunch?: {
		channel: "node-direct" | "cmd-shim";
		/** cmd-shim 通道的原因；node-direct 时为 undefined。 */
		reason?: string;
		/** node-direct 时实际执行的 JS 入口。 */
		entry?: string;
	};
};

/** Resolves the pi CLI across packaged Electron environments where shell PATH is often incomplete. */
export class PiLocator {
	constructor(private readonly translate: PiLocatorCopy = () => "Could not run pi CLI.") {}

	/**
	 * Resolves the pi CLI across packaged Electron environments where shell PATH is often incomplete.
	 * When `customPath` is provided, it takes priority over auto-detection —
	 * this is the user's manually specified path from settings.
	 */
	resolveCommand(customPath?: string, wslEnabled?: boolean, wslDistro?: string, wslUser?: string) {
		const normalizedCustomPath = this.normalizeCustomPath(customPath);
		// wsl:// 是显式运行目标，优先保留；普通本地路径则不能覆盖已启用的 WSL 模式，
		// 否则设置页残留的 Windows pi.cmd 会把 Agent 静默切回宿主机。
		if (normalizedCustomPath?.startsWith("wsl://")) return normalizedCustomPath;
		if (wslEnabled && process.platform === "win32" && wslDistro && wslUser) {
			const wslCustomPath = toWslCustomPath(normalizedCustomPath, wslEnabled, wslDistro, wslUser);
			if (wslCustomPath) return wslCustomPath;
			// 热路径只读缓存：同步 WSL 探测会把关窗/设置点死。
			// 即使尚未预热或探测失败，也必须保留 WSL 边界；返回裸 `pi` 的 WSL 标记，
			// 不能回退为 Windows 的 `pi`，否则 WSL 配置下会静默执行宿主机 pi。
			const wslCommand = this.peekCachedWslCommand(wslDistro, wslUser);
			return wslCommand ?? buildWslCommandMarker(wslDistro, wslUser, "pi");
		}
		// 用户手动指定路径优先，适用于 npm/pnpm/yarn 全局安装、nvm/volta/asdf/mise 等极端情况。
		// 旧版本可能已保存 pi.ps1；Windows 现在不再调用 PowerShell shim，遇到时忽略并回退自动检测。
		// 路径已失效（文件被删 / 版本管理器切换后旧路径残留）时同样回退自动检测——否则 check()
		// 会拿着失效路径反复失败，永远不重扫，用户会看到「检测不到 pi」卡死。wsl:// 是标记串
		// 不是本地文件，existsSync 对它无意义，必须原样保留。
		if (normalizedCustomPath && !isUnsupportedPowerShellShim(normalizedCustomPath) && !normalizedCustomPath.startsWith("wsl://") && existsSync(normalizedCustomPath)) {
			return normalizedCustomPath;
		}

		const candidates = getCandidates();
		const found = candidates.find((candidate) => existsSync(candidate));
		if (found) return found;
		return "pi";
	}

	/**
	 * 启动/设置变更时异步探测 WSL 内的 pi，结果写入进程级缓存。
	 * 热路径 `resolveCommand` 只读缓存，避免同步子进程调用卡住主进程。
	 * 多次调用同一 distro/user 会合并为一次 in-flight 探测。
	 *
	 * `force` 给用户显式重检（设置页「检测环境」/ 保存 WSL 配置 / WSL 连接验证）：
	 * 忽略正、负缓存重新探测，否则负缓存 TTL 内点按钮不会有任何变化。
	 */
	async warmWslCommand(distro?: string, user?: string, options?: { force?: boolean }): Promise<string | undefined> {
		if (process.platform !== "win32" || !distro || !user) return undefined;
		const key = wslCommandCacheKey(distro, user);
		if (options?.force) wslCommandCache.delete(key);
		else {
			const cached = this.readWslCache(key);
			// null 是负缓存（已探测且没有 pi），不能当成未命中再打一轮探测。
			if (cached) return cached.command ?? undefined;
		}
		const probed = await this.probeWslCommand(distro, user);
		return probed ?? undefined;
	}

	/**
	 * 读缓存并套用负缓存 TTL。
	 * undefined = 未命中或负缓存已过期（需重探）；有对象 = 命中（含「确认没装」的 null）。
	 *
	 * 正缓存不设 TTL：热路径上过期会回退到宿主机 pi（比多等一次探测危险得多）；
	 * 版本管理器切版本/卸载等失效场景由 `force`（设置变更、显式重检）覆盖。
	 */
	private readWslCache(key: string): WslCommandCacheEntry | undefined {
		const cached = wslCommandCache.get(key);
		if (!cached) return undefined;
		if (cached.command === null && Date.now() - cached.at > WSL_PI_NEGATIVE_CACHE_TTL_MS) {
			wslCommandCache.delete(key);
			return undefined;
		}
		return cached;
	}

	/** 搜索目录枚举：实现见 piLocator/piSearchDirs.ts，本类只留同名薄包装（顺序即解析优先级）。 */
	getSearchDirs() {
		return getSearchDirs();
	}

	/** 给 pi 子进程准备 env：实现见 piLocator/piLaunchEnv.ts，本类只留同名薄包装。 */
	createProcessEnv(settings?: PiProxySettings, pathPrefix?: string, wsl?: PiCommandInvocation["wsl"]) {
		return createPiProcessEnv(settings, pathPrefix, wsl, () => this.getSearchDirs());
	}

	/** 子进程 env 消毒：实现见 piLocator/piLaunchEnv.ts，本类只留同名薄包装。 */
	sanitizePiChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
		return sanitizePiChildEnv(env);
	}

	createInvocation(command: string, args: string[], options: { wslCwd?: string } = {}): PiCommandInvocation {
		// WSL 模式：command 为 "wsl://<distro>/<user>/<pi 绝对路径>" 形式的标记
		if (command.startsWith("wsl://")) {
			const parsed = this.parseWslUrl(command);
			if (!parsed) return { command, args, shell: false };
			const { distro, user, piCommand } = parsed;
			const wslExe = this.resolveWslExe();
			// 与 checkWslCommand 共用 buildWslPiExecArgs：探测通过即意味着能启动。
			const wslArgs = buildWslPiExecArgs({
				distro,
				user,
				piCommand,
				nodeBinDir: this.peekCachedWslNodeBinDir(distro, user, piCommand),
				wslCwd: options.wslCwd,
				args,
			});
			return {
				command: wslExe.command,
				args: wslArgs,
				shell: wslExe.shell,
				wsl: { distro, user, piCommand },
			};
		}

		// JS 源文件（.js/.mjs/.cjs）通常无 shebang/可执行位，不能直接 execve 或被 cmd
		// 关联执行；统一改用 node 启动，兼容用户通过 alias "node /path/pi.js" 方式安装
		// pi 的场景（#169）。仅对实际指向 .js 文件的路径生效，不误拦裸命令名 "pi"。
		if (/\.(?:m?js|cjs)$/i.test(command) && existsSync(command)) {
			const nodeBin = process.platform === "win32" ? "node.exe" : "node";
			return {
				command: nodeBin,
				args: [command, ...args],
				shell: false,
				// JS 文件同目录一般没有 node；靠 createProcessEnv 的搜索目录解析 node。
				pathPrefix: getCommandBinDir(command),
			};
		}

		if (process.platform !== "win32") {
			return { command, args, shell: false, pathPrefix: getCommandBinDir(command) };
		}

		// Windows：npm/pnpm 的 pi 是 .cmd 垫片，内容只是把参数转发给
		// "<垫片目录>\node_modules\...\<entry>.js"。经 cmd.exe /c 启动有三个硬伤：
		//   1) cmd 命令行上限 8191 字符（CreateProcess 是 32767）——技能白名单逐条 --skill
		//      注入时，技能多的用户命令行直接超长，pi 根本起不来；
		//   2) cmd 会在参数里展开 %VAR%，路径含 %XX% 会被静默改写，加双引号也挡不住；
		//   3) 进程树多一层 cmd.exe，stop()/kill() 只终止 cmd，真正的 pi(node) 变成孤儿
		//      继续跑（占内存、锁会话文件），进程监控取到的 pid 也是 cmd 而非 pi。
		// 还原出 node + JS 入口即可同时消除这三点：参数由 spawn 按 CreateProcess 规则转义，
		// 不再需要手工维护 cmd 引号。垫片形态不符预期时返回 null，回退下面的 cmd 路径。
		const shimEntry = resolveWindowsCmdShimDetailed(command);
		if (shimEntry.kind === "entry") {
			const siblingNode = join(dirname(command), "node.exe");
			return {
				// 与垫片自身的 `IF EXIST "%dp0%\node.exe"` 分支等价：优先用与 pi 同目录的 node，
				// 避免 PATH 里另一个 node 版本被误用。
				command: existsSync(siblingNode) ? siblingNode : "node.exe",
				args: [shimEntry.entry, ...args],
				shell: false,
				pathPrefix: getCommandBinDir(command),
				windowsLaunch: { channel: "node-direct", entry: shimEntry.entry },
			};
		}

		// Windows 仅支持 .cmd/.exe/裸命令，不再走 PowerShell .ps1。
		// npm/yarn/pnpm 生成的 pi.ps1 与 pi.cmd 指向同一个包入口，但 PowerShell 的执行策略、编码和引号规则更复杂；
		// 对桌面端来说，统一使用 cmd shim 能减少检测与 agent 启动路径差异。
		// Windows npm 全局命令通常是 .cmd shim；当命令路径本身需要引号时，cmd /s /c
		// 需要额外一层外引号才能正确解析用户名含空格的路径；不需要引号的路径不能套外层引号，
		// 否则 cmd 会把 `C:\...\pi.cmd --version` 整段当作命令名。
		const innerCommand = [command, ...args].map((part) => quoteCmdArgument(part)).join(" ");
		const commandLine = needsCmdQuote(command) ? `"${innerCommand}"` : innerCommand;
		return {
			command: resolveCmdExe(),
			args: ["/d", "/s", "/c", commandLine],
			shell: false,
			pathPrefix: getCommandBinDir(command),
			// 关键：cmd /c 的最后一个参数是完整命令行，里面的引号由 quoteCmdArgument/control 逻辑维护。
			// 若让 Node 再转义一次，`D:\\foo bar\\pi.cmd` 会变成 cmd 无法识别的路径。
			windowsVerbatimArguments: true,
			// 回退原因一并带出去：静默回到 cmd.exe 会让人以为「改 node 启动没生效」。
			windowsLaunch: {
				channel: "cmd-shim",
				reason: describeCmdShimFallback(shimEntry, command) ?? undefined,
			},
		};
	}

	/**
	 * 估算以 command 启动 pi 时，单条命令行可用的参数字符预算。
	 *
	 * 调用方（PiProcess 的技能/提示词白名单注入）据此判断 O(N) 参数是否会撑爆命令行——
	 * 各通道上限差 4 倍，必须按实际启动方式取，不能用统一的最坏值：
	 * - 非 Windows：execve 启动，上限是系统 ARG_MAX（Linux ≥2MB / macOS ≥1MB），实际不限制。
	 * - Windows 且不走 cmd.exe（wsl.exe / node 直启 / 直接跑 .js）：CreateProcess，上限 32767。
	 * - Windows 且走 cmd.exe（原生 exe / 裸命令名 / 垫片形态不符预期）：命令行被塞进
	 *   `cmd.exe /d /s /c "<整条命令行>"`，上限坍缩到 8191。
	 *
	 * 判定分支与 createInvocation 严格对齐；不一致会让预算与实际通道脱节，
	 * 要么误拦（预算偏小）要么撑爆（预算偏大）。
	 */
	resolveArgCharBudget(command: string): number {
		if (process.platform !== "win32") return UNLIMITED_ARG_CHAR_BUDGET;
		// wsl.exe 与 node.exe 同样由 CreateProcess 拉起，受同一 32767 约束。
		if (command.startsWith("wsl://")) return CREATE_PROCESS_ARG_CHAR_BUDGET;
		if (/\.(?:m?js|cjs)$/i.test(command) && existsSync(command)) {
			return CREATE_PROCESS_ARG_CHAR_BUDGET;
		}
		return resolveWindowsCmdShim(command) ? CREATE_PROCESS_ARG_CHAR_BUDGET : CMD_EXE_ARG_CHAR_BUDGET;
	}

	/**
	 * 验证用户手动输入的 pi 路径是否可用。
	 * 直接对给定路径执行 --version，绕过 getCandidates 的目录扫描，
	 * 适用于用户从终端复制完整路径（如 D:\nodejs\pi.cmd）后手动粘贴的场景。
	 */
	async validateCustomPath(customPath: string, wslEnabled?: boolean, wslDistro?: string, wslUser?: string): Promise<PiInstallStatus> {
		const normalized = this.normalizeCustomPath(customPath);
		const command = toWslCustomPath(normalized, wslEnabled, wslDistro, wslUser) ?? normalized;
		if (!command) {
			return { installed: false, searchedDirs: [], error: this.translate("mainPi.pathRequired") };
		}
		if (isUnsupportedPowerShellShim(command)) return this.unsupportedPowerShellStatus(command);
		if (command.startsWith("wsl://")) {
			const parsed = this.parseWslUrl(command);
			if (!parsed) return { installed: false, searchedDirs: [], error: this.translate("mainPi.invalidWslUrl") };
			const status = await this.checkWslCommand(parsed.distro, parsed.user, parsed.piCommand);
			// 设置页继续保存用户输入的 Linux 路径；下次启动由 resolveCommand 再转成 wsl:// 标记。
			return { ...status, command: normalized };
		}
		if (isDrivelessLinuxPathOnWindows(command)) {
			return this.linuxPathOutsideWslStatus(command, []);
		}
		return this.runCheck(command, []);
	}

	async check(customPath?: string, wslEnabled?: boolean, wslDistro?: string, wslUser?: string, options?: { forceWslProbe?: boolean }): Promise<PiInstallStatus> {
		const normalizedCustomPath = this.normalizeCustomPath(customPath);
		if (normalizedCustomPath && isUnsupportedPowerShellShim(normalizedCustomPath) && !(wslEnabled && process.platform === "win32" && wslDistro && wslUser)) {
			return this.unsupportedPowerShellStatus(normalizedCustomPath, this.getSearchDirs());
		}
		// 设置页检测可以等 WSL 探测：缓存未命中时先异步探测，再 resolve，避免热路径同步子进程。
		if (wslEnabled && process.platform === "win32" && wslDistro && wslUser) {
			await this.warmWslCommand(wslDistro, wslUser, { force: options?.forceWslProbe });
		}
		// 状态检测是异步入口：先预热登录 shell PATH（macOS/Linux GUI 启动拿不到
		// 终端 PATH 时靠它找到 brew/nvm 里的 pi），再读 getSearchDirs 快照。
		await this.warmLoginShellPath();
		const command = this.resolveCommand(customPath, wslEnabled, wslDistro, wslUser);
		const searchedDirs = this.getSearchDirs();

		if (command.startsWith("wsl://")) {
			const parsed = this.parseWslUrl(command);
			if (!parsed) return { installed: false, command, searchedDirs: [], error: this.translate("mainPi.invalidWslUrl") };
			const wslStatus = await this.checkWslCommand(parsed.distro, parsed.user, parsed.piCommand);
			return {
				...wslStatus,
				command: `wsl -d ${parsed.distro} -u ${parsed.user} ${parsed.piCommand}`,
				searchedDirs: [],
			};
		}

		if (isDrivelessLinuxPathOnWindows(command)) {
			return this.linuxPathOutsideWslStatus(command, searchedDirs);
		}

		return this.runCheck(command, searchedDirs);
	}

	/**
	 * 专给设置页「WSL 连接验证」用的 WSL pi 检测：强制重探 + 返回解析出的 Linux 绝对路径。
	 *
	 * 不复用 `check()` 是因为它未命中时会回退到宿主机候选（Windows pi），
	 * 验证场景要的是「这个 distro + 这个用户里到底有没有能跑的 pi」。
	 */
	async checkWslInstallation(distro: string, user: string, options?: { force?: boolean }): Promise<PiInstallStatus> {
		if (process.platform !== "win32" || !distro || !user) {
			return { installed: false, searchedDirs: [] };
		}
		const marker = await this.warmWslCommand(distro, user, options);
		if (!marker) return { installed: false, searchedDirs: [] };
		const parsed = this.parseWslUrl(marker);
		if (!parsed) return { installed: false, searchedDirs: [] };
		const status = await this.checkWslCommand(parsed.distro, parsed.user, parsed.piCommand);
		return {
			...status,
			command: `wsl -d ${parsed.distro} -u ${parsed.user} ${parsed.piCommand}`,
			piPath: parsed.piCommand,
		};
	}

	/**
	 * 列出本机探测到的全部 pi 安装（含官方安装器的 managed 安装）。
	 *
	 * 为什么单独一条链路（而不是扩展 `check()`）：`check()` 只回答「用哪个」——第一个命中的候选。
	 * 而用户实际可能存在多份安装（先 curl 装了官方安装，后来又被引导装了一份 npm 全局），
	 * 此时 PiDeck 必须把两份都摆出来让用户自己选，而不是默默用其中一份。
	 *
	 * 目录顺序与来源判定和 `check()` 完全同源（同一个 searchDirEntries），
	 * 所以 `isActive === true` 的那条就是 Agent 实际启动的那份。
	 *
	 * WSL 模式不扫描宿主机：宿主候选不代表用户实际用的 pi，只返回发行版内
	 * 正在使用的那一份（customPiPath 的 Linux 路径优先，其次发行版默认 pi），
	 * 让来源面板能显示 WSL pi 的路径与版本；发行版里探不到 pi 才返回空数组。
	 */
	async listInstallations(customPath?: string, wslEnabled?: boolean, wslDistro?: string, wslUser?: string, options: { forceShellProbe?: boolean; customPaths?: readonly string[] } = {}): Promise<PiInstallation[]> {
		if (wslEnabled && process.platform === "win32" && wslDistro && wslUser) {
			// 与 check() 同源：先预热（缓存命中则零开销），再解析当前实际使用的 pi。
			await this.warmWslCommand(wslDistro, wslUser);
			const command = this.resolveCommand(customPath, wslEnabled, wslDistro, wslUser);
			const parsed = command.startsWith("wsl://") ? this.parseWslUrl(command) : null;
			if (!parsed) return [];
			const status = await this.checkWslCommand(parsed.distro, parsed.user, parsed.piCommand);
			if (!status.installed) return [];
			return [
				{
					path: parsed.piCommand,
					realPath: parsed.piCommand,
					...(status.version ? { version: status.version } : {}),
					...(status.error ? { versionError: status.error } : {}),
					source: "wsl",
					isActive: true,
				},
			];
		}

		// 先只做目录扫描：交互式 shell 反查要加载用户 rc，不能每次检测都无谓跑一遍。
		// 两种情况才真的去问 shell：用户显式点「从终端再找一次」，或目录扫描一份都没找到
		// （最后兜底：官方安装器的 PATH 只写进 shell rc，扫描可能真的看不见它）。
		const scanned = this.candidateInstalls();
		const shellPath = await this.probeLoginShellPi({ force: options.forceShellProbe, allowProbe: options.forceShellProbe === true || scanned.length === 0 });
		// 用户路径 = 当前使用的那条（customPiPath）+ 设置里保存的备选池（piCustomPaths）；
		// 去重后再进候选，避免同一个路径既当 active 又当备选而出现两行。
		const userPaths = [...new Set([this.normalizeCustomPath(customPath), ...(options.customPaths ?? []).map((path) => String(path ?? "").trim())])].filter((path) => Boolean(path) && !path.startsWith("wsl://"));
		const cacheKey = `${userPaths.join("\u0000")}\u0000${shellPath ?? ""}`;
		const cached = installationListCache;
		if (cached && cached.key === cacheKey && !options.forceShellProbe && Date.now() - cached.at < INSTALLATION_LIST_TTL_MS) return cached.value;

		const candidates: Array<{ path: string; realPath: string; shellDefault?: boolean; userAdded?: boolean; missing?: boolean }> = [];
		// 按 realpath 去重：`~/.local/bin/pi` 与 `~/.pi/agent/bin/pi` 是同一份安装；
		// 保留先出现的那条（先出现 = 扫描优先级更高），并补回 shellDefault 标记。
		const push = (path: string, flags: { shellDefault?: boolean; userAdded?: boolean; missing?: boolean } = {}) => {
			const realPath = safeRealpath(path);
			const existing = candidates.find((entry) => entry.realPath === realPath);
			if (existing) {
				// 同一份安装可能同时是「终端默认」和「我添加的」：标记合并到已有那行，不重复列出。
				if (flags.shellDefault) existing.shellDefault = true;
				if (flags.userAdded) existing.userAdded = true;
				// 被自动扫描命中的条目必然存在；只有“用户添加且真的不存在”才算 missing。
				if (flags.missing && !existsSync(path)) existing.missing = true;
				return;
			}
			candidates.push({ path, realPath, ...flags });
		};
		for (const candidate of scanned) push(candidate);
		// 登录 shell 反查到的 pi 可能根本不在扫描目录里（zsh / 自定义 PATH），补进来才能让用户选到它。
		if (shellPath) push(shellPath, { shellDefault: true });
		// 用户自己添加的路径：即使当前不存在也要列出来（missing），否则那行会静默消失，
		// 用户既看不到「当前使用」的是谁，也无法修正或删除它。
		for (const path of userPaths) push(path, { userAdded: true, missing: !existsSync(path) });

		// 版本探测并行跑：单条几百毫秒，顺序跑会让设置页白等几秒。
		const probes = await Promise.all(candidates.map((candidate) => this.probeVersion(candidate.path)));
		const activePath = this.resolveCommand(customPath, wslEnabled, wslDistro, wslUser);
		const activeRealPath = activePath.startsWith("wsl://") ? "" : safeRealpath(activePath);

		const installations: PiInstallation[] = candidates.map((candidate, index) => {
			// 路径不存在的条目不能拿去判 managed/portable（目录都没有），直接归为自定义路径。
			const { source, managedRoot } = candidate.missing ? { source: "custom" as PiInstallationSource, managedRoot: undefined } : this.classifyInstallationSource(candidate.path);
			return {
				path: candidate.path,
				realPath: candidate.realPath,
				...(probes[index].version ? { version: probes[index].version } : {}),
				...(probes[index].error ? { versionError: probes[index].error } : {}),
				source,
				...(managedRoot ? { managedRoot } : {}),
				isActive: Boolean(activeRealPath) && candidate.realPath === activeRealPath,
				...(candidate.userAdded ? { userAdded: true } : {}),
				...(candidate.missing ? { missing: true } : {}),
				...(candidate.shellDefault ? { shellDefault: true } : {}),
			};
		});

		markNewestInstallation(installations);
		installations.sort(compareInstallations);
		installationListCache = { key: cacheKey, at: Date.now(), value: installations };
		return installations;
	}

	/**
	 * 反查「用户终端里敲 pi 用的那一份」。
	 *
	 * 官方安装器只把 PATH 写进**当前 shell 的 rc 文件**（bash 有 ~/.bashrc 就写 .bashrc，
	 * 否则写 .profile），且只写当前这个 shell 家族。本项目既有的登录 shell 探测走
	 * `/bin/sh -lc`（非交互），读不到 .bashrc，于是官方安装的 pi 在自动检测里天然不可见——
	 * 这正是「终端里 pi 能用、PiDeck 说没装」的根因。
	 *
	 * 只在以下两种情况才真的跑：用户显式点「从终端再找一次」（force），或目录扫描一份都没找到
	 * （最后兜底）——交互式 shell 会加载用户 rc，耗时与副作用都高于目录扫描，
	 * 不适合放进每次启动的常规检测链路。
	 * 结果只用于列表展示与排序（标 `shellDefault`），绝不参与 resolveCommand 的优先级，
	 * 避免静默改掉已有用户实际启动的 pi。
	 */
	async probeLoginShellPi(options: { force?: boolean; allowProbe?: boolean } = {}): Promise<string | null> {
		// Windows 的 PATH 来自系统合并环境（Explorer 启动的 Electron 已拿到），不走 shell rc，不需要反查。
		if (process.platform === "win32") return null;
		if (options.force) shellPiProbeCache = undefined;
		const cached = shellPiProbeCache;
		if (cached && (cached.path !== null || Date.now() - cached.at < LOGIN_SHELL_PI_NEGATIVE_TTL_MS)) return cached.path;
		// allowProbe=false：只允许读缓存，不为这次调用启动交互式 shell。
		if (options.allowProbe === false) return null;
		if (shellPiProbeInflight) return shellPiProbeInflight;

		const shells = this.loginShellCandidates();
		const task = new Promise<string | null>((resolve) => {
			const attempt = (index: number) => {
				if (index >= shells.length) {
					shellPiProbeCache = { path: null, at: Date.now() };
					shellPiProbeInflight = undefined;
					resolve(null);
					return;
				}
				const shell = shells[index];
				// 只取 stdout 里第一行「存在的绝对路径」：alias/function 形态（`alias pi='…'`）与 rc 的杂输出都被过滤掉。
				execFile(shell, ["-ilc", "command -v pi 2>/dev/null"], { encoding: "utf8", timeout: LOGIN_SHELL_PI_PROBE_TIMEOUT_MS }, (_error, stdout) => {
					const found = String(stdout ?? "")
						.split("\n")
						.map((line) => line.trim())
						.find((line) => line.startsWith("/") && existsSync(line));
					if (found) {
						// fnm 这类版本管理器在交互 shell 里把 PATH 指到会话级临时软链
						// （fnm: ~/.local/state/fnm_multishells/<id>/bin），shell 退出即被清理。
						// 先解析成真实路径再返回：列表展示、「设为默认」、保存自定义路径拿到的
						// 都是稳定落点，否则路径失效后 spawn pi ENOENT（#318 实测）。
						const stable = safeRealpath(found);
						shellPiProbeCache = { path: stable, at: Date.now() };
						shellPiProbeInflight = undefined;
						resolve(stable);
						return;
					}
					// 这个 shell 跑不通或没找到：换下一个（$SHELL 可能是 fish/已知路径之外的 shell）。
					attempt(index + 1);
				});
			};
			attempt(0);
		});
		shellPiProbeInflight = task;
		return task;
	}

	/**
	 * 解析官方安装（managed install）的 install 根目录，语义与 pi 安装器的
	 * `managed_install_root_for_command` 对齐：入口父目录的父目录下必须有合法标记文件；
	 * 入口是软链（如 ~/.local/bin/pi → ~/.pi/agent/bin/pi）时按 realpath 解析后重试。
	 * 不是 managed 安装时返回 undefined。
	 */
	resolveManagedInstallRoot(commandPath: string): string | undefined {
		const roots = [dirname(dirname(commandPath)), dirname(dirname(safeRealpath(commandPath)))];
		for (const agentDir of [...new Set(roots)]) {
			const root = join(agentDir, "install");
			if (this.isManagedInstallRoot(root)) return root;
		}
		return undefined;
	}

	private isManagedInstallRoot(root: string): boolean {
		try {
			// BOM 必须先剥：Windows PowerShell 5.1 重写 managed-install.json 时会写 BOM。
			// 裸 JSON.parse 会让官方安装被误判成 custom——SDK 入口找不到，提示词增强与智能体侧车跟着失效。
			const marker = JSON.parse(stripBom(readFileSync(join(root, MANAGED_INSTALL_MARKER), "utf8"))) as Record<string, unknown>;
			return marker.kind === "pi-managed-install" && marker.schemaVersion === 1 && marker.layout === "releases-v1";
		} catch {
			return false;
		}
	}

	/** 判定一份 pi 的来源；managed 优先（标记文件比目录名可靠），其次是用户自选路径。 */
	private classifyInstallationSource(commandPath: string): { source: PiInstallationSource; managedRoot?: string } {
		const managedRoot = this.resolveManagedInstallRoot(commandPath);
		if (managedRoot) return { source: "managed", managedRoot };
		const dir = dirname(commandPath);
		const entry = searchDirEntries().find((item) => item.dir === dir);
		// 目录不在任何已知落点 → 就是用户自己指定的那个路径（设置里手填/浏览选的）。
		if (!entry) return { source: "custom" };
		if (entry?.source === "portable") return { source: "portable" };
		// 登录 shell 反查到的路径可能在便携目录的子目录下，单独兜一层。
		const portableRoot = join(app.getPath("userData"), "pi-runtime");
		const rel = relative(portableRoot, dir);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return { source: "portable" };
		return { source: entry?.source ?? "path" };
	}

	/** 探测单个入口的版本；失败不是错误（列表要保留这份装不起来的安装，让用户看到它）。 */
	private async probeVersion(command: string): Promise<{ version?: string; error?: string }> {
		const status = await this.runCheck(command, [], { quiet: true });
		return status.installed ? { version: status.version } : { error: status.error };
	}

	/** 交互式登录 shell 候选：优先用户实际登录的 $SHELL，再退到常见路径。 */
	private loginShellCandidates(): string[] {
		const fromEnv = process.env.SHELL?.trim() ?? "";
		const shells = [isAbsolute(fromEnv) ? fromEnv : "", "/bin/bash", "/bin/zsh", "/bin/sh"];
		return [...new Set(shells.filter((shell) => shell && existsSync(shell)))];
	}

	/** 扫描目录 × 候选文件名，返回存在的入口（保序；供安装列表复用）。 */
	private candidateInstalls(): string[] {
		return getCandidates().filter((candidate) => existsSync(candidate));
	}

	/** 用户输入路径归一化：实现见 piLocator/piCustomPath.ts，本类只留同名薄包装。 */
	normalizeCustomPath(rawPath?: string) {
		return normalizeCustomPath(rawPath);
	}

	private linuxPathOutsideWslStatus(command: string, searchedDirs: string[]): PiInstallStatus {
		return {
			installed: false,
			command,
			searchedDirs,
			error: this.translate("mainPi.linuxPathOutsideWsl"),
		};
	}

	private unsupportedPowerShellStatus(command: string, searchedDirs: string[] = []): PiInstallStatus {
		return {
			installed: false,
			command,
			searchedDirs,
			error: this.translate("mainPi.powershellUnsupported"),
		};
	}

	/** --version 探测：实现见 piLocator/piVersionCheck.ts，本类只留同名薄包装。 */
	private async runCheck(command: string, searchedDirs: string[], options: { quiet?: boolean } = {}): Promise<PiInstallStatus> {
		return runPiVersionCheck(this, this.translate, command, searchedDirs, options);
	}

	/** 失败文案合成：实现见 piLocator/piVersionCheck.ts，本类只留同名薄包装（契约测试直接调它）。 */
	private composeCheckFailure(raw: string, nodeVersion?: string): string {
		return composeCheckFailure(this.translate, raw, nodeVersion);
	}

	/**
	 * wsl.exe 完整路径（优先绝对路径，fopen 失败时回退到 PATH）。
	 * 32 位进程在 64 位 Windows 上访问 System32 会被文件系统重定向，
	 * Sysnative 别名可绕过；若均不可用则通过 shell PATH 查找。
	 */
	private resolveWslExe(): { command: string; shell: boolean } {
		const systemRoot = process.env.SystemRoot || "C:\\Windows";
		// 尝试真实 System32（通过 Sysnative 处理 32-bit 重定向）
		const candidates = process.arch === "ia32" ? [join(systemRoot, "Sysnative", "wsl.exe"), join(systemRoot, "System32", "wsl.exe")] : [join(systemRoot, "System32", "wsl.exe")];
		for (const candidate of candidates) {
			const ok = existsSync(candidate);
			console.log("[PiLocator] resolveWslExe candidate:", candidate, "exists:", ok);
			if (ok) return { command: candidate, shell: false };
		}
		// 绝对路径均不存在：让 CreateProcess/Node 直接通过 PATH 查找 wsl.exe。
		// 不能打开 shell：distro/user/cwd 都来自设置，shell fallback 会引入命令注入。
		console.log("[PiLocator] resolveWslExe fallback: PATH lookup with shell disabled");
		return { command: "wsl", shell: false };
	}
	/** @deprecated 使用 resolveWslExe() 代替，支持 PATH 回退 */
	private get wslExePath(): string {
		return this.resolveWslExe().command;
	}

	/**
	 * 解析 "wsl://<distro>/<user>/<piCommand>" 格式的标记。
	 * piCommand 现在是绝对 Linux 路径（带斜杠），解析规则集中在 wslPiProbe，与构造侧对称。
	 */
	private parseWslUrl(url: string): { distro: string; user: string; piCommand: string } | null {
		return parseWslCommandMarker(url);
	}

	private peekCachedWslCommand(distro: string, user: string): string | undefined {
		return this.readWslCache(wslCommandCacheKey(distro, user))?.command ?? undefined;
	}

	/**
	 * 取探测阶段拿到的 node bin 目录。
	 * 只在标记与缓存命中的是同一个 pi 时才套用：用户手动指定的路径（如另一个 node 版本
	 * 下的 pi）不得继承探测缓存，否则会把错的 node 前置到 PATH。
	 * 未命中时返回 undefined，由 buildWslPiExecArgs 从 pi 绝对路径推导同目录。
	 */
	private peekCachedWslNodeBinDir(distro: string, user: string, piCommand: string): string | undefined {
		const entry = this.readWslCache(wslCommandCacheKey(distro, user));
		if (!entry?.command) return undefined;
		if (entry.command !== buildWslCommandMarker(distro, user, piCommand)) return undefined;
		return entry.nodeBinDir || undefined;
	}

	/**
	 * 异步探测 WSL 内的 pi，结果写入进程级缓存（含负缓存）。
	 *
	 * 不能用 `which pi`：wsl.exe 不带登录/交互标记跑命令，nvm/fnm 等写在 `~/.bashrc`
	 * 交互守卫之后的 PATH 注入不会生效，必然找不到。探测改走 `wslPiProbe` 分层脚本，
	 * 并缓存**绝对路径 + node bin 目录**，使「探测结果」与「启动参数」同源。
	 * 禁止回到 execFileSync：超时会把 Electron 主进程事件循环堵住。
	 */
	private probeWslCommand(distro: string, user: string): Promise<string | null> {
		const key = wslCommandCacheKey(distro, user);
		const cached = this.readWslCache(key);
		if (cached) return Promise.resolve(cached.command);
		const inflight = wslCommandInflight.get(key);
		if (inflight) return inflight;

		const task = this.runWslPiProbe(distro, user)
			.then((result) => {
				const command = result ? buildWslCommandMarker(distro, user, result.piPath) : null;
				wslCommandCache.set(key, {
					command,
					nodeBinDir: result?.nodeBinDir ?? "",
					at: Date.now(),
				});
				return command;
			})
			.finally(() => {
				wslCommandInflight.delete(key);
			});

		wslCommandInflight.set(key, task);
		return task;
	}

	/**
	 * 跑一次探测脚本。优先 `/bin/bash -lic`（交互登录 shell，PATH 含版本管理器注入）；
	 * 只有 spawn 本身失败（如 distro 里没有 bash）才降级到 `/bin/sh -c`，
	 * 后者仍覆盖已知安装目录 glob 与包管理器 prefix。
	 * 「脚本跑通但没找到」不重试，避免未装 pi 的用户白等一轮 WSL 往返。
	 */
	private async runWslPiProbe(distro: string, user: string): Promise<WslPiProbeResult | null> {
		const script = buildWslPiProbeScript();
		const shells: Array<{ shell: string; flags: string[] }> = [
			{ shell: "/bin/bash", flags: ["-lic"] },
			{ shell: "/bin/sh", flags: ["-c"] },
		];
		for (const candidate of shells) {
			const output = await this.execWslProbe(distro, user, candidate.shell, candidate.flags, script);
			if (output === null) continue;
			return parseWslPiProbeOutput(output);
		}
		return null;
	}

	/** 执行探测脚本；返回 null 表示 spawn/执行失败（区别于「跑通但没找到」的空输出）。 */
	private execWslProbe(distro: string, user: string, shell: string, flags: string[], script: string): Promise<string | null> {
		const wslExe = this.resolveWslExe();
		return new Promise((resolve) => {
			const child = execFile(
				wslExe.command,
				["-d", distro, "-u", user, "-e", shell, ...flags, script],
				{
					// Keep bytes until decodeWslOutput; wsl.exe may emit UTF-16LE on
					// older Windows builds and decoding as UTF-8 first loses non-ASCII paths.
					encoding: "buffer",
					timeout: WSL_PI_PROBE_TIMEOUT_MS,
					windowsHide: true,
					shell: wslExe.shell,
					maxBuffer: 8 * 1024 * 1024,
				},
				(error, stdout) => {
					if (error) {
						// 不区分错误类型：调用端会降级到 /bin/sh 重试，最终只是「未检测到」。
						// 但必须留痕，否则只能从 UI 的「未检测到」倒推是 WSL 探测链哪一环挂了。
						console.error("[PiLocator] WSL pi probe failed", { shell, error: error.message });
						resolve(null);
						return;
					}
					resolve(decodeWslOutput(stdout));
				},
			);
			// stdin 必须关：交互 shell 的 rc 里一句 `read` 就能把探测挂到超时。
			child.stdin?.end();
		});
	}

	/**
	 * 在 WSL 里验证一个已解析的 pi 命令。
	 * 参数组装必须与 createInvocation 同函数（buildWslPiExecArgs）：
	 * 否则会出现「--version 能跑但启动失败」或反过来的不对称，用户看到的就是「检测不到 / 启动不了」。
	 */
	private checkWslCommand(distro: string, user: string, piCommand: string): Promise<PiInstallStatus> {
		return new Promise((resolve) => {
			const wslExe = this.resolveWslExe();
			const wslArgs = buildWslPiExecArgs({
				distro,
				user,
				piCommand,
				nodeBinDir: this.peekCachedWslNodeBinDir(distro, user, piCommand),
				args: ["--version"],
			});
			const child = execFile(
				wslExe.command,
				wslArgs,
				{
					env: this.createProcessEnv(undefined, undefined, { distro, user, piCommand }),
					shell: wslExe.shell,
					windowsHide: true,
					timeout: WSL_PI_PROBE_TIMEOUT_MS,
					// Decode the raw bytes ourselves so UTF-16LE output is not corrupted
					// before decodeWslOutput gets a chance to inspect it.
					encoding: "buffer",
				},
				(error, stdout, stderr) => {
					if (error) {
						const raw = decodeWslOutput(stderr).trim() || cleanExecError(error.message);
						console.error("[PiLocator] WSL pi CLI check failed", { piCommand, error: raw });
						resolve({ installed: false, searchedDirs: [], error: this.composeCheckFailure(raw) });
						return;
					}
					resolve({ installed: true, command: `wsl -d ${distro} -u ${user} ${piCommand}`, version: decodeWslOutput(stdout).trim(), searchedDirs: [] });
				},
			);
			// pi 的 RPC 模式靠 stdin 通信，但 --version 不需要；提前关闭避免子进程等输入。
			child.stdin?.end();
		});
	}

	/** 登录 shell PATH 预热：实现见 piLocator/piSearchDirs.ts，本类只留同名薄包装。 */
	async warmLoginShellPath(): Promise<string> {
		return warmLoginShellPath();
	}
}
