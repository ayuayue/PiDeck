import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { AppInfo, AppSettings, Project } from "../../../../shared/types";
import { settingsFocusAtom, settingsOpenAtom, settingsPageOpenAtom } from "../../atoms";
import { cn } from "../../lib/utils";
import { updateStatusAtom } from "../../atoms/update-atoms";
import { flushUpdateInstallPreflight, updateInstallPreflightTasksAtom } from "../../atoms/update-install-preflight";
import { desktopApi as api } from "../../desktopApi";
import type { PiUpdateController } from "../../hooks/usePiUpdate";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

const SettingsModal = lazy(() => import("./SettingsModal").then((module) => ({ default: module.SettingsModal })));

type SettingsFeatureRootProps = {
	settings: AppSettings;
	piUpdate: PiUpdateController;
	webServiceChanging: boolean;
	onRestartWebService: () => void;
	appInfo: AppInfo;
	onChange: (patch: Partial<AppSettings>) => Promise<boolean>;
	/** 当前项目身份：项目资源 IPC 只接受主进程登记的 id。 */
	projectId?: string;
	/** PiDeck 当前加载的全部项目（作用域下拉展示；Chat 项目除外）。 */
	projects?: Array<{ id: string; name: string; kind?: Project["kind"] }>;
	/** Chat workspace has no project resource scope. */
	projectKind?: Project["kind"];
	/** 当前项目名称：作用域选择器显示用。 */
	projectName?: string;
	/** Tab 栏关闭叉的出口：由设置页写入带未保存确认的 handleClose（见 App 的关闭守卫）。 */
	closeRequestRef?: RefObject<(() => void) | null>;
};

