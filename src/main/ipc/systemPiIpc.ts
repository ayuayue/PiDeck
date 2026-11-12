/**
 * pi 检测 / 安装 IPC 域（自 systemIpc.ts 拆出：handler 体、通道、日志与文案逐字未改）。
 * 通道：pi:check / pi:installations / pi:set-custom-paths / pi:choose-executable /
 * pi:check-custom / pi:exec-install / pi:check-npm。
 */
import { app, dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { NpmAvailabilityResult, PiInstallExecResult } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import { invalidatePiInstallationCache, type PiLocator } from "../pi/PiLocator";
import { sanitizePiCustomPaths } from "../pi/piCustomPaths";
import { validateInstallCommand } from "../pi/installCommandPolicy";

export type SystemPiIpcDeps = {
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	appLogger: AppLogger;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	/** 后台更新快照：piCheck 发现快照过期时补一轮检查（未装配 = 不打网络）。 */
	updateService?: {
		getSnapshot: () => import("../../shared/types").AppUpdateStatusSnapshot;
		checkNow: () => Promise<void>;
	};
	/** 模型目录缓存失效重建（systemIpc 内的同一份闭包，不复制第二份定义）。 */
	refreshPiModelCatalogs: () => Promise<void>;
};

export function registerSystemPiIpc(deps: SystemPiIpcDeps): void {
	const { piLocator, settingsStore, appLogger, mainCopy, updateService, refreshPiModelCatalogs } = deps;

	// ── Pi 检测 ──────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.piCheck, async (_event, force?: unknown) => {
		const settings = settingsStore.get();
		// 渲染层输入不可信：只认布尔 true，其他一律当非强制重检
		const forceWslProbe = force === true;
		// WSL 模式必须按当前设置探测（customPiPath 仍是宿主机语义，wsl 三件套决定是否切到 wsl:// 解析），
		// 否则设置页切到 WSL 后状态卡永远显示宿主机 pi（#484 后续回归：2bc73a783 拿掉传参、5ee923a8f 恢复全局 WSL 设置时漏了这里）。
		const status = await piLocator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser, { forceWslProbe });
		void appLogger.info("pi", "Pi check completed", {
			installed: status.installed,
			version: status.version,
			command: status.command,
			error: status.error,
			forceWslProbe,
		});
		// 探测到的版本与后台更新快照不一致 = 快照已过期（pi 被外部升级过）：主动补一轮检查，
		// 否则侧栏设置按钮的「有新版本」圆点会一直停在已被超越的版本上，直到下一轮 2h 定时检查。
		// 快照尚未建立（首启首查前）时跳过：启动调度自己会查，不必提前打一轮网络。
		const snapshotPiVersion = updateService?.getSnapshot().piCli?.currentVersion;
		if (updateService && status.installed && status.version && snapshotPiVersion && snapshotPiVersion !== status.version) {
			void updateService.checkNow().catch((error: unknown) => {
				appLogger.warn("pi", "Pi update snapshot refresh failed", { error: error instanceof Error ? error.message : String(error) });
			});
		}
		return status;
	});

	/**
	 * 列出全部 pi 安装（含官方安装器的 managed 安装）。
	 *
	 * `force` = 用户显式点「从终端再找一次」：额外跑一次交互式登录 shell 反查并绕过列表缓存。
	 * 渲染层输入不可信，只认布尔 true。
	 */
	ipcMain.handle(ipcChannels.piInstallations, async (_event, force?: unknown) => {
		const settings = settingsStore.get();
		const forceShellProbe = force === true;
		// 与 piCheck 同理：WSL 模式下按设置探测（listInstallations 只返回发行版内正在用的那一份）。
		const installations = await piLocator.listInstallations(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser, { forceShellProbe, customPaths: settings.piCustomPaths });
		void appLogger.info("pi", "Pi installations listed", {
			count: installations.length,
			forceShellProbe,
			// 只记来源与版本：路径可能含 username，日志里不需要它（诊断报告另有脱敏路径）
			sources: installations.map((item) => `${item.source}:${item.version ?? "unknown"}`),
		});
		return installations;
	});

	/**
	 * 保存用户自加的 pi 候选路径（设置页列表的「我添加的」分组）。
	 *
	 * 入参不可信：只接数组，逐条校验绝对路径/wsl 标记、去重、限额（见 sanitizePiCustomPaths）。
	 * 额外处理「移除的正好是当前使用的那条」：同步清空 customPiPath，让解析回落到自动检测的首选——
	 * 否则会留下一份指向已被用户删掉的路径的“当前使用”状态。
	 */
	ipcMain.handle(ipcChannels.piSetCustomPaths, async (_event, input: unknown) => {
		const settings = settingsStore.get();
		const { paths, rejected } = sanitizePiCustomPaths(input);
		const activePath = settings.customPiPath.trim();
		const activeStillPresent = !activePath || paths.some((path) => path === activePath);
		const next = await settingsStore.update(activeStillPresent ? { piCustomPaths: paths } : { piCustomPaths: paths, customPiPath: "" });
		invalidatePiInstallationCache();
		void appLogger.info("pi", "Pi custom paths saved", {
			count: paths.length,
			rejected: rejected.length,
			// 仅记「当前使用是否被一并清空」，不记路径本身
			clearedActive: !activeStillPresent,
		});
		return { paths: next.piCustomPaths, clearedActive: !activeStillPresent };
	});

	/** 打开文件选择器挑 pi 可执行文件（稀有/自定义安装场景）。取消返回 null。 */
	ipcMain.handle(ipcChannels.piChooseExecutable, async () => {
		const options = {
			properties: ["openFile"],
			title: mainCopy("mainPi.chooseExecutableTitle"),
			filters:
				process.platform === "win32"
					? [
							{ name: "Executables", extensions: ["exe", "cmd", "bat"] },
							{ name: "All Files", extensions: ["*"] },
						]
					: [{ name: "All Files", extensions: ["*"] }],
		} satisfies Electron.OpenDialogOptions;
		const result = await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});

	/**
	 * 校验一条用户给出的 pi 路径。
	 * `activate=false` 只校验不落 customPiPath——设置页「编辑备选路径」不能因此改掉正在使用的那份。
	 */
	ipcMain.handle(ipcChannels.piCheckCustom, async (_event, customPath: string, activate?: unknown) => {
		const shouldActivate = activate !== false;
		const settings = settingsStore.get();
		const status = await piLocator.validateCustomPath(customPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		if (status.installed && status.command && shouldActivate) {
			await settingsStore.update({ customPiPath: status.command });
			// 自定义路径变了，当前使用项/排序跟着变；不清缓存会让设置页在 TTL 内显示旧列表。
			invalidatePiInstallationCache();
			void refreshPiModelCatalogs().catch(() => undefined);
		}
		void appLogger.info("pi", "Custom pi path checked", {
			installed: status.installed,
			version: status.version,
			command: status.command,
			error: status.error,
		});
		return status;
	});

	// ── Pi 安装 / NPM ────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.piExecInstall, async (_event, command: string): Promise<PiInstallExecResult> => {
		// IPC 边界第一行职责是校验：安装命令白名单化（installCommandPolicy），
		// 拒绝任意 shell 串直通 cmd.exe /c / sh -c（渲染层输入不可信）。
		const check = validateInstallCommand(command);
		if (!check.ok) {
			void appLogger.warn("pi", "Install command rejected", { command, reason: check.reason });
			return { success: false, exitCode: -1, stdout: "", stderr: `Command rejected: ${check.reason}` };
		}
		const normalized = check.command;
		void appLogger.info("pi", "Executing install command", { command: normalized });
		try {
			const { execFile } = await import("node:child_process");
			const result = await new Promise<import("../../shared/types").PiInstallExecResult>((resolve) => {
				const isWin = process.platform === "win32";
				if (isWin) {
					const child = execFile(
						process.env.ComSpec || "cmd.exe",
						["/d", "/s", "/c", normalized],
						{
							cwd: app.getPath("home"),
							timeout: 120_000,
							// 复用 PiLocator 搜索目录拼 PATH：桌面端继承的注册表 PATH 不含版本管理器
							// （mise/fnm/volta/scoop 等）在 shell 会话里动态注入的目录，终端可用而
							// 桌面端“找不到 npm”即源于此；前置搜索目录后 npm 才能被 cmd 解析到。
							env: { ...piLocator.createProcessEnv(), npm_config_fund: "false", npm_config_audit: "false" },
							windowsHide: true,
							encoding: "utf8",
							shell: false,
						},
						(error: unknown, stdout: string, stderr: string) => {
							const execError = error as { code?: number | string } | null;
							resolve({
								success: !error,
								exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
								stdout: stdout || "",
								stderr: stderr || "",
							});
						},
					);
				} else {
					execFile(
						"/bin/sh",
						["-c", normalized],
						{
							cwd: app.getPath("home"),
							timeout: 120_000,
							env: { ...piLocator.createProcessEnv(), npm_config_fund: "false", npm_config_audit: "false" },
							encoding: "utf8",
						},
						(error: unknown, stdout: string, stderr: string) => {
							const execError = error as { code?: number | string } | null;
							resolve({
								success: !error,
								exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
								stdout: stdout || "",
								stderr: stderr || "",
							});
						},
					);
				}
			});
			void appLogger.info("pi", "Install command completed", {
				success: result.success,
				exitCode: result.exitCode,
				stdoutLength: result.stdout.length,
				stderrLength: result.stderr.length,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void appLogger.error("pi", "Install command threw", { error: message });
			return { success: false, exitCode: -1, stdout: "", stderr: message };
		}
	});

	ipcMain.handle(ipcChannels.piCheckNpm, async (): Promise<import("../../shared/types").NpmAvailabilityResult> => {
		try {
			const { execFile } = await import("node:child_process");
			const result = await new Promise<import("../../shared/types").NpmAvailabilityResult>((resolve) => {
				const isWin = process.platform === "win32";
				if (isWin) {
					execFile(
						process.env.ComSpec || "cmd.exe",
						["/d", "/s", "/c", "npm --version"],
						{
							// 同 piExecInstall：npm 可能只存在于版本管理器动态目录中，
							// 必须用 PiLocator 搜索目录（含注册表 PATH）重建子进程 PATH。
							env: piLocator.createProcessEnv(),
							timeout: 10_000,
							encoding: "utf8",
							windowsHide: true,
							shell: false,
						},
						(error, stdout) => {
							if (error) {
								resolve({ available: false, error: error.message });
							} else {
								resolve({ available: true, version: stdout.trim() });
							}
						},
					);
				} else {
					execFile(
						"npm",
						["--version"],
						{
							// 非 Windows：/bin/sh -lc 已能拿到登录 shell PATH；仍叠加搜索目录
							// 兜底 GUI 启动时 Homebrew/fnm/mise 等动态路径缺失的场景。
							env: piLocator.createProcessEnv(),
							timeout: 10_000,
							encoding: "utf8",
						},
						(error, stdout) => {
							if (error) {
								resolve({ available: false, error: error.message });
							} else {
								resolve({ available: true, version: stdout.trim() });
							}
						},
					);
				}
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { available: false, error: message };
		}
	});
}
