/**
 * FeishuLinkIndicator — 输入框中的飞书链接状态指示器
 *
 * 在 composer 底部栏中显示飞书连接状态，提供按会话切换 Bot 的入口。
 * 视觉对齐 composer-bar-btn：透明底、弱色文字，状态仅用圆点表达。
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { FeishuBridgeStatus, FeishuBotConfig } from "../../../../shared/types";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

/** 飞书官方三色 Logo（SVG 内嵌，避免额外网络加载）——main 对齐项：输入框入口必须用 logo，不用圆点/文字 */
function FeishuLogo() {
	return (
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
			<path
				d="M12.9238 12.8029C12.9427 12.784 12.9616 12.7682 12.9806 12.7493C13.0184 12.7146 13.0563 12.6767 13.091 12.6389L13.1667 12.5631L13.397 12.336L14.7315 11.0173L15.0659 10.686C15.129 10.6229 15.1952 10.563 15.2615 10.5031C15.3845 10.3926 15.5076 10.2854 15.6369 10.1813C15.7536 10.0866 15.8767 9.99514 15.9997 9.9068C16.1732 9.78376 16.3499 9.67019 16.5329 9.55977C16.7127 9.45251 16.8957 9.35471 17.085 9.26322C17.2616 9.17804 17.4415 9.09917 17.6276 9.02661C17.7317 8.9856 17.8326 8.94774 17.9399 8.91304C17.9935 8.89411 18.044 8.87834 18.0977 8.86256C17.6276 7.00439 16.7632 5.3008 15.5991 3.84959C15.3719 3.56566 15.0249 3.40161 14.6589 3.40161H5.0084C4.83489 3.40161 4.76233 3.6256 4.90114 3.72656C8.18528 6.13997 10.9236 9.24114 12.9017 12.825C12.908 12.8187 12.9175 12.8124 12.9238 12.8029Z"
				fill="#00D6B9"
			/>
			<path
				d="M9.09696 21.2986C14.0815 21.2986 18.4225 18.5476 20.6877 14.4843C20.7666 14.3423 20.8454 14.1972 20.918 14.052C20.8044 14.2729 20.6751 14.4811 20.5394 14.6767C20.4889 14.7461 20.4385 14.8155 20.388 14.8818C20.3217 14.9669 20.2555 15.049 20.1861 15.1278C20.1324 15.1909 20.0757 15.2509 20.0189 15.3108C19.9021 15.4307 19.7823 15.5474 19.6561 15.6547C19.5867 15.7146 19.5141 15.7714 19.4415 15.8282C19.3564 15.8944 19.268 15.9575 19.1797 16.0143C19.1229 16.0522 19.0661 16.09 19.0093 16.1247C18.9494 16.1626 18.8895 16.1973 18.8264 16.232C18.7002 16.3014 18.574 16.3645 18.4446 16.4245C18.3311 16.4749 18.2175 16.5223 18.1008 16.5633C17.9746 16.6106 17.8452 16.6516 17.7159 16.6863C17.5234 16.7399 17.3247 16.7809 17.1259 16.8125C16.9808 16.8346 16.8357 16.8504 16.6874 16.863C16.5328 16.8724 16.3751 16.8787 16.2173 16.8756C16.0438 16.8724 15.8703 16.863 15.6936 16.844C15.5643 16.8314 15.435 16.8125 15.3056 16.7873C15.192 16.7683 15.0785 16.7431 14.9649 16.7178C14.9049 16.7021 14.845 16.6895 14.7851 16.6737C14.6179 16.6295 14.4538 16.5822 14.2898 16.5349C14.2077 16.5096 14.1257 16.4875 14.0437 16.4623C13.9206 16.4245 13.7976 16.3897 13.6777 16.3519C13.5768 16.3203 13.479 16.2888 13.378 16.2572C13.2834 16.2257 13.1887 16.1942 13.0941 16.1626C13.031 16.1405 12.9647 16.1184 12.9016 16.0964C12.8228 16.0711 12.7471 16.0427 12.6682 16.0143C12.6114 15.9954 12.5578 15.9765 12.501 15.9544C12.3906 15.9134 12.2802 15.8755 12.1729 15.8345C12.1098 15.8093 12.0467 15.7872 11.9836 15.7619C11.8984 15.7304 11.8132 15.6957 11.7312 15.6641C11.6429 15.6294 11.5514 15.5947 11.4631 15.5569C11.4063 15.5348 11.3463 15.5096 11.2895 15.4875C11.217 15.4591 11.1476 15.4275 11.075 15.3991C11.0214 15.3771 10.9646 15.3518 10.911 15.3297C10.8542 15.3045 10.7974 15.2793 10.7406 15.254C10.6901 15.2319 10.6428 15.2099 10.5923 15.1878C10.5482 15.1688 10.5008 15.1468 10.4567 15.1278C10.4094 15.1057 10.3652 15.0868 10.3179 15.0647C10.2705 15.0427 10.2232 15.0206 10.1759 14.9985C10.116 14.9701 10.056 14.9417 9.99608 14.9165C9.93299 14.8881 9.87304 14.8565 9.80995 14.8281C9.7437 14.7966 9.67745 14.765 9.6112 14.7303C9.55441 14.7019 9.49762 14.6735 9.44084 14.6483C6.45324 13.1592 3.80321 11.1717 1.54438 8.76145C1.43081 8.64157 1.23206 8.72044 1.23206 8.88449L1.23836 18.0933C1.23836 18.494 1.43712 18.8726 1.77153 19.0934C3.86631 20.4878 6.38699 21.2986 9.09696 21.2986Z"
				fill="#3370FF"
			/>
			<path
				d="M23.7322 9.29488C22.7226 8.79642 21.5838 8.5188 20.3818 8.5188C19.6688 8.5188 18.9747 8.6166 18.3217 8.80273C18.246 8.82481 18.1703 8.8469 18.0977 8.86898C18.0441 8.88476 17.9905 8.90368 17.94 8.91946C17.8359 8.95416 17.7318 8.99202 17.6276 9.03303C17.4447 9.10559 17.2617 9.18446 17.085 9.26964C16.8957 9.36113 16.7128 9.45893 16.5329 9.56619C16.35 9.67345 16.1701 9.79018 15.9998 9.91322C15.8767 10.0016 15.7569 10.093 15.637 10.1877C15.5076 10.2918 15.3846 10.3991 15.2616 10.5095C15.1953 10.5694 15.1322 10.6325 15.066 10.6925L14.7315 11.0206L13.3939 12.3424L13.1636 12.5696L13.0879 12.6453C13.05 12.6831 13.0122 12.7178 12.9775 12.7557C12.9586 12.7746 12.9396 12.7904 12.9207 12.8093C12.8923 12.8377 12.8639 12.863 12.8355 12.8882C12.804 12.9166 12.7724 12.9481 12.7409 12.9765C11.9143 13.7368 10.9931 14.3899 9.99304 14.923C10.053 14.9514 10.1129 14.9798 10.1729 15.0051C10.2202 15.0271 10.2675 15.0492 10.3148 15.0713C10.359 15.0934 10.4063 15.1123 10.4536 15.1344C10.4978 15.1533 10.5451 15.1754 10.5893 15.1943C10.6398 15.2164 10.6871 15.2385 10.7376 15.2606C10.7944 15.2858 10.8511 15.3111 10.9079 15.3363C10.9616 15.3584 11.0184 15.3836 11.072 15.4057C11.1445 15.4373 11.2139 15.4657 11.2865 15.4941C11.3433 15.5193 11.4032 15.5414 11.46 15.5635C11.5484 15.5982 11.6367 15.636 11.7282 15.6707C11.8134 15.7023 11.8954 15.737 11.9806 15.7685C12.0437 15.7938 12.1068 15.8158 12.1699 15.8411C12.2803 15.8821 12.3875 15.9231 12.498 15.961C12.5547 15.9799 12.6084 16.002 12.6652 16.0209C12.744 16.0493 12.8197 16.0745 12.8986 16.1029C12.9617 16.125 13.028 16.1471 13.0911 16.1692C13.1857 16.2007 13.2803 16.2323 13.375 16.2638C13.4728 16.2954 13.5737 16.3269 13.6747 16.3585C13.7977 16.3963 13.9176 16.4342 14.0406 16.4689C14.1227 16.4941 14.2047 16.5162 14.2867 16.5414C14.4508 16.5888 14.618 16.6361 14.782 16.6803C14.842 16.696 14.9019 16.7118 14.9618 16.7244C15.0754 16.7528 15.189 16.7749 15.3026 16.7938C15.4319 16.8159 15.5613 16.8348 15.6906 16.8506C15.8673 16.8695 16.0408 16.8822 16.2143 16.8822C16.372 16.8853 16.5298 16.879 16.6844 16.8695C16.8326 16.8601 16.9778 16.8412 17.1229 16.8191C17.3248 16.7875 17.5204 16.7465 17.7128 16.6929C17.8422 16.6582 17.9715 16.6172 18.0977 16.5698C18.2144 16.5257 18.328 16.4815 18.4416 16.4279C18.5709 16.3679 18.7003 16.3048 18.8233 16.2354C18.8833 16.2007 18.9464 16.166 19.0063 16.1282C19.0631 16.0935 19.1199 16.0556 19.1767 16.0178C19.265 15.9578 19.3533 15.8947 19.4385 15.8316C19.5111 15.7748 19.5836 15.718 19.653 15.6581C19.7792 15.5508 19.8991 15.4341 20.0158 15.3142C20.0726 15.2543 20.1294 15.1943 20.183 15.1313C20.2524 15.0524 20.3187 14.9704 20.3849 14.8852C20.4354 14.8189 20.4859 14.7495 20.5364 14.6801C20.672 14.4845 20.7982 14.2763 20.9118 14.0586L21.0411 13.7999L22.2084 11.4748L22.2053 11.4812C22.5807 10.6578 23.1012 9.91953 23.7322 9.29488Z"
				fill="#133C9A"
			/>
		</svg>
	);
}

