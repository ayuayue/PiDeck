/**
 * pi 环境引导 + pi 更新 IPC 域（自 systemIpc.ts 拆出：handler 体、通道、日志与文案逐字未改）。
 * 通道：pi:runtime-node-check / pi:runtime-node-install / pi:runtime-pi-install /
 * pi:update-check / pi:update / pi:release-notes。
 */
import { app, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ipcChannels } from "../../shared/ipc";
import type { NpmAvailabilityResult, PiInstallExecResult, PiRuntimeNodeInstallResult, PiRuntimeNodeStatus } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import { invalidatePiInstallationCache, type PiLocator } from "../pi/PiLocator";
import { detectPiRuntimeNode, installPiRuntimeNode, piRuntimeNodeBinDir, probeNodeVersion } from "../pi/runtimeNodeInstall";
import { runPiGlobalInstall } from "../pi/piGlobalInstall";
import { resolvePiInstallGuard } from "../pi/piInstallGuard";
import { piChangelogService } from "../pi/PiChangelogService";

export type SystemPiRuntimeIpcDeps = {
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	appLogger: AppLogger;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	/** pi 环境引导：便携 Node 安装器（下载/解压 IO 由装配层注入）；未装配 = 引导入口降级不可用。 */
	piRuntimeNodeInstaller?: import("../pi/runtimeNodeInstall").RuntimeNodeInstallerDeps;
	/** pi 更新：未装配时不注册这三条通道（与原 systemIpc 的 if 判定一致）。 */
	extensionManager?: {
		checkPiUpdate: () => Promise<import("../../shared/types").PiUpdateCheckResult>;
		updatePi: () => Promise<import("../../shared/types").PiCliUpdateResult>;
	};
	/** 后台更新快照：pi 更新检查结果写回快照。 */
	updateService?: {
		applyPiCheckResult: (result: import("../../shared/types").PiUpdateCheckResult) => void;
	};
	/** 模型目录缓存失效重建（systemIpc 内的同一份闭包，不复制第二份定义）。 */
	refreshPiModelCatalogs: () => Promise<void>;
};

