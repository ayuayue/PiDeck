/**
 * ImTab — IM 连接配置选项卡
 *
 * 在设置弹窗中集中管理飞书 Bot 配置，含二维码生成。
 */

import { useState, useEffect, useCallback } from "react";
import type {
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuTestResult,
} from "../../../shared/types";

type Props = {
	onSave?: () => void;
};

type FeishuApiRaw = {
	botsList?: () => Promise<FeishuBotConfig[]>;
	statusRequest?: () => Promise<FeishuBridgeStatus>;
	bindingsList?: () => Promise<FeishuChatBinding[]>;
	onStatus?: (cb: (s: FeishuBridgeStatus) => void) => () => void;
	connect?: (input: { appId: string; appSecret: string; name: string }) => Promise<{ success: boolean; message: string }>;
	connectByBot?: (botId: string) => Promise<{ success: boolean; message: string }>;
	disconnect?: () => Promise<unknown>;
	botAdd?: (input: { appId: string; appSecret: string; name?: string }) => Promise<{ success: boolean; bot?: FeishuBotConfig; error?: string }>;
	botRemove?: (botId: string) => Promise<boolean>;
	testConnection?: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	bindingRemove?: (chatId: string) => Promise<boolean>;
};

export function ImTab(_props: Props) {
	const [bots, setBots] = useState<FeishuBotConfig[]>([]);
	const [status, setStatus] = useState<FeishuBridgeStatus>({ status: "disconnected", activeBindings: 0 });
	const [bindings, setBindings] = useState<FeishuChatBinding[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [showAddForm, setShowAddForm] = useState(false);
	const [appId, setAppId] = useState("");
	const [appSecret, setAppSecret] = useState("");
	const [botName, setBotName] = useState("");
	const [adding, setAdding] = useState(false);
	const [testResult, setTestResult] = useState<FeishuTestResult | null>(null);
	const [testing, setTesting] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
	const [expandedBotId, setExpandedBotId] = useState<string | null>(null);

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
				name: botName.trim() || "飞书机器人",
			});
			if (result.success) {
				setAppId("");
				setAppSecret("");
				setBotName("");
				setShowAddForm(false);
				setTestResult(null);
				await loadData();
			} else {
				setError(result.error ?? "添加失败");
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setAdding(false);
		}
	}, [api, appId, appSecret, botName, loadData]);

	const handleConnect = useCallback(async () => {
		if (!api || bots.length === 0) return;
		setConnecting(true);
		setConnectionMessage(null);
		try {
			const bot = bots[0]!;
			const result = await api.connectByBot!(bot.id);
			setConnectionMessage(result.message);
			if (result.success) await loadData();
		} catch (e) {
			setConnectionMessage(e instanceof Error ? e.message : String(e));
		} finally {
			setConnecting(false);
		}
	}, [api, bots, loadData]);

	const handleDisconnect = useCallback(async () => {
		if (!api) return;
		await api.disconnect!();
		await loadData();
		setConnectionMessage("已断开");
	}, [api, loadData]);

	const handleRemoveBot = useCallback(async (botId: string) => {
		if (!api) return;
		if (!window.confirm("确定要删除该 Bot 配置吗？")) return;
		await api.botRemove!(botId);
		await loadData();
	}, [api, loadData]);

	const handleRemoveBinding = useCallback(async (chatId: string) => {
		if (!api) return;
		await api.bindingRemove!(chatId);
		await loadData();
	}, [api, loadData]);

	const isConnected = status.status === "connected";

	const statusColors: Record<string, string> = {
		connected: "#00c864",
		connecting: "#ffa726",
		disconnected: "#888",
		error: "#ff4d4d",
	};

	const statusLabels: Record<string, string> = {
		connected: "已连接",
		connecting: "连接中",
		disconnected: "未连接",
		error: "错误",
	};

	if (loading) {
		return <div style={{ padding: 40, textAlign: "center", color: "#888" }}>加载中...</div>;
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "8px 0" }}>
			{/* 连接状态 */}
			<div style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "12px 16px",
				background: "var(--bg-secondary, #1a1a2e)",
				borderRadius: 8,
			}}>
				<span style={{
					width: 10,
					height: 10,
					borderRadius: "50%",
					background: statusColors[status.status] || "#888",
					display: "inline-block",
					flexShrink: 0,
				}} />
				<div style={{ flex: 1 }}>
					<div style={{ fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
						飞书连接状态: {statusLabels[status.status] || status.status}
					</div>
					{status.errorMessage && (
						<div style={{ color: "#ff4d4d", fontSize: 12, marginTop: 2 }}>
							{status.errorMessage}
						</div>
					)}
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					{isConnected ? (
						<button className="config-btn" onClick={handleDisconnect} style={{ fontSize: 12 }}>
							⏹ 断开
						</button>
					) : (
						<button
							className="config-btn primary"
							onClick={handleConnect}
							disabled={connecting || bots.length === 0}
							style={{ fontSize: 12 }}
						>
							{connecting ? "连接中..." : "🔗 连接"}
						</button>
					)}
				</div>
			</div>

			{connectionMessage && (
				<div style={{
					padding: "8px 12px",
					borderRadius: 6,
					background: connectionMessage.includes("成功") ? "rgba(0, 200, 100, 0.1)" : "rgba(255, 150, 50, 0.1)",
					color: connectionMessage.includes("成功") ? "#00c864" : "#ff9632",
					fontSize: 13,
				}}>
					{connectionMessage}
				</div>
			)}

			{error && (
				<div style={{
					padding: "8px 12px",
					borderRadius: 6,
					background: "rgba(255, 77, 77, 0.1)",
					color: "#ff4d4d",
					fontSize: 13,
				}}>
					{error}
					<button onClick={() => setError(null)} style={{ marginLeft: 8, background: "none", border: "none", color: "#ff4d4d", cursor: "pointer" }}>✕</button>
				</div>
			)}

			{/* Bot 管理 */}
			<div>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
					<h3 style={{ margin: 0, fontSize: 15, color: "var(--text-primary, #e0e0e0)" }}>
						🤖 Bot 配置 ({bots.length})
					</h3>
					<button
						className="config-btn primary"
						onClick={() => { setShowAddForm((v) => !v); setTestResult(null); setAppId(""); setAppSecret(""); setBotName(""); }}
						style={{ fontSize: 12 }}
					>
						{showAddForm ? "取消" : "+ 添加 Bot"}
					</button>
				</div>

				{showAddForm && (
					<div style={{
						padding: 16,
						background: "var(--bg-secondary, #1a1a2e)",
						borderRadius: 8,
						marginBottom: 12,
						display: "flex",
						flexDirection: "column",
						gap: 12,
					}}>
						<div>
							<label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4, color: "var(--text-primary, #e0e0e0)" }}>
								App ID
							</label>
							<input
								type="text"
								value={appId}
								onChange={(e) => { setAppId(e.target.value); setTestResult(null); }}
								placeholder="cli_xxxxxxxxxxxx"
								style={{ width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-color, #333)", background: "var(--bg-primary, #0d0d1a)", color: "var(--text-primary, #e0e0e0)", fontSize: 13 }}
							/>
						</div>
						<div>
							<label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4, color: "var(--text-primary, #e0e0e0)" }}>
								App Secret
							</label>
							<input
								type="password"
								value={appSecret}
								onChange={(e) => { setAppSecret(e.target.value); setTestResult(null); }}
								placeholder="••••••••••••••••"
								style={{ width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-color, #333)", background: "var(--bg-primary, #0d0d1a)", color: "var(--text-primary, #e0e0e0)", fontSize: 13 }}
							/>
						</div>
						<div>
							<label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4, color: "var(--text-primary, #e0e0e0)" }}>
								Bot 名称 <span style={{ fontWeight: 400, color: "#888" }}>(可选)</span>
							</label>
							<input
								type="text"
								value={botName}
								onChange={(e) => setBotName(e.target.value)}
								placeholder="我的飞书助手"
								style={{ width: "100%", padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-color, #333)", background: "var(--bg-primary, #0d0d1a)", color: "var(--text-primary, #e0e0e0)", fontSize: 13 }}
							/>
						</div>

						{testResult && (
							<div style={{
								padding: "8px 12px",
								borderRadius: 4,
								background: testResult.success ? "rgba(0, 200, 100, 0.1)" : "rgba(255, 150, 50, 0.1)",
								color: testResult.success ? "#00c864" : "#ff9632",
								fontSize: 13,
							}}>
								{testResult.success ? "✅ " : "⚠️ "}{testResult.message}
							</div>
						)}

						<div style={{ display: "flex", gap: 8 }}>
							<button
								className="config-btn"
								onClick={handleTest}
								disabled={testing || !appId.trim() || !appSecret.trim()}
								style={{ fontSize: 12 }}
							>
								{testing ? "测试中..." : "🔍 测试连接"}
							</button>
							<button
								className="config-btn primary"
								onClick={handleAddBot}
								disabled={adding || !appId.trim() || !appSecret.trim()}
								style={{ fontSize: 12 }}
							>
								{adding ? "添加中..." : "✅ 保存"}
							</button>
						</div>

						<div style={{ fontSize: 11, color: "#888", lineHeight: 1.6 }}>
							<p style={{ margin: "4px 0" }}>
								💡 在 <a href="https://open.feishu.cn/app" target="_blank" style={{ color: "#4fc3f7" }}>飞书开放平台</a> 创建企业自建应用，获取 App ID 和 App Secret。
							</p>
						</div>
					</div>
				)}

				{bots.length === 0 && !showAddForm && (
					<div style={{ padding: 24, textAlign: "center", color: "#888", fontSize: 13 }}>
						暂无 Bot 配置，点击上方按钮添加。
					</div>
				)}
				{bots.map((bot) => (
					<div key={bot.id} style={{
						padding: "12px 14px",
						background: "var(--bg-secondary, #1a1a2e)",
						borderRadius: 8,
						marginBottom: 8,
					}}>
						<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
							<div>
								<div style={{ fontWeight: 600, color: "var(--text-primary, #e0e0e0)", fontSize: 14 }}>
									{bot.name}
								</div>
								<div style={{ color: "#888", fontSize: 12 }}>
									App ID: {bot.appId.slice(0, 14)}...
								</div>
							</div>
							<div style={{ display: "flex", gap: 6 }}>
								<button
									className="config-btn"
									onClick={() => setExpandedBotId(expandedBotId === bot.id ? null : bot.id)}
									style={{ fontSize: 11 }}
								>
									{expandedBotId === bot.id ? "收起" : "详情"}
								</button>
								<button
									className="config-btn"
									onClick={() => handleRemoveBot(bot.id)}
									style={{ fontSize: 11, color: "#ff4d4d" }}
								>
									🗑
								</button>
							</div>
						</div>
						{expandedBotId === bot.id && (
							<div style={{ marginTop: 10, padding: "10px 0", borderTop: "1px solid var(--border-color, #333)", fontSize: 12, color: "#999" }}>
								<div>Bot ID: {bot.id}</div>
								<div>状态: {bot.enabled ? "✅ 启用" : "❌ 禁用"}</div>
								{bot.defaultWorkspaceId && <div>默认工作区: {bot.defaultWorkspaceId}</div>}
								{bot.defaultModelId && <div>默认模型: {bot.defaultModelId}</div>}
							</div>
						)}
					</div>
				))}
			</div>

			{/* 聊天绑定 */}
			<div>
				<h3 style={{ margin: "0 0 12px 0", fontSize: 15, color: "var(--text-primary, #e0e0e0)" }}>
					💬 活跃聊天绑定 ({bindings.length})
				</h3>
				{bindings.length === 0 ? (
					<div style={{ padding: 16, textAlign: "center", color: "#888", fontSize: 13 }}>
						暂无活跃绑定。连接飞书后发送消息即可自动创建绑定。
					</div>
				) : (
					bindings.map((binding) => (
						<div key={binding.chatId} style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							padding: "8px 12px",
							background: "var(--bg-secondary, #1a1a2e)",
							borderRadius: 6,
							marginBottom: 4,
							fontSize: 12,
						}}>
							<div>
								<span style={{ color: "var(--text-primary, #e0e0e0)" }}>
									{binding.chatType === "p2p" ? "💬" : "👥"} {binding.groupName || binding.chatId.slice(0, 10)}
								</span>
								<div style={{ color: "#888", fontSize: 10 }}>
									会话: {binding.sessionId.slice(0, 8)} | {new Date(binding.createdAt).toLocaleString()}
								</div>
							</div>
							<button
								onClick={() => handleRemoveBinding(binding.chatId)}
								style={{
									background: "none",
									border: "none",
									color: "#ff4d4d",
									cursor: "pointer",
									fontSize: 14,
									padding: "2px 6px",
								}}
								title="解除绑定"
							>
								✕
							</button>
						</div>
					))
				)}
			</div>



			{/* 帮助信息 */}
			<details style={{ fontSize: 12, color: "#888" }}>
				<summary style={{ cursor: "pointer", marginBottom: 8 }}>📋 配置指南</summary>
				<div style={{ lineHeight: 1.8, paddingLeft: 16 }}>
					<p>1. 打开 <a href="https://open.feishu.cn/app" target="_blank" style={{ color: "#4fc3f7" }}>飞书开放平台</a></p>
					<p>2. 创建「企业自建应用」</p>
					<p>3. 在 <strong>凭证与基础信息</strong> 中获取 App ID 和 App Secret</p>
					<p>4. 在 <strong>权限管理</strong> 中开启：</p>
					<ul style={{ margin: "4px 0", paddingLeft: 20 }}>
						<li>im:message — 获取消息</li>
						<li>im:message:send_as_bot — 发送消息</li>
						<li>im:chat — 获取群聊信息</li>
						<li>im:resource — 下载文件/图片</li>
					</ul>
					<p>5. 在 <strong>事件订阅</strong> 中开启 im.message.receive_v1（WebSocket 长连接模式）</p>
					<p>6. 创建应用版本并发布</p>
					<p style={{ marginTop: 8 }}>详细文档：<a href="https://open.feishu.cn/document/home/index" target="_blank" style={{ color: "#4fc3f7" }}>飞书开放平台文档</a></p>
				</div>
			</details>
		</div>
	);
}
