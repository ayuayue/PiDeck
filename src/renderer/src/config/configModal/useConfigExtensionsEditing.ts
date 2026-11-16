import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiResourceOptions } from "../../../../shared/piConfig";
import type { PiExtensionListResult, PiExtensionSummary, ProjectResourceDiscoveryResult, ProjectResourceListResult } from "../../../../shared/types";
import { t } from "../../i18n";
import { formatIpcError } from "../../utils/ipcError";
import { showNotice } from "../../utils/notice";
import { emptyProjectResourceData, isProjectExtension, type ResourceScope } from "../resourceScopeModel";
import { resourceTargetErrorMessage } from "../resourceTargetErrorCopy";
import type { PiResourceWriteAction } from "../piResourceTargetModel";
import type { DiscoveredExtensionItem } from "../extensionsTableRows";

type ConfigExtensionsEditingDeps = {
	api: PiDesktopApi;
	resourceScope: ResourceScope;
	effectiveProjectId: string | undefined;
	hasProject: boolean;
	resourceOptions: PiResourceOptions | undefined;
	/** 资源写门禁：true = 当前目标下该动作被拦下，调用方直接返回。 */
	blockResourceMutation: (action: PiResourceWriteAction) => boolean;
	resourceGenerationRef: MutableRefObject<number>;
	setDiscoveryData: Dispatch<SetStateAction<ProjectResourceDiscoveryResult>>;
	setProjectResourcesData: Dispatch<SetStateAction<ProjectResourceListResult>>;
	setError: Dispatch<SetStateAction<string | null>>;
	/** 成功提示出口（宿主统一走 showNotice）。 */
	notify: (message: string) => void;
	/** 登记到宿主的 UI 计时器（卡片退场动画）。 */
	scheduleUiTimer: (fn: () => void, ms: number) => void;
};

/**
 * 扩展页的列表状态与开关/卸载动作：只搬数据与 IPC 动作，不渲染。
 * 刷新同时回写 discovery / projectResources——列表要并排展示包与 settings 声明的只读行。
 */
