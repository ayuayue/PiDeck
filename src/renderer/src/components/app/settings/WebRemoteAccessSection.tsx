/**
 * 设置弹框「外网访问」面板：两个内网穿透渠道的启停、地址展示与操作指南入口。
 * - Cloudflare Tunnel（免注册 quick tunnel）：手机零安装、任意网络可访问；域名每次启动变化。
 * - Tailscale：私有组网直连 + 可选 serve HTTPS 入口；手机需装客户端登录同一账号。
 * 状态全部来自主进程 RemoteAccessManager（invoke + web:remote-access-changed 推送），本组件不自持渠道状态。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { Cloud, Copy, Check, LifeBuoy, Globe, Lock, RefreshCw, Square, Loader2 } from "lucide-react";
import type { RemoteAccessChannelId, RemoteAccessState } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";
import { appendTokenToUrl } from "./webAccessUrl";
import { useQrDataUrl } from "./useQrDataUrl";
import { WebRemoteAccessGuideDialog, type RemoteAccessGuideTab } from "./WebRemoteAccessGuideDialog";

/** URL + 复制按钮 + 可选二维码的组合展示（两个渠道的地址区共用）。 */
function AccessUrlBlock({ url, showQr, hint }: { url: string; showQr?: boolean; hint?: string }) {
	const qrDataUrl = useQrDataUrl(showQr ? url : "");
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		if (!url) return;
		void navigator.clipboard
			.writeText(url)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => setCopied(false));
	}, [url]);

	return (
		<div className="flex flex-wrap items-start gap-3">
			{showQr && qrDataUrl ? <img src={qrDataUrl} alt={t("settings.webQrAlt")} className="size-36 shrink-0 rounded-md bg-white p-2" /> : null}
			<div className="min-w-0 flex-1">
				<div className="flex items-start gap-2 rounded-md border border-border-subtle/70 bg-bg-muted/40 p-2">
					<code className="block flex-1 break-all font-mono text-caption text-text-primary">{url}</code>
					<Button variant="ghost" size="icon-xs" className="size-7 shrink-0 rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-secondary" title={copied ? t("settings.webCopied") : t("settings.webCopyUrl")} aria-label={copied ? t("settings.webCopied") : t("settings.webCopyUrl")} onClick={handleCopy}>
						{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
					</Button>
				</div>
				{hint ? <small className="mt-1 block text-micro text-text-tertiary">{hint}</small> : null}
			</div>
		</div>
	);
}

/** 渠道卡片骨架：图标 + 名称 + 状态徽标 + 说明 + children（状态区/操作区）。 */
function ChannelCard({ icon, title, badge, badgeTone, description, children }: { icon: React.ReactNode; title: string; badge: string; badgeTone: "ok" | "warn" | "off"; description: string; children: React.ReactNode }) {
	const badgeClass = badgeTone === "ok" ? "bg-success/15 text-success" : badgeTone === "warn" ? "bg-warning/15 text-warning" : "bg-bg-muted text-text-tertiary";
	return (
		<div className="grid gap-2 rounded-lg border border-border-subtle/70 bg-bg-muted/20 p-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-bg-muted text-text-secondary">{icon}</span>
					<strong className="truncate text-caption font-semibold text-text-primary">{title}</strong>
				</div>
				<span className={`shrink-0 rounded-full px-2 py-0.5 text-micro font-semibold ${badgeClass}`}>{badge}</span>
			</div>
			<p className="text-micro text-text-tertiary">{description}</p>
			{children}
		</div>
	);
}

