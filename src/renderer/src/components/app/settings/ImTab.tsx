import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Collapsible, CollapsibleContent } from "../../ui-shadcn/collapsible";
/**
 * ImTab — 外部连接配置选项卡
 *
 * 在 PiDeck 设置中集中管理外部 IM/Bot 连接（由 Pi 管理界面迁入）：飞书/Lark 与微信（iLink）。
 * 样式统一使用配置页的设计 tokens。
 */

import { useState, useEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { Loader2, X } from "lucide-react";
import { ConfirmDialog } from "../../app/AppParts";
import { writeClipboard } from "../../../utils/clipboard";
import type { FeishuBotConfig, FeishuBridgeStatus, FeishuChatBinding, FeishuTestResult, ImChannelBackend } from "../../../../../shared/types";
import { parseImChannelBackend } from "../../../../../shared/types";
import { dshUiVisibilityFor } from "../../../../../shared/types/dshRuntime";
import { dshRuntimeStatusAtom } from "../../../atoms/dsh-atoms";
import { formatI18nDateTime, t } from "../../../i18n";
import { WeChatSection } from "./WeChatSection";
import { Label } from "../../ui-shadcn/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui-shadcn/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";

type Props = {
	onSave?: () => void;
};

const SCOPES_JSON = `{
  "scopes": {
    "tenant": [
      "application:application:self_manage",
      "application:bot.basic_info:read",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "docs:document.comment:create",
      "docs:document.comment:delete",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.comment:write_only",
      "docx:document.block:convert",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive.metadata:readonly",
      "im:chat.members:bot_access",
      "im:chat:create",
      "im:chat:read",
      "im:chat:update",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "wiki:node:read"
    ],
    "user": [
      "offline_access"
    ]
  }
}`;

const EVENTS_JSON = `[
  "im.chat.member.bot.added_v1",
  "im.chat.member.bot.deleted_v1",
  "im.message.reaction.created_v1",
  "im.message.reaction.deleted_v1",
  "im.message.receive_v1",
  "drive.notice.comment_add_v1",
  "vc.meeting.participant_meeting_ended_v1",
  "vc.note.generated_v1",
  "minutes.minute.generated_v1"
]`;

const CALLBACKS_JSON = `[
  "card.action.trigger"
]`;

type FeishuApiRaw = {
	botsList?: () => Promise<FeishuBotConfig[]>;
	statusRequest?: () => Promise<FeishuBridgeStatus>;
	bindingsList?: () => Promise<FeishuChatBinding[]>;
	onStatus?: (cb: (s: FeishuBridgeStatus) => void) => () => void;
	connect?: (input: { appId: string; appSecret: string; name: string }) => Promise<{ success: boolean; message: string }>;
	/** 临时连接（不保存 bot 配置），返回 botInfo 用于后续保存 */
	connectTemp?: (input: { appId: string; appSecret: string; name?: string }) => Promise<{ success: boolean; message: string; botInfo?: { id: string; name: string } }>;
	connectByBot?: (botId: string) => Promise<{ success: boolean; message: string }>;
	disconnect?: () => Promise<unknown>;
	botAdd?: (input: { appId: string; appSecret: string; name?: string; defaultUserOpenId?: string }) => Promise<{ success: boolean; bot?: FeishuBotConfig; error?: string }>;
	botRemove?: (botId: string) => Promise<boolean>;
	botSecret?: (botId: string) => Promise<string>;
	testConnection?: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	bindingRemove?: (chatId: string) => Promise<boolean>;
	botConfig?: (botId: string, patch: Partial<FeishuBotConfig>) => Promise<FeishuBotConfig | undefined>;
	/** 监听飞书 whoami 结果 */
	onWhoamiResult?: (cb: (openId: string) => void) => () => void;
};

/**
 * 飞书接入面板。原 ImTab 本体（2027-02 加微信时改名）：只负责飞书，平台切换由下面的 ImTab 承担。
 */
function FeishuPane(_props: Props) {
	const [bots, setBots] = useState<FeishuBotConfig[]>([]);
	const [status, setStatus] = useState<FeishuBridgeStatus>({ status: "disconnected", activeBindings: 0 });
	const [bindings, setBindings] = useState<FeishuChatBinding[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showAddForm, setShowAddForm] = useState(false);
	const [visibleBots, setVisibleBots] = useState(5);
	const [visibleBindingsByBot, setVisibleBindingsByBot] = useState<Record<string, number>>({});
	const [appId, setAppId] = useState("");
	const [appSecret, setAppSecret] = useState("");
	const [botName, setBotName] = useState("");
	const [adding, setAdding] = useState(false);
	const [expandedBotIds, setExpandedBotIds] = useState<Set<string>>(new Set());
	// 添加 Bot 流程：连接 → 获取 open_id → 保存
	const [addFormOpenId, setAddFormOpenId] = useState("");
	const [addStep, setAddStep] = useState<"input" | "connected" | "saving">("input");
	const [addError, setAddError] = useState<string | null>(null);
	const [addConnecting, setAddConnecting] = useState(false);
	const [editingOpenIdBotId, setEditingOpenIdBotId] = useState<string | null>(null);
	const [editOpenIdValue, setEditOpenIdValue] = useState("");
	const [deleteConfirmBotId, setDeleteConfirmBotId] = useState<string | null>(null);
	const [guideOpen, setGuideOpen] = useState(false);
	const [copiedScope, setCopiedScope] = useState(false);
	// 后端可用性：DSH 未安装/待更新时只能选 pi（与「通用 → 默认 Agent 后端」同一套判定）。
	const dshRuntimeState = useAtomValue(dshRuntimeStatusAtom).state;
	const dshAvailable = dshUiVisibilityFor(dshRuntimeState).canCreateDshSession;
	const [copiedEvents, setCopiedEvents] = useState(false);
	const [copiedCallbacks, setCopiedCallbacks] = useState(false);
	const [copiedCredential, setCopiedCredential] = useState<string | null>(null);
	const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
	const [guideAnimating, setGuideAnimating] = useState(false);
	const [connecting, setConnecting] = useState(false);

	// 指南弹窗统一关闭路径：150ms 退场动画后卸载；overlay 点击、头部关闭钮、Escape 三入口共用，
	// 防止三处内联后行为漂移（如改动画时长漏一处）。
	const closeGuide = useCallback(() => {
		setGuideAnimating(true);
		setTimeout(() => {
			setGuideAnimating(false);
			setGuideOpen(false);
		}, 150);
	}, []);
	// 模态惯例：Escape 可关（与 overlay 点击/头部关闭钮等价）
	useEffect(() => {
		if (!guideOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") closeGuide();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [guideOpen, closeGuide]);

	const api = (window as unknown as { piDesktop?: { feishu?: FeishuApiRaw } }).piDesktop?.feishu;

	/** 使用主进程能力打开外部链接；forceSystem=true 强制系统浏览器（如飞书登录/指南页不适合内置浏览器）。 */
	const openExternal = useCallback(async (url: string, forceSystem?: boolean) => {
		const appApi = (window as unknown as { piDesktop?: { app?: { openExternal: (u: string, forceSystem?: boolean) => Promise<void> } } }).piDesktop?.app;
		if (appApi?.openExternal) {
			await appApi.openExternal(url, forceSystem);
		} else {
			window.open(url, "_blank", "noopener,noreferrer");
		}
	}, []);

	const loadData = useCallback(async () => {
		if (!api) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const [botsList, statusRes, bindingsList] = await Promise.all([api.botsList?.(), api.statusRequest?.(), api.bindingsList?.()]);
			setBots(botsList ?? []);
			setStatus(statusRes ?? { status: "disconnected", activeBindings: 0 });
			setBindings(bindingsList ?? []);
		} catch (e) {
			console.error("[Feishu] Failed to load configuration", e);
			setError(t("config.im.loadFailed"));
		} finally {
			setLoading(false);
		}
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		void loadData();
	}, [loadData]);

	useEffect(() => {
		if (!api) return;
		return api.onStatus?.(setStatus);
	}, [api]);

	// 监听飞书 whoami 结果：用户在飞书给 Bot 发 /whoami 后，自动填入 open_id
	useEffect(() => {
		if (!api?.onWhoamiResult) return;
		return api.onWhoamiResult((openId: string) => {
			setAddFormOpenId(openId);
		});
	}, [api]);

	/**
	 * 临时连接：验证凭证可用性并建立 WebSocket，但不保存到磁盘。
	 * 连接成功后用户去飞书发 /whoami 获取 open_id，然后手动保存。
	 */
	const handleConnectTemp = useCallback(async () => {
		if (!api?.connectTemp || !appId.trim() || !appSecret.trim()) return;
		setAddConnecting(true);
		setAddError(null);
		try {
			const result = await api.connectTemp({
				appId: appId.trim(),
				appSecret: appSecret.trim(),
				name: botName.trim() || t("config.im.botDefaultName"),
			});
			if (result.success) {
				setAddStep("connected");
			} else {
				setAddError(result.message);
			}
		} catch (e) {
			console.error("[Feishu] Temporary connection failed", e);
			setAddError(t("config.im.connectFailed"));
		} finally {
			setAddConnecting(false);
		}
	}, [api, appId, appSecret, botName]);

	/** 保存 bot 配置（含 open_id） */
	const handleSaveBot = useCallback(async () => {
		if (!api || !appId.trim() || !appSecret.trim()) return;
		setAdding(true);
		setAddError(null);
		try {
			// 先断开临时连接，botAdd 内部会重新创建 bridge 并持久化
			await api.disconnect?.();
			const result = await api.botAdd!({
				appId: appId.trim(),
				appSecret: appSecret.trim(),
				name: botName.trim() || t("config.im.botDefaultName"),
				defaultUserOpenId: addFormOpenId.trim() || undefined,
			});
			if (result.success) {
				setAppId("");
				setAppSecret("");
				setBotName("");
				setAddFormOpenId("");
				setAddStep("input");
				setShowAddForm(false);
				await loadData();
			} else {
				setAddError(result.error ?? t("config.im.addFailed"));
			}
		} catch (e) {
			console.error("[Feishu] Failed to save Bot", e);
			setAddError(t("config.im.addFailed"));
		} finally {
			setAdding(false);
		}
	}, [api, appId, appSecret, botName, addFormOpenId, loadData]);

	const handleRemoveBot = useCallback(
		async (botId: string) => {
			if (!api) return;
			await api.botRemove!(botId);
			await loadData();
		},
		[api, loadData],
	);

	const handleEditOpenId = useCallback(
		async (botId: string) => {
			if (!api) return;
			await api.botConfig!(botId, { defaultUserOpenId: editOpenIdValue.trim() || undefined });
			setEditingOpenIdBotId(null);
			await loadData();
		},
		[api, editOpenIdValue, loadData],
	);

	/** 只影响该 Bot 新建的会话；已有绑定保持自己的后端（设置页文案已说明）。 */
	const handleBackendChange = useCallback(
		async (botId: string, backend: ImChannelBackend) => {
			if (!api) return;
			await api.botConfig!(botId, { backend });
			await loadData();
		},
		[api, loadData],
	);

	const handleRemoveBinding = useCallback(
		async (chatId: string) => {
			if (!api) return;
			await api.bindingRemove!(chatId);
			await loadData();
		},
		[api, loadData],
	);

	const handleCopyValue = useCallback(async (key: string, value: string) => {
		await writeClipboard(value);
		setCopiedCredential(key);
		setTimeout(() => setCopiedCredential(null), 1600);
	}, []);

	const handleLoadSecret = useCallback(
		async (botId: string) => {
			if (!api?.botSecret) return "";
			const cached = revealedSecrets[botId];
			if (cached) return cached;
			const secret = await api.botSecret(botId);
			setRevealedSecrets((prev) => ({ ...prev, [botId]: secret }));
			return secret;
		},
		[api, revealedSecrets],
	);

	const handleCopySecret = useCallback(
		async (botId: string) => {
			const secret = await handleLoadSecret(botId);
			if (secret) await handleCopyValue(`secret:${botId}`, secret);
		},
		[handleCopyValue, handleLoadSecret],
	);

	const handleRevealSecret = useCallback(
		async (botId: string) => {
			await handleLoadSecret(botId);
		},
		[handleLoadSecret],
	);

	const getVisibleBindingsForBot = useCallback((botId: string) => visibleBindingsByBot[botId] ?? 10, [visibleBindingsByBot]);

	const isConnected = bindings.length > 0;
	const statusLabel = t(`config.im.status.${status.status}` as Parameters<typeof t>[0]) || status.status;

	if (loading) {
		return (
			<div className="flex items-center justify-center gap-2 py-12 text-control text-text-tertiary">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				{t("common.loading")}
			</div>
		);
	}

	return (
		<div className="config-im-tab">
			{/* ── 全局连接状态提示 ── */}
			{isConnected && (
				<div className="config-im-status-bar">
					<span className="config-im-status-dot connected" />
					<div className="config-im-status-info">
						<div className="config-im-status-title">{t("config.im.linkedAgentsCount", { count: bindings.length })}</div>
						<div className="config-im-status-meta">{t("config.im.activeBindings", { count: bindings.length })}</div>
						{status.errorMessage && <div className="config-im-status-error">{status.errorMessage}</div>}
					</div>
				</div>
			)}

			{status.status === "error" && status.errorMessage && <div className="config-im-message warn">{status.errorMessage}</div>}

			{error && (
				<div className="config-im-error">
					<span>{error}</span>
					<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setError(null)}>
						×
					</Button>
				</div>
			)}

			{/* ── 单 Bot 连接提示 ── */}
			<div className="config-im-hint">{t("config.im.singleConnectionHint")}</div>

			{/* ── Bot 配置管理 ── */}
			<div className="config-section">
				<div className="mb-3 flex items-center justify-between gap-3">
					<span className="font-mono text-xs tabular-nums text-muted-foreground">{t("config.im.botConfig", { count: bots.length })}</span>
					<div className="flex min-w-0 items-center gap-1.5">
						<Button size="sm" variant="outline" onClick={() => setGuideOpen(true)}>
							{t("config.im.guide")}
						</Button>
						<Button size="sm" variant="outline" onClick={() => openExternal("https://xid01i1952l.feishu.cn/wiki/Yf8Gw5QW3is7xdkuG98cvRVen5d?from=from_copylink", true)}>
							{t("config.im.onlineGuide")}
						</Button>
						<Button
							size="sm"
							variant="default"
							onClick={() => {
								if (showAddForm && addStep === "connected") void api?.disconnect?.();
								setShowAddForm((v) => !v);
								setAddStep("input");
								setAddError(null);
								setAppId("");
								setAppSecret("");
								setBotName("");
								setAddFormOpenId("");
							}}
						>
							{showAddForm ? t("common.cancel") : t("config.im.addBot")}
						</Button>
					</div>
				</div>

				{/* 添加 Bot 表单开合走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
				    display:contents 根不生成盒子，样式类留在折叠体本身。 */}
				<Collapsible open={showAddForm} className="contents">
					<CollapsibleContent className="config-im-form">
						<div className="config-field">
							<Label>{t("config.im.appId")}</Label>
							<Input
								type="text"
								value={appId}
								onChange={(e) => {
									setAppId(e.target.value);
									setAddError(null);
									if (addStep !== "input") setAddStep("input");
								}}
								placeholder="cli_xxxxxxxxxxxx"
								disabled={addStep !== "input"}
							/>
						</div>
						<div className="config-field">
							<Label>{t("config.im.appSecret")}</Label>
							<Input
								type="password"
								value={appSecret}
								onChange={(e) => {
									setAppSecret(e.target.value);
									setAddError(null);
									if (addStep !== "input") setAddStep("input");
								}}
								placeholder="••••••••••••••••"
								disabled={addStep !== "input"}
							/>
						</div>
						<div className="config-field">
							<Label>
								{t("config.im.botName")} <span className="config-field-optional">({t("common.optional")})</span>
							</Label>
							<Input type="text" value={botName} onChange={(e) => setBotName(e.target.value)} placeholder={t("config.im.botNamePlaceholder")} disabled={addStep !== "input"} />
						</div>

						{/* 连接成功后才显示 Open ID 输入框 */}
						{addStep === "connected" && (
							<div className="config-im-openid-section">
								<div className="config-field">
									<Label>
										{t("config.im.openId")} <span className="config-field-required">*</span>
									</Label>
									<Input type="text" value={addFormOpenId} onChange={(e) => setAddFormOpenId(e.target.value)} placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
								</div>
								<div className="config-im-openid-hint">💡 {t("config.im.openIdHint")}</div>
							</div>
						)}

						{addStep === "input" && addConnecting && <div className="config-im-test-result info">⏳ {t("config.im.connectingToFeishu")}</div>}

						{addError && <div className="config-im-test-result warn">⚠️ {addError}</div>}

						<div className="config-im-form-actions">
							{addStep === "input" && (
								<Button size="sm" variant="default" onClick={handleConnectTemp} disabled={addConnecting || !appId.trim() || !appSecret.trim()} style={{ flex: 1 }}>
									{addConnecting ? t("config.im.connecting") : t("config.im.connect")}
								</Button>
							)}
							{addStep === "connected" && (
								<>
									<div className="config-im-connected-info">✅ {t("config.im.connectedToFeishu")}</div>
									<Button size="sm" variant="default" onClick={handleSaveBot} disabled={adding || !addFormOpenId.trim()} style={{ flex: 1 }} title={!addFormOpenId.trim() ? t("config.im.openIdRequired") : undefined}>
										{adding ? t("config.im.saving") : t("config.im.saveBot")}
									</Button>
								</>
							)}
						</div>
					</CollapsibleContent>
				</Collapsible>

				{bots.length === 0 && !showAddForm && <div className="py-12 text-center text-control text-text-tertiary">{t("config.im.noBotConfig")}</div>}

				{bots.slice(0, visibleBots).map((bot) => {
					const botBindings = bindings.filter((binding) => binding.botId === bot.id);
					// 连接状态来自 bridge 当前连接的 botId；绑定数量只代表已有聊天绑定，不等于 Bot 在线状态。
					const isThisConnected = status.status === "connected" && status.botId === bot.id;
					const isEditingOpenId = editingOpenIdBotId === bot.id;
					const isExpanded = expandedBotIds.has(bot.id);
					// 展开/折叠唯一入口：鼠标点击与键盘 Enter/Space 共用，避免两处内联后行为漂移
					const toggleBotExpanded = () =>
						setExpandedBotIds((prev) => {
							const next = new Set(prev);
							if (next.has(bot.id)) next.delete(bot.id);
							else next.add(bot.id);
							return next;
						});
					const visibleBindingCount = getVisibleBindingsForBot(bot.id);
					const visibleBotBindings = botBindings.slice(0, visibleBindingCount);
					const secretValue = revealedSecrets[bot.id];
					return (
						<div key={bot.id} className={`mb-2 overflow-hidden rounded-lg border border-border-subtle bg-bg-panel transition-[border-color,box-shadow,background-color] duration-fast config-im-bot-card${isThisConnected ? " border-[var(--color-accent)]/30" : ""}`}>
							{/* 折叠体走共享折叠原语；display:contents 不生成盒子，折叠态零空档。 */}
							<Collapsible open={isExpanded} className="contents">
								<div
									className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 hover:bg-bg-hover config-im-bot-header"
									/* 展开是进入 Bot 配置的唯一入口，键盘必须可达；全局 [role=button]:focus-visible 自动提供焦点环 */
									role="button"
									tabIndex={0}
									aria-expanded={isExpanded}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											toggleBotExpanded();
										}
									}}
									onClick={toggleBotExpanded}
								>
									<div className="min-w-0 flex-1">
										<div className="truncate text-control font-semibold text-text-primary">
											<span className="config-im-expand-caret">{isExpanded ? "▾" : "▸"}</span>
											{bot.name}
											{isThisConnected && <span className="config-im-connected-badge">{t("config.im.connected")}</span>}
										</div>
										<div className="text-micro text-text-tertiary">
											{t("config.im.expandHint")} · {t("config.im.appId")}: {bot.appId.slice(0, 14)}… · {t("config.im.linkedAgentsCount", { count: botBindings.length })}
										</div>
									</div>
									<div className="flex shrink-0 gap-1.5" onClick={(e) => e.stopPropagation()}>
										{isThisConnected ? (
											<Button
												variant="outline"
												size="sm"
												className="text-destructive"
												disabled={connecting}
												onClick={async () => {
													setConnecting(true);
													try {
														await api?.disconnect?.();
														await loadData();
													} finally {
														setConnecting(false);
													}
												}}
											>
												{connecting ? t("config.im.connecting") : t("config.im.disconnect")}
											</Button>
										) : (
											<Button
												variant="default"
												size="sm"
												disabled={connecting}
												onClick={async () => {
													setConnecting(true);
													try {
														await api?.connectByBot?.(bot.id);
														await loadData();
													} catch (e) {
														console.error("[Feishu] Failed to connect saved Bot", e);
														setError(t("config.im.connectFailed"));
													} finally {
														setConnecting(false);
													}
												}}
											>
												{connecting ? t("config.im.connecting") : t("config.im.connect")}
											</Button>
										)}
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												setExpandedBotIds((prev) => {
													const next = new Set(prev);
													if (next.has(bot.id)) next.delete(bot.id);
													else next.add(bot.id);
													return next;
												});
											}}
										>
											{isExpanded ? t("common.collapse") : t("common.details")}
										</Button>
										<Button size="sm" variant="destructive" onClick={() => setDeleteConfirmBotId(bot.id)}>
											{t("common.delete")}
										</Button>
									</div>
								</div>
								{/* 不再挂 animate-in/fade-in：twMerge 会把 animate-* 判同组，保留会盖掉高度动画。
							    onClick 原样保留：站点点击不应冒泡到外层卡片。 */}
								<CollapsibleContent className="border-t border-border-subtle px-3.5 py-2.5 text-xs config-im-bot-details" onClick={(e) => e.stopPropagation()}>
									<div className="config-im-bot-detail-section">
										<div className="config-im-section-title">{t("config.im.appCredentials")}</div>
										<div className="config-im-credential-grid">
											<div className="config-im-credential-card">
												<span>{t("config.im.appId")}</span>
												<code>{bot.appId}</code>
												<Button variant="outline" size="sm" onClick={() => handleCopyValue(`appid:${bot.id}`, bot.appId)}>
													{copiedCredential === `appid:${bot.id}` ? t("common.copied") : t("common.copy")}
												</Button>
											</div>
											<div className="config-im-credential-card">
												<span>{t("config.im.appSecret")}</span>
												<code>{secretValue || t("config.im.secretHidden")}</code>
												<div className="config-im-credential-actions">
													<Button variant="outline" size="sm" onClick={() => handleCopySecret(bot.id)}>
														{copiedCredential === `secret:${bot.id}` ? t("common.copied") : t("common.copy")}
													</Button>
													<Button
														variant="outline"
														size="sm"
														onClick={() => {
															if (secretValue) {
																setRevealedSecrets((prev) => {
																	const next = { ...prev };
																	delete next[bot.id];
																	return next;
																});
															} else {
																void handleRevealSecret(bot.id);
															}
														}}
													>
														{secretValue ? t("config.im.hideSecret") : t("config.im.revealSecret")}
													</Button>
												</div>
											</div>
										</div>
									</div>

									<div className="config-im-bot-detail-section">
										<div className="config-im-section-title">{t("config.im.openId")}</div>
										{isEditingOpenId ? (
											<div className="config-im-openid-edit">
												<Input type="text" value={editOpenIdValue} onChange={(e) => setEditOpenIdValue(e.target.value)} placeholder="ou_xxxxxxxxxxxx" className="config-input config-input-xs" />
												<Button variant="default" size="sm" onClick={() => handleEditOpenId(bot.id)}>
													{t("common.save")}
												</Button>
												<Button variant="outline" size="sm" onClick={() => setEditingOpenIdBotId(null)}>
													{t("common.cancel")}
												</Button>
											</div>
										) : (
											<div className="config-im-openid-line">
												{bot.defaultUserOpenId ? <code>{bot.defaultUserOpenId}</code> : <span className="config-im-openid-empty">{t("config.im.openIdEmpty")}</span>}
												<Button
													variant="outline"
													size="sm"
													onClick={() => {
														setEditingOpenIdBotId(bot.id);
														setEditOpenIdValue(bot.defaultUserOpenId || "");
													}}
												>
													{t("config.im.editOpenId")}
												</Button>
											</div>
										)}
									</div>

									<div className="config-im-bot-detail-section">
										<div className="config-im-section-title">{t("config.im.backend")}</div>
										<div className="flex items-center gap-3">
											<Select
												value={bot.backend ?? "pi"}
												onValueChange={(value) => {
													const next = parseImChannelBackend(value);
													if (next) void handleBackendChange(bot.id, next);
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
											<span className="text-muted-foreground text-xs">{t("config.im.backendHint")}</span>
										</div>
									</div>

									<div className="config-im-bot-detail-section">
										<div className="config-im-section-title">{t("config.im.linkedAgents", { count: botBindings.length })}</div>
										{botBindings.length === 0 ? (
											<div className="py-12 text-center text-control text-text-tertiary config-im-inline-empty">{t("config.im.noBotBindings")}</div>
										) : (
											<div className="config-im-binding-list">
												{visibleBotBindings.map((binding) => (
													<div key={binding.chatId} className="config-im-binding-row">
														<div className="config-im-binding-avatar">{binding.chatType === "p2p" ? "💬" : "👥"}</div>
														<div className="config-im-binding-info">
															<div className="config-im-binding-title">{binding.groupName || binding.chatId.slice(0, 10)}</div>
															<div className="config-im-binding-meta">
																{t("config.im.agentId")}: {binding.sessionId.slice(0, 8)} · {t("config.im.chat")}: {binding.chatId.slice(0, 10)} · {formatI18nDateTime(binding.createdAt)}
															</div>
														</div>
														<Button variant="destructive" size="sm" onClick={() => handleRemoveBinding(binding.chatId)}>
															{t("config.im.disconnect")}
														</Button>
													</div>
												))}
												{botBindings.length > visibleBindingCount && (
													<Button variant="outline" size="sm" className="config-im-show-more" onClick={() => setVisibleBindingsByBot((prev) => ({ ...prev, [bot.id]: Math.min((prev[bot.id] ?? 10) + 10, botBindings.length) }))}>
														{t("config.im.showMoreAgents")} ({botBindings.length - visibleBindingCount})
													</Button>
												)}
											</div>
										)}
									</div>
								</CollapsibleContent>
							</Collapsible>
						</div>
					);
				})}
				{bots.length > visibleBots && (
					<Button variant="outline" size="sm" style={{ marginTop: 4 }} onClick={() => setVisibleBots((v) => Math.min(v + 5, bots.length))}>
						{t("common.showMore")} ({bots.length - visibleBots})
					</Button>
				)}
			</div>

			{/* ── 删除确认弹窗 ── */}
			{deleteConfirmBotId && (
				<ConfirmDialog
					title={t("config.im.confirmDeleteBot")}
					message={t("config.im.deleteBotMessage")}
					danger
					confirmLabel={t("common.delete")}
					onConfirm={() => {
						const botId = deleteConfirmBotId;
						setDeleteConfirmBotId(null);
						void handleRemoveBot(botId);
					}}
					onCancel={() => setDeleteConfirmBotId(null)}
				/>
			)}

			{/* ── 配置指南弹窗 ── */}
			{guideOpen && (
				<div
					className={`config-im-guide-overlay${guideAnimating ? " closing" : ""}`}
					onClick={(e) => {
						if (e.target === e.currentTarget) closeGuide();
					}}
				>
					<div className="config-im-guide-modal">
						<div className="config-im-guide-modal-header">
							<strong>{t("config.im.guide")}</strong>
							<Button variant="ghost" size="icon-sm" className="size-7" onClick={closeGuide}>
								<X size={16} strokeWidth={2.2} />
							</Button>
						</div>
						<div className="config-im-guide-modal-body">
							<p>
								<strong>{t("config.im.guideMethodTitle")}</strong>
							</p>

							{/* 方式一：智能体（推荐） */}
							<p>
								<strong>{t("config.im.guideMethodA")}</strong>
							</p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideMethodADesc")}</p>
							<ol>
								<li>
									{t("config.im.guideMethodAStep1a")}
									<br />
									<Button variant="link" size="sm" className="config-link-like h-auto p-0" onClick={() => openExternal("https://open.feishu.cn/app", true)}>
										https://open.feishu.cn/app
									</Button>{" "}
									→ {t("config.im.guideMethodAStep1b")}
								</li>
								<li>{t("config.im.guideMethodAStep2")}</li>
								<li>{t("config.im.guideMethodAStep3")}</li>
								<li>{t("config.im.guideMethodAStep4")}</li>
							</ol>

							{/* 方式二：开放平台（手动） */}
							<p style={{ marginTop: 16 }}>
								<strong>{t("config.im.guideMethodB")}</strong>
							</p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideMethodBDesc")}</p>
							<ol>
								<li>
									{t("config.im.guideMethodBStep1a")}
									<br />
									<Button variant="link" size="sm" className="config-link-like h-auto p-0" onClick={() => openExternal("https://open.feishu.cn/app", true)}>
										https://open.feishu.cn/app
									</Button>{" "}
									→ {t("config.im.guideMethodBStep1b")}
								</li>
								<li>{t("config.im.guideMethodBStep2")}</li>
								<li>
									{t("config.im.guideMethodBStep3")}
									<br />
									<ul className="config-im-guide-perms">
										<li>
											<code>im:message:send_as_bot</code> — {t("config.im.permSendMessage")}
										</li>
										<li>
											<code>im:message.p2p_msg:readonly</code> — {t("config.im.permGetMessageP2P")}
										</li>
										<li>
											<code>im:message.group_at_msg:readonly</code> — {t("config.im.permGetMessageGroup")}
										</li>
										<li>
											<code>im:message:update</code> — {t("config.im.permUpdateMessage")}
										</li>
										<li>
											<code>im:chat:read</code> / <code>im:chat:create</code> / <code>im:chat:update</code> — {t("config.im.permChatManage")}
										</li>
										<li>
											<code>im:resource</code> — {t("config.im.permDownload")}
										</li>
										<li>
											<code>contact:contact.base:readonly</code> — {t("config.im.permContact")}
										</li>
									</ul>
								</li>
								<li>{t("config.im.guideMethodBStep4")}</li>
								<li>{t("config.im.guideMethodBStep5")}</li>
								<li>{t("config.im.guideMethodBStep6")}</li>
								<li>{t("config.im.guideMethodAStep4")}</li>
							</ol>

							<p className="config-im-guide-note">{t("config.im.guideGroupChat")}</p>

							{/* 可复制的权限和作用域 */}
							<p style={{ marginTop: 20, fontWeight: 600 }}>{t("config.im.guideScopeTitle")}</p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideScopeDesc")}</p>
							<pre className="config-im-code-block">{SCOPES_JSON}</pre>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									writeClipboard(SCOPES_JSON);
									setCopiedScope(true);
									setTimeout(() => setCopiedScope(false), 2000);
								}}
							>
								{copiedScope ? t("common.copied") : t("common.copy")}
							</Button>

							<p style={{ marginTop: 20, fontWeight: 600 }}>{t("config.im.guideEventsTitle")}</p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideEventsDesc")}</p>
							<pre className="config-im-code-block">{EVENTS_JSON}</pre>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									writeClipboard(EVENTS_JSON);
									setCopiedEvents(true);
									setTimeout(() => setCopiedEvents(false), 2000);
								}}
							>
								{copiedEvents ? t("common.copied") : t("common.copy")}
							</Button>

							<p style={{ marginTop: 20, fontWeight: 600 }}>{t("config.im.guideCallbacksTitle")}</p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideCallbacksDesc")}</p>
							<pre className="config-im-code-block">{CALLBACKS_JSON}</pre>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									writeClipboard(CALLBACKS_JSON);
									setCopiedCallbacks(true);
									setTimeout(() => setCopiedCallbacks(false), 2000);
								}}
							>
								{copiedCallbacks ? t("common.copied") : t("common.copy")}
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * IM 接入设置页：飞书与微信是两套完全不同的登录流程（App ID/Secret vs 扫码），
 * 共用一个表单会把两边的状态混在一起，所以这里只做平台切换，各自的面板内部自理。
 */
export function ImTab() {
	const [platform, setPlatform] = useState<"feishu" | "wechat">("feishu");
	return (
		<div className="flex flex-col gap-4">
			{/* 平台切换用共享 Tabs 分组控件：容器包住两个 tab，选中项靠 data-state 高亮 */}
			<Tabs value={platform} onValueChange={(value) => setPlatform(value === "wechat" ? "wechat" : "feishu")} className="gap-4">
				<TabsList className="w-auto self-start" aria-label={t("config.im.platformLabel")}>
					<TabsTrigger value="feishu">{t("config.im.platformFeishu")}</TabsTrigger>
					<TabsTrigger value="wechat">{t("config.im.platformWechat")}</TabsTrigger>
				</TabsList>
				<TabsContent value="feishu">
					<FeishuPane />
				</TabsContent>
				<TabsContent value="wechat">
					<div className="config-im-tab">
						<WeChatSection />
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
