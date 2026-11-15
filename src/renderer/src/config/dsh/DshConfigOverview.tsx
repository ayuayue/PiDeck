import { useAtomValue } from "jotai";
import { ArchiveRestore, FolderOpen, LoaderCircle, Power, PowerOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { dshRuntimeStatusAtom } from "../../atoms/dsh-atoms";
import { DshLogo } from "../../components/session/SessionSourceBadge";
import { Button } from "../../components/ui-shadcn/button";
import { Switch } from "../../components/ui-shadcn/switch";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { managerArchivedDshLabel } from "../../sessionManagerModel";
import { showNotice } from "../../utils/notice";
import { DshHomeSharingNotice } from "../DshHomeSharingNotice";
import { DshRuntimeSection } from "../DshRuntimeSection";
import type { DshStatus } from "./dshConfigTypes";
import type { ArchivedDshSession } from "../../../../shared/types";

export function DshConfigOverview(props: { status: DshStatus | null; hasDocument: boolean; onOpenFolder: (path: string) => void; onOpenDocument: () => void; onChanged: () => void }) {
	const { status } = props;
	const [picking, setPicking] = useState(false);
	const [switching, setSwitching] = useState(false);
	/** runtime 安装态（全局同步）：概览页顶部 runtime 管理区块（未装→安装引导，已装→版本/目录/卸载）。 */
	const runtimeStatus = useAtomValue(dshRuntimeStatusAtom);
	/** G14：归档区 DSH 会话清单（目录已移入 .pideck-archive 的 host 会话；恢复入口用，含标题）。 */
	const [archived, setArchived] = useState<ArchivedDshSession[]>([]);
	/** G14：正在恢复的 dshSessionId（按钮转圈防重复点击）。 */
	const [restoring, setRestoring] = useState<string | null>(null);
	/** 启动时是否自动导入外部会话：原设置页 DSH tab 独有项，收口到配置管理概览。 */
	const [autoImport, setAutoImport] = useState(true);
	const [autoImportLoaded, setAutoImportLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.sessions
			.listArchivedDshSessions()
			.then((items) => {
				if (!cancelled) setArchived(items);
			})
			.catch(() => undefined);
		void desktopApi.settings
			.get()
			.then((settings) => {
				if (!cancelled) {
					setAutoImport(settings.dshAutoImportSessions !== false);
					setAutoImportLoaded(true);
				}
			})
			.catch(() => {
				if (!cancelled) setAutoImportLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	/** 启动自动导入：即时写入设置，下次启动生效；关闭后侧栏不再收录外部会话。 */
	const toggleAutoImport = async (checked: boolean) => {
		const prev = autoImport;
		setAutoImport(checked);
		try {
			await desktopApi.settings.update({ dshAutoImportSessions: checked });
			showNotice(t(checked ? "config.dsh.autoImportOn" : "config.dsh.autoImportOff"), 3000);
		} catch (saveError) {
			setAutoImport(prev);
			showNotice(saveError instanceof Error ? saveError.message : String(saveError), 4000);
		}
	};

	/** G14：恢复归档的 DSH 会话（主进程移回 sessions 树并重建 catalog 记录）。 */
	const restoreArchived = async (dshSessionId: string) => {
		if (restoring) return;
		setRestoring(dshSessionId);
		try {
			await desktopApi.sessions.unarchiveDshSession(dshSessionId);
			showNotice(t("config.dsh.restored"), 3000);
			setArchived((current) => current.filter((item) => item.dshSessionId !== dshSessionId));
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setRestoring(null);
		}
	};

	/**
	 * 切换 DSH_HOME 目录：选目录 → 写设置 → 立即重启 host 生效。
	 * 主进程 restartDshHost 会先自动停掉活跃 DSH 会话（catalog 保留，重新打开时 attach）。
	 */
	const pickHomeDir = async () => {
		if (picking) return;
		setPicking(true);
		try {
			const picked = await desktopApi.dialog.pickFiles({ title: t("config.dsh.pickHomeTitle"), includeDirectories: true });
			const dir = picked?.[0];
			if (!dir) return;
			setSwitching(true);
			await desktopApi.settings.update({ dshHomeDir: dir });
			if (status?.started) {
				const restarted = await desktopApi.sessions.restartDshHost();
				if (restarted) {
					showNotice(t("config.dsh.homeChangeApplied"), 4000);
				} else {
					// 兑底：stopAll/restart 异常（正常路径不会走到这里）
					showNotice(t("config.dsh.homeChangeFailed"), 6000);
				}
			} else {
				showNotice(t("config.dsh.homeChangeNextBoot"), 4000);
			}
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setPicking(false);
			setSwitching(false);
		}
	};

	/** 恢复默认：清空 dshHomeDir，回到自动解析（~/.dsh 优先，不存在则应用私有目录）。 */
	const resetHomeDir = async () => {
		setSwitching(true);
		try {
			await desktopApi.settings.update({ dshHomeDir: "" });
			if (status?.started) {
				const restarted = await desktopApi.sessions.restartDshHost();
				showNotice(restarted ? t("config.dsh.homeResetApplied") : t("config.dsh.homeChangeFailed"), restarted ? 4000 : 6000);
			} else {
				showNotice(t("config.dsh.homeReset"), 4000);
			}
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setSwitching(false);
		}
	};

	/**
	 * 手动恢复 host：复用设置切换时的完整重启链路，确保先终止旧 mux，
	 * 再等待新 host ready，不能只杀 utilityProcess 留下运行会话。
	 */
	const restartHost = async () => {
		if (switching) return;
		setSwitching(true);
		try {
			const restarted = await desktopApi.sessions.restartDshHost();
			showNotice(restarted ? t("config.dsh.hostRestarted") : t("config.dsh.hostRestartFailed"), restarted ? 4000 : 6000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setSwitching(false);
			props.onChanged();
		}
	};

	/**
	 * 手动停止 host（用户不想让它运行）：主进程先停活跃 DSH 会话，再 dispose host，
	 * 并持久化 dshManualStopped=true——之后预热/按需兕底/崩溃自动重启都不会再拉起，
	 * 只有点「启动」才恢复。停止后配置读写（settings.describe 等）也会失败——这是
	 * 预期行为，概览页会显示「已手动停止」徽标而不是错误态。
	 */
	const stopHost = async () => {
		if (switching) return;
		setSwitching(true);
		try {
			const stopped = await desktopApi.sessions.stopDshHost();
			showNotice(stopped ? t("config.dsh.hostStopped") : t("config.dsh.hostStopFailed"), stopped ? 4000 : 6000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 6000);
		} finally {
			setSwitching(false);
			props.onChanged();
		}
	};

	/** 手动启动 host（唯一能恢复运行的方式）：主进程清停止标记后 boot。 */
	const startHost = async () => {
		if (switching) return;
		setSwitching(true);
		try {
			const started = await desktopApi.sessions.startDshHost();
			showNotice(started ? t("config.dsh.hostStarted") : t("config.dsh.hostStartFailed"), started ? 4000 : 6000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 6000);
		} finally {
			setSwitching(false);
			props.onChanged();
		}
	};

	return (
		<div className="grid gap-4 p-4">
			{/* DSH 后端运行时管理区块：未装→安装引导，已装→版本/目录/卸载/导入。 */}
			<DshRuntimeSection status={runtimeStatus} onOpenFolder={props.onOpenFolder} />
			<section className="grid gap-2">
				<h3 className="flex items-center gap-2 text-caption font-semibold text-muted-foreground">
					<DshLogo className="size-4" />
					{t("config.dsh.title")}
				</h3>
				<div className="flex items-center gap-2">
					{status?.started ? (
						<span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-micro font-medium text-success  ">{t("config.dsh.started")}</span>
					) : status?.manuallyStopped ? (
						// 手动停止是用户的主动选择，用中性徽标而非错误红：区别于 boot 失败。
						<span className="rounded-full border border-border-subtle bg-bg-panel px-2 py-0.5 text-micro text-muted-foreground">{t("config.dsh.manuallyStopped")}</span>
					) : (
						<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">{t("config.dsh.notStarted")}</span>
					)}
					{/* 停止/启动互斥：运行中→停止；已手动停止→启动（唯一恢复入口）。重启仅在运行中可用。 */}
					{status?.started ? (
						<Button type="button" variant="secondary" size="sm" className="h-7 gap-1" disabled={switching} onClick={() => void stopHost()}>
							{switching ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <PowerOff className="size-3.5" aria-hidden="true" />}
							{t("config.dsh.stopHost")}
						</Button>
					) : (
						<Button type="button" variant="secondary" size="sm" className="h-7 gap-1" disabled={switching} onClick={() => void startHost()}>
							{switching ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <Power className="size-3.5" aria-hidden="true" />}
							{t("config.dsh.startHost")}
						</Button>
					)}
					{status?.started ? (
						<Button type="button" variant="secondary" size="sm" className="h-7 gap-1" disabled={switching} onClick={() => void restartHost()}>
							<RefreshCw className="size-3.5" aria-hidden="true" />
							{t("config.dsh.restartHost")}
						</Button>
					) : null}
				</div>
			</section>
			{/* 跨工具兼容只留开关：开=启动只读扫盘入侧栏；关=不收录。不提供手动导入。 */}
			<section className="grid gap-2">
				<div className="flex items-center justify-between gap-4 rounded-md border border-border-subtle bg-bg-panel px-3.5 py-2.5">
					<div className="grid gap-0.5">
						<span className="text-caption font-semibold text-foreground">{t("config.dsh.autoImportForeign")}</span>
						<p className="text-micro text-muted-foreground">{t("config.dsh.autoImportForeignHint")}</p>
					</div>
					<Switch checked={autoImport} disabled={!autoImportLoaded} onCheckedChange={(checked) => void toggleAutoImport(checked)} />
				</div>
			</section>
			<section className="grid gap-2">
				<h3 className="text-caption font-semibold text-muted-foreground">{t("config.dsh.directories")}</h3>
				{/* 共享/并发冲突提示（issue #189）：默认 ~/.dsh 与 dsh CLI 共用（中性说明），
				    或锁文件里有另一个存活的 PiDeck host（升级为警告）。显式覆盖过目录时不提示。 */}
				<DshHomeSharingNotice sharing={status?.sharing} />
				{/* DSH_HOME 即唯一配置目录：settings.yaml / .credentials.yaml / sessions / storages 全在同一目录 */}
				<DirRow label={t("config.dsh.homeDir")} path={status?.homeDir ?? ""} onOpen={props.onOpenFolder} />
				<div className="flex items-center gap-2">
					<Button type="button" variant="secondary" size="sm" className="h-7" disabled={picking || switching} onClick={() => void pickHomeDir()}>
						{picking ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <FolderOpen className="size-3.5" aria-hidden="true" />}
						{t("config.dsh.changeHome")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled={switching} onClick={() => void resetHomeDir()}>
						{t("config.dsh.resetHome")}
					</Button>
				</div>
				<p className="text-micro text-muted-foreground">{t("config.dsh.homeHint")}</p>
			</section>
			{/* G14：DSH 归档区（归档动作在会话列表右键；恢复入口在这里） */}
			<section className="grid gap-2">
				<h3 className="text-caption font-semibold text-muted-foreground">{t("config.dsh.archived")}</h3>
				{archived.length === 0 ? (
					<p className="text-micro text-muted-foreground">{t("config.dsh.archivedEmpty")}</p>
				) : (
					<div className="grid gap-1.5">
						{archived.map((item) => (
							<div key={item.dshSessionId} className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-panel px-2 py-1.5">
								<span className="min-w-0 flex-1 truncate text-control text-foreground" title={item.cwd || item.dshSessionId}>
									{/* 标题（manifest/日志折叠）> cwd 末段 > host id：与会话管理弹窗归档视图同一策略 */}
									<span className="font-medium">{managerArchivedDshLabel({ kind: "dsh", item })}</span>
									<span className="ml-2 text-caption text-text-secondary">{item.cwd}</span>
								</span>
								<Button type="button" variant="secondary" size="sm" className="h-6 shrink-0" disabled={restoring === item.dshSessionId} onClick={() => void restoreArchived(item.dshSessionId)}>
									{restoring === item.dshSessionId ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <ArchiveRestore className="size-3.5" aria-hidden="true" />}
									{t("config.dsh.restore")}
								</Button>
							</div>
						))}
					</div>
				)}
				<p className="text-micro text-muted-foreground">{t("config.dsh.archivedHint")}</p>
			</section>
			{props.hasDocument && (
				<section>
					<Button type="button" variant="secondary" size="sm" onClick={props.onOpenDocument}>
						<FolderOpen className="size-3.5" aria-hidden="true" />
						{t("config.dsh.openDocument")}
					</Button>
				</section>
			)}
			<p className="text-micro text-muted-foreground">{t("config.dsh.overviewHint")}</p>
		</div>
	);
}

function DirRow(props: { label: string; path: string; onOpen: (path: string) => void }) {
	return (
		<div className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-panel px-3 py-2">
			<span className="shrink-0 text-caption text-muted-foreground">{props.label}</span>
			<span className="min-w-0 flex-1 truncate font-mono text-micro text-foreground" title={props.path}>
				{props.path || "—"}
			</span>
			{props.path && (
				<Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 rounded-md px-2 text-control" onClick={() => props.onOpen(props.path)}>
					{t("config.dsh.openFolder")}
				</Button>
			)}
		</div>
	);
}
