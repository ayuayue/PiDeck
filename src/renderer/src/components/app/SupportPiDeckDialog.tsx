/**
 * SupportPiDeckDialog — 「请作者喝咖啡」打赏弹窗（爱猹收）。
 *
 * 链路：打开 → 主进程查一次快照（缓存 60s）→ 把当次购买链接画成二维码
 * → 用户用支付宝扫 → 每 5 秒重查，remaining 变多即视为到账。
 *
 * 边界：
 * - 纯打赏：不显示次数、不做门禁、不扣减；
 * - 二维码内容是 purchaseUrl 本身；qrCodeUrl 是「展示二维码的页面」，扫出来还是二维码；
 * - 购买链接是短期票据，只在内存存活，关闭即丢弃（下次打开重取）；
 * - 跨境链路慢且偶发失败：打开时自动重试，不把一次抖动直接甩给用户。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Coffee, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import QRCode from "qrcode";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import type { WatchaAccessSnapshot, WatchaErrorCode } from "../../../../shared/watcha";

const POLL_INTERVAL_MS = 5000;
const LOAD_ATTEMPTS = 3;
const LOAD_RETRY_DELAY_MS = 800;

export type SupportPiDeckDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(code: WatchaErrorCode): string {
	if (code === "not-configured") return t("support.notConfigured");
	if (code === "timeout") return t("support.timeout");
	if (code === "network") return t("support.network");
	return t("support.badResponse");
}

export function SupportPiDeckDialog(props: SupportPiDeckDialogProps) {
	const [snapshot, setSnapshot] = useState<WatchaAccessSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [qrDataUrl, setQrDataUrl] = useState("");
	const [polling, setPolling] = useState(false);
	const [paid, setPaid] = useState(false);
	const { onOpenChange } = props;
	const baselineRef = useRef<number | null>(null);
	const cancelledRef = useRef(false);

	const load = useCallback(async (): Promise<WatchaAccessSnapshot | null> => {
		setLoading(true);
		setError(null);
		let lastCode: WatchaErrorCode | null = null;
		for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
			if (cancelledRef.current) return null;
			try {
				const result = await desktopApi.config.watchaAccess();
				if (result.ok) {
					setSnapshot(result.snapshot);
					setLoading(false);
					return result.snapshot;
				}
				lastCode = result.code;
			} catch {
				lastCode = "bad-response";
			}
			if (attempt < LOAD_ATTEMPTS - 1) await delay(LOAD_RETRY_DELAY_MS);
		}
		if (!cancelledRef.current) {
			setError(errorText(lastCode ?? "bad-response"));
			setLoading(false);
		}
		return null;
	}, []);

	// 打开即查一次；关闭时清空（购买票据是短期票据，不留内存）。
	useEffect(() => {
		if (!props.open) {
			cancelledRef.current = true;
			return;
		}
		cancelledRef.current = false;
		setError(null);
		setPolling(false);
		setPaid(false);
		baselineRef.current = null;
		void load().then((value) => {
			baselineRef.current = value && value.access === "granted" ? value.remaining : 0;
		});
		return () => {
			cancelledRef.current = true;
		};
	}, [props.open, load]);

	// 二维码内容 = 当次购买链接，本地渲染，不加载平台图片（CSP 不放行支付宝图片域名）。
	// 依赖必须带 open：关闭时清空，重开时即使链接没变也要重画。快照缓存 5 分钟，同一次
	// 打开窗口里重复打开弹窗拿到的是同一张票，只盯 purchaseUrl 的话 effect 不重跑，
	// 框里会一直是空的（「第一次能扫，之后再打开空白」）。
	useEffect(() => {
		const url = props.open ? snapshot?.purchaseUrl : undefined;
		if (!url) {
			setQrDataUrl("");
			return;
		}
		let cancelled = false;
		void QRCode.toDataURL(url, { width: 208, margin: 1, color: { dark: "#111827", light: "#ffffff" } })
			.then((data) => {
				if (!cancelled) setQrDataUrl(data);
			})
			.catch(() => {
				if (!cancelled) setQrDataUrl("");
			});
		return () => {
			cancelled = true;
		};
	}, [props.open, snapshot?.purchaseUrl]);

	// 轮询到账：只在弹窗打开且已发起支付后跑。
	useEffect(() => {
		if (!props.open || !polling) return;
		const timer = setInterval(() => {
			void (async () => {
				// 轮询必须绕过缓存，否则读到的永远是打开时那份快照。
				const result = await desktopApi.config.watchaAccess(true);
				if (!result.ok) return;
				const baseline = baselineRef.current ?? 0;
				if (result.snapshot.remaining > baseline) {
					setSnapshot(result.snapshot);
					setPolling(false);
					setPaid(true);
				}
			})();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [props.open, polling]);

	const isAlipayDeepLink = Boolean(snapshot?.purchaseUrl?.startsWith("alipays://"));
	const hasPurchase = Boolean(snapshot?.purchaseUrl);

	const openPurchase = useCallback(() => {
		const url = snapshot?.purchaseUrl;
		if (!url) return;
		if (url.startsWith("alipays://")) {
			void desktopApi.config.watchaOpenAlipay(url).then((result) => {
				if (!result.ok) setError(t("support.alipayFailed"));
			});
		} else {
			void desktopApi.app.openExternal(url, true);
		}
		setPolling(true);
	}, [snapshot?.purchaseUrl]);

	const hint = error ? (
		<p className="text-center text-xs text-destructive">{error}</p>
	) : loading ? (
		<p className="text-xs text-muted-foreground">{t("support.loading")}</p>
	) : hasPurchase ? (
		<p className="text-xs text-muted-foreground">{t("support.scanHint")}</p>
	) : (
		<p className="text-xs text-muted-foreground">{t("support.noPurchase")}</p>
	);

	return (
		<Dialog open={props.open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Coffee className="size-4" aria-hidden="true" />
						{t("support.title")}
					</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<p className="text-xs leading-relaxed text-muted-foreground">{t("support.desc")}</p>
					<div className="flex flex-col items-center gap-2">
						{qrDataUrl ? (
							<img src={qrDataUrl} alt={t("support.qrAlt")} className="size-52 rounded-md border border-border-subtle bg-white p-2" />
						) : (
							<div className="flex size-52 items-center justify-center rounded-md border border-border-subtle bg-bg-panel">{loading ? <Loader2 className="size-5 animate-pideck-spin text-muted-foreground" /> : <Coffee className="size-6 text-muted-foreground/50" aria-hidden="true" />}</div>
						)}
						{hint}
						{hasPurchase && !loading && !error && <p className="text-micro text-muted-foreground/70">{t("support.qrExpiry")}</p>}
						{paid && <p className="text-xs text-success">{t("support.paid")}</p>}
						{polling && !paid && !loading && (
							<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Loader2 className="size-3 animate-pideck-spin" aria-hidden="true" />
								{t("support.waiting")}
							</p>
						)}
					</div>
				</div>

				<DialogFooter className="gap-2">
					<Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
						<RefreshCw className={loading ? "size-3.5 animate-pideck-spin" : "size-3.5"} aria-hidden="true" />
						{t("support.refresh")}
					</Button>
					{hasPurchase && (
						<Button type="button" size="sm" onClick={openPurchase}>
							<ExternalLink className="size-3.5" aria-hidden="true" />
							{isAlipayDeepLink ? t("support.openAlipay") : t("support.openBrowser")}
						</Button>
					)}
					<Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
						{t("support.close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
