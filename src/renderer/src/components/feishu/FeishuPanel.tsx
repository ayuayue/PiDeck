/**
 * FeishuPanel — 侧边栏飞书面板
 *
 * 遵循 PiDeck 设计系统：CSS 变量 + ui-button / icon-button 体系。
 * 显示连接状态、Bot 信息、聊天绑定列表，提供连接/断开/管理操作。
 */

import { useState } from "react";
import { FeishuConnectDialog } from "./FeishuConnectDialog";
import type {
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuBotConfig,
	FeishuTestResult,
} from "../../../../shared/types";

type Props = {
	status: FeishuBridgeStatus;
	bots: FeishuBotConfig[];
	bindings: FeishuChatBinding[];
	connecting: boolean;
	isConnected: boolean;
	hasConfig: boolean;
	onConnect: (appId: string, appSecret: string, name: string, defaultUserOpenId?: string) => Promise<{ success: boolean; message: string }>;
	onDisconnect: () => void;
	onRemoveBot: (botId: string) => Promise<boolean>;
	onUpdateBotConfig: (botId: string, patch: Partial<FeishuBotConfig>) => Promise<FeishuBotConfig | undefined>;
	onTest: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	onRemoveBinding: (chatId: string) => Promise<boolean>;
};

const STATUS_LABEL: Record<string, string> = {
	connected: "已连接",
	connecting: "连接中",
	disconnected: "未连接",
	error: "错误",
};

