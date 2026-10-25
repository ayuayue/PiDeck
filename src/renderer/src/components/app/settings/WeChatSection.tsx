/**
 * WeChatSection — 微信 iLink（ClawBot）桥接设置区。
 *
 * 与飞书区最大的差异：微信没有 App ID/Secret 表单，登录是「扫码 + 手机确认」，
 * 所以这里必须能渲染二维码。二维码由渲染层生成（useQrDataUrl），主进程只给
 * 待编码字符串——主进程不引图像栈，也避免二维码内容经过 IPC 二进制通道。
 *
 * 微信侧是 1:1 单账号：没有多 Bot、没有群聊、不能主动推送，界面刻意不提供
 * 对应开关（见 shared/types/wechat.ts 的说明），免得用户以为只是没做。
 */

import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { ArrowDown, ArrowUp, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Switch } from "../../ui-shadcn/switch";
import { ConfirmDialog } from "../../app/AppParts";
import { ModelPicker } from "../../session/ComposerComponents";
import type { AvailableModel, ImChannelBackend, WeChatBindingModel, WeChatBindingView, WeChatBridgeStatus, WeChatIpcResult, WeChatLoginState, WeChatModelChainEntry, WeChatSettings, WeChatSettingsSnapshot } from "../../../../../shared/types";
import { parseImChannelBackend } from "../../../../../shared/types";
import { dshUiVisibilityFor } from "../../../../../shared/types/dshRuntime";
import { dshRuntimeStatusAtom } from "../../../atoms/dsh-atoms";
import { formatI18nDateTime, t, type TranslationKey } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { useFavoriteModels } from "../../../hooks/useFavoriteModels";
import { useQrDataUrl } from "./useQrDataUrl";

/**
 * preload 的微信命名空间在本组件里按可选字段声明：预览模式（previewApi）下
 * 这些方法存在但一律返回不支持，缺失时界面显示「不可用」而不是崩。
 */
type WeChatApiRaw = {
	snapshot?: () => Promise<WeChatIpcResult<WeChatSettingsSnapshot>>;
	setEnabled?: (enabled: boolean) => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	updateSettings?: (patch: { defaultWorkspaceId?: string; defaultModelId?: string; backend?: ImChannelBackend; modelChain?: WeChatModelChainEntry[] }) => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	renameAccount?: (displayName: string) => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	logout?: () => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	beginLogin?: () => Promise<WeChatIpcResult<{ state: WeChatLoginState }>>;
	cancelLogin?: () => Promise<WeChatIpcResult<{ state: WeChatLoginState }>>;
	submitVerifyCode?: (code: string) => Promise<WeChatIpcResult<{ state: WeChatLoginState }>>;
	getLoginState?: () => Promise<WeChatLoginState>;
	unbindChat?: (chatId: string) => Promise<WeChatIpcResult<{ removed: boolean; bindings: WeChatBindingView[] }>>;
	onStatus?: (cb: (status: WeChatBridgeStatus) => void) => () => void;
	onLoginState?: (cb: (state: WeChatLoginState) => void) => () => void;
	onBindingsChanged?: (cb: (bindings: WeChatBindingView[]) => void) => () => void;
};

/** 登录阶段 → 文案 key。集中映射避免 JSX 里堆 switch。 */
const PHASE_LABEL: Record<WeChatLoginState["phase"], TranslationKey> = {
	idle: "config.wechat.phase.idle",
	waiting: "config.wechat.phase.waiting",
	scanned: "config.wechat.phase.scanned",
	"need-verify-code": "config.wechat.phase.needVerifyCode",
	confirmed: "config.wechat.phase.confirmed",
	expired: "config.wechat.phase.expired",
	error: "config.wechat.phase.error",
};

/**
 * 状态机只给错误码（流程代码里不写用户可见文案），文案由渲染层映射。
 * 映射不到的码回退到通用的「错误」标签，不把英文码摊到界面上。
 */
const LOGIN_ERROR_LABEL: Record<string, TranslationKey> = {
	verify_code_blocked: "config.wechat.loginError.verifyCodeBlocked",
	"confirmed without credentials": "config.wechat.loginError.noCredentials",
};

