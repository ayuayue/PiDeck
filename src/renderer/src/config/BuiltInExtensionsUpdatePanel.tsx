import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw, RotateCcw, Undo2, UploadCloud } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import type {
	BuiltInExtensionsCheckResult,
	BuiltInExtensionsUpdateResult,
	BuiltInExtensionsUpdateStatus,
} from "../../../shared/types/extensionsUpdate";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/** 内置扩展热更新的 preload 表面（窄接口，避免整包 PiDesktopApi 依赖）。 */
type BuiltInExtensionsApi = {
	builtInStatus: () => Promise<BuiltInExtensionsUpdateStatus>;
	builtInCheck: (branch?: "main" | "dev") => Promise<BuiltInExtensionsCheckResult>;
	builtInUpdate: (branch?: "main" | "dev") => Promise<BuiltInExtensionsUpdateResult>;
	builtInRestore: () => Promise<BuiltInExtensionsUpdateResult>;
	builtInRestorePrevious: () => Promise<BuiltInExtensionsUpdateResult>;
	builtInOpenDir: () => Promise<void>;
};

type Busy = "check" | "update" | "restore" | "restorePrevious" | null;

function getBuiltInApi(): BuiltInExtensionsApi {
	const api = (window as unknown as { piDesktop?: { extensions?: BuiltInExtensionsApi } })
		.piDesktop?.extensions;
	if (!api?.builtInStatus) throw new Error("PiDeck built-in extensions API is not available");
	return api;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 内置扩展版本与热更新面板（扩展设置页「已安装」区块顶部，全局作用域可见）。
 *
 * 为什么单独一块：内置扩展的版本号是**包级**的（extensions-manifest.json，不跟 PiDeck 应用
 * 版本走），更新粒度也是整包（逐文件 sha256 比对），塞进每行扩展的「当前/最新」版本列会误导。
 * 这里集中展示「内置版本 / 覆盖层版本 / 远端版本 + 变更文件数」，并提供检测/更新/还原入口；
 * 表格里的内置行只显示当前生效版本号。
 *
 * 更新写进 userData 覆盖层，重启会话才生效——面板显式提示，避免用户以为没生效。
 */
export function BuiltInExtensionsUpdatePanel(props: { onApplied: () => void }) {
	const [status, setStatus] = useState<BuiltInExtensionsUpdateStatus | null>(null);
	const [check, setCheck] = useState<BuiltInExtensionsCheckResult | null>(null);
	const [busy, setBusy] = useState<Busy>(null);

	const loadStatus = useCallback(async () => {
		try {
			setStatus(await getBuiltInApi().builtInStatus());
		} catch {
			// 状态读取失败不阻塞扩展列表：面板退化为不显示版本号
			setStatus(null);
		}
	}, []);

	useEffect(() => {
		void loadStatus();
	}, [loadStatus]);

	const handleCheck = async () => {
		if (busy) return;
		setBusy("check");
		setCheck(null);
		try {
			const result = await getBuiltInApi().builtInCheck();
			setCheck(result);
			if (!result.ok) {
				showNotice(t("config.builtInExt.checkFailed", { error: result.message ?? "" }), 4500, "error");
			} else if (result.hasUpdate) {
				showNotice(
					t("config.builtInExt.hasUpdateToast", {
						remote: result.remoteVersion ?? "?",
						count: String(result.changedFiles?.length ?? 0),
					}),
					5000,
				);
			} else {
				showNotice(t("config.builtInExt.upToDateToast", { version: result.remoteVersion ?? "?" }), 3500);
			}
		} catch (error) {
			showNotice(t("config.builtInExt.checkFailed", { error: errorText(error) }), 4500, "error");
		} finally {
			setBusy(null);
			void loadStatus();
		}
	};

	const handleUpdate = async () => {
		if (busy) return;
		setBusy("update");
		try {
			const result = await getBuiltInApi().builtInUpdate();
			if (!result.ok) {
				showNotice(t("config.builtInExt.operationFailed", { error: result.message ?? "" }), 5000, "error");
			} else if (result.updated) {
				showNotice(
					t("config.builtInExt.updatedToast", {
						version: result.version ?? "?",
						count: String(result.filesWritten ?? 0),
					}),
					6000,
				);
			} else {
				showNotice(t("config.builtInExt.alreadyLatestToast"), 3500);
			}
			setCheck(null);
			// 覆盖层变化会改变 -e 注入路径，刷新列表让版本列与路径同步
			props.onApplied();
		} catch (error) {
			showNotice(t("config.builtInExt.operationFailed", { error: errorText(error) }), 5000, "error");
		} finally {
			setBusy(null);
			void loadStatus();
		}
	};

	const handleRestore = async (previous: boolean) => {
		if (busy) return;
		setBusy(previous ? "restorePrevious" : "restore");
		try {
			const api = getBuiltInApi();
			const result = previous ? await api.builtInRestorePrevious() : await api.builtInRestore();
			if (!result.ok) {
				showNotice(t("config.builtInExt.operationFailed", { error: result.message ?? "" }), 5000, "error");
			} else if (!result.updated) {
				showNotice(t("config.builtInExt.nothingToRestoreToast"), 3500);
			} else {
				showNotice(
					previous
						? t("config.builtInExt.restoredPreviousToast")
						: t("config.builtInExt.restoredToast"),
					4500,
				);
			}
			setCheck(null);
			props.onApplied();
		} catch (error) {
			showNotice(t("config.builtInExt.operationFailed", { error: errorText(error) }), 5000, "error");
		} finally {
			setBusy(null);
			void loadStatus();
		}
	};

	const handleOpenDir = async () => {
		try {
			await getBuiltInApi().builtInOpenDir();
		} catch (error) {
			showNotice(t("config.builtInExt.operationFailed", { error: errorText(error) }), 4500, "error");
		}
	};

	const effectiveVersion = status?.effectiveVersion ?? null;
	const overlayActive = Boolean(status?.overlay);
	// 远端与本地版本一致但文件有差异（改了内容没 bump 版本）时，仍要提示「有更新」
	const hasUpdate = Boolean(check?.ok && check?.hasUpdate);

	return (
		<div className="mb-3 rounded-lg border border-border-subtle bg-bg-panel px-3 py-2.5">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<strong className="text-control font-semibold text-foreground">
							{t("config.builtInExt.title")}
						</strong>
						<span className="font-mono text-caption tabular-nums text-muted-foreground">
							{effectiveVersion
								? t("config.builtInExt.version", { version: effectiveVersion })
								: t("config.builtInExt.versionUnknown")}
						</span>
						{/* 覆盖层生效标识：版本号相同时用户需知道自己跑的是热补丁而非随包版本 */}
						{overlayActive && (
							<span className="text-micro text-text-primary">
								{t("config.builtInExt.overlayActive")}
							</span>
						)}
						{hasUpdate && (
							<span className="text-caption text-text-primary">
								{t("config.builtInExt.hasUpdate", {
									remote: check?.remoteVersion ?? "?",
									count: String(check?.changedFiles?.length ?? 0),
								})}
							</span>
						)}
					</div>
					<small className="mt-1 block text-caption leading-4 text-muted-foreground">
						{t("config.builtInExt.description")}
					</small>
					{check?.ok && !check.hasUpdate && (
						<small className="block text-caption text-muted-foreground">
							{t("config.builtInExt.upToDate", { version: check.remoteVersion ?? "?" })}
						</small>
					)}
					{overlayActive && (
						<small className="block text-caption text-muted-foreground">
							{t("config.builtInExt.restartHint")}
						</small>
					)}
				</div>
				{/* shrink-0 + flex-wrap + justify-end：窄窗口下按钮换行到第二行而不是溢出被裁 */}
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
					<Button variant="outline" size="sm" onClick={() => void handleCheck()} disabled={Boolean(busy)}>
						<RefreshCw size={14} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />
						{busy === "check" ? t("config.builtInExt.checking") : t("config.builtInExt.check")}
					</Button>
					<Button variant="outline" size="sm" onClick={() => void handleUpdate()} disabled={Boolean(busy)}>
						<UploadCloud size={14} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />
						{busy === "update" ? t("config.builtInExt.updating") : t("config.builtInExt.update")}
					</Button>
					{/* 还原入口只在确实存在覆盖层/备份时出现，避免普通用户看到无意义的按钮 */}
					{overlayActive && (
						<Button variant="ghost" size="sm" onClick={() => void handleRestore(false)} disabled={Boolean(busy)}>
							<RotateCcw size={14} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />
							{t("config.builtInExt.restore")}
						</Button>
					)}
					{status?.hasBackup && (
						<Button variant="ghost" size="sm" onClick={() => void handleRestore(true)} disabled={Boolean(busy)}>
							<Undo2 size={14} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />
							{t("config.builtInExt.restorePrevious")}
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon-sm"
						className="size-7"
						onClick={() => void handleOpenDir()}
						title={t("config.builtInExt.openDir")}
					>
						<FolderOpen size={14} strokeWidth={1.8} />
					</Button>
				</div>
			</div>
		</div>
	);
}