export function registerSystemPiRuntimeIpc(deps: SystemPiRuntimeIpcDeps): void {
	const { piLocator, settingsStore, appLogger, mainCopy, piRuntimeNodeInstaller, extensionManager, updateService, refreshPiModelCatalogs } = deps;

	/**
	 * 探测系统 PATH 上的 node 版本（不含便携副本）。
	 * 复用 piCheckNpm 的思路：cmd /d /s /c 走 Windows shim 解析；env 前置 PiLocator
	 * 搜索目录，覆盖版本管理器动态目录。找不到/不可执行返回 undefined，不抛错。
	 */
	async function probeSystemNodeVersion(piLocator: PiLocator): Promise<string | undefined> {
		try {
			if (process.platform === "win32") {
				const { stdout } = await promisify(execFile)(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "node -v"], { env: piLocator.createProcessEnv(), timeout: 10_000, encoding: "utf8", windowsHide: true, shell: false });
				const version = stdout.trim();
				return /^v\d+\.\d+\.\d+$/.test(version) ? version : undefined;
			}
			return await probeNodeVersion("node", 10_000, piLocator.createProcessEnv());
		} catch {
			return undefined;
		}
	}

	/** 探测系统 npm 可用性（结构与 piCheckNpm 返回一致，供 pi 安装前置检查复用）。 */
	async function probeSystemNpmVersion(piLocator: PiLocator): Promise<NpmAvailabilityResult> {
		try {
			const run = async () => {
				if (process.platform === "win32") {
					const { stdout } = await promisify(execFile)(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm --version"], { env: piLocator.createProcessEnv(), timeout: 10_000, encoding: "utf8", windowsHide: true, shell: false });
					return stdout.trim();
				}
				const { stdout } = await promisify(execFile)("npm", ["--version"], {
					env: piLocator.createProcessEnv(),
					timeout: 10_000,
					encoding: "utf8",
				});
				return stdout.trim();
			};
			const version = await run();
			return version ? { available: true, version } : { available: false };
		} catch (error) {
			return { available: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	// ── pi 环境引导：便携 Node / npm / pi 安装 ────────────────────

	/**
	 * 引导步骤 1：检测便携 Node 副本 + 系统 node。
	 * 渲染层据此决定三步引导从哪一步开始（有系统 node 可直接跳到装 pi）。
	 */
	ipcMain.handle(ipcChannels.piRuntimeNodeCheck, async (): Promise<PiRuntimeNodeStatus> => {
		try {
			// 系统 node 探测复用 piCheckNpm 的搜索目录链路：直接找 node 而不是 npm，
			// 因为引导的入口问题是「有没有 node」，npm 在便携包里随 node 一起出现。
			const systemNodeVersion = await probeSystemNodeVersion(piLocator);
			return await detectPiRuntimeNode(app.getPath("userData"), systemNodeVersion);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void appLogger.warn("pi", "Runtime node check failed", { error: message });
			return { installed: false, systemNodeAvailable: false, installSupported: true, error: message };
		}
	});

	/**
	 * 引导步骤 2：安装便携 Node 到 <userData>/pi-runtime/node。
	 * 镜像回退 + sha256 校验在 installPiRuntimeNode 内部完成；失败不抛 IPC 裸异常，
	 * 返回结构化 error 让弹窗内联展示。
	 */
	ipcMain.handle(ipcChannels.piRuntimeNodeInstall, async (): Promise<PiRuntimeNodeInstallResult> => {
		if (!piRuntimeNodeInstaller) {
			return { ok: false, error: "installer not available" };
		}
		try {
			const result = await installPiRuntimeNode(
				{
					userDataPath: app.getPath("userData"),
					log: (message, detail) => void appLogger.info("pi", message, { detail: detail ?? null }),
				},
				piRuntimeNodeInstaller,
			);
			void appLogger.info("pi", "Runtime node install completed", {
				ok: result.ok,
				source: result.source,
				version: result.version,
				error: result.error,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void appLogger.error("pi", "Runtime node install threw", { error: message });
			return { ok: false, error: message };
		}
	});

	/**
	 * 引导步骤 3：全局安装 pi。收紧通道：渲染层只传「是否用国内镜像」布尔意图，
	 * 命令由主进程拼接 —— 渲染层不可再注入任意 shell 字符串。
	 * npm 源优先用便携 node 自带的 npm；没有系统 node/npm 时拒绝执行（前面步骤未完成）。
	 */
	ipcMain.handle(ipcChannels.piRuntimePiInstall, async (_event, useMirror: unknown): Promise<PiInstallExecResult> => {
		// 边界校验：只认布尔；其他类型一律按 false（官方源）处理，不回退猜默认。
		const mirrorArg = useMirror === true;
		try {
			// 硬约束（用户明确要求）：本机已经有 pi 就**不再装第二份**。
			// 只在 UI 层不展示引导不够——检测总有覆盖不到的地方（自定义目录、别名、只在 GUI 看不见的 shell 里配的 PATH），
			// 一旦漏判，用户点一下就会真的多出一份，之后终端与 PiDeck 各用各的、更新走两条路。
			const settings = settingsStore.get();
			// WSL 模式下 pi 是发行版内的那一份：宿主机 npm 装出来的副本一条也用不上（PATH 与执行环境都在 Linux 侧），
			// 先按 WSL 目标探一次，既校验「已装」拦截，也避免往下走白白装一份宿主副本。
			const wslEnabled = process.platform === "win32" && settings.wslEnabled === true && Boolean(settings.wslDistro) && Boolean(settings.wslUser);
			const existing = await piLocator.listInstallations(settings.customPiPath, wslEnabled, settings.wslDistro, settings.wslUser);
			const guard = resolvePiInstallGuard(existing);
			if (guard.skip) {
				void appLogger.info("pi", "Runtime pi install skipped because pi already exists", {
					count: guard.installations.length,
					sources: guard.installations.map((item) => item.source),
					wsl: wslEnabled,
				});
				return { success: false, exitCode: null, stdout: "", stderr: "", alreadyInstalled: guard.installations };
			}
			if (wslEnabled) {
				// 发行版里确实没有 pi，而这一步只能装宿主机副本——直接说清楚，不要给用户装出一份用不上的 pi。
				const blocked = mainCopy("wsl.hostInstallBlocked");
				void appLogger.warn("pi", "Runtime pi install skipped in WSL mode", { distro: settings.wslDistro, user: settings.wslUser });
				return { success: false, exitCode: null, stdout: "", stderr: blocked };
			}
			const userData = app.getPath("userData");
			// npm 解析顺序：便携 node 同目录 npm（引导链路主路径）→ 系统 npm。
			// 便携目录层级由 piRuntimeNodeBinDir 统一给（POSIX 是 node/bin，Windows 是 node），
			// 自己拼 dirname(node) 容易在 POSIX 上错一层，导致永远回退到系统 npm。
			const portableBinDir = piRuntimeNodeBinDir(userData);
			const portableNpm = join(portableBinDir, process.platform === "win32" ? "npm.cmd" : "npm");
			const hasPortableNpm = existsSync(portableNpm);
			// 系统 npm 无条件先探（不再只在便携缺失时探）：真全局安装是首选形态，见下方分派注释。
			const systemNpm = await probeSystemNpmVersion(piLocator);
			if (!systemNpm.available && !hasPortableNpm) {
				return {
					success: false,
					exitCode: null,
					stdout: "",
					stderr: "npm is not available; complete the node install step first",
				};
			}
			const npmArgs = ["install", "-g", "@earendil-works/pi-coding-agent"];
			if (mirrorArg) {
				// 国内镜像：只追加 --registry 参数，不改全局配置，用户终端环境零污染。
				npmArgs.push("--registry=https://registry.npmmirror.com");
			}
			// 安装形态分派（2026-10 起用户明确要求）：首选**真全局**——系统 npm 直接
			// `install -g`（不带 --prefix），pi 落进用户自己的 npm 全局目录，终端与 PiDeck
			// 用同一份、更新走同一条路，不再默认塞进 PiDeck 私有前缀。
			// 仅在：①系统 npm 不可用（只有便携 node），或 ②真全局遭遇布局性失败
			//（spawn 不起来 / EACCES/EPERM，典型是 macOS/Linux 全局目录需提权）时，
			// 才回退 PiDeck 前缀（<userData>/pi-runtime/pi-global，用户目录内、免提权）；
			// 回退形态的自更新由 ExtensionManager 的 portable-prefix 通道代管，不会停旧。
			const prefixDir = join(userData, "pi-runtime", "pi-global");
			// 启动规格交给 PiLocator 解析：Windows 的 npm 是 .cmd 垫片，execFile 直启必 ENOENT
			// （详见 runPiGlobalInstall 注释），只有经它解析（node 直启 / cmd.exe）才真正跑得起来。
			const runInstall = (npmCommand: string, usePrefix: boolean) =>
				runPiGlobalInstall({
					npmCommand,
					npmArgs,
					...(usePrefix ? { prefixDir } : {}),
					launcher: {
						createInvocation: (command, args) => piLocator.createInvocation(command, args),
						// 参数顺序陷阱：createProcessEnv 首个参数是代理设置，pathPrefix 在第二位。
						createProcessEnv: (pathPrefix) => piLocator.createProcessEnv(undefined, pathPrefix),
					},
					cwd: app.getPath("home"),
					// 包一层而不是直接把 execFile 传进去：Node 的 execFile 是重载签名，
					// 显式适配后模块契约只需覆盖「数组传参 + utf8 回调」这一种形态。
					execFileImpl: (command, args, options, callback) => execFile(command, args, options, callback),
				});
			let outcome: Awaited<ReturnType<typeof runPiGlobalInstall>>;
			let installMode: "system-global" | "pideck-prefix" = "pideck-prefix";
			if (systemNpm.available) {
				installMode = "system-global";
				outcome = await runInstall("npm", false);
				const failed = !outcome.success || outcome.exitCode !== 0;
				// 布局性失败（无权写全局目录 / 起不来）才值得换前缀重试；网络/源错误换前缀也一样失败，
				// 不做无谓重试，把原始错误直接还给用户。
				const layoutSpecific = failed && (outcome.exitCode === -1 || /EACCES|EPERM|permission denied|ENOENT/i.test(outcome.stderr));
				if (layoutSpecific && hasPortableNpm) {
					void appLogger.warn("pi", "Runtime pi system-global install hit a layout failure; falling back to PiDeck prefix", {
						exitCode: outcome.exitCode,
						stderrPreview: outcome.stderr.slice(0, 200),
					});
					installMode = "pideck-prefix";
					outcome = await runInstall(portableNpm, true);
				}
			} else {
				outcome = await runInstall(portableNpm, true);
			}
			void appLogger.info("pi", "Runtime pi install started", {
				mode: installMode,
				systemNpm: systemNpm.available,
				useMirror: mirrorArg,
				prefix: installMode === "pideck-prefix" ? prefixDir : undefined,
			});
			const { launchCommand, launchChannel, launchFallbackReason, ...result } = outcome;
			void appLogger.info("pi", "Runtime pi install completed", {
				success: result.success,
				exitCode: result.exitCode,
				stdoutLength: result.stdout.length,
				stderrLength: result.stderr.length,
				launch: launchCommand,
				launchChannel,
				launchFallbackReason,
				// 仅 spawn 层失败时带片段：这时 npm 一行没执行，stderr 只会是 Node 自己的报错，
				// 没有 npm 输出也没有 registry 凭据面；缺了它日志里只剩 stdout/stderr=0 无从诊断。
				stderrPreview: result.exitCode === -1 ? result.stderr.slice(0, 200) : undefined,
			});
			// 引导安装写完 pi 后必须让安装列表重新枚举，否则用户点「重新检测」看到的还是旧列表。
			if (result.success && result.exitCode === 0) invalidatePiInstallationCache();
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void appLogger.error("pi", "Runtime pi install threw", { error: message });
			return { success: false, exitCode: null, stdout: "", stderr: message };
		}
	});

	// ── Pi 更新 ──────────────────────────────────────────────────────

	if (extensionManager) {
		ipcMain.handle(ipcChannels.piUpdateCheck, async () => {
			const result = await extensionManager.checkPiUpdate();
			// 这次检查已经真跑过 `pi --version`：同步给后台快照，否则应用内「更新 pi」成功后
			// 侧栏圆点仍停在「pi 有新版本」（与设置页刚显示的「已是最新版本」矛盾）。
			updateService?.applyPiCheckResult(result);
			void appLogger.info("pi", "Pi update check completed", { currentVersion: result.currentVersion, latestVersion: result.latestVersion, hasUpdate: result.hasUpdate, error: result.error });
			return result;
		});
		ipcMain.handle(ipcChannels.piUpdate, async () => {
			const result = await extensionManager.updatePi();
			if (result.updated) void refreshPiModelCatalogs().catch(() => undefined);
			void appLogger.info("pi", "Pi update command completed", { updated: result.updated, bytes: result.output.length });
			return result;
		});
		// pi 更新日志：用户点「更新详情」才按需拉取（不参与版本检查的自动调度）。
		ipcMain.handle(ipcChannels.piReleaseNotes, async (_event, rawOptions) => {
			// 输入校验在边界：渲染层数据一律不可信，版本号必须是 semver 形态的字符串。
			const options = (rawOptions ?? {}) as { latestVersion?: unknown; currentVersion?: unknown };
			const latestVersion = typeof options.latestVersion === "string" ? options.latestVersion : "";
			const currentVersion = typeof options.currentVersion === "string" ? options.currentVersion : undefined;
			const result = await piChangelogService.getReleaseNotes({ latestVersion, currentVersion });
			void appLogger.info("pi", "Pi release notes fetched", { source: result.source, versionCount: result.versionCount, truncated: result.truncated });
			return result;
		});
	}
}
