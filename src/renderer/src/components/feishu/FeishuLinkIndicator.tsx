/**
 * FeishuLinkIndicator — 输入框中的飞书链接状态指示器
 *
 * 在 composer 底部栏中显示飞书连接状态，提供按会话切换 Bot 的入口。
 * 视觉对齐 composer-bar-btn：透明底、弱色文字，状态仅用圆点表达。
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { FeishuBridgeStatus, FeishuBotConfig } from "../../../../shared/types";
import { t } from "../../i18n";

type Props = {
	status: FeishuBridgeStatus;
	bots: FeishuBotConfig[];
	/** 当前活跃 Agent ID，用于读取/保存 Bot 分配 */
	activeAgentId: string | undefined;
	/** 当前连接的 Bot ID */
	activeBotId: string | undefined;
	/** 当前 Agent 指定的 Bot ID（可能不同于 activeBotId） */
	sessionBotId: string | undefined;
	isConnected: boolean;
	connecting: boolean;
	onConnectByBot: (botId: string) => Promise<{ success: boolean; message: string }>;
	onDisconnect: () => void;
	onSetSessionBot: (agentId: string, botId: string | null) => Promise<{ success: boolean; message?: string; chatId?: string } | void>;
};

export function FeishuLinkIndicator({
	status,
	bots,
	activeAgentId,
	activeBotId,
	sessionBotId,
	isConnected,
	connecting,
	onConnectByBot,
	onSetSessionBot,
}: Props) {
	const [open, setOpen] = useState(false);
	const [selectingBotId, setSelectingBotId] = useState<string | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (
				popoverRef.current &&
				!popoverRef.current.contains(e.target as Node) &&
				triggerRef.current &&
				!triggerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open]);

	const sessionBot = sessionBotId
		? bots.find((b) => b.id === sessionBotId)
		: undefined;
	// 仅当会话绑定 Bot 且全局 bridge 也连着该 Bot 时，才算“会话已连接”
	const sessionConnected = Boolean(isConnected && sessionBot && sessionBot.id === activeBotId);
	const hasBots = bots.length > 0;

	const handleSelectBot = useCallback(async (botId: string) => {
		setSelectingBotId(botId);
		try {
			if (botId !== activeBotId) {
				const connectResult = await onConnectByBot(botId);
				if (!connectResult.success) {
					window.alert(connectResult.message || t("feishu.link.connectFailed"));
					return;
				}
			}
			if (!activeAgentId) {
				window.alert(t("feishu.link.noActiveSession"));
				return;
			}
			const bindResult = await onSetSessionBot(activeAgentId, botId);
			if (bindResult && bindResult.success === false) {
				window.alert(bindResult.message || t("feishu.link.bindFailed"));
				return;
			}
			window.setTimeout(() => setOpen(false), 180);
		} finally {
			window.setTimeout(() => setSelectingBotId(null), 180);
		}
	}, [activeBotId, activeAgentId, onConnectByBot, onSetSessionBot]);

	const handleClearSessionBot = useCallback(async () => {
		if (activeAgentId) {
			await onSetSessionBot(activeAgentId, null);
		}
		setOpen(false);
	}, [activeAgentId, onSetSessionBot]);

	if (!hasBots) return null;

	const statusClass = connecting
		? "connecting"
		: sessionConnected
			? "connected"
			: "disconnected";

	const triggerLabel = sessionConnected && sessionBot
		? t("feishu.link.connectedWithName", { name: sessionBot.name })
		: connecting
			? t("feishu.link.connecting")
			: t("feishu.link.disconnected");

	const statusText = sessionConnected
		? t("feishu.link.sessionConnected")
		: connecting
			? t("feishu.link.connectingShort")
			: t("feishu.link.disconnectedShort");

	return (
		<div className="feishu-link-indicator">
			<button
				ref={triggerRef}
				type="button"
				className={`feishu-link-trigger ${statusClass}${open ? " open" : ""}`}
				onClick={() => setOpen((prev) => !prev)}
				title={sessionConnected && sessionBot
					? t("feishu.link.triggerConnectedTitle", { name: sessionBot.name })
					: t("feishu.link.triggerDisconnectedTitle")}
				aria-label={t("feishu.link.ariaLabel")}
				aria-expanded={open}
				aria-haspopup="menu"
			>
				<span className={`feishu-link-dot ${statusClass}`} aria-hidden="true" />
				<span className="feishu-link-label">{triggerLabel}</span>
			</button>

			{open && (
				<div ref={popoverRef} className="feishu-link-popover" role="menu">
					<div className="feishu-link-popover-header">
						<div className="feishu-link-popover-heading">
							<span className={`feishu-link-dot ${statusClass}`} aria-hidden="true" />
							<div className="feishu-link-popover-heading-text">
								<strong>{t("feishu.link.popoverTitle")}</strong>
								<span>
									{statusText}
									{sessionBot ? ` · ${sessionBot.name}` : ""}
								</span>
							</div>
						</div>
						{sessionBotId && (
							<button
								type="button"
								className="feishu-link-popover-action"
								onClick={handleClearSessionBot}
								disabled={connecting}
							>
								{t("feishu.link.disconnectSession")}
							</button>
						)}
					</div>

					{status.errorMessage && (
						<div className="feishu-link-popover-error">{status.errorMessage}</div>
					)}

					<div className="feishu-link-popover-list">
						{bots.map((bot) => {
							const isActive = bot.id === activeBotId;
							const isSessionPinned = bot.id === sessionBotId;
							const isSessionConnectedBot = isActive && isSessionPinned;
							const isSelecting = selectingBotId === bot.id;
							return (
								<button
									key={bot.id}
									type="button"
									className={`feishu-link-bot-item${isSessionConnectedBot ? " active" : ""}${isSessionPinned && !isActive ? " pinned" : ""}`}
									onClick={() => handleSelectBot(bot.id)}
									disabled={connecting || Boolean(selectingBotId)}
									role="menuitem"
								>
									<div className="feishu-link-bot-info">
										<span className="feishu-link-bot-name">{bot.name}</span>
										<span className="feishu-link-bot-meta">
											{isSelecting
												? t("feishu.link.connectingShort")
												: isSessionConnectedBot
													? t("feishu.link.sessionConnected")
													: isActive
														? t("feishu.link.globalOnline")
														: isSessionPinned
															? t("feishu.link.sessionNotConnected")
															: bot.appId}
										</span>
									</div>
									{(isSelecting || isSessionConnectedBot || isSessionPinned) && (
										<span className="feishu-link-bot-check" aria-hidden="true">
											{isSelecting ? <span className="feishu-link-spinner" /> : "✓"}
										</span>
									)}
								</button>
							);
						})}
					</div>

					{!sessionConnected && (
						<div className="feishu-link-popover-hint">
							{t("feishu.link.selectHint")}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
