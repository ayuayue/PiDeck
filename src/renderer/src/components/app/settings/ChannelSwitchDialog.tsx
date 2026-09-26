import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import type { TargetChannelRelease } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { channelSwitchStatusAtom } from "../../../atoms/channelSwitchAtoms";
import { Button } from "../../ui-shadcn/button";
import { Progress } from "../../ui-shadcn/progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";

type ChannelSwitchDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 查询失败拿不到目标发布时的退化入口（AppInfo.releasesUrl，主进程受信地址）。 */
	releasesUrl: string;
};

/**
 * 通道切换向导（ChannelSwitchService 快照驱动，无本地状态副本）。
 *
 * 状态机（对齐服务端 ChannelSwitchSnapshot.phase）：
 *   打开时 idle/error → query() → available（目标版本 + notes 摘要 + 数据模式预告，用户在此确认）
 *   → downloading（进度条）→ ready（立即安装：launch 后主进程唤起安装器并退出应用）；
 *   error 保留「打开发布页」手动下载退化入口。
 * busy 并发被服务端拒绝时快照不变（仍在 downloading），此处静默吞掉异常即可。
 */
export function ChannelSwitchDialog(props: ChannelSwitchDialogProps) {
	const snapshot = useAtomValue(channelSwitchStatusAtom);
	const phase = snapshot?.phase ?? "idle";
	// launch 失败不在服务端状态机内（spawn/quit 无错误快照推送），本地兜底展示一次。
	const [launchError, setLaunchError] = useState<string | null>(null);

	useEffect(() => {
		if (!props.open) return;
		setLaunchError(null);
		// 首次进入（idle）或上次失败后重开：重新查询目标版本；
		// available/downloading/ready 是进行中状态，重开照常展示快照，不重复发起网络请求。
		if (!snapshot || snapshot.phase === "idle" || snapshot.phase === "error") {
			void desktopApi.channelSwitch.query().catch(() => undefined);
		}
		// 仅响应 open 翻转；快照变化由 onStateChanged 订阅驱动渲染，不入依赖避免重复触发 query。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.open]);

	const target = phase === "error" ? null : (snapshot?.target ?? null);
	// ready 阶段的安装包路径（服务端已做临时目录白名单校验，launch 前缀二次校验在 IPC 层）。
	const installerPath = phase === "ready" ? snapshot?.installerPath : undefined;
	// 错误退化入口：优先用查询到的发布页地址，查询失败缺省回退仓库 releases 页。
	const releasePageUrl = target?.releasePageUrl ?? props.releasesUrl;

	const handleDownload = (release: TargetChannelRelease) => {
		void desktopApi.channelSwitch.download(release).catch(() => undefined);
	};

	const handleInstall = (path: string) => {
		void desktopApi.channelSwitch
			.launch(path)
			.then((result) => {
				// 结构化失败（如路径校验不过）不抛异常，本地展示；成功则主进程即将退出应用。
				if (!result.ok) setLaunchError(result.error);
			})
			.catch((error: unknown) => {
				setLaunchError(error instanceof Error ? error.message : String(error));
			});
	};

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("settings.channelSwitchDialogTitle")}</DialogTitle>
					{/* 数据模式预告（规格 §5 确认区必备文案）：通道切换后首次启动会进入数据模式选择。 */}
					<DialogDescription>{t("settings.channelSwitchDataModeNotice")}</DialogDescription>
				</DialogHeader>

				{(phase === "idle" || phase === "querying") && <p className="text-caption text-muted-foreground">{t("settings.channelSwitchQuerying")}</p>}

				{/* available：确认区——目标版本 + notes 摘要；点「下载」即确认切换。 */}
				{phase === "available" && target && (
					<div className="space-y-2">
						<p className="text-body font-medium">{t("settings.channelSwitchTargetVersion", { version: target.version })}</p>
						{target.notesExcerpt && (
							<div className="space-y-1">
								<p className="text-caption font-medium text-muted-foreground">{t("settings.channelSwitchNotes")}</p>
								<p className="whitespace-pre-wrap text-caption text-muted-foreground">{target.notesExcerpt}</p>
							</div>
						)}
					</div>
				)}

				{/* downloading：进度条（进度模式照 AppUpdateCard 同通道下载，快照 percent 为 0-100 整数）。 */}
				{phase === "downloading" && target && (
					<div className="space-y-1">
						<div className="flex items-center justify-between text-caption text-muted-foreground">
							<span>{t("settings.updateDownloading", { version: target.version })}</span>
							<span>{snapshot?.percent != null ? `${snapshot.percent}%` : ""}</span>
						</div>
						<Progress value={snapshot?.percent ?? 0} aria-label={t("settings.updateDownloading", { version: "" })} />
					</div>
				)}

				{/* ready：安装包已就绪，等待用户明确安装。 */}
				{phase === "ready" && target && <p className="text-caption text-success">{t("settings.updateReadyToInstall", { version: target.version })}</p>}

				{/* error：失败说明 + 手动下载退化入口（查询类失败的服务端文案已附发布页地址）。 */}
				{phase === "error" && <p className="text-caption text-destructive">{t("settings.channelSwitchError", { error: snapshot?.error ?? t("common.unknown") })}</p>}
				{launchError && <p className="text-caption text-destructive">{t("settings.channelSwitchError", { error: launchError })}</p>}

				<DialogFooter>
					{target && phase === "available" && (
						<Button size="sm" onClick={() => handleDownload(target)}>
							{t("settings.channelSwitchDownload")}
						</Button>
					)}
					{installerPath && (
						<Button size="sm" onClick={() => handleInstall(installerPath)}>
							{t("settings.channelSwitchInstallNow")}
						</Button>
					)}
					{phase === "error" && (
						<Button variant="ghost" size="sm" onClick={() => void desktopApi.app.openExternal(releasePageUrl, true)}>
							{t("settings.channelSwitchOpenReleasePage")}
						</Button>
					)}
					<Button variant="ghost" size="sm" onClick={() => props.onOpenChange(false)}>
						{t("common.close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