export function FeishuPanel({
	status,
	bots,
	bindings,
	connecting,
	isConnected,
	hasConfig,
	onConnect,
	onDisconnect,
	onRemoveBot,
	onUpdateBotConfig,
	onTest,
	onRemoveBinding,
}: Props) {
	const [showConfig, setShowConfig] = useState(false);
	const [showBots, setShowBots] = useState(false);
	const [showBindings, setShowBindings] = useState(false);
	const [editingBotId, setEditingBotId] = useState<string | null>(null);
	const [editOpenId, setEditOpenId] = useState("");

	const statusClass = status.status;

	const handleDeleteBot = async (botId: string) => {
		if (!window.confirm("确定要删除该 Bot 配置吗？")) return;
		await onRemoveBot(botId);
	};

	return (
		<div className="feishu-panel">
			{/* ── 状态指示器 ── */}
			<div className="feishu-panel-header">
				<span className={`feishu-status-dot ${statusClass}`} />
				<span className="feishu-panel-title">飞书 Bridge</span>
				<span
					className="feishu-panel-status"
					style={{
						color:
							statusClass === "connected"
								? "var(--color-accent)"
								: statusClass === "connecting"
									? "var(--color-warning)"
									: statusClass === "error"
										? "var(--color-danger)"
										: "var(--color-text-tertiary)",
					}}
				>
					{STATUS_LABEL[statusClass] || statusClass}
				</span>
			</div>

			{/* ── 错误消息 ── */}
			{status.errorMessage && (
				<div className="feishu-error-banner">{status.errorMessage}</div>
			)}

			{/* ── Bot 列表 ── */}
			{bots.length > 0 && (
				<div>
					<button
						className="feishu-section-toggle"
						onClick={() => setShowBots((prev) => !prev)}
					>
						{showBots ? "▾" : "▸"} 已配置 Bot ({bots.length})
					</button>
					{showBots &&
						bots.map((bot) => (
							<div key={bot.id} className="feishu-bot-item" style={{ marginTop: 4 }}>
								<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
									<div style={{ minWidth: 0 }}>
										<div className="feishu-bot-name">{bot.name}</div>
										<div className="feishu-bot-meta">
											App: <span>{bot.appId.slice(0, 12)}…</span>
										</div>
										{bot.defaultUserOpenId && (
											<div className="feishu-bot-meta" style={{ marginTop: 2 }}>
												Open ID: <span>{bot.defaultUserOpenId.slice(0, 16)}…</span>
											</div>
										)}
									</div>
									<div className="feishu-bot-actions">
										<button
											className="icon-button"
											title="编辑 Open ID"
											onClick={() => {
												setEditingBotId(editingBotId === bot.id ? null : bot.id);
												setEditOpenId(bot.defaultUserOpenId || "");
											}}
											style={{ width: 26, height: 26, fontSize: 13 }}
										>
											{editingBotId === bot.id ? "✕" : "✎"}
										</button>
										<button
											className="icon-button"
											title="删除 Bot"
											onClick={() => handleDeleteBot(bot.id)}
											style={{ width: 26, height: 26, color: "var(--color-danger)", fontSize: 14 }}
										>
											🗑
										</button>
									</div>
								</div>
								{/* Open ID 编辑 */}
								{editingBotId === bot.id && (
									<div className="feishu-openid-edit">
										<input
											type="text"
											value={editOpenId}
											onChange={(e) => setEditOpenId(e.target.value)}
											placeholder="ou_xxxxxxxxxxxxxxxx"
										/>
										<button
											className="ui-button ui-button-sm ui-button-primary"
											style={{ fontSize: "var(--font-size-micro)", height: "var(--control-height-xs)", padding: "0 8px" }}
											onClick={async () => {
												await onUpdateBotConfig(bot.id, { defaultUserOpenId: editOpenId.trim() || undefined });
												setEditingBotId(null);
											}}
										>
											保存
										</button>
									</div>
								)}
							</div>
						))}
				</div>
			)}

			{/* ── 绑定概览 ── */}
			{bindings.length > 0 && (
				<div>
					<button
						className="feishu-section-toggle"
						onClick={() => setShowBindings((prev) => !prev)}
					>
						{showBindings ? "▾" : "▸"} 活跃聊天 ({bindings.length})
					</button>
					{showBindings &&
						bindings.map((b) => (
							<div key={b.chatId} className="feishu-binding-item" style={{ marginTop: 2 }}>
								<div className="feishu-binding-info">
									<div className="feishu-binding-name">
										{b.chatType === "p2p" ? "💬" : "👥"} {b.groupName || b.chatId.slice(0, 8)}
									</div>
									<div className="feishu-binding-session">
										会话: {b.sessionId.slice(0, 8)}
									</div>
								</div>
								<button
									className="icon-button"
									title="解除绑定"
									onClick={() => onRemoveBinding(b.chatId)}
									style={{ width: 24, height: 24, fontSize: 12, color: "var(--color-text-tertiary)" }}
								>
									✕
								</button>
							</div>
						))}
				</div>
			)}

			{/* ── 无 Bot 时的空状态 ── */}
			{bots.length === 0 && !isConnected && (
				<div className="feishu-empty">
					连接飞书 Bot，在飞书中与 Pi 对话
				</div>
			)}

			{/* ── 操作按钮 ── */}
			<div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
				{!isConnected ? (
					<>
						<button
							className="ui-button ui-button-sm ui-button-primary"
							onClick={() => setShowConfig(true)}
							disabled={connecting}
							style={{ flex: 1 }}
						>
							{hasConfig ? "连接" : "配置 Bot"}
						</button>
						{hasConfig && (
							<button
								className="ui-button ui-button-sm"
								onClick={() => setShowConfig(true)}
								style={{ minWidth: 32, padding: "0 8px" }}
							>
								⚙
							</button>
						)}
					</>
				) : (
					<button
						className="ui-button ui-button-sm ui-button-secondary"
						onClick={onDisconnect}
						style={{ flex: 1 }}
					>
						断开连接
					</button>
				)}
			</div>

			{/* ── 配置弹窗 ── */}
			{showConfig && (
				<FeishuConnectDialog
					onClose={() => setShowConfig(false)}
					onConnect={async (appId, appSecret, name, defaultUserOpenId) => {
						const result = await onConnect(appId, appSecret, name, defaultUserOpenId);
						if (result.success) setShowConfig(false);
						return result;
					}}
					onTest={onTest}
					connecting={connecting}
				/>
			)}
		</div>
	);
}
