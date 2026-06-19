/**
 * ImTab — 外部链接配置选项卡
 *
 * 在配置弹窗中集中管理外部 IM/Bot 连接（当前支持飞书/Lark）。
 * 样式统一使用配置页的设计 tokens。
 */

import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { ConfirmDialog } from "../components/app/AppParts";
import type {
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuTestResult,
} from "../../../shared/types";
import { t } from "../i18n";

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

type FeishuApiRaw = {
	botsList?: () => Promise<FeishuBotConfig[]>;
	statusRequest?: () => Promise<FeishuBridgeStatus>;
	bindingsList?: () => Promise<FeishuChatBinding[]>;
	onStatus?: (cb: (s: FeishuBridgeStatus) => void) => () => void;
	connect?: (input: { appId: string; appSecret: string; name: string }) => Promise<{ success: boolean; message: string }>;
	connectByBot?: (botId: string) => Promise<{ success: boolean; message: string }>;
	disconnect?: () => Promise<unknown>;
	botAdd?: (input: { appId: string; appSecret: string; name?: string; defaultUserOpenId?: string }) => Promise<{ success: boolean; bot?: FeishuBotConfig; error?: string }>;
	botRemove?: (botId: string) => Promise<boolean>;
	testConnection?: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	bindingRemove?: (chatId: string) => Promise<boolean>;
	botConfig?: (botId: string, patch: Partial<FeishuBotConfig>) => Promise<FeishuBotConfig | undefined>;
};

