import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw, RotateCcw, Undo2, UploadCloud } from "lucide-react";
import { Button } from "../components/ui-shadcn/button";
import type { BuiltinContentCheckResult, BuiltinContentUpdateResult, BuiltinContentUpdateStatus } from "../../../shared/types/contentUpdate";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/**
 * 内置内容包（提示词商店官方模板 / 内置技能）热更新面板。
 *
 * 与内置扩展面板（BuiltInExtensionsUpdatePanel）同构：版本号是包级 manifest.version，
 * 更新写 userData 覆盖层。提示词/技能覆盖层是「读取时实时合并」（XuePromptManager /
 * SkillManager 扫描覆盖层目录），不需要重启 agent，所以生效提示由调用方传入。
 *
 * 为什么传 text 而不是 key 前缀：i18n t() 的 key 是字面量联合类型，动态拼接 key 过不了
 * typecheck；面板内共享操作文案用字面量 key（config.contentStore.*），差异文案
 * （title/description/restartHint）留给调用方用字面量 key 绑定。
 */
export type ContentStorePanelText = {
	title: string;
	description: string;
	restartHint: string;
};

type ContentStoreApiGroup = {
	status: () => Promise<BuiltinContentUpdateStatus>;
	check: (branch?: "main" | "dev") => Promise<BuiltinContentCheckResult>;
	update: (branch?: "main" | "dev") => Promise<BuiltinContentUpdateResult>;
	restore: () => Promise<BuiltinContentUpdateResult>;
	restorePrevious: () => Promise<BuiltinContentUpdateResult>;
	openDir: () => Promise<void>;
};

type Busy = "check" | "update" | "restore" | "restorePrevious" | null;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 通用面板。操作后的统一反馈：
 * - 更新/还原成功后清掉 check 结果（本地状态已变），并让父级刷新列表。
 * - 三种结果分支（失败 / 有写盘 / 已是最新）分别 toast。
 */
