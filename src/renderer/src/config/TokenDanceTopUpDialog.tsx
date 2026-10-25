/**
 * TokenDanceTopUpDialog — TokenDance 充值弹窗（Agent 支付，PC 扫码主链路）。
 * 文档：https://tokendance.space/docs/agent-payment
 *
 * 链路：输金额 → 主进程创建会话（POST payment/sessions）→ 把 payment_url 渲染成二维码
 * → 每 3 秒查 status_url → `paid` 才算成功并刷新余额缓存；`failed/closed/refunded`
 * 与 `expired_at` 之后的轮询都提示重新创建会话。
 *
 * 边界（对齐平台文档）：
 * - 唤起支付宝深链只能由用户点击触发（不自动跳转），且失败时引导改用扫码；
 * - payment_url 是聚合码内容（不是可跳转的网页），只用于渲染二维码，不自动打开；
 * - 客户端不做「已支付」推断：唤起支付宝/用户返回页面都不算成功，只有服务端状态为准。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, QrCode, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Input } from "../components/ui-shadcn/input";
import { TOKENDANCE_TOP_UP_MAX_AMOUNT, TOKENDANCE_TOP_UP_MIN_AMOUNT, type TokendancePaymentErrorCode, type TokendancePaymentSession } from "../../../shared/tokendance";

/** 轮询节奏（平台建议 3 秒；过期后立即停止，不再空转请求）。 */
const TOP_UP_POLL_INTERVAL_MS = 3000;
/** 金额输入默认值：够试几个中档模型，不至于让用户先想「充多少」。 */
const DEFAULT_TOP_UP_AMOUNT = "10";

/** 弹窗阶段：amount 输金额/失败后重来；pending 等支付；paid 到账。 */
type TopUpPhase = "amount" | "pending" | "paid";

export type TokenDanceTopUpDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 到账回调：父级据此刷新余额缓存（会话侧余额面板订阅同一 atom）。 */
	onPaid: () => void;
};

/** 金额不合法文案（带上下界，避免与常量漂移）。 */
function invalidAmountText(): string {
	return t("config.tokendance.topUpAmountInvalid", { min: TOKENDANCE_TOP_UP_MIN_AMOUNT, max: TOKENDANCE_TOP_UP_MAX_AMOUNT });
}

/** 主进程错误码 → 用户可读文案（码在 shared 定义，主进程不带 i18n 依赖）。 */
function topUpErrorMessage(code: TokendancePaymentErrorCode, detail?: string): string {
	switch (code) {
		case "invalid-amount":
			return invalidAmountText();
		case "not-configured":
			return t("config.tokendance.topUpNoKey");
		case "endpoint-mismatch":
			return t("config.tokendance.topUpEndpointMismatch");
		case "http":
			return t("config.tokendance.topUpHttp", { status: detail ?? "?" });
		case "timeout":
			return t("config.tokendance.topUpTimeout");
		case "network":
			return t("config.tokendance.topUpNetwork");
		default:
			return t("config.tokendance.topUpBadResponse");
	}
}

/** 本地有效性预检（真门禁在主进程）：整数元 + 上下界，与主进程共用同一份常量。 */
function parseAmount(input: string): number | null {
	const value = Number(input.trim());
	if (!Number.isInteger(value) || value < TOKENDANCE_TOP_UP_MIN_AMOUNT || value > TOKENDANCE_TOP_UP_MAX_AMOUNT) return null;
	return value;
}

