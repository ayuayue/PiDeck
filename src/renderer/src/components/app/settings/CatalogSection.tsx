import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { updateStatusAtom } from "../../../atoms/update-atoms";
import { Button } from "../../ui-shadcn/button";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingSwitchRow } from "./SettingRows";
import type { CatalogCheckResult, CatalogUpdateFailCode, CatalogUpdateResult, CatalogUpdateStatus } from "../../../../../shared/types/catalog";
import type { UpdateSourceId } from "../../../../../shared/types/settings";
import { normalizeCustomMirrorHost, UPDATE_SOURCE_MIRRORS } from "../../../../../shared/updateSources";

type BusyKind = "check" | "update" | "restore" | "restore-prev" | null;

type Notice = { kind: "ok" | "error"; text: string } | null;

/** 错误码 → 用户可读文案（i18n），message 只进主进程日志不上屏。 */
function failText(code: CatalogUpdateFailCode | "unexpected"): string {
	switch (code) {
		case "network":
			return t("settings.catalogFailNetwork");
		case "validation":
			return t("settings.catalogFailValidation");
		case "incompatible":
			return t("settings.catalogFailIncompatible");
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
function sourceText(info: CatalogUpdateStatus["builtin"]): string {
	if (!info || info.packageVersion === null || info.entryCount === null) {
		return t("settings.catalogUnavailable");
	}
	return `${info.packageVersion} · ${info.entryCount} ${t("settings.catalogModelCount")}`;
}

/**
 * 设置页「模型目录」：查看内置/覆盖版本状态，从 GitHub（main 分支）拉取最新
 * pi-ai 模型目录覆盖到 userData，支持一键还原与恢复上一个覆盖版。
 * 状态与操作结果不落本地配置——目录文件由主进程统一管理，本组件只读展示。
 *
 * 开关（autoUpdate 等）由设置页 tab 传入：后台检查发现新版本默认直接自动更新，
 * 关掉后退回「只提示、手动更新」的旧行为。
 */
export function CatalogSection(props: { updateSource?: UpdateSourceId; customUpdateSourceUrl?: string; autoUpdate?: boolean; autoUpdateDirty?: boolean; onAutoUpdateChange?: (checked: boolean) => void }) {
	const [status, setStatus] = useState<CatalogUpdateStatus | null>(null);
	const [busy, setBusy] = useState<BusyKind>(null);
	const [notice, setNotice] = useState<Notice>(null);
	// 后台定时检查（UpdateService 第三路）发现的新版本提示：打开设置页立即可见，
	// 无需先点「检查更新」；本地/远端版本取自同一检查链路（覆盖层优先，否则内置）。
	const catalogSnapshot = useAtomValue(updateStatusAtom)?.catalog ?? null;
	const updateNotice = useMemo(
		() =>
			catalogSnapshot?.hasUpdate
				? t("settings.catalogUpdateAvailable", {
						local: catalogSnapshot.localVersion ?? "—",
						remote: catalogSnapshot.latestVersion ?? "—",
					})
				: null,
		[catalogSnapshot],
	);
	// 当前目录更新源的展示名：与应用更新同源，直接复用同一份清单与 label。
	const catalogSourceLabel = useMemo(() => {
		const source = props.updateSource ?? "atomgit";
		if (source === "github") return t("settings.updateSourceGithub");
		if (source === "atomgit") return t("settings.updateSourceAtomGit");
		const mirror = UPDATE_SOURCE_MIRRORS.find((m) => m.id === source);
		return mirror ? mirror.host : t("settings.updateSourceAtomGit");
	}, [props.updateSource]);

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
	const run = (kind: Exclude<BusyKind, null>, action: () => Promise<CatalogUpdateResult | CatalogCheckResult>, message: (result: CatalogUpdateResult | CatalogCheckResult) => string) => {
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
		<SettingsSection id="settings-section-dev-catalog" title={t("settings.catalogSectionTitle")} description={t("settings.catalogSectionDesc")}>
			<div className="flex flex-col gap-2">
				{/* 目录更新源：与应用更新同源，方便用户确认走的是哪个 GitHub 镜像 */}
				<div className="flex items-center gap-1.5 text-caption text-muted-foreground">
					<span>{t("settings.catalogUpdateSource")}</span>
					<span className="font-medium text-foreground">{catalogSourceLabel}</span>
				</div>
				{/* 后台检查发现新版本：亮点 + 版本对比，提示用户点「更新」拉取最新目录 */}
				{updateNotice ? (
					<div className="flex items-center gap-1.5 text-caption font-medium text-[var(--color-accent)]">
						<span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
						<span>{updateNotice}</span>
					</div>
				) : null}
				<div className="flex items-center gap-2 text-caption text-muted-foreground">
					<span>{t("settings.catalogBuiltin")}</span>
					<span className="font-medium text-foreground">{sourceText(status?.builtin ?? null)}</span>
				</div>
				<div className="flex items-center gap-2 text-caption text-muted-foreground">
					<span>{t("settings.catalogOverlay")}</span>
					{overlayActive ? <span className="font-medium text-foreground">{sourceText(status.overlay)}</span> : <span className={hasInvalidOverlayFiles ? "font-medium text-destructive" : undefined}>{hasInvalidOverlayFiles ? t("settings.catalogInvalidOverlay") : t("settings.catalogNone")}</span>}
				</div>
				<div className="flex items-center gap-2 text-caption text-muted-foreground">
					<span>{t("settings.catalogBackup")}</span>
					<span className="font-medium text-foreground">{status?.hasBackup ? t("settings.catalogHasBackup") : t("settings.catalogNone")}</span>
				</div>
			</div>

			{/* 自动更新开关：后台检查发现新版本即拉取，与下面「更新到最新」同一链路（带校验与备份） */}
			<div className="mt-2">
				<SettingSwitchRow anchor="dev-catalog-auto-update" title={t("settings.catalogAutoUpdate")} description={t("settings.catalogAutoUpdateDesc")} checked={props.autoUpdate !== false} dirty={props.autoUpdateDirty} onChange={(checked) => props.onAutoUpdateChange?.(checked)} />
			</div>

			{notice && <div className={`mt-2 rounded-md border px-3 py-2 text-caption ${notice.kind === "ok" ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-text-primary" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>{notice.text}</div>}

			<div className="mt-2 flex flex-wrap items-center gap-2">
				<Button
					variant="secondary"
					loading={busy === "check"}
					disabled={busy !== null && busy !== "check"}
					onClick={() =>
						run(
							"check",
							() => desktopApi.catalog.check("main"),
							(result) => {
								const checked = result as CatalogCheckResult;
								return checked.ok
									? checked.hasUpdate
										? t("settings.catalogCheckAvailable", {
												local: checked.localVersion ?? "—",
												remote: checked.remoteVersion,
											})
										: t("settings.catalogCheckLatest", { remote: checked.remoteVersion })
									: failText("unexpected");
							},
						)
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
							(result) => {
								const r = result as CatalogUpdateResult;
								if (r.ok && r.updated) return t("settings.catalogUpdated");
								// 分支预生成件比本地旧（仓库目录没跟上 npm 发布）：说清是谁落后，
								// 否则用户看到的是「提示可更新 → 点更新 → 已是最新」这种自我矛盾的循环。
								if (r.ok && r.skipped === "remote-behind") {
									return t("settings.catalogRemoteBehind", { remote: r.remoteVersion ?? "—", local: r.localVersion ?? "—" });
								}
								return t("settings.catalogAlreadyLatest");
							},
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
						run(
							"restore",
							() => desktopApi.catalog.restore(),
							() => t("settings.catalogRestored"),
						)
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
						desktopApi.catalog.openFile().catch(() => setNotice({ kind: "error", text: failText("unexpected") }));
					}}
				>
					{t("settings.catalogOpenFile")}
				</Button>
			</div>
		</SettingsSection>
	);
}