/** Owns the Settings page tab and its commands without mirroring AppSettings. */
export function SettingsFeatureRoot(props: SettingsFeatureRootProps) {
	/** Tab 已打开（失活仍为 true）：决定页面子树挂载还是卸载。 */
	const open = useAtomValue(settingsPageOpenAtom);
	/** 当前正在呈现（页面 Tab 激活）：决定显隐与关闭语义。 */
	const active = useAtomValue(settingsOpenAtom);
	const setOpen = useSetAtom(settingsOpenAtom);
	const setFocus = useSetAtom(settingsFocusAtom);
	const setUpdateStatus = useSetAtom(updateStatusAtom);
	const updateStatus = useAtomValue(updateStatusAtom);
	const updateInstallPreflightTasks = useAtomValue(updateInstallPreflightTasksAtom);
	const updateInstallInFlightRef = useRef(false);
	// 打开设置页即视为「已看过」更新圆点解释（无论从侧栏/toast/深链进入）：
	// 用户已找到入口，coachmark 无需再弹（持久化标记，settings.update 幂等）。
	useEffect(() => {
		if (open) {
			void api.settings.update({ updateDotHintSeen: true }).catch(() => undefined);
		}
	}, [open]);

	// 设置页头部右上角是「保存/关闭」主操作，而全局 toast 固定右上角——两者在 1600px 窗口下
	// 正好重叠，toast 会拦住点击（e2e 里表现为关闭按钮被 Notifications 区域拒绝）。
	// 激活设置页时把通知整体下移一个页头高度（header 为 py-3 + text-base 行高 = 48px），
	// 失活或卸载立即复位，其他页面保持原位置。
	useEffect(() => {
		const root = document.documentElement;
		if (active) root.style.setProperty("--notice-top-shift", "48px");
		else root.style.removeProperty("--notice-top-shift");
		return () => {
			root.style.removeProperty("--notice-top-shift");
		};
	}, [active]);

	// 全局快捷键（macOS Cmd+, / Windows·Linux Ctrl+Alt+S）由主进程 before-input-event
	// 捕获后经 app:open-settings 广播（覆盖 webview 焦点与托盘隐藏唤起场景）；
	// 这里只负责打开弹窗——快捷键入口没有深链聚焦目标，无需动 settingsFocusAtom。
	useEffect(() => {
		return api.app.onOpenSettings(() => {
			setOpen(true);
		});
	}, [setOpen]);

	/**
	 * File editors debounce writes during normal typing. Before an updater-triggered process
	 * exit, explicitly flush every registered editor and keep the user in the app on failure.
	 */
	const installAppUpdate = useCallback(async () => {
		if (updateInstallInFlightRef.current) return;
		updateInstallInFlightRef.current = true;
		try {
			// manual 交付只是打开已下载的安装包，不退出应用，不需要编辑器落盘闸门。
			if (updateStatus?.deliveryMode === "manual") {
				await api.app.installUpdate();
				return;
			}
			const allSaved = await flushUpdateInstallPreflight(updateInstallPreflightTasks.values());
			if (!allSaved) {
				showNotice(t("update.saveBeforeInstallDetail"), 0, "error", t("update.saveBeforeInstallTitle"));
				return;
			}
			await api.app.installUpdate();
		} catch (error) {
			showNotice(
				t("update.installFailedDetail", {
					error: error instanceof Error ? error.message : String(error),
				}),
				0,
				"error",
				t("update.installFailedTitle"),
			);
		} finally {
			updateInstallInFlightRef.current = false;
		}
	}, [updateInstallPreflightTasks, updateStatus?.deliveryMode]);

	// 按字段级 useMemo 稳定弹窗 props：App 根组件重渲染（低频）不会连带
	// 重渲染 SettingsModal（memo）。piUpdate 内部函数均为 useCallback，
	// 原语字段不变则引用不变。
	const modalProps = useMemo(
		() => ({
			settings: props.settings,
			piStatus: props.piUpdate.piStatus,
			piChecking: props.piUpdate.piChecking,
			piInstallations: props.piUpdate.piInstallations ?? [],
			onChoosePiInstallation: props.piUpdate.choosePiInstallation,
			onShellProbePiInstallations: () => void props.piUpdate.loadPiInstallations({ forceShellProbe: true }),
			shellProbingPiInstallations: props.piUpdate.piInstallationsProbing,
			applyingPiInstallationPath: props.piUpdate.applyingInstallationPath,
			onRequestPiInstallations: () => void props.piUpdate.loadPiInstallations(),
			onBrowsePiPath: () => void props.piUpdate.browsePiPath(),
			browsingPiPath: props.piUpdate.browsingPiPath,
			piProxyChecking: props.piUpdate.piProxyChecking,
			piProxyNotice: props.piUpdate.piProxyNotice,
			piProxyNoticeTone: props.piUpdate.piProxyNoticeTone,
			webServiceChanging: props.webServiceChanging,
			appInfo: props.appInfo,
			onAddPiCustomPath: props.piUpdate.addPiCustomPath,
			onUpdatePiCustomPath: props.piUpdate.updatePiCustomPath,
			onRemovePiCustomPath: props.piUpdate.removePiCustomPath,
			updateChecking: false,
			piUpdating: props.piUpdate.piUpdating,
			piUpdateChecking: props.piUpdate.piUpdateChecking,
			piUpdateCheck: props.piUpdate.piUpdateCheck,
			piUpdateResult: props.piUpdate.piUpdateResult,
			onCheckPi: props.piUpdate.checkPiInstallInline,
			onTestPiProxy: props.piUpdate.testPiProxy,
			onCheckUpdate: () => {
				// 手动检测：直接触发主进程检查（结果经快照推送，设置页状态卡片响应）。
				void api.app.checkUpdate();
				void api.app.getUpdateStatus().then((snapshot) => {
					if (snapshot) setUpdateStatus(snapshot);
				});
			},
			onInstallUpdate: () => void installAppUpdate(),
			onDownloadUpdate: () => void api.app.downloadUpdate(),
			onCheckPiUpdate: props.piUpdate.checkPiCliUpdate,
			onUpdatePi: props.piUpdate.updatePiCli,
			onToggleDevTools: () => {
				void api.app.toggleDevTools().then((opened) => {
					showNotice(opened ? t("app.devToolsOpened") : t("app.devToolsClosed"));
				});
			},
			onRestartApp: () => api.app.restart(),
			onRestartWebService: props.onRestartWebService,
			onClearCheckFlag: async () => {
				await api.settings.update({ piEnvironmentChecked: false });
				showNotice(t("environment.checkFlagCleared"));
			},
			// forceSystem=true：Web 服务页必须离开内置浏览器面板——面板在 Dialog 下层，
			// 设置弹窗打开时会被遮挡；且外部端按桌面浏览器视口设计，系统浏览器体验更完整。
			onOpenWebService: (url: string) => api.app.openExternal(url, true),
			onClose: () => {
				// 关闭时清掉未消费的深链，避免下次从侧栏打开仍跳到 Git 分区。
				setFocus(null);
				setOpen(false);
			},
			onChange: props.onChange,
			projectId: props.projectId,
			projectKind: props.projectKind,
			projectName: props.projectName,
			projects: props.projects,
			active,
			closeRequestRef: props.closeRequestRef,
		}),
		[
			props.settings,
			props.piUpdate.piStatus,
			props.piUpdate.piChecking,
			props.piUpdate.piInstallations,
			props.piUpdate.choosePiInstallation,
			props.piUpdate.loadPiInstallations,
			props.piUpdate.piInstallationsProbing,
			props.piUpdate.applyingInstallationPath,
			props.piUpdate.browsePiPath,
			props.piUpdate.browsingPiPath,
			props.piUpdate.piProxyChecking,
			props.piUpdate.piProxyNotice,
			props.piUpdate.piProxyNoticeTone,
			props.webServiceChanging,
			props.appInfo,
			props.piUpdate.addPiCustomPath,
			props.piUpdate.updatePiCustomPath,
			props.piUpdate.removePiCustomPath,
			props.piUpdate.piUpdateChecking,
			props.piUpdate.piUpdateCheck,
			props.piUpdate.piUpdateResult,
			props.piUpdate.setCustomPiPath,
			props.piUpdate.setCustomPathResult,
			props.piUpdate.validateCustomPiPath,
			props.piUpdate.checkPiInstallInline,
			props.piUpdate.testPiProxy,
			props.piUpdate.checkPiCliUpdate,
			props.piUpdate.updatePiCli,
			props.piUpdate.piUpdating,
			props.onRestartWebService,
			props.onChange,
			props.projectId,
			props.projectKind,
			props.projectName,
			props.projects,
			active,
			props.closeRequestRef,
			installAppUpdate,
			setFocus,
			setOpen,
		],
	);

	if (!open) return null;

	// 页面宿主与其它工作区页面同构（绝对定位覆盖会话列、失活 hidden 保挂载），
	// 区别只在于设置页自己管着一批内存草稿：关闭 Tab 前必须先走未保存确认。
	return (
		<div className={cn("absolute inset-0 z-30 flex flex-col bg-background", !active && "hidden")} role="region" aria-label={t("settings.title")}>
			<Suspense fallback={null}>
				<SettingsModal {...modalProps} />
			</Suspense>
		</div>
	);
}
