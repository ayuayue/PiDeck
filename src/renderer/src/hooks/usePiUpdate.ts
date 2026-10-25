import { useState, useCallback, useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { t } from "../i18n";
import { settingsOpenAtom } from "../atoms";
import { resolvePiStatusFromProbe } from "../utils/piStatusSync";
import type { AppSettings, NpmAvailabilityResult, PiCliUpdateResult, PiInstallation, PiInstallExecResult, PiInstallStatus, PiUpdateCheckResult } from "../../../shared/types";
import type { PiDesktopApi } from "../../../preload";

export interface UsePiUpdateOptions {
	settings: AppSettings;
	setSettings: (settings: AppSettings) => void;
	showToast: (message: string, duration?: number) => void;
	api: PiDesktopApi;
}

export function usePiUpdate(options: UsePiUpdateOptions) {
	const { settings, setSettings, showToast, api } = options;
	const setSettingsOpen = useSetAtom(settingsOpenAtom);

	// ---- Pi 环境状态（内部管理） ----
	const [piStatus, setPiStatus] = useState<PiInstallStatus | null>(null);
	const [piChecking, setPiChecking] = useState(false);
	const [environmentDialog, setEnvironmentDialog] = useState(false);
	/**
	 * 「安装引导」预览：开发时本机 pi 已装好，但仍想看清未安装态长什么样。
	 * 置 true 时弹窗无视检测结果直接渲染一键安装面板。只由开发入口打开，产品流程不会置位。
	 */
	const [environmentSetupPreview, setEnvironmentSetupPreview] = useState(false);
	// 探测到的全部 pi 安装（含官方 managed 安装）。null = 尚未检测过。
	// 只有一份时 UI 不需要选择；多份时必须让用户自己选（静默用其中一份是本次要修的坑）。
	const [piInstallations, setPiInstallations] = useState<PiInstallation[] | null>(null);
	/** 「从终端再找一次」正在跑交互式 shell 反查（按钮 loading 态） */
	const [piInstallationsProbing, setPiInstallationsProbing] = useState(false);
	/** 正在校验的安装路径（列表行内 loading）；显式自持而不靠 customPiPath 反推 ——
	 *  点击后 state 更新是异步的，用 customPiPath 反推会在错误的行上转圈。 */
	const [applyingInstallationPath, setApplyingInstallationPath] = useState<string | null>(null);
	/** 「浏览…」正在等待系统文件选择器返回 */
	const [browsingPiPath, setBrowsingPiPath] = useState(false);
	/**
	 * 用户自加的候选路径池：直接读设置（单一数据源）。
	 * 刻意不做本地镜像——镜像一旦没被初始化，随后的「移除」会按空数组回写，把已存路径全清掉。
	 */
	const piCustomPaths: readonly string[] = settings.piCustomPaths ?? [];

	// 恢复上次检测成功的缓存：打开开发设置直接显示（piInstall 来自 settings 持久化），
	// 不重复 spawn 检测；仅当本会话尚未检测过（piStatus 为 null）时生效。
	useEffect(() => {
		if (settings.piInstall && piStatus === null) {
			setPiStatus({
				installed: true,
				command: settings.piInstall.command,
				version: settings.piInstall.version,
				searchedDirs: [],
			});
		}
	}, [settings.piInstall, piStatus]);

	// piStatus 的 ref 快照：探测结果校正（syncPiStatusFromProbe）要读「当前显示值」，
	// 但它必须保持稳定身份——loadPiInstallations / checkPiCliUpdate 的依赖数组不能随 piStatus 变化重建。
	const piStatusRef = useRef<PiInstallStatus | null>(null);
	useEffect(() => {
		piStatusRef.current = piStatus;
	}, [piStatus]);

	// 缓存复核的会话级闸门（effect 本体在 persistPiInstall 声明之后）。
	const piStatusRevalidatedRef = useRef(false);

	// ---- Pi 更新相关 state ----
	const [piUpdating, setPiUpdating] = useState(false);
	const [piUpdateChecking, setPiUpdateChecking] = useState(false);
	const [piUpdateCheck, setPiUpdateCheck] = useState<PiUpdateCheckResult | null>(null);
	const [piUpdateResult, setPiUpdateResult] = useState<PiCliUpdateResult | null>(null);

	// ---- Pi 代理相关 state ----
	const [piProxyNotice, setPiProxyNotice] = useState("");
	const [piProxyNoticeTone, setPiProxyNoticeTone] = useState<"info" | "success" | "error">("info");
	const [piProxyChecking, setPiProxyChecking] = useState(false);

	// ---- 自定义 Pi 路径相关 state ----
	const [customPiPath, setCustomPiPath] = useState("");
	const [customPathValidating, setCustomPathValidating] = useState(false);
	const [customPathResult, setCustomPathResult] = useState<PiInstallStatus | null>(null);

	// ---- npm 安装相关 state ----
	const [npmAvailable, setNpmAvailable] = useState<boolean | null>(null);
	const [npmVersion, setNpmVersion] = useState<string | undefined>(undefined);
	const [npmChecking, setNpmChecking] = useState(false);
	const [installCommand, setInstallCommand] = useState("npm install -g @earendil-works/pi-coding-agent");
	const [installUseMirror, setInstallUseMirror] = useState(false);
	const [installExecuting, setInstallExecuting] = useState(false);
	const [installResult, setInstallResult] = useState<PiInstallExecResult | null>(null);
	const [installCompleted, setInstallCompleted] = useState(false);

	// ---- Pi 检测函数 ----
	// 检测成功后把命令路径/版本写入 settings 缓存：打开开发设置直接显示缓存结果，
	// 不重复 spawn 检测；手动点「检测环境」才重新探测。
	const persistPiInstall = useCallback(
		async (status: PiInstallStatus) => {
			if (status.installed && status.command && status.version) {
				return api.settings.update({ piInstall: { command: status.command, version: status.version } });
			}
			// 未检测到：清除旧缓存，避免残留上一台机器/旧路径的结果
			return api.settings.update({ piInstall: undefined });
		},
		[api],
	);

	/**
	 * 用一次「实时探测」出的版本校正顶部状态与持久化缓存。
	 *
	 * 为什么要单独一条链路：settings.piInstall 只在探测时刷新，而 pi 会被外部升级（`npm install -g`、
	 * `pi update`，都绕开 PiDeck）。运行期间用户升级完，「检查 Pi 更新」/安装列表已经拿到新版本，
	 * 顶部却还显示旧版本（实测同屏「已找到 1.1.0」+ 列表 v1.2.0，还伴随「Pi 已是最新版本」提示）。
	 * 凡是真跑过 `pi --version` 的结果都必须与缓存比对，不一致就以探测结果回写。
	 *
	 * 失败必须自收：写 settings 只是缓存维护，不能因为一次写盘失败把调用方的正常流程带崩
	 * （安装列表已经拿到了，不能让它的 catch 退化成空数组）；持久化失败仅意味着下次启动缓存仍旧，
	 * 届时会由会话级复核再次纠正。
	 */
	const syncPiStatusFromProbe = useCallback(
		async (probe: { command?: string; version?: string }) => {
			const next = resolvePiStatusFromProbe(piStatusRef.current, probe);
			if (!next) return;
			setPiStatus(next);
			try {
				setSettings(await persistPiInstall(next));
			} catch {
				// 静默：顶部已经显示真实版本，只有缓存没跟上
			}
		},
		[persistPiInstall, setSettings],
	);

	// 缓存恢复后按会话静默复核一次：pi 可能已被外部升级（npm/self-update），
	// 持久化的版本会永久过期——startup 检测只在首次引导跑（piEnvironmentChecked 之后
	// 没人纠正缓存，实测 dev 实例停在 0.84.4 而真实已是 1.0.2）。
	// hook 挂在 App 上，此 effect 随应用启动触发，每渲染会话至多一次 spawn，
	// 不违反「打开设置页不自动检测 pi」的约束（tests/piUpdateStartupNotice.test.mjs）。
	useEffect(() => {
		if (piStatusRevalidatedRef.current || !settings.piInstall || !piStatus?.installed) return;
		piStatusRevalidatedRef.current = true;
		void (async () => {
			try {
				const next = await api.pi.check(false);
				// 只在确认仍安装时纠正展示与缓存：探测失败可能是暂时性的（杀软锁文件等），
				// 不用「疑似未安装」静默盖掉上次成功的结果。
				if (!next.installed) return;
				await syncPiStatusFromProbe({ command: next.command, version: next.version });
			} catch {
				// 静默失败：缓存照常显示，真实错误由下次手动检测或会话启动暴露。
			}
		})();
	}, [settings.piInstall, piStatus, api, syncPiStatusFromProbe]);

	/**
	 * 拉取全部 pi 安装。
	 * `forceShellProbe` = 用户在弹窗/设置页点「从终端再找一次」：额外跑一次交互式登录 shell 反查
	 * （zsh/自定义 PATH 等扫描目录覆盖不到的情况）。失败不抛错：探测不到列表只退化成现有单结果视图。
	 */
	const loadPiInstallations = useCallback(
		async (options: { forceShellProbe?: boolean } = {}) => {
			if (options.forceShellProbe) setPiInstallationsProbing(true);
			try {
				const list = await api.pi.listInstallations(options.forceShellProbe === true);
				setPiInstallations(list);
				// 列表里「当前使用」那条的版本也是真跑 `pi --version` 得来的：顺带校正顶部显示与缓存，
				// 用户不点「检测环境」也能看到外部升级后的真实版本（列表与顶部显示同一版本）。
				const active = list.find((item) => item.isActive);
				if (active?.version) await syncPiStatusFromProbe({ command: active.path, version: active.version });
				return list;
			} catch {
				setPiInstallations([]);
				return [];
			} finally {
				if (options.forceShellProbe) setPiInstallationsProbing(false);
			}
		},
		[api, syncPiStatusFromProbe],
	);

	const checkPiInstall = useCallback(
		async (source: "startup" | "manual" = "manual", runOptions?: { keepOpen?: boolean }) => {
			setSettingsOpen(false);
			setPiChecking(true);
			setEnvironmentDialog(true);
			try {
				// manual = 用户点「检测环境」，忽略 WSL 探测缓存重新扫描；startup 沿用启动预热结果
				const next = await api.pi.check(source === "manual");
				setPiStatus(next);
				// 安装列表与状态一起拿：多份安装时弹窗要展示选择列表，且不能自动关闭。
				const installations = next.installed ? await loadPiInstallations({ forceShellProbe: source === "manual" }) : [];
				// 检测结果缓存（含未检测到的清除）；startup 额外标记 piEnvironmentChecked
				const saved = await persistPiInstall(next);
				setSettings(saved);
				// 只有一份安装（或没找到）时才自动关窗：多份安装必须留给用户选择。
				const canAutoClose = installations.length <= 1;
				if (next.installed && source === "startup") {
					// 检测到 pi 就算「引导已完成」：多份安装时弹窗会留在屏幕上让用户选，
					// 但不能因此每次启动都强制弹一次（用户也可以从设置页随时切换）。
					const marked = await api.settings.update({ piEnvironmentChecked: true });
					setSettings(marked);
					if (canAutoClose && !runOptions?.keepOpen) window.setTimeout(() => setEnvironmentDialog(false), 3000);
				}
				if (next.installed && source === "manual" && canAutoClose && !runOptions?.keepOpen) window.setTimeout(() => setEnvironmentDialog(false), 3000);
				// 回传给调用方（一键安装的「重新检测」步骤据此判定装完能不能看到 pi）。
				return next;
			} finally {
				setPiChecking(false);
			}
		},
		[api, setPiStatus, setPiChecking, setSettings, setSettingsOpen, setEnvironmentDialog, persistPiInstall, loadPiInstallations],
	);

	/**
	 * 手动打开「环境检测 / 安装引导」（命令面板、开发预览共用）。
	 * previewSetup=true 时固定渲染未安装态的一键安装面板，用来在不拆 PATH 的情况下看效果。
	 */
	const openEnvironmentGuide = useCallback(
		(options?: { previewSetup?: boolean }) => {
			setEnvironmentSetupPreview(options?.previewSetup === true);
			void checkPiInstall("manual", { keepOpen: options?.previewSetup === true });
		},
		[checkPiInstall],
	);

	const checkPiInstallInline = useCallback(async () => {
		setPiChecking(true);
		setCustomPathResult(null);
		try {
			// 设置页的显式重检：强制重探 WSL，否则刚装完 pi 的用户要等负缓存过期
			const next = await api.pi.check(true);
			setPiStatus(next);
			if (next.installed) {
				const saved = await api.settings.update({
					piEnvironmentChecked: true,
					piInstall: next.command && next.version ? { command: next.command, version: next.version } : undefined,
				});
				setSettings(saved);
				showToast(
					t("app.piCheckPassed", {
						value: next.command ?? next.version ?? "pi",
					}),
				);
			} else {
				setSettingsOpen(false);
				setEnvironmentDialog(true);
				setPiStatus(next);
				// 未检测到：清除旧缓存
				const saved = await api.settings.update({ piInstall: undefined });
				setSettings(saved);
			}
			// 版本/安装集合可能变了（例如刚升完 pi）：列表跟状态一起刷新
			await loadPiInstallations();
		} finally {
			setPiChecking(false);
		}
	}, [api, setPiStatus, setPiChecking, setSettings, setSettingsOpen, setEnvironmentDialog, loadPiInstallations]);

	// ---- 自定义 Pi 路径 ----
	const validateCustomPiPath = useCallback(
		async (options: { closeDialogOnSuccess?: boolean; path?: string; activate?: boolean } = {}) => {
			// path 显式传入时优先：安装列表里的「使用这个」是异步点击，不能依赖 customPiPath state（可能还是旧值）
			const path = (options.path ?? customPiPath).trim();
			if (!path) return;
			setCustomPathValidating(true);
			setCustomPathResult(null);
			try {
				// activate=false：只校验路径可用性，不改「当前使用」——编辑一条非当前使用的备选路径时用。
				const result = await api.pi.checkCustom(path, options.activate !== false);
				setCustomPathResult(result);
				if (result.installed) {
					const updated = await api.settings.get();
					setSettings(updated);
					setCustomPiPath(updated.customPiPath ?? result.command ?? path);
					setPiStatus(result);
					// 自定义路径检测成功同样写入缓存，打开设置直接显示
					void persistPiInstall(result);
					// 当前使用项变了：重拉列表让「当前使用」徽章跟着走（主进程已失效缓存）
					void loadPiInstallations();
					showToast(
						t("app.piPathSaved", {
							path: result.command ?? updated.customPiPath ?? path,
						}),
					);
					if (options.closeDialogOnSuccess) {
						window.setTimeout(() => setEnvironmentDialog(false), 3000);
					}
				} else {
					showToast(
						t("app.piPathValidateFailed", {
							error: result.error ?? t("environment.unableToRun"),
						}),
					);
				}
			} finally {
				setCustomPathValidating(false);
			}
		},
		[customPiPath, api, setPiStatus, setSettings, setEnvironmentDialog, persistPiInstall, loadPiInstallations],
	);

	/** 从安装列表里选定一份：校验通过后落盘 customPiPath，以后启动/更新/扩展都用它。 */
	const choosePiInstallation = useCallback(
		async (path: string) => {
			setApplyingInstallationPath(path);
			setCustomPiPath(path);
			try {
				await validateCustomPiPath({ path, closeDialogOnSuccess: true });
			} finally {
				setApplyingInstallationPath(null);
			}
		},
		[validateCustomPiPath],
	);

	/** 把「用户自加的候选路径」写回主进程（主进程做绝对路径/去重/限额校验），并以主进程落盘结果刷新本地设置。 */
	const persistPiCustomPaths = useCallback(
		async (paths: readonly string[]) => {
			const saved = await api.pi.setCustomPaths(paths);
			// 主进程可能丢掉非法/重复项，也可能因“移除的就是当前使用项”而一并清空 customPiPath：
			// 统一以落盘后的设置为准，不做本地乐观更新。
			setSettings(await api.settings.get());
			return saved;
		},
		[api, setSettings],
	);

	/**
	 * 添加一条自定义路径：先实跑校验，通过后入池并**立即切换为当前使用**（产品确认的默认行为）。
	 * 校验失败只提示不写入——避免池子里躺一条跑不起来的路径让用户困惑。
	 */
	const addPiCustomPath = useCallback(
		async (path: string) => {
			const trimmed = path.trim();
			if (!trimmed) return;
			setApplyingInstallationPath(trimmed);
			try {
				const result = await api.pi.checkCustom(trimmed, true);
				if (!result.installed) {
					showToast(t("app.piPathValidateFailed", { error: result.error ?? t("environment.unableToRun") }));
					return;
				}
				await persistPiCustomPaths([...piCustomPaths, result.command ?? trimmed]);
				const updated = await api.settings.get();
				setSettings(updated);
				setCustomPiPath(updated.customPiPath ?? result.command ?? trimmed);
				setPiStatus(result);
				void persistPiInstall(result);
				await loadPiInstallations();
				showToast(t("app.piPathSaved", { path: result.command ?? trimmed }));
			} finally {
				setApplyingInstallationPath(null);
			}
		},
		[api, piCustomPaths, persistPiCustomPaths, setSettings, setPiStatus, persistPiInstall, loadPiInstallations],
	);

	/**
	 * 编辑一条自定义路径：原地替换（保留位置）；只有原路径就是当前使用时才顺带切换，
	 * 否则“改备选”不该悄悄改掉正在跑的那份。
	 */
	const updatePiCustomPath = useCallback(
		async (previousPath: string, nextPath: string) => {
			const trimmed = nextPath.trim();
			if (!trimmed) return;
			setApplyingInstallationPath(previousPath);
			try {
				const result = await api.pi.checkCustom(trimmed, false);
				if (!result.installed) {
					showToast(t("app.piPathValidateFailed", { error: result.error ?? t("environment.unableToRun") }));
					return;
				}
				// 历史 settings 里可能只有一个 customPiPath、没有进过池子：编辑时必须补进池子，
				// 否则“改完保存”看起来生效了、下次打开又变回旧值。
				const replaced = piCustomPaths.includes(previousPath) ? piCustomPaths.map((item) => (item === previousPath ? trimmed : item)) : [...piCustomPaths, trimmed];
				await persistPiCustomPaths(replaced);
				if (customPiPath === previousPath) {
					setCustomPiPath(trimmed);
					const activated = await api.pi.checkCustom(trimmed, true);
					setPiStatus(activated);
				}
				await loadPiInstallations();
				showToast(t("app.piPathSaved", { path: trimmed }));
			} finally {
				setApplyingInstallationPath(null);
			}
		},
		[api, piCustomPaths, customPiPath, persistPiCustomPaths, setPiStatus, loadPiInstallations],
	);

	/**
	 * 移除一条自定义路径。若删的正好是当前使用项，主进程会一并清空 customPiPath（回落到自动检测首选），
	 * 这里据此重新检测一次并把「已回落」告诉用户——不能让界面停在“当前使用一份不存在的路径”。
	 */
	const removePiCustomPath = useCallback(
		async (path: string) => {
			const saved = await persistPiCustomPaths(piCustomPaths.filter((item) => item !== path));
			if (saved.clearedActive) {
				const status = await api.pi.check(true);
				setPiStatus(status);
				showToast(t("app.piPathRemovedFallback"));
			}
			await loadPiInstallations();
		},
		[api, piCustomPaths, persistPiCustomPaths, setPiStatus, loadPiInstallations],
	);

	/**
	 * 「浏览…」：用系统文件选择器挑一个 pi 可执行文件（稀有/自定义安装在扫描目录之外时用）。
	 * 选完立即校验并落盘，与手输路径完全同一条链路（归一化、兼容 pi.cmd、失败提示）。
	 */
	const browsePiPath = useCallback(async () => {
		setBrowsingPiPath(true);
		try {
			const picked = await api.pi.chooseExecutable();
			if (!picked) return;
			// 走与「添加路径」完全同一条链路：校验 → 入池 → 立即使用。
			await addPiCustomPath(picked);
		} finally {
			setBrowsingPiPath(false);
		}
	}, [api, addPiCustomPath]);

	// ---- npm ----
	const checkNpm = useCallback(async () => {
		setNpmChecking(true);
		try {
			const result = await api.pi.checkNpm();
			setNpmAvailable(result.available);
			setNpmVersion(result.version);
		} finally {
			setNpmChecking(false);
		}
	}, [api]);

	const execInstallCommand = useCallback(async () => {
		const cmd = installCommand.trim();
		if (!cmd) return;
		setInstallExecuting(true);
		setInstallResult(null);
		setInstallCompleted(false);
		try {
			const result = await api.pi.execInstall(cmd);
			setInstallResult(result);
			if (result.success && result.exitCode === 0) {
				setInstallCompleted(true);
			}
		} finally {
			setInstallExecuting(false);
		}
	}, [installCommand, api]);

	// ---- Pi CLI 更新 ----
	// 启动不再自动检查 pi 更新（toast 打扰启动流程）；仅设置页手动检查。
	const checkPiCliUpdate = useCallback(async () => {
		setPiUpdateChecking(true);
		try {
			const result = await api.pi.checkUpdate();
			setPiUpdateCheck(result);
			// 「检查 Pi 更新」就是一次真探测：版本不一致时校正顶部，避免“已是最新版本”与顶部旧版本并存（外部升级后必现）。
			await syncPiStatusFromProbe({ command: result.command, version: result.currentVersion });
			showToast(result.error ? t("settings.piUpdateFailed", { error: result.error }) : result.hasUpdate ? t("settings.piUpdateAvailable") : t("settings.piUpdateChecked"));
		} finally {
			setPiUpdateChecking(false);
		}
	}, [api, syncPiStatusFromProbe]);

	const updatePiCli = useCallback(async () => {
		setPiUpdating(true);
		setPiUpdateResult(null);
		try {
			const result = await api.pi.update();
			setPiUpdateResult(result);
			await checkPiInstallInline();
			setPiUpdateCheck(await api.pi.checkUpdate());
			showToast(result.updated ? t("settings.piUpdateDone") : t("settings.piUpdateChecked"));
		} catch (error) {
			showToast(
				t("settings.piUpdateFailed", {
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		} finally {
			setPiUpdating(false);
		}
	}, [api, checkPiInstallInline]);

	// ---- Pi 代理测试 ----
	const testPiProxy = useCallback(async () => {
		setPiProxyChecking(true);
		setPiProxyNoticeTone("info");
		setPiProxyNotice(t("app.proxyChecking"));
		try {
			const result = await api.settings.testPiProxy();
			setPiProxyNoticeTone(result.success ? "success" : "error");
			setPiProxyNotice(
				result.success
					? t("app.proxyAvailable", {
							message: result.message ?? t("app.proxyDefaultOk"),
							elapsed: result.elapsedMs,
						})
					: t("app.proxyCheckFailed", {
							error: result.error ?? t("app.proxyUnknownError"),
						}),
			);
		} catch (error) {
			setPiProxyNoticeTone("error");
			setPiProxyNotice(
				t("app.proxyCheckFailed", {
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		} finally {
			setPiProxyChecking(false);
		}
	}, [api]);

	return {
		// exposed state
		piStatus,
		setPiStatus,
		piChecking,
		piInstallations,
		piInstallationsProbing,
		applyingInstallationPath,
		browsingPiPath,
		piCustomPaths,
		environmentDialog,
		setEnvironmentDialog,
		environmentSetupPreview,
		setEnvironmentSetupPreview,
		openEnvironmentGuide,
		piUpdating,
		piUpdateChecking,
		piUpdateCheck,
		piUpdateResult,
		piProxyNotice,
		piProxyNoticeTone,
		piProxyChecking,
		customPiPath,
		customPathValidating,
		customPathResult,
		installCommand,
		installUseMirror,
		installExecuting,
		installCompleted,
		installResult,
		npmChecking,
		npmAvailable,
		npmVersion,
		// setters
		setCustomPiPath,
		setCustomPathValidating,
		setCustomPathResult,
		setInstallCommand,
		setInstallUseMirror,
		setInstallExecuting,
		setInstallResult,
		setInstallCompleted,
		setNpmAvailable,
		setNpmVersion,
		setNpmChecking,
		setPiProxyNotice,
		setPiProxyNoticeTone,
		setPiProxyChecking,
		setPiUpdating,
		setPiUpdateChecking,
		setPiUpdateCheck,
		setPiUpdateResult,
		// functions
		checkPiInstall,
		checkPiInstallInline,
		loadPiInstallations,
		choosePiInstallation,
		browsePiPath,
		addPiCustomPath,
		updatePiCustomPath,
		removePiCustomPath,
		validateCustomPiPath,
		checkNpm,
		execInstallCommand,
		checkPiCliUpdate,
		updatePiCli,
		testPiProxy,
	};
}

export type PiUpdateController = ReturnType<typeof usePiUpdate>;
