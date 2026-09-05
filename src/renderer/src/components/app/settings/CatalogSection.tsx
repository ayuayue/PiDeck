import { useCallback, useEffect, useState } from "react";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { SettingsSection } from "./SettingsStorageTab";
import type {
	CatalogCheckResult,
	CatalogUpdateFailCode,
	CatalogUpdateResult,
	CatalogUpdateStatus,
} from "../../../../../shared/types/catalog";

type BusyKind = "check" | "update" | "restore" | "restore-prev" | null;

type Notice = { kind: "ok" | "error"; text: string } | null;

/** 错误码 → 用户可读文案（i18n），message 只进主进程日志不上屏。 */
function failText(code: CatalogUpdateFailCode | "unexpected"): string {
	switch (code) {
		case "network":
			return t("settings.catalogFailNetwork");
		case "validation":
			return t("settings.catalogFailValidation");
		case "write":
			return t("settings.catalogFailWrite");
		case "no-backup":
			return t("settings.catalogFailNoBackup");
		case "unexpected":
		default:
			return t("settings.catalogFailUnexpected");
	}
}

/** 目录来源摘要行：「v0.84.4 · 1290 条」或「不可用」。 */
function sourceText(
	info: CatalogUpdateStatus["builtin"],
): string {
	if (!info || info.packageVersion === null || info.entryCount === null) {
		return t("settings.catalogUnavailable");
	}
	return `${info.packageVersion} · ${info.entryCount} ${t("settings.catalogModelCount")}`;
}

/**
 * 设置页「模型目录」：查看内置/覆盖版本状态，从 GitHub（main 分支）拉取最新
 * pi-ai 模型目录覆盖到 userData，支持一键还原与恢复上一个覆盖版。
 * 状态与操作结果不落本地配置——目录文件由主进程统一管理，本组件只读展示。
 */
export function CatalogSection() {
	const [status, setStatus] = useState<CatalogUpdateStatus | null>(null);
	const [busy, setBusy] = useState<BusyKind>(null);
	const [notice, setNotice] = useState<Notice>(null);

	const refresh = useCallback(() => {
		desktopApi.catalog
			.status()
			.then(setStatus)
			.catch(() => setStatus(null));
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	/** 统一执行动作：busy 锁防重入 → 执行 → 按结果显示 notice → 刷新状态。 */
	const run = (
		kind: Exclude<BusyKind, null>,
		action: () => Promise<CatalogUpdateResult | CatalogCheckResult>,
		message: (result: CatalogUpdateResult | CatalogCheckResult) => string,
	) => {
		setBusy(kind);
		setNotice(null);
		void action()
			.then((result) => {
				if (result.ok) setNotice({ kind: "ok", text: message(result) });
				else setNotice({ kind: "error", text: failText(result.code) });
			})
			.catch(() => setNotice({ kind: "error", text: failText("unexpected") }))
			.finally(() => {
				setBusy(null);
				refresh();
			});
	};

	const overlayActive = status?.overlay != null;
	const hasInvalidOverlayFiles = (status?.hasOverlayFiles ?? false) && !overlayActive;

	return (
		<SettingsSection
			title={t("settings.catalogSectionTitle")}
			description={t("settings.catalogSectionDesc")}
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2 text-caption text-muted-foreground">
					<span>{t("settings.catalogBuiltin")}</span>
					<span className="font-medium text-foreground">{sourceText(status?.builtin ?? null)}</span>
				</div>
				<div className="flex items-center gap-2 text-caption text-muted-foreground">
					<span>{t("settings.catalogOverlay")}</span>
					{overlayActive ? (
						<span className="font-medium text-foreground">{sourceText(status.overlay)}</span>
					) : (
						<span className={hasInvalidOverlayFiles ? "font-medium text-destructive" : undefined}>
							{hasInvalidOverlayFiles
								? t("settings.catalogInvalidOverlay")
								: t("settings.catalogNone")}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 text-caption text-muted-foreground">
					<span>{t("settings.catalogBackup")}</span>
					<span className="font-medium text-foreground">
						{status?.hasBackup ? t("settings.catalogHasBackup") : t("settings.catalogNone")}
					</span>
				</div>
			</div>

			{notice && (
				<div
					className={`mt-2 rounded-md border px-3 py-2 text-caption ${
						notice.kind === "ok"
							? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-text-primary"
							: "border-destructive/40 bg-destructive/10 text-destructive"
					}`}
				>
					{notice.text}
				</div>
			)}

			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button
					variant="secondary"
					loading={busy === "check"}
					disabled={busy !== null && busy !== "check"}
					onClick={() =>
						run("check", () => desktopApi.catalog.check("main"), (result) => {
							const checked = result as CatalogCheckResult;
							return checked.ok
								? checked.hasUpdate
									? t("settings.catalogCheckAvailable", {
											local: checked.localVersion ?? "—",
											remote: checked.remoteVersion,
										})
									: t("settings.catalogCheckLatest", { remote: checked.remoteVersion })
								: failText("unexpected");
						})
					}
				>
					{t("settings.catalogCheck")}
				</Button>
				<Button
					loading={busy === "update"}
					disabled={busy !== null && busy !== "update"}
					onClick={() =>
						run(
							"update",
							() => desktopApi.catalog.updateFromGithub("main"),
							() => t("settings.catalogUpdated"),
						)
					}
				>
					{t("settings.catalogUpdate")}
				</Button>
				<Button
					variant="secondary"
					loading={busy === "restore"}
					disabled={(busy !== null && busy !== "restore") || !status?.hasOverlayFiles}
					onClick={() =>
						run("restore", () => desktopApi.catalog.restore(), () => t("settings.catalogRestored"))
					}
				>
					{t("settings.catalogRestore")}
				</Button>
				<Button
					variant="secondary"
					loading={busy === "restore-prev"}
					disabled={(busy !== null && busy !== "restore-prev") || !status?.hasBackup}
					onClick={() =>
						run(
							"restore-prev",
							() => desktopApi.catalog.restorePrevious(),
							() => t("settings.catalogRestorePrevOk"),
						)
					}
				>
					{t("settings.catalogRestorePrev")}
				</Button>
				<Button
					variant="ghost"
					disabled={busy !== null}
					onClick={() => {
						// 打开文件走主进程解析路径（覆盖层/内置），渲染层只发意图；失败给出提示
						desktopApi.catalog
							.openFile()
							.catch(() => setNotice({ kind: "error", text: failText("unexpected") }));
					}}
				>
					{t("settings.catalogOpenFile")}
				</Button>
			</div>
		</SettingsSection>
	);
}