/** 工作区选择器的「自动」哨兵值：写设置时转成空串（主进程用项目列表第一项兜底）。 */
const AUTO_WORKSPACE = "__auto__";

/** 上/下移一条链项；越界返回原数组。纯函数，便于单测。 */
function moveChainEntry(chain: WeChatModelChainEntry[], from: number, to: number): WeChatModelChainEntry[] {
	if (to < 0 || to >= chain.length || from === to) return chain;
	const next = [...chain];
	const [entry] = next.splice(from, 1);
	next.splice(to, 0, entry);
	return next;
}

/** 追加一条链项（已存在则原样返回，避免重复点同一个模型把它插两次）。 */
function appendChainEntry(chain: WeChatModelChainEntry[], entry: WeChatModelChainEntry): WeChatModelChainEntry[] {
	if (chain.some((item) => item.provider === entry.provider && item.modelId === entry.modelId)) return chain;
	return [...chain, entry];
}

/**
 * 链为空时那句提示要写出的「当前会话模型」。
 *
 * 只有唯一一条绑定拿得到模型时才给：多条绑定各跑各的会话，各有各的模型，写谁都是误导
 * （那种情况逐条显示在绑定列表里）。拿不到运行时（进程没起）也返回 undefined，界面宁可少一行。
 */
function currentSessionModelLabel(bindings: WeChatBindingView[]): string | undefined {
	const models = bindings.map((binding) => binding.currentModel).filter((model): model is WeChatBindingModel => Boolean(model));
	if (models.length !== 1) return undefined;
	const [model] = models;
	return `${model.provider}/${model.modelName ?? model.modelId}`;
}

/**
 * 绑定行第二行：工作区 + 后端 + 会话当前模型。
 * 纯数据拼接（工作区 id、品牌名、模型 id 都不翻译），所以不占 i18n key。
 */
function describeBinding(binding: WeChatBindingView): string {
	const parts = [binding.workspaceId, binding.backend === "dsh" ? "DSH" : "pi"];
	if (binding.currentModel) parts.push(`${binding.currentModel.provider}/${binding.currentModel.modelName ?? binding.currentModel.modelId}`);
	return parts.join(" · ");
}