export function ImTab(_props: Props) {
	const [bots, setBots] = useState<FeishuBotConfig[]>([]);
	const [status, setStatus] = useState<FeishuBridgeStatus>({ status: "disconnected", activeBindings: 0 });
	const [bindings, setBindings] = useState<FeishuChatBinding[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showAddForm, setShowAddForm] = useState(false);
	const [visibleBots, setVisibleBots] = useState(5);
	const [visibleBindings, setVisibleBindings] = useState(5);
	const [appId, setAppId] = useState("");
	const [appSecret, setAppSecret] = useState("");
	const [botName, setBotName] = useState("");
	const [adding, setAdding] = useState(false);
	const [testResult, setTestResult] = useState<FeishuTestResult | null>(null);
	const [testing, setTesting] = useState(false);
	const [connectingBotId, setConnectingBotId] = useState<string | null>(null);
	const [connectedBotId, setConnectedBotId] = useState<string | null>(null);
	const [expandedBotIds, setExpandedBotIds] = useState<Set<string>>(new Set());
	const [addFormOpenId, setAddFormOpenId] = useState("");
	const [editingOpenIdBotId, setEditingOpenIdBotId] = useState<string | null>(null);
	const [editOpenIdValue, setEditOpenIdValue] = useState("");
	const [deleteConfirmBotId, setDeleteConfirmBotId] = useState<string | null>(null);
	const [guideOpen, setGuideOpen] = useState(false);
	const [copiedScope, setCopiedScope] = useState(false);
	const [copiedEvents, setCopiedEvents] = useState(false);
	const [guideAnimating, setGuideAnimating] = useState(false);

	const api = (window as unknown as { piDesktop?: { feishu?: FeishuApiRaw } }).piDesktop?.feishu;

	const loadData = useCallback(async () => {
		if (!api) { setLoading(false); return; }
		setLoading(true);
		setError(null);
		try {
			const [botsList, statusRes, bindingsList] = await Promise.all([
				api.botsList?.(),
				api.statusRequest?.(),
				api.bindingsList?.(),
			]);
			setBots(botsList ?? []);
			setStatus(statusRes ?? { status: "disconnected", activeBindings: 0 });
			setBindings(bindingsList ?? []);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
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

	const handleTest = useCallback(async () => {
		if (!api || !appId.trim() || !appSecret.trim()) return;
		setTesting(true);
		setTestResult(null);
		try {
			const result = await api.testConnection!(appId.trim(), appSecret.trim());
			setTestResult(result);
		} catch (e) {
			setTestResult({ success: false, message: e instanceof Error ? e.message : String(e) });
		} finally {
			setTesting(false);
		}
	}, [api, appId, appSecret]);

	const handleAddBot = useCallback(async () => {
		if (!api || !appId.trim() || !appSecret.trim()) return;
		setAdding(true);
		try {
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
				setShowAddForm(false);
				setTestResult(null);
				await loadData();
			} else {
				setError(result.error ?? t("config.im.addFailed"));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setAdding(false);
		}
	}, [api, appId, appSecret, botName, addFormOpenId, loadData]);

	const handleConnectBot = useCallback(async (botId: string) => {
		if (!api) return;
		setConnectingBotId(botId);
		setError(null);
		try {
			const result = await api.connectByBot!(botId);
			if (result.success) {
				setConnectedBotId(botId);
				await loadData();
			} else {
				setError(result.message || t("config.im.connectFailed"));
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setConnectingBotId(null);
		}
	}, [api, loadData]);

	const handleDisconnectBot = useCallback(async () => {
		if (!api) return;
		await api.disconnect!();
		setConnectedBotId(null);
		await loadData();
	}, [api, loadData]);

	const handleRemoveBot = useCallback(async (botId: string) => {
		if (!api) return;
		await api.botRemove!(botId);
		await loadData();
	}, [api, loadData]);

	const handleEditOpenId = useCallback(async (botId: string) => {
		if (!api) return;
		await api.botConfig!(botId, { defaultUserOpenId: editOpenIdValue.trim() || undefined });
		setEditingOpenIdBotId(null);
		await loadData();
	}, [api, editOpenIdValue, loadData]);

	const handleRemoveBinding = useCallback(async (chatId: string) => {
		if (!api) return;
		await api.bindingRemove!(chatId);
		await loadData();
	}, [api, loadData]);


	const isConnected = status.status === "connected";
	const statusLabel = t(`config.im.status.${status.status}` as any) || status.status;

	if (loading) {
		return <div className="config-loading">{t("common.loading")}</div>;
	}

	return (
		<div className="config-im-tab">
			{/* ── 全局连接状态提示 ── */}
			{isConnected && connectedBotId && (
				<div className="config-im-status-bar">
					<span className={`config-im-status-dot ${status.status}`} />
					<div className="config-im-status-info">
						<div className="config-im-status-title">
							{t("config.im.connectedWith", { name: bots.find(b => b.id === connectedBotId)?.name ?? "" })}
						</div>
						{status.activeBindings > 0 && (
							<div className="config-im-status-meta">
								{t("config.im.activeBindings", { count: status.activeBindings })}
							</div>
						)}
						{status.errorMessage && (
							<div className="config-im-status-error">{status.errorMessage}</div>
						)}
					</div>
				</div>
			)}

			{status.status === "error" && status.errorMessage && (
				<div className="config-im-message warn">{status.errorMessage}</div>
			)}

			{error && (
				<div className="config-im-error">
					<span>{error}</span>
					<button className="config-icon-btn" onClick={() => setError(null)}>×</button>
				</div>
			)}

			{/* ── 单 Bot 连接提示 ── */}
			<div className="config-im-hint">
				{t("config.im.singleConnectionHint")}
			</div>

			{/* ── Bot 配置管理 ── */}
			<div className="config-section">
				<div className="config-toolbar">
					<span className="config-count">{t("config.im.botConfig", { count: bots.length })}</span>
					<div className="config-toolbar-actions">
						<button
							className="config-btn"
							onClick={() => setGuideOpen(true)}
						>
							{t("config.im.guide")}
						</button>
						<a
							href="https://xid01i1952l.feishu.cn/wiki/Yf8Gw5QW3is7xdkuG98cvRVen5d?from=from_copylink"
							target="_blank"
							rel="noreferrer"
							className="config-btn"
						>
							{t("config.im.onlineGuide")}
						</a>
						<button
							className="config-btn primary"
							onClick={() => { setShowAddForm((v) => !v); setTestResult(null); setAppId(""); setAppSecret(""); setBotName(""); setAddFormOpenId(""); }}
						>
							{showAddForm ? t("common.cancel") : t("config.im.addBot")}
						</button>
					</div>
				</div>

				{showAddForm && (
					<div className="config-im-form">
						<div className="config-field">
							<label>{t("config.im.appId")}</label>
							<input
								type="text"
								value={appId}
								onChange={(e) => { setAppId(e.target.value); setTestResult(null); }}
								placeholder="cli_xxxxxxxxxxxx"
								className="config-input"
							/>
						</div>
						<div className="config-field">
							<label>{t("config.im.appSecret")}</label>
							<input
								type="password"
								value={appSecret}
								onChange={(e) => { setAppSecret(e.target.value); setTestResult(null); }}
								placeholder="••••••••••••••••"
								className="config-input"
							/>
						</div>
						<div className="config-field">
							<label>{t("config.im.botName")} <span className="config-field-optional">({t("common.optional")})</span></label>
							<input
								type="text"
								value={botName}
								onChange={(e) => setBotName(e.target.value)}
								placeholder={t("config.im.botNamePlaceholder")}
								className="config-input"
							/>
						</div>
						<div className="config-field">
							<label>{t("config.im.openId")} <span className="config-field-optional">({t("common.optional")})</span></label>
							<input
								type="text"
								value={addFormOpenId}
								onChange={(e) => setAddFormOpenId(e.target.value)}
								placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
								className="config-input"
							/>
							<span className="config-field-hint">{t("config.im.openIdHint")}</span>
						</div>

						{testResult && (
							<div className={`config-im-test-result ${testResult.success ? "success" : "warn"}`}>
								{testResult.success ? "✅ " : "⚠️ "}{testResult.message}
							</div>
						)}

						<div className="config-im-form-actions">
							<button
								className="config-btn"
								onClick={handleTest}
								disabled={testing || !appId.trim() || !appSecret.trim()}
							>
								{testing ? t("config.im.testing") : t("config.im.testConnection")}
							</button>
							<button
								className="config-btn primary"
								onClick={handleAddBot}
								disabled={adding || !appId.trim() || !appSecret.trim()}
							>
								{adding ? t("config.im.saving") : t("common.save")}
							</button>
						</div>
					</div>
				)}

				{bots.length === 0 && !showAddForm && (
					<div className="config-empty">{t("config.im.noBotConfig")}</div>
				)}

				{bots.slice(0, visibleBots).map((bot) => {
					const isThisConnected = connectedBotId === bot.id;
					const isConnectingThis = connectingBotId === bot.id;
					const isEditingOpenId = editingOpenIdBotId === bot.id;
					return (
					<div key={bot.id} className={`config-card${isThisConnected ? " connected" : ""}`}>
						{/* 点击整行切换展开/收起 */}
						<div
							className="config-card-header"
							onClick={() => setExpandedBotIds((prev) => {
								const next = new Set(prev);
								if (next.has(bot.id)) next.delete(bot.id);
								else next.add(bot.id);
								return next;
							})}
						>
							<div className="config-card-info">
								<div className="config-card-name">
									{bot.name}
									{isThisConnected && <span className="config-im-connected-badge">{t("config.im.connected")}</span>}
								</div>
								<div className="config-card-meta">
									App ID: {bot.appId.slice(0, 14)}...
								</div>
							</div>
							<div className="config-card-actions" onClick={(e) => e.stopPropagation()}>
								{isThisConnected ? (
									<button
										className="config-btn"
										onClick={handleDisconnectBot}
										disabled={connectingBotId !== null}
									>
										{t("config.im.disconnect")}
									</button>
								) : (
									<button
										className="config-btn primary"
										onClick={() => handleConnectBot(bot.id)}
										disabled={connectingBotId !== null}
									>
										{isConnectingThis ? t("config.im.connecting") : t("config.im.connect")}
									</button>
								)}
								<button
									className="config-btn"
									onClick={(e) => {
										e.stopPropagation();
										setExpandedBotIds((prev) => {
											const next = new Set(prev);
											if (next.has(bot.id)) next.delete(bot.id);
											else next.add(bot.id);
											return next;
										});
									}}
								>
									{expandedBotIds.has(bot.id) ? t("common.collapse") : t("common.details")}
								</button>
								<button
									className="config-btn danger-fill"
									onClick={(e) => { e.stopPropagation(); setDeleteConfirmBotId(bot.id); }}
								>
									{t("common.delete")}
								</button>
							</div>
						</div>
						{expandedBotIds.has(bot.id) && (
							<div className="config-card-details" onClick={(e) => e.stopPropagation()}>
								<div className="config-detail-row">
									<span className="config-detail-label">{t("config.im.botId")}</span>
									<span className="config-detail-value">{bot.id}</span>
								</div>
								<div className="config-detail-row">
									<span className="config-detail-label">{t("config.im.status")}</span>
									<span className="config-detail-value">{bot.enabled ? "✅ " + t("common.enabled") : "❌ " + t("common.disabled")}</span>
								</div>
								<div className="config-detail-row">
									<span className="config-detail-label">{t("config.im.openId")}</span>
									<div className="config-detail-value" style={{ flex: 1 }}>
										{isEditingOpenId ? (
											<div className="config-im-openid-edit">
												<input
													type="text"
													value={editOpenIdValue}
													onChange={(e) => setEditOpenIdValue(e.target.value)}
													placeholder="ou_xxxxxxxxxxxx"
													className="config-input config-input-xs"
												/>
												<button className="config-btn primary small" onClick={() => handleEditOpenId(bot.id)}>{t("common.save")}</button>
												<button className="config-btn small" onClick={() => setEditingOpenIdBotId(null)}>{t("common.cancel")}</button>
											</div>
										) : (
											<span>
												{bot.defaultUserOpenId ? (
													<code>{bot.defaultUserOpenId}</code>
												) : (
													<span className="config-im-openid-empty">{t("config.im.openIdEmpty")}</span>
												)}
												<button
													className="config-btn small"
													onClick={() => { setEditingOpenIdBotId(bot.id); setEditOpenIdValue(bot.defaultUserOpenId || ""); }}
													style={{ marginLeft: 8 }}
												>
													{t("common.edit")}
												</button>
											</span>
										)}
									</div>
								</div>
								{bot.defaultWorkspaceId && (
									<div className="config-detail-row">
										<span className="config-detail-label">{t("config.im.defaultWorkspace")}</span>
										<span className="config-detail-value">{bot.defaultWorkspaceId}</span>
									</div>
								)}
								{bot.defaultModelId && (
									<div className="config-detail-row">
										<span className="config-detail-label">{t("config.im.defaultModel")}</span>
										<span className="config-detail-value">{bot.defaultModelId}</span>
									</div>
								)}
							</div>
						)}
					</div>
				);
				})}
				{bots.length > visibleBots && (
					<button className="config-btn small" style={{ marginTop: 4 }} onClick={() => setVisibleBots((v) => Math.min(v + 5, bots.length))}>
						{t("common.showMore")} ({bots.length - visibleBots})
					</button>
				)}
			</div>

			{/* ── 已关联的 Agent ── */}
			<div className="config-section">
				<div className="config-toolbar">
					<span className="config-count">{t("config.im.botBindings", { count: bindings.length })}</span>
				</div>

				{bindings.length === 0 ? (
					<div className="config-empty">{t("config.im.noBindings")}</div>
				) : (
					<>
						{bindings.slice(0, visibleBindings).map((binding) => (
							<div key={binding.chatId} className="config-card config-binding-card">
								<div className="config-card-header">
									<div className="config-card-info">
										<div className="config-card-name">
											{binding.chatType === "p2p" ? "💬" : "👥"} {binding.groupName || binding.chatId.slice(0, 10)}
										</div>
										<div className="config-card-meta">
											{t("config.im.session")}: {binding.sessionId.slice(0, 8)} | {new Date(binding.createdAt).toLocaleString()}
										</div>
									</div>
									<div className="config-card-actions">
										<button
											className="config-btn danger-fill"
											onClick={() => handleRemoveBinding(binding.chatId)}
										>
											{t("common.delete")}
										</button>
									</div>
								</div>
							</div>
						))}
						{bindings.length > visibleBindings && (
							<button className="config-btn small" style={{ marginTop: 4 }} onClick={() => setVisibleBindings((v) => Math.min(v + 5, bindings.length))}>
								{t("common.showMore")} ({bindings.length - visibleBindings})
							</button>
						)}
					</>
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
						if (e.target === e.currentTarget) {
							setGuideAnimating(true);
							setTimeout(() => { setGuideAnimating(false); setGuideOpen(false); }, 150);
						}
					}}
				>
					<div className="config-im-guide-modal">
						<div className="config-im-guide-modal-header">
							<strong>{t("config.im.guide")}</strong>
							<button
								className="config-icon-btn"
								onClick={() => { setGuideAnimating(true); setTimeout(() => { setGuideAnimating(false); setGuideOpen(false); }, 150); }}
							>
								<X size={16} strokeWidth={2.2} />
							</button>
						</div>
						<div className="config-im-guide-modal-body">
							<p><strong>{t("config.im.guideMethodTitle")}</strong></p>

							{/* 方式一：智能体（推荐） */}
							<p><strong>{t("config.im.guideMethodA")}</strong></p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideMethodADesc")}</p>
							<ol>
								<li>{t("config.im.guideMethodAStep1a")}<br /><a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" style={{ whiteSpace: "nowrap" }}>https://open.feishu.cn/app</a> → {t("config.im.guideMethodAStep1b")}</li>
								<li>{t("config.im.guideMethodAStep2")}</li>
								<li>{t("config.im.guideMethodAStep3")}</li>
								<li>{t("config.im.guideMethodAStep4")}</li>
							</ol>

							{/* 方式二：开放平台（手动） */}
							<p style={{ marginTop: 16 }}><strong>{t("config.im.guideMethodB")}</strong></p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideMethodBDesc")}</p>
							<ol>
								<li>{t("config.im.guideMethodBStep1a")}<br /><a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" style={{ whiteSpace: "nowrap" }}>https://open.feishu.cn/app</a> → {t("config.im.guideMethodBStep1b")}</li>
								<li>{t("config.im.guideMethodBStep2")}</li>
								<li>{t("config.im.guideMethodBStep3")}<br />
									<ul className="config-im-guide-perms">
										<li><code>im:message:send_as_bot</code> — {t("config.im.permSendMessage")}</li>
										<li><code>im:message.p2p_msg:readonly</code> — {t("config.im.permGetMessageP2P")}</li>
										<li><code>im:message.group_at_msg:readonly</code> — {t("config.im.permGetMessageGroup")}</li>
										<li><code>im:message:update</code> — {t("config.im.permUpdateMessage")}</li>
										<li><code>im:chat:read</code> / <code>im:chat:create</code> / <code>im:chat:update</code> — {t("config.im.permChatManage")}</li>
										<li><code>im:resource</code> — {t("config.im.permDownload")}</li>
										<li><code>contact:contact.base:readonly</code> — {t("config.im.permContact")}</li>
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
							<button className="config-btn small" onClick={() => { navigator.clipboard.writeText(SCOPES_JSON); setCopiedScope(true); setTimeout(() => setCopiedScope(false), 2000); }}>
								{copiedScope ? t("common.copied") : t("common.copy")}
							</button>

							<p style={{ marginTop: 20, fontWeight: 600 }}>{t("config.im.guideEventsTitle")}</p>
							<p style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>{t("config.im.guideEventsDesc")}</p>
							<pre className="config-im-code-block">{EVENTS_JSON}</pre>
							<button className="config-btn small" onClick={() => { navigator.clipboard.writeText(EVENTS_JSON); setCopiedEvents(true); setTimeout(() => setCopiedEvents(false), 2000); }}>
								{copiedEvents ? t("common.copied") : t("common.copy")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