export function TokenDanceTopUpDialog(props: TokenDanceTopUpDialogProps) {
	const [amountInput, setAmountInput] = useState(DEFAULT_TOP_UP_AMOUNT);
	const [phase, setPhase] = useState<TopUpPhase>("amount");
	const [session, setSession] = useState<TokendancePaymentSession | null>(null);
	/** 本次充值的目标 Key 掩码（仅创建时回来）：支付前给用户核对充的是哪把 Key。 */
	const [keyHint, setKeyHint] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	/** 阻断型错误（创建失败/会话未完成/已过期）：需要用户动作才能继续。 */
	const [error, setError] = useState<string | null>(null);
	/** 轮询瞬时失败（断网等）：不终结流程，下个周期自动重试。 */
	const [pollError, setPollError] = useState<string | null>(null);
	const [qrDataUrl, setQrDataUrl] = useState("");
	const { onPaid, onOpenChange } = props;
	// onPaid 放 ref：轮询 effect 的依赖只留 phase/session，父级重渲染不会重启轮询链。
	const onPaidRef = useRef(onPaid);
	useEffect(() => {
		onPaidRef.current = onPaid;
	}, [onPaid]);

	/** 重置到输金额状态（关闭/结束后调用；丢弃的会话由服务端自行过期）。 */
	const reset = useCallback(() => {
		setPhase("amount");
		setSession(null);
		setKeyHint(null);
		setError(null);
		setPollError(null);
		setQrDataUrl("");
	}, []);

	const close = useCallback(() => {
		reset();
		onOpenChange(false);
	}, [onOpenChange, reset]);

	/** 创建充值会话：金额预检 → 主进程 POST → 进入等待支付。 */
	const createSession = useCallback(async () => {
		const amount = parseAmount(amountInput);
		if (amount == null) {
			setError(invalidAmountText());
			return;
		}
		setCreating(true);
		setError(null);
		setPollError(null);
		try {
			const result = await desktopApi.config.tokendanceTopUpCreate(amount);
			if (!result.ok) {
				setError(topUpErrorMessage(result.code, result.detail));
				return;
			}
			setSession(result.session);
			setKeyHint(result.keyHint ?? null);
			setPhase("pending");
		} catch {
			setError(t("config.tokendance.topUpNetwork"));
		} finally {
			setCreating(false);
		}
	}, [amountInput]);

	/** 二维码：只在会话变化时重新编码；编码失败降级为「扫码不可用」提示，不阻塞流程。 */
	const paymentUrl = session?.paymentUrl ?? "";
	useEffect(() => {
		if (!paymentUrl) {
			setQrDataUrl("");
			return;
		}
		let active = true;
		void QRCode.toDataURL(paymentUrl, {
			width: 192,
			margin: 1,
			color: { dark: "#111827", light: "#ffffff" },
		})
			.then((dataUrl) => {
				if (active) setQrDataUrl(dataUrl);
			})
			.catch(() => {
				if (active) setQrDataUrl("");
			});
		return () => {
			active = false;
		};
	}, [paymentUrl]);

	/**
	 * 状态轮询：3 秒一次，`paid` 才成功；过期即停；查询失败保留二维码继续重试。
	 * 会话对象在 pending 期间保持不变（不写入查询结果），依赖稳定 → 只有一条轮询链。
	 */
	const statusUrl = session?.statusUrl ?? "";
	const expiresAt = session?.expiredAt ?? 0;
	useEffect(() => {
		if (phase !== "pending" || !statusUrl) return;
		let cancelled = false;
		let timer: number | undefined;
		const tick = async () => {
			if (expiresAt > 0 && Date.now() / 1000 >= expiresAt) {
				reset();
				setError(t("config.tokendance.topUpExpired"));
				return;
			}
			let result: Awaited<ReturnType<typeof desktopApi.config.tokendanceTopUpStatus>> | null = null;
			try {
				result = await desktopApi.config.tokendanceTopUpStatus(statusUrl);
			} catch {
				result = null;
			}
			if (cancelled) return;
			if (result?.ok && result.session.status === "paid") {
				setSession(result.session);
				setPhase("paid");
				setPollError(null);
				onPaidRef.current();
				return;
			}
			if (result?.ok && result.session.status !== "pending") {
				// failed/closed/refunded：本次支付未完成，必须重新创建会话（旧会话不可复用）。
				reset();
				setError(t("config.tokendance.topUpNotCompleted", { status: result.session.status }));
				return;
			}
			setPollError(result?.ok ? null : result ? topUpErrorMessage(result.code, result.detail) : t("config.tokendance.topUpNetwork"));
			timer = window.setTimeout(() => void tick(), TOP_UP_POLL_INTERVAL_MS);
		};
		timer = window.setTimeout(() => void tick(), TOP_UP_POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [phase, statusUrl, expiresAt, reset]);

	/** 支付宝 App 深链：仅用户点击时唤起；失败引导改用扫码（不自动跳转，不做成功推断）。 */
	const openAlipay = useCallback(async () => {
		const url = session?.alipayUrl;
		if (!url) return;
		try {
			const result = await desktopApi.config.tokendanceTopUpOpenAlipay(url);
			if (result.ok) return;
		} catch {
			// 落到统一提示：未安装支付宝或系统拦截。
		}
		showNotice(t("config.tokendance.topUpAlipayFailed"), 5000);
	}, [session?.alipayUrl]);

	const busy = creating;
	const expiresLabel = expiresAt > 0 ? new Date(expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

	return (
		<Dialog open={props.open} onOpenChange={(open) => (open ? undefined : close())}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("config.tokendance.topUpTitle")}</DialogTitle>
				</DialogHeader>
				<div className="flex min-w-0 flex-col gap-3 text-sm leading-relaxed text-text-secondary">
					{phase === "amount" && (
						<>
							<p className="text-muted-foreground">{t("config.tokendance.topUpDesc")}</p>
							<label className="flex min-w-0 flex-col gap-1.5">
								<span className="text-xs text-text-tertiary">{t("config.tokendance.topUpAmountLabel")}</span>
								<Input value={amountInput} onChange={(e) => setAmountInput(e.target.value)} inputMode="numeric" className="h-8 max-w-[12rem] font-mono" placeholder={DEFAULT_TOP_UP_AMOUNT} />
								<span className="text-micro text-text-tertiary">{t("config.tokendance.topUpAmountHint", { min: TOKENDANCE_TOP_UP_MIN_AMOUNT, max: TOKENDANCE_TOP_UP_MAX_AMOUNT })}</span>
							</label>
						</>
					)}

					{phase === "pending" && session && (
						<>
							<div className="flex items-center justify-between gap-2 text-xs">
								<span className="text-text-tertiary">{t("config.tokendance.topUpAmountLabel")}</span>
								<span className="font-mono text-sm font-semibold text-text-primary">¥{session.amount}</span>
							</div>
							{/* 聚合码内容渲染成二维码：白底独立卡片保证暗色模式下也可扫 */}
							<div className="flex flex-col items-center gap-2 rounded-sm border border-border-subtle bg-bg-subtle/50 p-3">
								{qrDataUrl ? (
									<img src={qrDataUrl} alt={t("config.tokendance.topUpQrAlt")} className="size-44 rounded-sm bg-white p-1.5" />
								) : (
									<span className="flex size-44 items-center justify-center text-text-tertiary">
										<QrCode className="size-6" aria-hidden="true" />
									</span>
								)}
								<span className="text-xs text-text-secondary">{t("config.tokendance.topUpScanHint")}</span>
							</div>
							{/* 等待/瞬时失败：都不影响扫码，把状态与重试说明放在同一行 */}
							<p className="flex items-center gap-2 text-xs text-text-secondary">
								<Loader2 className="size-3.5 shrink-0 animate-pideck-spin text-[var(--color-accent)]" aria-hidden="true" />
								<span className="min-w-0">
									{t("config.tokendance.topUpWaiting")}
									{expiresLabel ? `（${t("config.tokendance.topUpExpiresAt", { time: expiresLabel })}）` : ""}
								</span>
							</p>
							{pollError && <p className="rounded-sm border border-border-subtle bg-bg-subtle/60 px-2.5 py-1.5 text-xs text-text-tertiary">{t("config.tokendance.topUpStatusRetry", { error: pollError })}</p>}
							{session.alipayUrl && (
								<Button variant="outline" size="sm" className="self-start" onClick={() => void openAlipay()}>
									<Smartphone className="size-3.5" aria-hidden="true" />
									{t("config.tokendance.topUpAlipay")}
								</Button>
							)}
						</>
					)}

					{phase === "paid" && session && (
						<p className="flex items-center gap-2 rounded-sm border border-emerald-300/70 bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
							<CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
							<span className="min-w-0">{t("config.tokendance.topUpPaid", { amount: session.amount })}</span>
						</p>
					)}

					{/* 支付前可核对：额度进的是配置里这把 Key 所属的账户（只显尾号，不落明文） */}
					{keyHint && phase !== "amount" && <p className="text-micro text-text-tertiary">{t("config.tokendance.topUpTarget", { hint: keyHint })}</p>}

					{/* 到账说明：桌面端不做自动重发，提示用户回到会话重试（账户余额已刷新） */}
					{phase === "paid" && <p className="text-micro text-text-tertiary">{t("config.tokendance.topUpPaidHint")}</p>}
					{error && <p className="rounded-sm border border-danger/20 bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{error}</p>}
				</div>
				<DialogFooter className="gap-2">
					{phase === "paid" ? (
						<Button variant="default" size="sm" onClick={close}>
							{t("config.tokendance.topUpDone")}
						</Button>
					) : (
						<>
							<Button variant="ghost" size="sm" onClick={close} disabled={busy}>
								{phase === "pending" ? t("config.tokendance.topUpLater") : t("common.cancel")}
							</Button>
							{phase === "amount" && (
								<Button variant="default" size="sm" onClick={() => void createSession()} disabled={busy}>
									{busy ? <Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <QrCode className="size-3.5" aria-hidden="true" />}
									{t("config.tokendance.topUpCreate")}
								</Button>
							)}
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