export function useConfigExtensionsEditing(deps: ConfigExtensionsEditingDeps) {
	const { api, resourceScope, effectiveProjectId, hasProject, resourceOptions, blockResourceMutation, resourceGenerationRef, setDiscoveryData, setProjectResourcesData, setError, notify: showToast, scheduleUiTimer } = deps;

	const [extensionsData, setExtensionsData] = useState<PiExtensionListResult>({
		extensions: [],
		raw: "",
	});
	const [extensionsLoading, setExtensionsLoading] = useState(false);
	const [uninstallingExtensionSource, setUninstallingExtensionSource] = useState<string | null>(null);
	const [uninstallExtensionConfirm, setUninstallExtensionConfirm] = useState<PiExtensionSummary | null>(null);
	/** 项目包发现行（package-project）的卸载确认：走 `pi remove <source> -l`，只删项目层记账。 */
	const [uninstallProjectPackageConfirm, setUninstallProjectPackageConfirm] = useState<{ source: string } | null>(null);

	/**
	 * Load the complete list, while project-owned rows are fetched only in project scope.
	 * Discovery is always requested: extension discovery also resolves global settings packages.
	 */
	const refreshExtensions = async (forceRefresh = false) => {
		setExtensionsLoading(true);
		setError(null);
		const generation = resourceGenerationRef.current;
		const projectIdHere = resourceScope === "project" ? effectiveProjectId : undefined;
		try {
			const [globalResult, projectResult, discoveryResult] = await Promise.all([api.extensions.list(forceRefresh, resourceOptions), projectIdHere && hasProject ? api.projectResources.list(projectIdHere) : Promise.resolve(emptyProjectResourceData()), api.projectResources.discovery(projectIdHere)]);
			if (generation !== resourceGenerationRef.current) return;
			setDiscoveryData(discoveryResult);
			const globalExtensions = globalResult.extensions.filter((extension) => !isProjectExtension(extension));
			const projectExtensions = projectResult.extensions;
			setProjectResourcesData(projectResult);
			const seenSources = new Set<string>();
			const mergedExtensions = [...projectExtensions, ...globalExtensions].filter((extension) => {
				const key = `${extension.scope ?? "unknown"}\u0000${extension.source}`;
				if (seenSources.has(key)) return false;
				seenSources.add(key);
				return true;
			});
			setExtensionsData({ ...globalResult, extensions: mergedExtensions });
		} catch (e) {
			// 资源域失败给稳定码文案；其它异常保留原文。
			setError(resourceTargetErrorMessage(e));
		} finally {
			if (generation === resourceGenerationRef.current) setExtensionsLoading(false);
		}
	};

	/** Extension toggles in project view are project overrides, never global mutations. */
	const handleToggleExtension = async (extension: PiExtensionSummary, enabled: boolean) => {
		if (blockResourceMutation("extensions:toggle")) return;
		if (resourceScope === "project" && effectiveProjectId) {
			if (isProjectExtension(extension) && extension.path) {
				await api.projectResources.toggleExtension(effectiveProjectId, extension.path, enabled);
			} else if (!isProjectExtension(extension)) {
				if (extension.enabled === false) {
					// A globally disabled extension cannot be re-enabled from project scope.
					showNotice(t("config.resourceScope.inheritedReadOnly"), 4000, "warning");
					return;
				}
				await api.projectResources.toggleInherited({
					projectId: effectiveProjectId,
					kind: "extension",
					// 文件扩展用路径；包扩展回退 source（包级过滤走 packages，路径形态 pi 同样能匹配到入口文件时才生效）
					key: extension.path ?? extension.source,
					enabled,
				});
			}
			return;
		}
		// 传路径与项目上下文：本地文件扩展需要精确路径，项目作用域需要 projectId 写项目 .pi/settings.json。
		await api.extensions.toggle(extension.source, enabled, extension.scope, extension.path, effectiveProjectId, resourceOptions);
	};

	const handleRequestExtensionUninstall = (extension: PiExtensionSummary) => {
		if (blockResourceMutation("extensions:uninstall")) return;
		// A global row shown as inherited by a project is read-only in that project.
		if (resourceScope === "project" && !isProjectExtension(extension)) return;
		setUninstallExtensionConfirm(extension);
	};

	const handleRequestProjectPackageUninstall = (item: DiscoveredExtensionItem) => {
		if (blockResourceMutation("extensions:uninstall")) return;
		setUninstallProjectPackageConfirm({ source: item.source });
	};

	const handleOpenExtensionLocation = async (extension: PiExtensionSummary) => {
		if (!extension.path) return;
		try {
			await api.files.showInFolder(extension.path, extension.scope === "project" && effectiveProjectId ? { projectId: effectiveProjectId } : undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	/** 发现行打开安装位置：包缓存（user 层）走默认边界，项目目录内文件（settings-project 等）需带 projectId 走项目读边界。 */
	const handleOpenDiscoveredLocation = async (item: DiscoveredExtensionItem) => {
		if (!item.path) return;
		try {
			await api.files.showInFolder(item.path, item.physicalScope === "project" && effectiveProjectId ? { projectId: effectiveProjectId } : undefined);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const confirmUninstallExtension = async () => {
		if (blockResourceMutation("extensions:uninstall")) return;
		if (!uninstallExtensionConfirm) return;
		const target = uninstallExtensionConfirm;
		setUninstallExtensionConfirm(null);
		// 立刻进入卸载态以触发卡片退场动画，同时发起真实卸载；两者并行，避免"删完才闪一下"。
		setUninstallingExtensionSource(target.source);
		const exitAnimation = new Promise<void>((resolve) => {
			scheduleUiTimer(resolve, 280);
		});
		try {
			await Promise.all([
				(async () => {
					if (isProjectExtension(target) && effectiveProjectId && target.path) {
						await api.projectResources.deleteExtension(effectiveProjectId, target.path);
					} else if (target.builtIn) {
						await api.extensions.removeBuiltIn(target.source);
					} else {
						await api.extensions.uninstall(target.source, target.scope, target.scope === "project" ? effectiveProjectId : undefined);
					}
				})(),
				exitAnimation,
			]);
			// 与禁用/手动刷新一致：强制重扫并跳过可能残留的 in-flight 缓存结果。
			await refreshExtensions(true);
			showToast(t("config.extensionUninstalledToast"));
		} catch (e) {
			if (isProjectExtension(target) || target.builtIn) {
				showNotice(t("config.extensionOperationFailed", { error: formatIpcError(e) }), 4500, "error");
				return;
			}
			// Package uninstall failures include the equivalent CLI command as a manual fallback.
			const uninstallCmd = `pi uninstall ${target.source}${target.scope === "project" ? " -l" : ""}`;
			showNotice(t("config.extensionUninstallFailed", { error: formatIpcError(e) }) + " " + t("config.extensionUninstallManual", { command: uninstallCmd }), 6000, "error", undefined, {
				action: {
					label: t("config.copyUninstallCmd"),
					onClick: () => void navigator.clipboard.writeText(uninstallCmd),
				},
			});
		} finally {
			setUninstallingExtensionSource(null);
		}
	};

	/**
	 * 项目包卸载：`pi remove <source> -l` 删项目层记账条目（<项目>/.pi/settings.json 的 packages），
	 * 不动全局缓存与磁盘文件；卸载态复用 uninstallingExtensionSource（发现行按 source 匹配）。
	 */
	const confirmUninstallProjectPackage = async () => {
		if (blockResourceMutation("extensions:uninstall")) return;
		if (!uninstallProjectPackageConfirm) return;
		const target = uninstallProjectPackageConfirm;
		setUninstallProjectPackageConfirm(null);
		setUninstallingExtensionSource(target.source);
		try {
			// 与全局包卸载一致：失败时给等价 CLI 手动回退（项目层加 -l）。项目层要带 effectiveProjectId，
			// 后端经信任门解析项目根后再执行 pi remove -l（无 id 会被拒绝，不会误删别的项目）。
			await api.extensions.uninstall(target.source, "project", effectiveProjectId);
			await refreshExtensions(true);
			showToast(t("config.extensionUninstalledToast"));
		} catch (e) {
			// 与全局包卸载一致：失败时给等价 CLI 手动回退（项目层加 -l）。
			const uninstallCmd = `pi uninstall ${target.source} -l`;
			showNotice(t("config.extensionUninstallFailed", { error: formatIpcError(e) }) + " " + t("config.extensionUninstallManual", { command: uninstallCmd }), 6000, "error", undefined, {
				action: {
					label: t("config.copyUninstallCmd"),
					onClick: () => void navigator.clipboard.writeText(uninstallCmd),
				},
			});
		} finally {
			setUninstallingExtensionSource(null);
		}
	};

	return {
		extensionsData,
		extensionsLoading,
		uninstallingExtensionSource,
		uninstallExtensionConfirm,
		setUninstallExtensionConfirm,
		uninstallProjectPackageConfirm,
		setUninstallProjectPackageConfirm,
		refreshExtensions,
		handleToggleExtension,
		handleRequestExtensionUninstall,
		handleRequestProjectPackageUninstall,
		handleOpenExtensionLocation,
		handleOpenDiscoveredLocation,
		confirmUninstallExtension,
		confirmUninstallProjectPackage,
	};
}