export function ContentStoreUpdatePanel(props: { api: ContentStoreApiGroup; text: ContentStorePanelText; onApplied?: () => void }) {
	const { api } = props;
	const [status, setStatus] = useState<BuiltinContentUpdateStatus | null>(null);
	const [check, setCheck] = useState<BuiltinContentCheckResult | null>(null);
	const [busy, setBusy] = useState<Busy>(null);

	const loadStatus = useCallback(async () => {
		try {
			setStatus(await api.status());
		} catch {
			// 状态读取失败不阻塞页面：面板退化为不显示版本号
			setStatus(null);
		}
	}, [api]);

	useEffect(() => {
		void loadStatus();
	}, [loadStatus]);

	const handleCheck = async () => {
		if (busy) return;
		setBusy("check");
		setCheck(null);
		try {
			const result = await api.check();
			setCheck(result);
			if (!result.ok) {
				showNotice(t("config.contentStore.checkFailed", { error: result.message ?? "" }), 4500, "error");
			} else if (result.hasUpdate) {
				showNotice(
					t("config.contentStore.hasUpdateToast", {
						remote: result.remoteVersion ?? "?",
						count: String(result.changedFiles?.length ?? 0),
					}),
					5000,
				);
			} else {
				showNotice(t("config.contentStore.upToDateToast", { version: result.remoteVersion ?? "?" }), 3500);
			}
		} catch (error) {
			showNotice(t("config.contentStore.checkFailed", { error: errorText(error) }), 4500, "error");
		} finally {
			setBusy(null);
			void loadStatus();
		}
	};

	const handleUpdate = async () => {
		if (busy) return;
		setBusy("update");
		try {
			const result = await api.update();
			if (!result.ok) {
				showNotice(t("config.contentStore.operationFailed", { error: result.message ?? "" }), 5000, "error");
			} else if (result.updated) {
				showNotice(
					t("config.contentStore.updatedToast", {
						version: result.version ?? "?",
						count: String(result.filesWritten ?? 0),
					}),
					6000,
				);
			} else {
				showNotice(t("config.contentStore.alreadyLatestToast"), 3500);
			}
			setCheck(null);
			props.onApplied?.();
		} catch (error) {
			showNotice(t("config.contentStore.operationFailed", { error: errorText(error) }), 5000, "error");
		} finally {
			setBusy(null);
			void loadStatus();
		}
	};

	const handleRestore = async (previous: boolean) => {
		if (busy) return;
		setBusy(previous ? "restorePrevious" : "restore");
		try {
			const result = previous ? await api.restorePrevious() : await api.restore();
			if (!result.ok) {
				showNotice(t("config.contentStore.operationFailed", { error: result.message ?? "" }), 5000, "error");
			} else if (!result.updated) {
				showNotice(t("config.contentStore.nothingToRestoreToast"), 3500);
			} else {
				showNotice(previous ? t("config.contentStore.restoredPreviousToast") : t("config.contentStore.restoredToast"), 4500);
			}
			setCheck(null);
			props.onApplied?.();
		} catch (error) {
			showNotice(t("config.contentStore.operationFailed", { error: errorText(error) }), 5000, "error");
		} finally {
			setBusy(null);
			void loadStatus();
		}
	};

	const handleOpenDir = async () => {
		try {
			await api.openDir();
		} catch (error) {
			showNotice(t("config.contentStore.operationFailed", { error: errorText(error) }), 4500, "error");
		}
	};

	const effectiveVersion = status?.effectiveVersion ?? null;
	const overlayActive = Boolean(status?.overlay);
	const hasUpdate = Boolean(check?.ok && check?.hasUpdate);

	return (
		<div className="mb-3 rounded-lg border border-border-subtle bg-bg-panel px-3 py-2.5">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<strong className="text-control font-semibold text-foreground">{props.text.title}</strong>
						<span className="font-mono text-caption tabular-nums text-muted-foreground">{effectiveVersion ? t("config.contentStore.version", { version: effectiveVersion }) : t("config.contentStore.versionUnknown")}</span>
						{/* 覆盖层生效标识：版本号相同时用户需知道自己跑的是热补丁而非随包版本 */}
						{overlayActive && <span className="text-micro text-text-primary">{t("config.contentStore.overlayActive")}</span>}
						{hasUpdate && (
							<span className="text-caption text-text-primary">
								{t("config.contentStore.hasUpdate", {
									remote: check?.remoteVersion ?? "?",
									count: String(check?.changedFiles?.length ?? 0),
								})}
							</span>
						)}
					</div>
					<small className="mt-1 block text-caption leading-4 text-muted-foreground">{props.text.description}</small>
					{check?.ok && !check.hasUpdate && <small className="block text-caption text-muted-foreground">{t("config.contentStore.upToDate", { version: check.remoteVersion ?? "?" })}</small>}
					{overlayActive && <small className="block text-caption text-muted-foreground">{props.text.restartHint}</small>}
				</div>
				{/* shrink-0 + flex-wrap + justify-end：窄窗口下按钮换行而不是溢出被裁 */}
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
					<Button variant="outline" size="sm" onClick={() => void handleCheck()} disabled={Boolean(busy)}>
						<RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
						{busy === "check" ? t("config.contentStore.checking") : t("config.contentStore.check")}
					</Button>
					<Button variant="outline" size="sm" onClick={() => void handleUpdate()} disabled={Boolean(busy)}>
						<UploadCloud size={14} strokeWidth={1.8} aria-hidden="true" />
						{busy === "update" ? t("config.contentStore.updating") : t("config.contentStore.update")}
					</Button>
					{/* 还原入口只在确实存在覆盖层/备份时出现，避免普通用户看到无意义的按钮 */}
					{overlayActive && (
						<Button variant="ghost" size="sm" onClick={() => void handleRestore(false)} disabled={Boolean(busy)}>
							<RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />
							{t("config.contentStore.restore")}
						</Button>
					)}
					{status?.hasBackup && (
						<Button variant="ghost" size="sm" onClick={() => void handleRestore(true)} disabled={Boolean(busy)}>
							<Undo2 size={14} strokeWidth={1.8} aria-hidden="true" />
							{t("config.contentStore.restorePrevious")}
						</Button>
					)}
					<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => void handleOpenDir()} title={t("config.contentStore.openDirTitle")}>
						<FolderOpen size={14} strokeWidth={1.8} />
					</Button>
				</div>
			</div>
		</div>
	);
}