export function WeChatSection() {
	const [snapshot, setSnapshot] = useState<WeChatSettingsSnapshot | null>(null);
	const [loginState, setLoginState] = useState<WeChatLoginState>({ phase: "idle" });
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [verifyCode, setVerifyCode] = useState("");
	const [confirmLogout, setConfirmLogout] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState("");
	// 模型链编辑器：模型目录懒拉（打开本页才拉），选择器单独一个开关控制挂载。
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [modelsRefreshing, setModelsRefreshing] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);

	const api = (window as unknown as { piDesktop?: { wechat?: WeChatApiRaw } }).piDesktop?.wechat;
	const qrDataUrl = useQrDataUrl(loginState.qrcodeContent ?? "");
	// 钩子必须在任何提前 return 之前调用（本组件有 loading / api 不可用两条早退路径）。
	const dshRuntimeState = useAtomValue(dshRuntimeStatusAtom).state;

	const loadSnapshot = useCallback(async () => {
		if (!api?.snapshot) {
			setLoading(false);
			return;
		}
		try {
			const result = await api.snapshot();
			if (result.ok) setSnapshot(result);
			else setError(result.message);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [api]);

	const loadModels = useCallback(async (force = false) => {
		if (force) setModelsRefreshing(true);
		try {
			setModels(await desktopApi.projects.listModelsReport(undefined, force).then((r) => r.models));
		} catch {
			setModels([]);
		} finally {
			setModelsRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void loadModels();
	}, [loadModels]);

	// 收藏与输入框模型选择器同源（设置页各选择器都打开前重读，避免缓存不一致）
	const { favoriteModels, refreshFavoriteModels, toggleFavorite } = useFavoriteModels();

	const openPicker = useCallback(async () => {
		await loadModels();
		await refreshFavoriteModels();
		setPickerOpen(true);
	}, [loadModels, refreshFavoriteModels]);

	useEffect(() => {
		void loadSnapshot();
	}, [loadSnapshot]);

	// 订阅三个推送：状态、登录阶段、绑定变化。组件卸载必须退订（preload 返回 unsubscribe）。
	useEffect(() => {
		if (!api) return;
		const offStatus = api.onStatus?.((status) => {
			setSnapshot((prev) => (prev ? { ...prev, status } : prev));
		});
		const offLogin = api.onLoginState?.((state) => {
			setLoginState(state);
			// 扫码确认后主进程已把账号落盘并把开关置为启用，快照不重拉会让界面继续显示
			// 「尚未登录 + 开关关闭」，用户会以为扫码没生效。
			if (state.phase === "confirmed") void loadSnapshot();
		});
		const offBindings = api.onBindingsChanged?.((bindings) => {
			setSnapshot((prev) => (prev ? { ...prev, bindings } : prev));
			// 首次绑定/换绑时主进程会顺手把会话当前模型播种进模型优先级链，只吃推送里的
			// bindings 会停在「绑定已建、链还是空的」。重拉快照同时拿到链与 currentModel。
			void loadSnapshot();
		});
		return () => {
			offStatus?.();
			offLogin?.();
			offBindings?.();
		};
	}, [api, loadSnapshot]);

	// 初始登录阶段也要拉一次：事件只覆盖「变化」，刷新页面后没人会再推。
	useEffect(() => {
		if (!api?.getLoginState) return;
		void api.getLoginState().then(setLoginState);
	}, [api]);

	const runAction = useCallback(async (action: () => Promise<WeChatIpcResult<Record<string, unknown>>>) => {
		setBusy(true);
		setError(null);
		try {
			const result = await action();
			if (!result.ok) setError(result.message);
			return result;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return { ok: false as const, message: String(e) };
		} finally {
			setBusy(false);
		}
	}, []);

	const handleToggleEnabled = useCallback(
		async (enabled: boolean) => {
			if (!api?.setEnabled) return;
			await runAction(() => api.setEnabled?.(enabled) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			await loadSnapshot();
		},
		[api, runAction, loadSnapshot],
	);

	const handleBeginLogin = useCallback(async () => {
		if (!api?.beginLogin) return;
		setVerifyCode("");
		const result = await runAction(() => api.beginLogin?.() as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok && "state" in result) setLoginState(result.state as WeChatLoginState);
	}, [api, runAction]);

	const handleCancelLogin = useCallback(async () => {
		if (!api?.cancelLogin) return;
		const result = await runAction(() => api.cancelLogin?.() as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok) setLoginState({ phase: "idle" });
		await loadSnapshot();
	}, [api, runAction, loadSnapshot]);

	const handleSubmitVerifyCode = useCallback(async () => {
		const code = verifyCode.trim();
		if (!api?.submitVerifyCode || !code) return;
		const result = await runAction(() => api.submitVerifyCode?.(code) as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok && "state" in result) {
			setLoginState(result.state as WeChatLoginState);
			setVerifyCode("");
		}
	}, [api, runAction, verifyCode]);

	const handleLogout = useCallback(async () => {
		setConfirmLogout(false);
		if (!api?.logout) return;
		await runAction(() => api.logout?.() as Promise<WeChatIpcResult<Record<string, unknown>>>);
		setLoginState({ phase: "idle" });
		await loadSnapshot();
	}, [api, runAction, loadSnapshot]);

	const handleUnbind = useCallback(
		async (chatId: string) => {
			if (!api?.unbindChat) return;
			const result = await runAction(() => api.unbindChat?.(chatId) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			if (result.ok && "bindings" in result) {
				const bindings = result.bindings as WeChatBindingView[];
				setSnapshot((prev) => (prev ? { ...prev, bindings } : prev));
			}
		},
		[api, runAction],
	);

	const handleRenameSave = useCallback(async () => {
		const name = nameDraft.trim();
		setRenaming(false);
		if (!api?.renameAccount || !name) return;
		const result = await runAction(() => api.renameAccount?.(name) as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok) await loadSnapshot();
	}, [api, nameDraft, runAction, loadSnapshot]);

	const handleWorkspaceChange = useCallback(
		async (workspaceId: string) => {
			if (!api?.updateSettings) return;
			// 哨兵值转空串：主进程对空串的解释是「自动」，不会把哨兵写进设置文件。
			const value = workspaceId === AUTO_WORKSPACE ? "" : workspaceId;
			const result = await runAction(() => api.updateSettings?.({ defaultWorkspaceId: value }) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			if (result.ok) await loadSnapshot();
		},
		[api, runAction, loadSnapshot],
	);

	const handleModelChainChange = useCallback(
		async (modelChain: WeChatModelChainEntry[]) => {
			if (!api?.updateSettings) return;
			const result = await runAction(() => api.updateSettings?.({ modelChain }) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			if (result.ok) await loadSnapshot();
		},
		[api, runAction, loadSnapshot],
	);

	const handleBackendChange = useCallback(
		async (value: ImChannelBackend) => {
			if (!api?.updateSettings) return;
			const result = await runAction(() => api.updateSettings?.({ backend: value }) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			if (result.ok) await loadSnapshot();
		},
		[api, runAction, loadSnapshot],
	);

	if (!api?.snapshot) {
		return <p className="text-muted-foreground text-sm">{t("config.wechat.unavailable")}</p>;
	}

	if (loading) {
		return (
			<div className="text-muted-foreground flex items-center gap-2 text-sm">
				<Loader2 className="h-4 w-4 animate-pideck-spin" />
				{t("config.wechat.loading")}
			</div>
		);
	}

	const settings = snapshot?.settings;
	const status = snapshot?.status;
	const account = settings?.account ?? null;
	const bindings = snapshot?.bindings ?? [];
	const projects = snapshot?.projects ?? [];
	const modelChain = settings?.modelChain ?? [];
	// 链为空时用绑定会话的真实模型补齐「现在用的是哪个模型」这句提示。
	const currentSessionModel = currentSessionModelLabel(bindings);
	// 渠道后端：只作用于新会话（老绑定自带后端）；未设置时与历史行为一致——pi。
	const backend: ImChannelBackend = settings?.backend ?? "pi";
	const dshAvailable = dshUiVisibilityFor(dshRuntimeState).canCreateDshSession;
	const loginInProgress = loginState.phase !== "idle" && loginState.phase !== "confirmed";

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<span className="text-foreground text-sm font-medium">{t("config.wechat.title")}</span>
					<span className="text-muted-foreground text-xs">{t("config.wechat.description")}</span>
				</div>
				<Switch checked={settings?.enabled ?? false} disabled={busy} onCheckedChange={(checked) => void handleToggleEnabled(checked)} />
			</div>

			{error ? <p className="text-destructive text-xs">{error}</p> : null}

			<div className="border-border bg-card flex flex-col gap-3 rounded-md border p-3">
				<div className="flex items-center justify-between gap-2">
					<span className="text-foreground text-xs font-medium">{t("config.wechat.account")}</span>
					<span className="text-muted-foreground text-xs">{t(`config.wechat.status.${status?.status ?? "disconnected"}`)}</span>
				</div>

				{account ? (
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							{renaming ? (
								<>
									<Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} size="sm" className="text-xs" />
									<Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleRenameSave()}>
										{t("common.save")}
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
										{t("common.cancel")}
									</Button>
								</>
							) : (
								<>
									<span className="text-foreground text-sm">{account.displayName}</span>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setNameDraft(account.displayName);
											setRenaming(true);
										}}
									>
										{t("common.rename")}
									</Button>
								</>
							)}
						</div>
						<span className="text-muted-foreground text-xs">{t("config.wechat.loggedInHint", { time: formatI18nDateTime(account.loggedInAt) })}</span>
						<span className="text-muted-foreground text-xs">{t("config.wechat.displayNameHint")}</span>
						{status?.errorMessage === "login-required" ? <span className="text-destructive text-xs">{t("config.wechat.needRelogin")}</span> : null}
						{status?.errorMessage === "credential-unavailable" ? <span className="text-destructive text-xs">{t("config.wechat.credentialUnavailable")}</span> : null}
						{/* 单账号是协议约束：换绑后旧号的白名单会被覆写，不写清楚就会被当成「坏掉」*/}
						<span className="text-muted-foreground text-xs">{t("config.wechat.singleAccountHint")}</span>
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleBeginLogin()}>
								<RefreshCw className="mr-1 h-3.5 w-3.5" />
								{t("config.wechat.rescan")}
							</Button>
							<Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmLogout(true)}>
								{t("config.wechat.logout")}
							</Button>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<span className="text-muted-foreground text-xs">{t("config.wechat.notLoggedIn")}</span>
						<p className="text-muted-foreground text-xs">{t("config.wechat.grayHint")}</p>
						{!loginInProgress ? (
							<Button size="sm" disabled={busy} onClick={() => void handleBeginLogin()}>
								{t("config.wechat.scanLogin")}
							</Button>
						) : null}
					</div>
				)}

				{loginInProgress ? (
					<div className="border-border flex flex-col items-center gap-2 border-t pt-3">
						<span className="text-foreground text-xs">{t(PHASE_LABEL[loginState.phase])}</span>
						{qrDataUrl ? <img src={qrDataUrl} alt={t("config.wechat.qrAlt")} className="h-40 w-40 rounded bg-white p-1" /> : null}
						{loginState.error ? <span className="text-muted-foreground text-xs">{t(LOGIN_ERROR_LABEL[loginState.error] ?? "config.wechat.phase.error")}</span> : null}
						{loginState.phase === "need-verify-code" ? (
							<div className="flex w-full items-center gap-2">
								<Input value={verifyCode} onChange={(event) => setVerifyCode(event.target.value)} placeholder={t("config.wechat.verifyCodePlaceholder")} size="sm" className="text-xs" />
								<Button size="sm" disabled={busy || !verifyCode.trim()} onClick={() => void handleSubmitVerifyCode()}>
									{t("common.submit")}
								</Button>
							</div>
						) : null}
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleCancelLogin()}>
							{t("common.cancel")}
						</Button>
					</div>
				) : null}
			</div>

			{account && projects.length > 0 ? (
				<div className="flex flex-col gap-1">
					<Label className="text-xs">{t("config.wechat.workspace")}</Label>
					<Select value={settings?.defaultWorkspaceId || AUTO_WORKSPACE} onValueChange={(value) => void handleWorkspaceChange(value)}>
						<SelectTrigger className="w-60">
							<SelectValue placeholder={t("config.wechat.workspacePlaceholder")} />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={AUTO_WORKSPACE}>{t("config.wechat.workspaceAuto")}</SelectItem>
							{projects.map((project) => (
								<SelectItem key={project.id} value={project.id}>
									{project.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<span className="text-muted-foreground text-xs">{t("config.wechat.workspaceHint")}</span>
				</div>
			) : null}

			{account ? (
				<div className="flex flex-col gap-1">
					<Label className="text-xs">{t("config.wechat.backend")}</Label>
					<Select
						value={backend}
						onValueChange={(value) => {
							const next = parseImChannelBackend(value);
							if (next) void handleBackendChange(next);
						}}
					>
						<SelectTrigger className="w-60">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="pi">{t("settings.defaultAgentBackendPi")}</SelectItem>
							<SelectItem value="dsh" disabled={!dshAvailable}>
								{dshAvailable ? t("settings.defaultAgentBackendDsh") : t("settings.defaultAgentBackendDshUnavailable")}
							</SelectItem>
						</SelectContent>
					</Select>
					<span className="text-muted-foreground text-xs">{t("config.wechat.backendHint")}</span>
				</div>
			) : null}

			{account ? (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2">
						<span className="text-foreground text-xs font-medium">{t("config.wechat.modelChain")}</span>
						<Button size="sm" variant="secondary" disabled={busy} onClick={() => void openPicker()}>
							<Plus className="mr-1 h-3.5 w-3.5" />
							{t("config.wechat.modelChainAdd")}
						</Button>
					</div>
					{modelChain.length === 0 ? (
						<>
							<span className="text-muted-foreground text-xs">{t("config.wechat.modelChainEmpty")}</span>
							{currentSessionModel ? <span className="text-muted-foreground text-xs">{t("config.wechat.currentSessionModel", { model: currentSessionModel })}</span> : null}
						</>
					) : (
						modelChain.map((entry, index) => (
							<div key={`${entry.provider}/${entry.modelId}`} className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
								<span className="text-foreground flex min-w-0 flex-1 items-center gap-2 text-xs">
									<span className="text-muted-foreground">{index + 1}</span>
									{/* 同名模型可能来自不同供应商：名称后面始终跟供应商，避免只看到模型名分不出条目 */}
									<span className="truncate" title={`${entry.provider}/${entry.modelId}`}>
										{entry.modelName ?? entry.modelId}
									</span>
									<span className="text-muted-foreground shrink-0 text-micro">{entry.provider}</span>
								</span>
								<span className="flex items-center gap-1">
									<Button size="sm" variant="ghost" disabled={busy || index === 0} aria-label={t("config.wechat.modelChainUp")} onClick={() => void handleModelChainChange(moveChainEntry(modelChain, index, index - 1))}>
										<ArrowUp className="h-3.5 w-3.5" />
									</Button>
									<Button size="sm" variant="ghost" disabled={busy || index === modelChain.length - 1} aria-label={t("config.wechat.modelChainDown")} onClick={() => void handleModelChainChange(moveChainEntry(modelChain, index, index + 1))}>
										<ArrowDown className="h-3.5 w-3.5" />
									</Button>
									<Button size="sm" variant="ghost" disabled={busy} aria-label={t("config.wechat.modelChainRemove")} onClick={() => void handleModelChainChange(modelChain.filter((_, i) => i !== index))}>
										<X className="h-3.5 w-3.5" />
									</Button>
								</span>
							</div>
						))
					)}
					<span className="text-muted-foreground text-xs">{backend === "dsh" ? t("config.wechat.modelChainDshHint") : t("config.wechat.modelChainHint")}</span>
				</div>
			) : null}

			{/* 操作指志：微信侧只有纯文本命令，桌面上没有入口提示，不写在这里用户就不知道 /new 能开新会话。 */}
			{account ? (
				<div className="border-border bg-muted/30 flex flex-col gap-1.5 rounded-md border px-3 py-2">
					<span className="text-foreground text-xs font-medium">{t("config.wechat.guideTitle")}</span>
					<ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs">
						<li>{t("config.wechat.guideNewSession")}</li>
						<li>{t("config.wechat.guideCommands")}</li>
						<li>{t("config.wechat.guideModelChain")}</li>
					</ul>
				</div>
			) : null}

			<div className="flex flex-col gap-2">
				<span className="text-foreground text-xs font-medium">{t("config.wechat.bindings", { count: bindings.length })}</span>
				{bindings.length === 0 ? (
					<span className="text-muted-foreground text-xs">{t("config.wechat.noBindings")}</span>
				) : (
					bindings.map((binding) => {
						const description = describeBinding(binding);
						return (
							<div key={binding.chatId} className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2">
								<div className="flex min-w-0 flex-col">
									<span className="text-foreground text-xs">{binding.chatId}</span>
									{/* 工作区 + 后端 + 当前模型：用户在这里就能确认这个 chat 到底跑在哪个引擎、哪个模型上。 */}
									<span className="text-muted-foreground truncate text-xs" title={description}>
										{description}
									</span>
								</div>
								<Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleUnbind(binding.chatId)}>
									{t("config.wechat.unbind")}
								</Button>
							</div>
						);
					})
				)}
			</div>

			<p className="text-muted-foreground text-xs">{t("config.wechat.p2pHint")}</p>

			{confirmLogout ? <ConfirmDialog title={t("config.wechat.logout")} message={t("config.wechat.logoutMessage")} onCancel={() => setConfirmLogout(false)} onConfirm={() => void handleLogout()} /> : null}

			{pickerOpen ? (
				// 这里是「从全部模型里挑一条加入优先级链」：默认展开所有供应商，避免逐个手动展开找模型。
				<ModelPicker
					models={models}
					loading={models.length === 0 && !modelsRefreshing}
					refreshing={modelsRefreshing}
					onRefresh={() => void loadModels(true)}
					favoriteModels={favoriteModels}
					onToggleFavorite={toggleFavorite}
					expandAllProviders
					onPick={(model) => {
						setPickerOpen(false);
						const next = appendChainEntry(modelChain, { provider: model.provider, modelId: model.id, modelName: model.name });
						// 重复选择时不产生写入：appendChainEntry 原样返回时 setState/落盘都是空转。
						if (next !== modelChain) void handleModelChainChange(next);
					}}
					onClose={() => setPickerOpen(false)}
				/>
			) : null}
		</div>
	);
}
