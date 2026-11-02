/**
 * 设置弹框「外网访问」面板：三个渠道的启停/只读探测、地址展示与操作指南入口。
 * - Cloudflare Tunnel（免注册 quick tunnel）：手机零安装、任意网络可访问；域名每次启动变化。
 * - Tailscale：私有组网直连 + 可选 serve HTTPS 入口；手机需装客户端登录同一账号。
 * - EasyTier：去中心化 P2P 组网；PiDeck 只读取本地节点虚拟 IP，不启动/停止网络。
 * 状态全部来自主进程 RemoteAccessManager（invoke + web:remote-access-changed 推送），本组件不自持渠道状态。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { Cloud, Copy, Check, LifeBuoy, Globe, Lock, Network, RefreshCw, RotateCw, Square, Loader2 } from "lucide-react";
import type { AppSettings, RemoteAccessChannelId, RemoteAccessState, WebNetworkAddress } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow } from "./SettingRows";
import { appendTokenToUrl, bracketIpv6Host } from "./webAccessUrl";
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

export const WebRemoteAccessSection = memo(function WebRemoteAccessSection(props: {
	webServiceChanging: boolean;
	/** 设置草稿与更新入口：隧道参数（协议/自定义参数）走设置保存流，随弹框统一落盘 */
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	/** 本机可用网卡地址：手机还没入网时，配置下载只能走局域网入口。 */
	networkAddresses?: WebNetworkAddress[];
}) {
	const [state, setState] = useState<RemoteAccessState | null>(null);
	const [busyChannel, setBusyChannel] = useState<RemoteAccessChannelId | null>(null);
	// 分享二维码用的网卡索引：手机首次配置只能走局域网，多网卡时需要能切换
	const [etShareHostIndex, setEtShareHostIndex] = useState(0);
	// 配置表单默认折叠：卡片首屏只留状态 + 主操作，配置属于一次性设置
	const [etConfigOpen, setEtConfigOpen] = useState(false);
	// 二维码按需展开：手机没准备好之前它只是噪声
	const [etShareOpen, setEtShareOpen] = useState(false);
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

	const runChannelAction = useCallback(
		async (channel: RemoteAccessChannelId, action: "start" | "restart" | "stop") => {
			setBusyChannel(channel);
			try {
				const api = desktopApi.settings;
				// EasyTier 用当前草稿而非已保存设置：改完配置直接点启动/重启即可，不必先点保存
				const starting = action !== "stop";
				const easyTierConfig =
					channel === "easytier" && starting
						? {
								networkName: (props.draft.webRemoteEasyTierNetworkName ?? "").trim(),
								networkSecret: (props.draft.webRemoteEasyTierNetworkSecret ?? "").trim(),
								peers: props.draft.webRemoteEasyTierPeers ?? [],
								bindIpv4: props.draft.webRemoteEasyTierIp ?? "",
							}
						: undefined;
				// 重启复用 start 通道：主进程会先写配置，服务已在跑时先停再启（见 RemoteAccessManager.startEasyTier）
				const result = starting ? await api.webRemoteAccessStart(channel, easyTierConfig) : await api.webRemoteAccessStop(channel);
				if (result.ok) setState(result.state);
			} catch {
				// IPC 层异常不常见（业务失败走 ok:false）；忽略后由推送/重拉兜底
			} finally {
				setBusyChannel(null);
			}
		},
		[props.draft.webRemoteEasyTierNetworkName, props.draft.webRemoteEasyTierNetworkSecret, props.draft.webRemoteEasyTierPeers, props.draft.webRemoteEasyTierIp],
	);

	const openGuide = useCallback((tab: RemoteAccessGuideTab) => {
		setGuideTab(tab);
		setGuideOpen(true);
	}, []);

	// 重新检测要跑子进程/注册表探测，给个忙碌态，避免「点了没反应」的错觉
	const [refreshing, setRefreshing] = useState(false);
	const refresh = useCallback(() => {
		setRefreshing(true);
		void desktopApi.settings
			.webRemoteAccessRefresh()
			.then((snapshot) => setState(snapshot))
			.catch(() => {})
			.finally(() => setRefreshing(false));
	}, []);

	// 解压版 CLI 不在 PATH 也不写卸载信息：让用户直接挑 easytier-cli.exe
	const pickEasyTierCli = useCallback(() => {
		void desktopApi.dialog
			.pickFiles({ title: t("settings.remote.et.cliPathLabel") })
			.then((paths) => {
				const picked = paths[0];
				if (picked) props.updateDraft({ webRemoteEasyTierCliPath: picked });
			})
			.catch(() => {});
	}, [props]);

	const cf = state?.cloudflare;
	const ts = state?.tailscale;
	const et = state?.easytier;
	const webReady = Boolean(state?.webRunning);
	const token = state?.webToken ?? "";
	const requiresAuth = state?.webRequiresAuth ?? true;

	// cloudflare 渠道展示地址：运行中的公网 URL（拼 token）
	const cfAccessUrl = cf?.publicUrl ? appendTokenToUrl(cf.publicUrl, token, requiresAuth) : "";
	// tailscale 直连地址（HTTP，虚拟 IP）
	const tsDirectUrl = ts?.ip && webReady ? appendTokenToUrl(`http://${ts.ip}:${state?.webPort ?? 0}`, token, requiresAuth) : "";
	// tailscale serve HTTPS 入口
	const tsServeUrl = ts?.serveUrl ? appendTokenToUrl(ts.serveUrl, token, requiresAuth) : "";
	// EasyTier 直连地址（HTTP，虚拟 IP）
	const etUrl = et?.ip && webReady ? appendTokenToUrl(`http://${et.ip}:${state?.webPort ?? 0}`, token, requiresAuth) : "";

	// EasyTier 配置下载地址：手机在入网前就得能打开，所以优先用已就绪的公网/组网入口，
	// 最后才回落到 EasyTier 虚拟 IP（此时手机已入网，属于重复配置场景）。
	// 手机首次配置时还没入网，下载地址必须走它能访问到的入口：局域网网卡优先，
	// 其次是已开启的隧道/组网入口；EasyTier 虚拟 IP 放最后（那时已入网，属重复配置）。
	const lanAddresses = props.networkAddresses ?? [];
	const lanHost = lanAddresses.length > 0 ? lanAddresses[Math.min(etShareHostIndex, lanAddresses.length - 1)] : undefined;
	const etConfigBase = lanHost?.address ? `http://${bracketIpv6Host(lanHost.address)}:${state?.webPort ?? 0}` : cf?.publicUrl || (ts?.ip ? `http://${ts.ip}:${state?.webPort ?? 0}` : "") || (et?.ip ? `http://${et.ip}:${state?.webPort ?? 0}` : "");
	const etConfigUrl = etConfigBase && webReady ? appendTokenToUrl(`${etConfigBase.replace(/\/$/, "")}/api/easytier/config.toml`, token, requiresAuth) : "";

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

	// 徽标只回答「起没起来」：托管服务或外部客户端任一在跑就是运行中；
	// 托管/外部的区别放在卡片里的状态行，避免用户把「已连接」误当成「已启动本机服务」。
	const etBadge = !et?.installed ? { text: t("settings.remote.status.notInstalled"), tone: "warn" as const } : et.serviceRunning || et.running ? { text: t("settings.remote.status.running"), tone: "ok" as const } : { text: t("settings.remote.status.notRunning"), tone: "warn" as const };

	return (
		<SettingsSection id="settings-section-web-remote-access" title={t("settings.remote.title")} description={t("settings.remote.desc")}>
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
						<Button size="sm" variant="outline" onClick={refresh} disabled={props.webServiceChanging || refreshing}>
							{refreshing ? <Loader2 className="mr-1.5 size-3.5 animate-pideck-spin" aria-hidden="true" /> : <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />}
							{t("settings.remote.recheck")}
						</Button>
					</div>
				) : cf.running || cf.starting ? (
					<div className="grid gap-2">
						{cf.starting ? (
							<div className="flex items-center gap-2 text-caption text-text-secondary">
								<Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" />
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
				{/* 隧道参数：用户环境差异大（UDP QoS/IPv6/区域），协议与额外参数可调；走设置保存流，重启隧道后生效 */}
				{cf?.binaryAvailable ? (
					<div className="mt-1 grid gap-2 border-t border-border-subtle/60 pt-2">
						<div className="grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
							<Label className="text-xs font-bold text-text-tertiary">{t("settings.remote.cf.protocolLabel")}</Label>
							<Select value={props.draft.webRemoteCloudflaredProtocol ?? "http2"} onValueChange={(value) => props.updateDraft({ webRemoteCloudflaredProtocol: value as AppSettings["webRemoteCloudflaredProtocol"] })}>
								<SelectTrigger size="sm" className="w-full sm:w-[220px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="http2">{t("settings.remote.cf.protocolHttp2")}</SelectItem>
									<SelectItem value="quic">{t("settings.remote.cf.protocolQuic")}</SelectItem>
									<SelectItem value="auto">{t("settings.remote.cf.protocolAuto")}</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
							<Label className="text-xs font-bold text-text-tertiary">{t("settings.remote.cf.extraArgsLabel")}</Label>
							<Input
								className="h-8 w-full font-mono text-xs"
								placeholder={t("settings.remote.cf.extraArgsPlaceholder")}
								value={props.draft.webRemoteCloudflaredExtraArgs ?? ""}
								onChange={(event) => props.updateDraft({ webRemoteCloudflaredExtraArgs: event.target.value })}
								onBlur={(event) => props.updateDraft({ webRemoteCloudflaredExtraArgs: event.target.value.trim() })}
							/>
						</div>
						<small className="text-micro text-text-tertiary">{t("settings.remote.cf.paramsHint")}</small>
					</div>
				) : null}
			</ChannelCard>

			{/* ── Tailscale ── */}
			<ChannelCard icon={<Lock size={15} aria-hidden="true" />} title={t("settings.remote.ts.title")} badge={tsBadge.text} badgeTone={tsBadge.tone} description={t("settings.remote.ts.desc")}>
				{!ts?.installed ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="secondary" onClick={() => openGuide("tailscale")}>
							<LifeBuoy className="mr-1.5 size-3.5" aria-hidden="true" />
							{t("settings.remote.openGuide")}
						</Button>
						<Button size="sm" variant="outline" onClick={refresh} disabled={props.webServiceChanging || refreshing}>
							{refreshing ? <Loader2 className="mr-1.5 size-3.5 animate-pideck-spin" aria-hidden="true" /> : <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />}
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

			{/* ── EasyTier（托管：填齐网络名/密钥后由 PiDeck 启停；未配置时退回只读探测）── */}
			<ChannelCard icon={<Network size={15} aria-hidden="true" />} title={t("settings.remote.et.title")} badge={etBadge.text} badgeTone={etBadge.tone} description={t("settings.remote.et.desc")}>
				{/* 明确区分「PiDeck 托管服务」与「外部客户端」：两者都会让徽标变成运行中，但只有前者能用下方的按钮控制 */}
				{et?.installed ? <small className="text-micro text-text-tertiary">{et.serviceRunning ? t("settings.remote.et.statusManagedRunning") : et.running ? t("settings.remote.et.statusExternalRunning") : t("settings.remote.et.statusStopped")}</small> : null}
				{etUrl ? (
					<AccessUrlBlock url={etUrl} showQr hint={et?.ipSource === "cli" ? t("settings.remote.et.autoUrlHint") : t("settings.remote.et.manualUrlHint")} />
				) : (
					<p className="text-caption text-text-secondary">{et?.installed ? (et.serviceRunning ? t("settings.remote.et.addressPendingHint") : t("settings.remote.et.notRunningHint")) : t("settings.remote.et.noCliHint")}</p>
				)}
				{etConfigOpen ? (
					<>
						{/* CLI 路径：官方 Windows 包是「解压即用」，不在 PATH 也没卸载记录，自动检测可能找不到 */}
						<div className="grid gap-1">
							<div className="grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
								<Label className="text-xs font-bold text-text-tertiary">{t("settings.remote.et.cliPathLabel")}</Label>
								<div className="flex items-center gap-2">
									<Input
										className="h-8 w-full font-mono text-xs"
										placeholder={t("settings.remote.et.cliPathPlaceholder")}
										value={props.draft.webRemoteEasyTierCliPath ?? ""}
										onChange={(event) => props.updateDraft({ webRemoteEasyTierCliPath: event.target.value })}
										onBlur={(event) => props.updateDraft({ webRemoteEasyTierCliPath: event.target.value.trim() })}
									/>
									<Button size="sm" variant="outline" className="shrink-0" onClick={pickEasyTierCli}>
										{t("settings.remote.et.browse")}
									</Button>
								</div>
							</div>
							<small className="text-micro text-text-tertiary">{t("settings.remote.et.cliPathHint")}</small>
						</div>
						{et?.installed && et.binaryPath ? <small className="break-all text-micro text-text-tertiary">{t("settings.remote.et.cliFound", { path: et.binaryPath })}</small> : null}
						{/* 手动地址始终可填：留空用自动检测，填写后明确优先（多网络/自动结果不对时的覆盖入口） */}
						<div className="grid gap-1">
							<div className="grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
								<Label className="text-xs font-bold text-text-tertiary">{t("settings.remote.et.manualLabel")}</Label>
								<Input
									className="h-8 w-full font-mono text-xs"
									placeholder={t("settings.remote.et.manualPlaceholder")}
									value={props.draft.webRemoteEasyTierIp ?? ""}
									onChange={(event) => props.updateDraft({ webRemoteEasyTierIp: event.target.value })}
									onBlur={(event) => props.updateDraft({ webRemoteEasyTierIp: event.target.value.trim() })}
								/>
							</div>
							<small className="text-micro text-text-tertiary">{t("settings.remote.et.manualHint")}</small>
						</div>
						{et?.hostname || et?.version ? <small className="text-micro text-text-tertiary">{t("settings.remote.et.nodeInfo", { hostname: et.hostname || "-", version: et.version || "-" })}</small> : null}
						{/* 托管配置：填齐网络名 + 密钥后由 PiDeck 生成配置并接管 core 的启停 */}
						<div className="grid gap-2 rounded-md border border-border-subtle/70 bg-bg-muted/30 p-2">
							<small className="text-micro text-text-tertiary">{t("settings.remote.et.managedHint")}</small>
							<div className="grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
								<Label className="text-xs font-bold text-text-tertiary">{t("settings.remote.et.networkNameLabel")}</Label>
								<Input
									className="h-8 w-full font-mono text-xs"
									placeholder={t("settings.remote.et.networkNamePlaceholder")}
									value={props.draft.webRemoteEasyTierNetworkName ?? ""}
									onChange={(event) => props.updateDraft({ webRemoteEasyTierNetworkName: event.target.value })}
									onBlur={(event) => props.updateDraft({ webRemoteEasyTierNetworkName: event.target.value.trim() })}
								/>
							</div>
							<div className="grid items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
								<Label className="text-xs font-bold text-text-tertiary">{t("settings.remote.et.networkSecretLabel")}</Label>
								<Input
									type="password"
									className="h-8 w-full font-mono text-xs"
									placeholder={t("settings.remote.et.networkSecretPlaceholder")}
									value={props.draft.webRemoteEasyTierNetworkSecret ?? ""}
									onChange={(event) => props.updateDraft({ webRemoteEasyTierNetworkSecret: event.target.value })}
									onBlur={(event) => props.updateDraft({ webRemoteEasyTierNetworkSecret: event.target.value.trim() })}
								/>
							</div>
							<div className="grid gap-1">
								<Label className="text-xs font-bold text-text-tertiary">{t("settings.remote.et.peersLabel")}</Label>
								<textarea
									className="min-h-16 w-full resize-y rounded-md border border-border-subtle/70 bg-bg-base p-2 font-mono text-xs text-text-primary outline-none focus-visible:border-border-strong"
									placeholder={t("settings.remote.et.peersPlaceholder")}
									value={(props.draft.webRemoteEasyTierPeers ?? []).join("\n")}
									onChange={(event) => props.updateDraft({ webRemoteEasyTierPeers: event.target.value.split("\n") })}
								/>
								<small className="text-micro text-text-tertiary">{t("settings.remote.et.peersHint")}</small>
							</div>
						</div>
					</>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="ghost" onClick={() => setEtConfigOpen((value) => !value)}>
						{etConfigOpen ? t("settings.remote.et.configCollapse") : t("settings.remote.et.configExpand")}
					</Button>
					{et?.serviceRunning ? (
						<>
							{/* 改完配置需要重启才生效：服务安装时已固定配置文件路径，重写 TOML 后停再启即可 */}
							<Button size="sm" variant="secondary" disabled={busyChannel !== null} onClick={() => void runChannelAction("easytier", "restart")}>
								<RotateCw className="mr-1.5 size-3.5" aria-hidden="true" />
								{t("settings.remote.et.restart")}
							</Button>
							<Button size="sm" variant="outline" disabled={busyChannel !== null} onClick={() => void runChannelAction("easytier", "stop")}>
								<Square className="mr-1.5 size-3.5" aria-hidden="true" />
								{t("settings.remote.et.stop")}
							</Button>
						</>
					) : (
						<Button size="sm" variant="secondary" disabled={!et?.installed || busyChannel !== null} onClick={() => void runChannelAction("easytier", "start")}>
							<Network className="mr-1.5 size-3.5" aria-hidden="true" />
							{t("settings.remote.et.start")}
						</Button>
					)}
					{et?.configPresent && etConfigUrl ? (
						<Button size="sm" variant="outline" onClick={() => setEtShareOpen((value) => !value)}>
							{t("settings.remote.et.shareButton")}
						</Button>
					) : null}
					<Button size="sm" variant="outline" onClick={refresh} disabled={props.webServiceChanging}>
						<RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
						{t("settings.remote.recheck")}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => openGuide("easytier")}>
						{t("settings.remote.openGuide")}
					</Button>
				</div>
				{/* 按钮只在没装 CLI 时禁用：配置不全时点击给明确原因，而不是灰着不说为什么 */}
				{et?.installed && !et.configPresent ? <small className="text-micro text-text-tertiary">{t("settings.remote.et.needConfigHint")}</small> : null}
				{et?.installed && !et.coreAvailable ? <small className="text-micro text-warning">{t("settings.remote.et.needCoreHint")}</small> : null}
				{/* 手机导入配置：二维码指向本机 Web 的 TOML 下载地址，扫完在 EasyTier App 里「导入配置」 */}
				{etShareOpen && et?.configPresent && etConfigUrl ? (
					<div className="grid gap-1 border-t border-border-subtle/50 pt-2">
						<small className="text-micro text-text-tertiary">{t("settings.remote.et.shareHint")}</small>
						{lanAddresses.length > 1 ? (
							<Select value={String(Math.min(etShareHostIndex, lanAddresses.length - 1))} onValueChange={(value) => setEtShareHostIndex(Number(value))}>
								<SelectTrigger className="h-8 w-full text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{lanAddresses.map((item, index) => (
										<SelectItem key={item.address} value={String(index)}>
											{item.address} · {item.interfaceName}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : null}
						<AccessUrlBlock url={etConfigUrl} showQr hint={t("settings.remote.et.shareQrHint")} />
					</div>
				) : null}
				{et?.error ? <p className="text-caption text-warning">{et.error}</p> : null}
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
