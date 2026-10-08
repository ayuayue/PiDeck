import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, RotateCw } from "lucide-react";
import type { AppSettings, WebNetworkAddress, WebServiceStatusInfo } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Switch } from "../../ui-shadcn/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "./SettingRows";
import { buildWebAccessUrl, previewHostFromBinding, webAddressesForBinding } from "./webAccessUrl";
import { useQrDataUrl } from "./useQrDataUrl";
import { WebRemoteAccessSection } from "./WebRemoteAccessSection";

type WebTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	webServiceChanging: boolean;
	onOpenWebService: (url: string) => void;
	onRestartWebService: () => void;
	/** 壳层「取消」递增；本 tab 借此重置端口草稿等局部编辑态 */
	resetKey: number;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function isPublicBindHost(host: string): boolean {
	const trimmed = host.trim();
	return trimmed.length > 0 && !LOOPBACK_HOSTS.has(trimmed);
}

/**
 * 设置弹框「局域网 Web 服务」tab：服务开关、Token 鉴权、主机/端口、本机预览、扫码访问。
 * 端口草稿/网卡列表/二维码等局部状态自持，只有进入本 tab 才加载；
 * 服务开关、端口、地址仍写入全局设置草稿，由弹框统一提交。
 */
export const WebTab = memo(function WebTab(props: WebTabProps) {
	const { draft, updateDraft, webServiceChanging, onOpenWebService, onRestartWebService } = props;

	// ── Web 服务端口/网卡/二维码（只在本 tab 展示）──
	const [webPortDraft, setWebPortDraft] = useState(String(draft.webServicePort));
	const [webNetworkAddresses, setWebNetworkAddresses] = useState<WebNetworkAddress[]>([]);
	const [selectedWebAddress, setSelectedWebAddress] = useState("");
	const [webNetworkLoading, setWebNetworkLoading] = useState(false);
	const [webStatus, setWebStatus] = useState<WebServiceStatusInfo | null>(null);
	const [qrCopied, setQrCopied] = useState(false);
	const copyTimeoutRef = useRef<number | null>(null);

	const applyWebPortDraft = () => {
		const port = Number(webPortDraft);
		if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== draft.webServicePort) {
			updateDraft({ webServicePort: port });
		} else {
			setWebPortDraft(String(draft.webServicePort));
		}
	};

	// 网卡地址只在设置弹框内展示；优先局域网 IPv4，VPN/虚拟网卡仍保留为可选入口。
	useEffect(() => {
		const loadAddresses = desktopApi.app.networkAddresses;
		if (typeof loadAddresses !== "function") return;
		let active = true;
		setWebNetworkLoading(true);
		void loadAddresses()
			.then((addresses) => {
				if (!active) return;
				setWebNetworkAddresses(addresses);
			})
			.catch(() => {
				if (active) setWebNetworkAddresses([]);
			})
			.finally(() => {
				if (active) setWebNetworkLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	// 始终拉取运行状态（含本次启动的令牌）；失败置 null。
	// 重启会重生成令牌，故把 webServiceChanging 纳入刷新依赖：重启的 finally 置 false 只发生在
	// 重启 IPC 成功之后，此刻重拉状态即拿到新令牌，避免二维码带过期令牌。
	const refreshWebStatus = useCallback(() => {
		void desktopApi.settings
			.webServiceStatus()
			.then((status) => setWebStatus(status))
			.catch(() => setWebStatus(null));
	}, []);
	useEffect(() => {
		refreshWebStatus();
	}, [refreshWebStatus, selectedWebAddress, props.webServiceChanging]);

	// 以实际运行的绑定为准，而非尚未保存的草稿；切换监听后同步排除旧选择，避免生成不可达链接。
	const availableWebAddresses = useMemo(() => webAddressesForBinding(webNetworkAddresses, webStatus?.host ?? ""), [webNetworkAddresses, webStatus?.host]);
	const activeWebAddress = availableWebAddresses.some((item) => item.address === selectedWebAddress) ? selectedWebAddress : (availableWebAddresses.find((item) => item.isPrivate)?.address ?? availableWebAddresses[0]?.address ?? "");
	// 运行中的 URL：预览用环回，扫码用选中的局域网地址。
	const previewUrl = webStatus?.running ? buildWebAccessUrl(previewHostFromBinding(webStatus.host), webStatus.port, webStatus.token, webStatus.requiresAuth) : "";
	const qrUrl = webStatus?.running && activeWebAddress ? buildWebAccessUrl(activeWebAddress, webStatus.port, webStatus.token, webStatus.requiresAuth) : "";

	// URL 变化时重新编码，二维码只保存 data URL，不把主进程能力暴露给页面。
	const webQrDataUrl = useQrDataUrl(qrUrl);

	// 壳层「取消」：重置本 tab 局部编辑态（Web 端口草稿）
	useEffect(() => {
		setWebPortDraft(String(draft.webServicePort));
		setQrCopied(false);
		if (copyTimeoutRef.current) {
			window.clearTimeout(copyTimeoutRef.current);
			copyTimeoutRef.current = null;
		}
	}, [props.resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

	// 组件卸载时清理复制状态恢复定时器
	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) {
				window.clearTimeout(copyTimeoutRef.current);
			}
		};
	}, []);

	const handleCopyQrUrl = useCallback(() => {
		if (!qrUrl) return;
		void navigator.clipboard
			.writeText(qrUrl)
			.then(() => {
				setQrCopied(true);
				if (copyTimeoutRef.current) {
					window.clearTimeout(copyTimeoutRef.current);
				}
				copyTimeoutRef.current = window.setTimeout(() => {
					copyTimeoutRef.current = null;
					setQrCopied(false);
				}, 1500);
			})
			.catch(() => {
				// 剪贴板写入失败（权限拒绝/非安全上下文）时保持未复制状态
				setQrCopied(false);
			});
	}, [qrUrl]);

	return (
		<SettingsSection title={t("settings.webLocalService")} description={t("settings.webLocalServiceDesc")}>
			{/* 服务总开关 + 重启按钮 */}
			<SettingRow anchor="web-enable-service" title={t("settings.enableWebService")} description={webServiceChanging ? t("settings.webOpening") : t("settings.webOffDesc")}>
				<div className="flex items-center gap-2">
					<Switch checked={draft.webServiceEnabled} disabled={webServiceChanging} onCheckedChange={(checked) => updateDraft({ webServiceEnabled: checked })} />
					<Button variant="outline" size="sm" disabled={!webStatus?.running || webServiceChanging} onClick={onRestartWebService}>
						<RotateCw className="mr-1.5 size-3.5" aria-hidden="true" />
						{webServiceChanging ? t("settings.webRestarting") : t("settings.webRestartService")}
					</Button>
				</div>
			</SettingRow>

			{/* Token 鉴权开关 */}
			<SettingSwitchRow anchor="web-use-token-auth" title={t("settings.webUseTokenAuth")} description={t("settings.webUseTokenAuthDesc")} checked={draft.webServiceRequiresAuth} onChange={(checked) => updateDraft({ webServiceRequiresAuth: checked })} />
			{!draft.webServiceRequiresAuth && isPublicBindHost(draft.webServiceHost) && <p className="-mt-1.5 ml-1 text-caption text-warning">{t("settings.webAuthOffWarning")}</p>}

			{/* 主机 / 端口 */}
			<div className="mt-2.5 grid grid-cols-2 gap-2">
				<div className="min-w-0">
					<Label className="text-xs font-bold text-text-tertiary">{t("settings.webServiceHost")}</Label>
					<Input value={draft.webServiceHost} disabled={webServiceChanging} className="mt-1 font-mono text-sm tabular-nums" onChange={(event) => updateDraft({ webServiceHost: event.target.value })} onBlur={(event) => updateDraft({ webServiceHost: event.target.value.trim() })} />
				</div>
				<div className="min-w-0">
					<Label className="text-xs font-bold text-text-tertiary">{t("settings.webServicePort")}</Label>
					<Input
						type="number"
						min={1}
						max={65535}
						value={webPortDraft}
						disabled={webServiceChanging}
						className="mt-1 font-mono text-sm tabular-nums"
						onChange={(event) => setWebPortDraft(event.target.value)}
						onBlur={applyWebPortDraft}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								applyWebPortDraft();
								event.currentTarget.blur();
							}
						}}
					/>
				</div>
			</div>

			{/* 本机预览 */}
			{webStatus?.running && (
				<div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-border-subtle/70 bg-bg-muted/30 px-3 py-2.5">
					{/* 服务状态点：开启时 accent 色 + 光晕 */}
					<span className="size-2 shrink-0 rounded-full bg-[var(--color-accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_12%,transparent)]" />
					<div className="min-w-0">
						<strong className="block truncate text-caption font-semibold text-text-primary">{t("settings.openWebService")}</strong>
						<small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.localWebHint")}</small>
					</div>
					<Button variant="secondary" size="sm" disabled={webServiceChanging} onClick={() => onOpenWebService(previewUrl)}>
						{t("common.open")}
					</Button>
				</div>
			)}

			{/* 扫码访问卡片 */}
			{webStatus?.running && (
				<div className="mt-2.5 grid gap-2 rounded-lg border border-border-subtle/70 bg-bg-muted/20 p-3">
					<div className="flex items-center justify-between gap-2">
						<div className="min-w-0">
							<strong className="block text-caption font-semibold text-text-primary">{t("settings.webQrTitle")}</strong>
							<small className="mt-0.5 block text-micro text-text-tertiary">{t("settings.webQrDesc")}</small>
						</div>
						{webNetworkLoading && <span className="text-micro text-text-tertiary">{t("settings.webNetworkLoading")}</span>}
					</div>
					{availableWebAddresses.length > 0 ? (
						<div className="grid gap-1.5">
							<Label className="text-xs font-bold text-text-tertiary">{t("settings.webQrAddress")}</Label>
							<Select value={activeWebAddress} onValueChange={setSelectedWebAddress}>
								<SelectTrigger className="font-mono text-sm tabular-nums">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{availableWebAddresses.map((item) => (
										<SelectItem key={item.address} value={item.address}>
											<span className="font-mono">{item.address}</span>
											<span className="ml-2 text-xs text-muted-foreground">
												{item.interfaceName}
												{item.cidr ? ` · /${item.cidr.split("/")[1]}` : ""}
												{item.isPrivate ? ` · ${t("settings.webLanAddress")}` : ""}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : (
						<p className="text-caption text-text-tertiary">{t("settings.webNoNetworkAddress")}</p>
					)}
					{qrUrl ? (
						<div className="flex flex-wrap items-start gap-3 pt-1">
							<img src={webQrDataUrl} alt={t("settings.webQrAlt")} className="size-44 rounded-md bg-white p-2" />
							<div className="min-w-0 flex-1">
								<div className="flex items-start gap-2 rounded-md border border-border-subtle/70 bg-bg-muted/40 p-2">
									<code className="block flex-1 break-all font-mono text-caption text-text-primary">{qrUrl}</code>
									<Button
										variant="ghost"
										size="icon-xs"
										className="size-7 shrink-0 rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
										title={qrCopied ? t("settings.webCopied") : t("settings.webCopyUrl")}
										aria-label={qrCopied ? t("settings.webCopied") : t("settings.webCopyUrl")}
										onClick={handleCopyQrUrl}
									>
										{qrCopied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
									</Button>
								</div>
								<small className="mt-1 block text-micro text-text-tertiary">{t("settings.webQrScanHint")}</small>
								{webStatus.requiresAuth ? <small className="mt-1 block text-micro text-text-tertiary">{t("settings.webQrTokenHint")}</small> : null}
							</div>
						</div>
					) : (
						<p className="text-caption text-text-tertiary">{t("settings.webQrUnavailable")}</p>
					)}
				</div>
			)}

			{/* 外网访问（内网穿透）：cloudflare 隧道 + tailscale，独立卡片不侵入局域网设置 */}
			<WebRemoteAccessSection webServiceChanging={webServiceChanging} />
		</SettingsSection>
	);
});