export const WebRemoteAccessSection = memo(function WebRemoteAccessSection(props: { webServiceChanging: boolean }) {
	const [state, setState] = useState<RemoteAccessState | null>(null);
	const [busyChannel, setBusyChannel] = useState<RemoteAccessChannelId | null>(null);
	const [guideOpen, setGuideOpen] = useState(false);
	const [guideTab, setGuideTab] = useState<RemoteAccessGuideTab>("cloudflare");

	// 初始拉取 + 订阅主进程推送；面板卸载退订
	useEffect(() => {
		let active = true;
		void desktopApi.settings
			.webRemoteAccessState()
			.then((snapshot) => {
				if (active) setState(snapshot);
			})
			.catch(() => {});
		const unsubscribe = desktopApi.settings.onWebRemoteAccessChanged((snapshot) => setState(snapshot));
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	const runChannelAction = useCallback(async (channel: RemoteAccessChannelId, action: "start" | "stop") => {
		setBusyChannel(channel);
		try {
			const api = desktopApi.settings;
			const result = action === "start" ? await api.webRemoteAccessStart(channel) : await api.webRemoteAccessStop(channel);
			if (result.ok) setState(result.state);
		} catch {
			// IPC 层异常不常见（业务失败走 ok:false）；忽略后由推送/重拉兜底
		} finally {
			setBusyChannel(null);
		}
	}, []);

	const openGuide = useCallback((tab: RemoteAccessGuideTab) => {
		setGuideTab(tab);
		setGuideOpen(true);
	}, []);

	const refresh = useCallback(() => {
		void desktopApi.settings
			.webRemoteAccessRefresh()
			.then((snapshot) => setState(snapshot))
			.catch(() => {});
	}, []);

	const cf = state?.cloudflare;
	const ts = state?.tailscale;
	const webReady = Boolean(state?.webRunning);
	const token = state?.webToken ?? "";
	const requiresAuth = state?.webRequiresAuth ?? true;

	// cloudflare 渠道展示地址：运行中的公网 URL（拼 token）
	const cfAccessUrl = cf?.publicUrl ? appendTokenToUrl(cf.publicUrl, token, requiresAuth) : "";
	// tailscale 直连地址（HTTP，虚拟 IP）
	const tsDirectUrl = ts?.ip && webReady ? appendTokenToUrl(`http://${ts.ip}:${state?.webPort ?? 0}`, token, requiresAuth) : "";
	// tailscale serve HTTPS 入口
	const tsServeUrl = ts?.serveUrl ? appendTokenToUrl(ts.serveUrl, token, requiresAuth) : "";

	const cfBadge = !cf?.binaryAvailable
		? { text: t("settings.remote.status.notInstalled"), tone: "warn" as const }
		: cf.running
			? { text: t("settings.remote.status.running"), tone: "ok" as const }
			: cf.starting
				? { text: t("settings.remote.status.starting"), tone: "warn" as const }
				: { text: t("settings.remote.status.ready"), tone: "off" as const };

	const tsBadge = !ts?.installed
		? { text: t("settings.remote.status.notInstalled"), tone: "warn" as const }
		: !ts.loggedIn
			? { text: t("settings.remote.status.notLoggedIn"), tone: "warn" as const }
			: ts.serveActive
				? { text: t("settings.remote.status.httpsOn"), tone: "ok" as const }
				: { text: t("settings.remote.status.connected"), tone: "ok" as const };

	return (
		<SettingsSection title={t("settings.remote.title")} description={t("settings.remote.desc")}>
			{/* 前提提示：Web 服务未开启时渠道不可用 */}
			{!webReady ? <p className="text-caption text-warning">{t("settings.remote.webServiceRequired")}</p> : null}
			{/* Token 鉴权关闭时的公网暴露警告（与局域网卡片的警告同源，公网场景更严重） */}
			{webReady && !requiresAuth ? <p className="text-caption text-warning">{t("settings.remote.authOffWarning")}</p> : null}

			{/* ── Cloudflare Tunnel ── */}
			<ChannelCard icon={<Cloud size={15} aria-hidden="true" />} title={t("settings.remote.cf.title")} badge={cfBadge.text} badgeTone={cfBadge.tone} description={t("settings.remote.cf.desc")}>
				{!cf?.binaryAvailable ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="secondary" onClick={() => openGuide("cloudflare")}>
							<LifeBuoy className="mr-1.5 size-3.5" aria-hidden="true" />
							{t("settings.remote.openGuide")}
						</Button>
						<Button size="sm" variant="outline" onClick={refresh} disabled={props.webServiceChanging}>
							<RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
							{t("settings.remote.recheck")}
						</Button>
					</div>
				) : cf.running || cf.starting ? (
					<div className="grid gap-2">
						{cf.starting ? (
							<div className="flex items-center gap-2 text-caption text-text-secondary">
								<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
								{t("settings.remote.cf.starting")}
							</div>
						) : cfAccessUrl ? (
							<AccessUrlBlock url={cfAccessUrl} showQr hint={t("settings.remote.cf.urlHint")} />
						) : null}
						<div>
							<Button size="sm" variant="outline" disabled={busyChannel !== null} onClick={() => void runChannelAction("cloudflare", "stop")}>
								<Square className="mr-1.5 size-3.5" aria-hidden="true" />
								{t("settings.remote.stop")}
							</Button>
						</div>
					</div>
				) : (
					<div className="grid gap-2">
						<div>
							<Button size="sm" disabled={!webReady || busyChannel !== null} onClick={() => void runChannelAction("cloudflare", "start")}>
								<Globe className="mr-1.5 size-3.5" aria-hidden="true" />
								{t("settings.remote.start")}
							</Button>
						</div>
					</div>
				)}
				{cf?.error ? <p className="text-caption text-warning">{cf.error}</p> : null}
			</ChannelCard>

			{/* ── Tailscale ── */}
			<ChannelCard icon={<Lock size={15} aria-hidden="true" />} title={t("settings.remote.ts.title")} badge={tsBadge.text} badgeTone={tsBadge.tone} description={t("settings.remote.ts.desc")}>
				{!ts?.installed ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="secondary" onClick={() => openGuide("tailscale")}>
							<LifeBuoy className="mr-1.5 size-3.5" aria-hidden="true" />
							{t("settings.remote.openGuide")}
						</Button>
						<Button size="sm" variant="outline" onClick={refresh} disabled={props.webServiceChanging}>
							<RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
							{t("settings.remote.recheck")}
						</Button>
					</div>
				) : !ts.loggedIn ? (
					<div className="grid gap-2">
						<p className="text-caption text-text-secondary">{t("settings.remote.ts.loginRequired")}</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="secondary" onClick={() => openGuide("tailscale")}>
								<LifeBuoy className="mr-1.5 size-3.5" aria-hidden="true" />
								{t("settings.remote.openGuide")}
							</Button>
							<Button size="sm" variant="outline" onClick={refresh} disabled={props.webServiceChanging}>
								<RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
								{t("settings.remote.recheck")}
							</Button>
						</div>
					</div>
				) : (
					<div className="grid gap-2">
						{tsDirectUrl ? <AccessUrlBlock url={tsDirectUrl} hint={t("settings.remote.ts.directHint")} /> : <p className="text-caption text-text-tertiary">{t("settings.remote.webServiceRequired")}</p>}
						{ts.serveActive && tsServeUrl ? <AccessUrlBlock url={tsServeUrl} showQr hint={t("settings.remote.ts.serveHint")} /> : <p className="text-micro text-text-tertiary">{t("settings.remote.ts.serveOffDesc")}</p>}
						<div className="flex flex-wrap items-center gap-2">
							{ts.serveActive ? (
								<Button size="sm" variant="outline" disabled={busyChannel !== null} onClick={() => void runChannelAction("tailscale", "stop")}>
									<Square className="mr-1.5 size-3.5" aria-hidden="true" />
									{t("settings.remote.ts.stopHttps")}
								</Button>
							) : (
								<Button size="sm" variant="secondary" disabled={!webReady || busyChannel !== null} onClick={() => void runChannelAction("tailscale", "start")}>
									<Lock className="mr-1.5 size-3.5" aria-hidden="true" />
									{t("settings.remote.ts.startHttps")}
								</Button>
							)}
							<Button size="sm" variant="ghost" onClick={() => openGuide("tailscale")}>
								{t("settings.remote.openGuide")}
							</Button>
						</div>
					</div>
				)}
				{ts?.error ? <p className="text-caption text-warning">{ts.error}</p> : null}
			</ChannelCard>

			{/* 底部：总入口的操作指南 */}
			<SettingRow anchor="web-remote-access-guide" title={t("settings.remote.guideRowTitle")} description={t("settings.remote.guideRowDesc")}>
				<Button variant="outline" size="sm" onClick={() => openGuide(guideTab)}>
					<LifeBuoy className="mr-1.5 size-3.5" aria-hidden="true" />
					{t("settings.remote.openGuide")}
				</Button>
			</SettingRow>

			<WebRemoteAccessGuideDialog open={guideOpen} onOpenChange={setGuideOpen} tab={guideTab} onTabChange={setGuideTab} />
		</SettingsSection>
	);
});
