import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import type { PiAuthMethod, PiAuthProviderOption } from "../../../shared/types/piAuth";
import { openProviderLoginAtom, providerLoginRequestAtom } from "../atoms/providerLoginAtoms";
import { ProviderAuthTable } from "../components/app/ProviderAuthTable";
import { Alert, AlertDescription, AlertTitle } from "../components/ui-shadcn/alert";
import { Button } from "../components/ui-shadcn/button";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { filterLoggedInProviders } from "../utils/providerLoginList";

/**
 * 配置管理 → OAuth 登录。
 *
 * 用 pi 的 `/login` 认证例外通道列出供应商并完成登录，解决「登录入口只藏在输入框
 * slash 命令里、用户发现不了」的问题。登录流程本身完全复用 `/login` 弹框：
 * 这里只负责挑供应商与方式，点「登录」把请求写进 `providerLoginRequestAtom`，
 * 弹框加载完列表后自动开始，宿主不复制第二套登录状态机。
 *
 * 列表同时覆盖两种凭据：OAuth 订阅授权与 API key 录入（pi 的 `/login` 也是同一范围），
 * 「已登录」= pi 的 auth.json 里已有 credential。
 */
type OAuthTabPhase = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; providers: PiAuthProviderOption[]; piVersion?: string };

export function OAuthTab() {
	const [state, setState] = useState<OAuthTabPhase>({ phase: "loading" });
	const [filter, setFilter] = useState<"all" | "logged-in">("all");
	const [busyProviderId, setBusyProviderId] = useState<string | undefined>(undefined);
	const [actionError, setActionError] = useState<string | undefined>(undefined);
	const openLogin = useSetAtom(openProviderLoginAtom);
	const request = useAtomValue(providerLoginRequestAtom);
	/** 上一刻的弹框开关：true → false 说明登录流程结束，需要回读凭据状态。 */
	const requestOpenRef = useRef(request.open);

	/**
	 * silent：登录弹框关闭后的回读。失败时保留现有列表，只提示错误，
	 * 避免「刚登录成功却整页变成加载/错误」的观感。
	 */
	const load = useCallback(async (options?: { silent?: boolean }) => {
		if (!options?.silent) setState({ phase: "loading" });
		try {
			const result = await api.piAuth.listProviders();
			if (!result.ok) {
				if (options?.silent) setActionError(`${t("providerLogin.listFailed")}：${result.error}`);
				else setState({ phase: "error", message: result.error });
				return;
			}
			setActionError(undefined);
			setState({ phase: "ready", providers: result.list.providers, piVersion: result.list.piVersion });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (options?.silent) setActionError(`${t("providerLogin.listFailed")}：${message}`);
			else setState({ phase: "error", message });
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// 弹框关闭即回读：登录成功后 credential 才出现在列表里（弹框内不负责 tab 的列表）。
	useEffect(() => {
		const wasOpen = requestOpenRef.current;
		requestOpenRef.current = request.open;
		if (wasOpen && !request.open) void load({ silent: true });
	}, [request.open, load]);

	const providers = state.phase === "ready" ? state.providers : [];
	const loggedIn = useMemo(() => filterLoggedInProviders(providers), [providers]);
	const visible = filter === "logged-in" ? loggedIn : providers;

	const handleLogout = async (providerId: string) => {
		setBusyProviderId(providerId);
		setActionError(undefined);
		try {
			const result = await api.piAuth.logout(providerId);
			if (!result.ok) {
				setActionError(`${t("config.oauth.actionFailed")}：${result.error}`);
				return;
			}
			await load({ silent: true });
		} catch (error) {
			setActionError(`${t("config.oauth.actionFailed")}：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setBusyProviderId(undefined);
		}
	};

	const handleStartLogin = (providerId: string, method: PiAuthMethod) => {
		// method 一并带过去：弹框列表就绪后直接开始这一步登录，不用用户再点一次同款按钮。
		openLogin({ providerId, method });
	};

	return (
		<div className="flex min-h-0 flex-col gap-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<p className="min-w-0 text-control leading-relaxed text-muted-foreground">{t("config.oauth.subtitle")}</p>
				<Button size="sm" variant="ghost" disabled={state.phase === "loading"} onClick={() => void load()} title={t("providerLogin.refresh")} aria-label={t("providerLogin.refresh")}>
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("providerLogin.refresh")}
				</Button>
			</div>

			{state.phase === "loading" && (
				<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("providerLogin.loading")}
				</div>
			)}

			{state.phase === "error" && (
				<Alert variant="destructive">
					<AlertTriangle />
					<AlertTitle>{t("providerLogin.listFailed")}</AlertTitle>
					<AlertDescription>
						<p className="font-mono text-xs break-all whitespace-pre-wrap">{state.message}</p>
						<Button className="mt-2" size="sm" variant="secondary" onClick={() => void load()}>
							{t("providerLogin.retry")}
						</Button>
					</AlertDescription>
				</Alert>
			)}

			{state.phase === "ready" && (
				<>
					<div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("config.oauth.filter.all")}>
						<Button size="sm" variant={filter === "all" ? "secondary" : "ghost"} onClick={() => setFilter("all")}>
							{t("config.oauth.filter.all")}
						</Button>
						<Button size="sm" variant={filter === "logged-in" ? "secondary" : "ghost"} onClick={() => setFilter("logged-in")}>
							{t("config.oauth.filter.loggedIn", { count: loggedIn.length })}
						</Button>
					</div>

					{actionError && (
						<Alert variant="destructive">
							<AlertTriangle />
							<AlertTitle>{t("config.oauth.actionFailed")}</AlertTitle>
							<AlertDescription>
								<p className="font-mono text-xs break-all whitespace-pre-wrap">{actionError}</p>
							</AlertDescription>
						</Alert>
					)}

					<ProviderAuthTable providers={visible} piVersion={state.piVersion} busyProviderId={busyProviderId} emptyMessage={filter === "logged-in" ? t("config.oauth.empty.loggedIn") : undefined} onStartLogin={handleStartLogin} onLogout={(providerId) => void handleLogout(providerId)} onRefresh={() => void load()} />
				</>
			)}
		</div>
	);
}
