import { useCallback, useEffect, useState } from "react";
import { t, type TranslationKey } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import {
	BackupDetailDialog,
	RestoreDialog,
	formatBytes,
	formatReason,
	formatTime,
} from "./SettingsBackupDialogs";
import type {
	ConfigBackupDetail,
	ConfigBackupMeta,
} from "../../../../../shared/types/backup";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";

/**
 * 配置备份 tab：列出所有配置备份（pi 配置文件 + pideck 设置），
 * 支持立即备份、查看（脱敏）、恢复（单个/全部文件）、单删与批量删除。
 *
 * 自动备份由主进程触发（首次使用 / 版本升级 / 配置保存，防抖合并），
 * 本组件只负责展示与手动操作，不感知触发逻辑。
 * 操作结果统一走全局 toast（showNotice），避免底部小字被忽略。
 */
export function BackupTab() {
	const [backups, setBackups] = useState<ConfigBackupMeta[] | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<{
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);
	const [detail, setDetail] = useState<ConfigBackupDetail | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	/** 恢复选择弹窗目标：非 null 时弹窗打开（默认全选，可勾选单个文件）。 */
	const [restoreTarget, setRestoreTarget] = useState<ConfigBackupDetail | null>(null);
	/** 批量删除勾选集合（备份 id）。 */
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const refresh = useCallback(async () => {
		const result = await window.piDesktop.configBackups.list();
		if (result.ok) {
			setBackups(result.backups);
			// 列表刷新后清理已不存在的勾选（被删/被清理的备份 id）。
			setSelected((prev) => {
				const alive = new Set(result.backups.map((entry) => entry.id));
				const next = new Set([...prev].filter((id) => alive.has(id)));
				return next.size === prev.size ? prev : next;
			});
		} else {
			showNotice(result.error, 3000, "error");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/**
	 * 统一动作执行：busyKey 标识 loading 源（默认 "action" = 顶部按钮，
	 * "bulk" = 批量删除，备份 id = 对应列表行/恢复弹窗）。
	 * 结果一律 toast：成功 info、失败 error（用户可感知，不依赖页面内小字）。
	 */
	const runAction = async (
		action: () => Promise<{ ok: boolean; error?: string }>,
		successKey: TranslationKey,
		successParams?: Record<string, string | number | boolean | null | undefined>,
		busyKey: string = "action",
	) => {
		setBusy(busyKey);
		try {
			const result = await action();
			if (result.ok) {
				showNotice(t(successKey, successParams), 2500);
				await refresh();
			} else {
				showNotice(result.error ?? t("common.error"), 3000, "error");
			}
		} catch (e) {
			showNotice(e instanceof Error ? e.message : String(e), 3000, "error");
		} finally {
			setBusy(null);
		}
	};

	const doCreate = () => {
		void runAction(
			() => window.piDesktop.configBackups.create("manual"),
			"settings.backup.createSuccess",
		);
	};

	/** 打开恢复选择弹窗：先读取脱敏详情拿到文件清单，再让用户勾选。 */
	const openRestoreDialog = async (backup: ConfigBackupMeta) => {
		setBusy(`restore-${backup.id}`);
		try {
			const result = await window.piDesktop.configBackups.read(backup.id);
			if (result) {
				setRestoreTarget(result);
			} else {
				showNotice(t("settings.backup.readFailed"), 3000, "error");
			}
		} catch (e) {
			showNotice(e instanceof Error ? e.message : String(e), 3000, "error");
		} finally {
			setBusy(null);
		}
	};

	const toggleSelect = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	/** 批量删除确认：danger 弹窗，确认后一次 IPC 删除全部勾选项。 */
	const confirmBulkDelete = () => {
		const ids = [...selected];
		if (ids.length === 0) return;
		setConfirm({
			title: t("settings.backup.bulkDeleteTitle"),
			message: t("settings.backup.bulkDeleteConfirm", { count: ids.length }),
			onConfirm: () => {
				setConfirm(null);
				void runAction(
					() => window.piDesktop.configBackups.deleteMany(ids),
					"settings.backup.bulkDeleteSuccess",
					{ count: ids.length },
					"bulk",
				);
			},
		});
	};

	const confirmDelete = (backup: ConfigBackupMeta) => {
		setConfirm({
			title: t("settings.backup.deleteTitle"),
			message: t("settings.backup.deleteConfirm", {
				time: formatTime(backup.createdAt),
			}),
			onConfirm: () => {
				setConfirm(null);
				void runAction(
					() => window.piDesktop.configBackups.delete(backup.id),
					"settings.backup.deleteSuccess",
					undefined,
					`del-${backup.id}`,
				);
			},
		});
	};

	const openDetail = async (backup: ConfigBackupMeta) => {
		setBusy(`view-${backup.id}`);
		try {
			const result = await window.piDesktop.configBackups.read(backup.id);
			if (result) {
				setDetail(result);
				setDetailOpen(true);
			} else {
				showNotice(t("settings.backup.readFailed"), 3000, "error");
			}
		} catch (e) {
			showNotice(e instanceof Error ? e.message : String(e), 3000, "error");
		} finally {
			setBusy(null);
		}
	};

	const isLoading = backups === null;
	/** 当前列表是否全部勾选（空列表视为未全选，避免全选态误导）。 */
	const allSelected =
		backups !== null &&
		backups.length > 0 &&
		backups.every((backup) => selected.has(backup.id));

	/** 全选/取消全选：整表切换，不动列表外的失效 id（refresh 已负责清理）。 */
	const toggleSelectAll = () => {
		if (!backups) return;
		setSelected(allSelected ? new Set() : new Set(backups.map((backup) => backup.id)));
	};

	return (
		<>
			{confirm && (
				<ConfirmDialog
					title={confirm.title}
					message={confirm.message}
					danger
					onConfirm={confirm.onConfirm}
					onCancel={() => setConfirm(null)}
				/>
			)}
			<BackupDetailDialog detail={detail} open={detailOpen} onOpenChange={setDetailOpen} />
			<RestoreDialog
				detail={restoreTarget}
				open={restoreTarget !== null}
				restoring={busy === restoreTarget?.id}
				onOpenChange={(open) => {
					// 恢复执行中不允许关闭（防止用户误以为已取消、重复提交）。
					if (!open && busy !== restoreTarget?.id) setRestoreTarget(null);
				}}
				onRestore={(files) => {
					const target = restoreTarget;
					if (!target) return;
					void (async () => {
						// 弹窗保持打开直到恢复完成：按钮转圈（restoring）→ toast 结果 → 关闭。
						await runAction(
							() => window.piDesktop.configBackups.restore(target.id, files),
							"settings.backup.restoreSuccess",
							undefined,
							target.id,
						);
						setRestoreTarget(null);
					})();
				}}
			/>

			<SettingsSection title={t("settings.backup.title")} description={t("settings.backup.desc")}>
				<SettingRow
					level={1}
					title={<span>{t("settings.backup.createButton")}</span>}
					description={t("settings.backup.createDesc")}
				>
					<Button
						variant="secondary"
						loading={busy === "action"}
						disabled={busy !== null}
						onClick={doCreate}
					>
						{t("settings.backup.createButton")}
					</Button>
				</SettingRow>
				<p className="px-0.5 pb-1 text-caption text-muted-foreground">
					{t("settings.backup.hint")}
				</p>
			</SettingsSection>

			<SettingsSection title={t("settings.backup.listTitle")}>
				<div className="flex items-center justify-between gap-2 pb-1">
					{backups && backups.length > 0 ? (
						<label className="flex cursor-pointer select-none items-center gap-2 px-0.5 text-caption text-muted-foreground">
							<Checkbox
								checked={
									allSelected
										? true
										: selected.size > 0
											? "indeterminate"
											: false
								}
								disabled={busy !== null}
								onCheckedChange={toggleSelectAll}
							/>
							<span>
								{allSelected
									? t("common.deselectAll")
									: t("common.selectAll")}
							</span>
						</label>
					) : (
						<span />
					)}
					<Button
						variant="ghost"
						size="sm"
						className="text-destructive hover:text-destructive"
						disabled={selected.size === 0 || busy !== null}
						loading={busy === "bulk"}
						onClick={confirmBulkDelete}
					>
						{selected.size > 0
							? t("settings.backup.bulkDeleteSelected", { count: selected.size })
							: t("settings.backup.bulkDelete")}
					</Button>
				</div>
				{isLoading ? (
					<p className="px-0.5 py-1 text-caption text-muted-foreground">{t("common.loading")}</p>
				) : backups.length === 0 ? (
					<p className="px-0.5 py-1 text-caption text-muted-foreground">{t("settings.backup.empty")}</p>
				) : (
					backups.map((backup) => (
						<SettingRow
							key={backup.id}
							level={1}
							title={
								<div className="flex items-center gap-2">
									<Checkbox
										checked={selected.has(backup.id)}
										onCheckedChange={() => toggleSelect(backup.id)}
									/>
									<span>{formatTime(backup.createdAt)}</span>
								</div>
							}
							description={formatBackupDesc(backup)}
						>
							<div className="flex items-center gap-2">
								<Button
									variant="ghost"
									size="sm"
									disabled={busy !== null}
									loading={busy === `view-${backup.id}`}
									onClick={() => void openDetail(backup)}
								>
									{t("settings.backup.view")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy !== null}
									loading={busy === `restore-${backup.id}`}
									onClick={() => void openRestoreDialog(backup)}
								>
									{t("settings.backup.restore")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									className="text-destructive hover:text-destructive"
									disabled={busy !== null}
									loading={busy === `del-${backup.id}`}
									onClick={() => confirmDelete(backup)}
								>
									{t("common.delete")}
								</Button>
							</div>
						</SettingRow>
					))
				)}
			</SettingsSection>
		</>
	);
}

/** 列表行描述：文件清单 + 大小 + 触发原因。 */
function formatBackupDesc(backup: ConfigBackupMeta): string {
	const files = backup.files.join("、");
	return `${formatReason(backup.reason)} · ${files} · ${formatBytes(backup.size)}`;
}