type Props = {
	status: FeishuBridgeStatus;
	bots: FeishuBotConfig[];
	/** 当前稳定 Session ID，用于读取/保存 Bot 分配 */
	activeSessionId: string | undefined;
	/** 当前连接的 Bot ID */
	activeBotId: string | undefined;
	/** 当前 Agent 指定的 Bot ID（可能不同于 activeBotId） */
	sessionBotId: string | undefined;
	isConnected: boolean;
	connecting: boolean;
	onConnectByBot: (botId: string) => Promise<{ success: boolean; message: string }>;
	onDisconnect: () => void;
	onSetSessionBot: (sessionId: string, botId: string | null) => Promise<{ success: boolean; message?: string; chatId?: string } | void>;
};

export function FeishuLinkIndicator({ status, bots, activeSessionId, activeBotId, sessionBotId, isConnected, connecting, onConnectByBot, onSetSessionBot }: Props) {
	const [open, setOpen] = useState(false);
	const [selectingBotId, setSelectingBotId] = useState<string | null>(null);
	/** popover 经 createPortal 渲染到 body 后的视口锚点（trigger 左上角）。
	 * 原因：composer 底栏是 overflow-y:hidden 的单行滚动容器（da415c99 引入），
	 * 绝对定位的 popover 向上弹出会被裁剪，表现为「点击后内容不可见」。 */
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node) && triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
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

	// 打开时按 trigger 位置计算视口锚点；窗口缩放/任意容器滚动时跟随重算（capture 捕获所有滚动容器）
	useEffect(() => {
		if (!open) return;
		const updateAnchor = () => {
			const el = triggerRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			// left 钳制：popover 最大宽 420px，右缘留 8px 视口边距
			const left = Math.max(8, Math.min(rect.left, window.innerWidth - 420 - 8));
			setAnchor({ top: rect.top, left });
		};
		updateAnchor();
		window.addEventListener("resize", updateAnchor);
		document.addEventListener("scroll", updateAnchor, true);
		return () => {
			window.removeEventListener("resize", updateAnchor);
			document.removeEventListener("scroll", updateAnchor, true);
		};
	}, [open]);

	const sessionBot = sessionBotId ? bots.find((b) => b.id === sessionBotId) : undefined;
	// 仅当会话绑定 Bot 且全局 bridge 也连着该 Bot 时，才算“会话已连接”
	const sessionConnected = Boolean(isConnected && sessionBot && sessionBot.id === activeBotId);
	const hasBots = bots.length > 0;

	const handleSelectBot = useCallback(
		async (botId: string) => {
			setSelectingBotId(botId);
			try {
				if (botId !== activeBotId) {
					const connectResult = await onConnectByBot(botId);
					if (!connectResult.success) {
						// 使用应用内 toast，避免原生 alert 打断桌面交互
						showNotice(connectResult.message || t("feishu.link.connectFailed"), 5000, "error");
						return;
					}
				}
				if (!activeSessionId) {
					showNotice(t("feishu.link.noActiveSession"), 4000, "error");
					return;
				}
				const bindResult = await onSetSessionBot(activeSessionId, botId);
				if (bindResult && bindResult.success === false) {
					showNotice(bindResult.message || t("feishu.link.bindFailed"), 6500, "error");
					return;
				}
				window.setTimeout(() => setOpen(false), 180);
			} finally {
				window.setTimeout(() => setSelectingBotId(null), 180);
			}
		},
		[activeBotId, activeSessionId, onConnectByBot, onSetSessionBot],
	);

	const handleClearSessionBot = useCallback(async () => {
		if (activeSessionId) {
			await onSetSessionBot(activeSessionId, null);
		}
		setOpen(false);
	}, [activeSessionId, onSetSessionBot]);

	if (!hasBots) return null;

	const statusClass = connecting ? "connecting" : sessionConnected ? "connected" : "disconnected";

	const statusText = sessionConnected ? t("feishu.link.sessionConnected") : connecting ? t("feishu.link.connectingShort") : t("feishu.link.disconnectedShort");

	return (
		<div className="feishu-link-indicator">
			<button
				ref={triggerRef}
				type="button"
				className={`feishu-link-trigger ${statusClass}${open ? " open" : ""}`}
				onClick={() => setOpen((prev) => !prev)}
				title={sessionConnected && sessionBot ? t("feishu.link.triggerConnectedTitle", { name: sessionBot.name }) : t("feishu.link.triggerDisconnectedTitle")}
				aria-label={t("feishu.link.ariaLabel")}
				aria-expanded={open}
				aria-haspopup="menu"
			>
				<span className={`feishu-link-logo ${statusClass}`} aria-hidden="true">
					<FeishuLogo />
				</span>
			</button>

			{open &&
				anchor &&
				createPortal(
					<div
						ref={popoverRef}
						className="feishu-link-popover"
						role="menu"
						style={{
							position: "fixed",
							left: anchor.left,
							// 底边固定在 trigger 顶部上方 8px：用 bottom 定位无需测量 popover 自身高度
							bottom: window.innerHeight - anchor.top + 8,
						}}
					>
						<div className="feishu-link-popover-header">
							<div className="feishu-link-popover-heading">
								<span className={`feishu-link-logo ${statusClass}`} aria-hidden="true">
									<FeishuLogo />
								</span>
								<div className="feishu-link-popover-heading-text">
									<strong>{t("feishu.link.popoverTitle")}</strong>
									<span>
										{statusText}
										{sessionBot ? ` · ${sessionBot.name}` : ""}
									</span>
								</div>
							</div>
							{sessionBotId && (
								<button type="button" className="feishu-link-popover-action" onClick={handleClearSessionBot} disabled={connecting}>
									{t("feishu.link.disconnectSession")}
								</button>
							)}
						</div>

						{status.errorMessage && <div className="feishu-link-popover-error">{status.errorMessage}</div>}

						<div className="feishu-link-popover-list">
							{bots.map((bot) => {
								const isActive = bot.id === activeBotId;
								const isSessionPinned = bot.id === sessionBotId;
								const isSessionConnectedBot = isActive && isSessionPinned;
								const isSelecting = selectingBotId === bot.id;
								return (
									<button key={bot.id} type="button" className={`feishu-link-bot-item${isSessionConnectedBot ? " active" : ""}${isSessionPinned && !isActive ? " pinned" : ""}`} onClick={() => handleSelectBot(bot.id)} disabled={connecting || Boolean(selectingBotId)} role="menuitem">
										<div className="feishu-link-bot-info">
											<span className="feishu-link-bot-name">{bot.name}</span>
											<span className="feishu-link-bot-meta">{isSelecting ? t("feishu.link.connectingShort") : isSessionConnectedBot ? t("feishu.link.sessionConnected") : isActive ? t("feishu.link.globalOnline") : isSessionPinned ? t("feishu.link.sessionNotConnected") : bot.appId}</span>
										</div>
										{(isSelecting || isSessionConnectedBot || isSessionPinned) && (
											<span className="feishu-link-bot-check" aria-hidden="true">
												{isSelecting ? <span className="feishu-link-spinner animate-pideck-spin" /> : "✓"}
											</span>
										)}
									</button>
								);
							})}
						</div>

						{!sessionConnected && <div className="feishu-link-popover-hint">{t("feishu.link.selectHint")}</div>}
					</div>,
					document.body,
				)}
		</div>
	);
}
