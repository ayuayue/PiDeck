/**
 * useFeishuBridge — 飞书桥接状态 Hook
 *
 * 封装 IPC 调用 + 状态订阅，供前端组件使用。
 * 通过 window.piDesktop.feishu.* API 与主进程通信。
 */

import { useState, useEffect, useCallback } from "react";
import type { FeishuBotConfig, FeishuBridgeStatus, FeishuChatBinding, FeishuChatMessage, FeishuConnectInput, FeishuSessionBotResult, FeishuTestResult } from "../../../shared/types";
import { t } from "../i18n";

type PiDesktopFeishuApi = {
	connect: (input: FeishuConnectInput) => Promise<{ success: boolean; message: string }>;
	/** 临时连接（不保存配置），返回 botInfo 用于后续保存 */
	connectTemp: (input: FeishuConnectInput) => Promise<{ success: boolean; message: string; botInfo?: { id: string; name: string } }>;
	disconnect: () => Promise<{ success: boolean }>;
	connectByBot: (botId: string) => Promise<{ success: boolean; message: string }>;
	statusRequest: () => Promise<FeishuBridgeStatus>;
	onStatus: (callback: (status: FeishuBridgeStatus) => void) => () => void;
	botsList: () => Promise<FeishuBotConfig[]>;
	botAdd: (input: FeishuConnectInput) => Promise<{ success: boolean; bot?: FeishuBotConfig; error?: string }>;
	botRemove: (botId: string) => Promise<boolean>;
	botConfig: (botId: string, patch: Partial<FeishuBotConfig>) => Promise<FeishuBotConfig | undefined>;
	testConnection: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	bindingsList: () => Promise<FeishuChatBinding[]>;
	bindingRemove: (chatId: string) => Promise<boolean>;
	bindingUpdate: (chatId: string, patch: Partial<FeishuChatBinding>) => Promise<FeishuChatBinding | undefined>;
	onMessages: (callback: (message: FeishuChatMessage) => void) => () => void;
	onBindingsChanged: (callback: (bindings: FeishuChatBinding[]) => void) => () => void;
	onBotsChanged: (callback: (bots: FeishuBotConfig[]) => void) => () => void;
	onWhoamiResult: (callback: (openId: string) => void) => () => void;
	sessionBotGet: (sessionId: string) => Promise<string | null>;
	sessionBotSet: (sessionId: string, botId: string | null) => Promise<FeishuSessionBotResult>;
};

function getApi(): PiDesktopFeishuApi | undefined {
	return (window as unknown as { piDesktop?: { feishu?: PiDesktopFeishuApi } }).piDesktop?.feishu;
}

export function retainBoundSessionBots(current: Record<string, string>, bindings: FeishuChatBinding[]): Record<string, string> {
	const boundSessionIds = new Set(bindings.map((binding) => binding.sessionId));
	return Object.fromEntries(Object.entries(current).filter(([sessionId]) => boundSessionIds.has(sessionId)));
}

export function applySessionBotAssignment(current: Record<string, string>, sessionId: string, botId: string | null, result: FeishuSessionBotResult): Record<string, string> {
	if (!result.success) return current;
	if (botId) return { ...current, [sessionId]: botId };
	const next = { ...current };
	delete next[sessionId];
	return next;
}

export function useFeishuBridge() {
	const [status, setStatus] = useState<FeishuBridgeStatus>({ status: "disconnected", activeBindings: 0 });
	const [bots, setBots] = useState<FeishuBotConfig[]>([]);
	const [bindings, setBindings] = useState<FeishuChatBinding[]>([]);
	const [messages, setMessages] = useState<FeishuChatMessage[]>([]);
	const [connecting, setConnecting] = useState(false);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 当前连接的 Bot ID，从 status 的 botId 或通过 activeBotId 跟踪 */
	const [activeBotId, setActiveBotId] = useState<string | undefined>(undefined);
	/** Stable Session → Bot 映射缓存 */
	const [sessionBotMap, setSessionBotMap] = useState<Record<string, string>>({});

	const api = getApi();

	// 初始状态加载
	useEffect(() => {
		if (!api) return;

		void (async () => {
			try {
				const [s, b, bi] = await Promise.all([api.statusRequest(), api.botsList(), api.bindingsList()]);
				setStatus(s);
				setActiveBotId(s.botId);
				setBots(b);
				setBindings(bi);
			} catch (e) {
				console.error("[Feishu] Failed to load bridge state", e);
			}
		})();
	}, [api]);

	// 状态推送订阅
	useEffect(() => {
		if (!api) return;
		return api.onStatus((nextStatus) => {
			setStatus(nextStatus);
			setActiveBotId(nextStatus.botId);
		});
	}, [api]);

	// 消息推送订阅
	useEffect(() => {
		if (!api) return;
		return api.onMessages((msg) => {
			setMessages((prev) => [...prev.slice(-99), msg]);
		});
	}, [api]);

	// 绑定列表变更推送
	useEffect(() => {
		if (!api) return;
		return api.onBindingsChanged((bi) => {
			setBindings(bi);
			// 绑定列表变更时，同步清理 sessionBotMap 中已失效的条目：
			// 某个会话的绑定被移除（如从配置页断开关联）后，
			// 其 stable sessionId 不再出现在 bindings 中，应在内存缓存中同步清除。
			// 否则 getSessionBot 会命中旧缓存，UI 仍显示「已连接」。
			setSessionBotMap((prev) => retainBoundSessionBots(prev, bi));
		});
	}, [api]);

	// Bot 配置变更推送：配置页增删改 Bot 后，会话下拉等使用同一 hook 的组件自动同步。
	useEffect(() => {
		if (!api) return;
		return api.onBotsChanged((nextBots) => {
			setBots(nextBots);
			setActiveBotId((current) => (current && nextBots.some((b) => b.id === current) ? current : undefined));
			setSessionBotMap((current) => {
				const aliveIds = new Set(nextBots.map((b) => b.id));
				const next: Record<string, string> = {};
				for (const [sessionId, botId] of Object.entries(current)) {
					if (aliveIds.has(botId)) next[sessionId] = botId;
				}
				return next;
			});
		});
	}, [api]);

	/**
	 * 读取某个稳定 Session 的 Bot 分配
	 */
	const getSessionBot = useCallback(
		async (sessionId: string): Promise<string | undefined> => {
			if (!api) return undefined;
			// 先查缓存
			if (sessionBotMap[sessionId]) return sessionBotMap[sessionId];
			const botId = await api.sessionBotGet(sessionId);
			if (botId) {
				setSessionBotMap((prev) => ({ ...prev, [sessionId]: botId }));
			}
			return botId ?? undefined;
		},
		[api, sessionBotMap],
	);

	/**
	 * 设置某个稳定 Session 使用的 Bot ID
	 */
	const setSessionBot = useCallback(
		async (sessionId: string, botId: string | null) => {
			if (!api) return { success: false, message: t("feishu.apiUnavailable") };
			const result = await api.sessionBotSet(sessionId, botId);
			// 仅在主进程真正绑定成功后更新本地映射，避免 UI 假阳性“已连接”。
			setSessionBotMap((prev) => applySessionBotAssignment(prev, sessionId, botId, result));
			return result;
		},
		[api],
	);

	const connectTemp = useCallback(
		async (input: FeishuConnectInput) => {
			if (!api) return { success: false, message: t("feishu.apiUnavailable") };
			setConnecting(true);
			setError(null);
			try {
				const result = await api.connectTemp(input);
				return result;
			} catch (e) {
				console.error("[Feishu] Temporary connection failed", e);
				const msg = t("config.im.connectFailed");
				setError(msg);
				return { success: false, message: msg };
			} finally {
				setConnecting(false);
			}
		},
		[api],
	);

	const connect = useCallback(
		async (input: FeishuConnectInput) => {
			if (!api) return { success: false, message: t("feishu.apiUnavailable") };
			setConnecting(true);
			setError(null);
			try {
				const result = await api.connect(input);
				if (result.success) {
					const [b, bi] = await Promise.all([api.botsList(), api.bindingsList()]);
					setBots(b);
					setBindings(bi);
				} else {
					setError(result.message);
				}
				return result;
			} catch (e) {
				console.error("[Feishu] Connection failed", e);
				const msg = t("config.im.connectFailed");
				setError(msg);
				return { success: false, message: msg };
			} finally {
				setConnecting(false);
			}
		},
		[api],
	);

	/**
	 * 使用已保存的 Bot 配置连接（自动解密 Secret）
	 */
	const connectByBot = useCallback(
		async (botId: string) => {
			if (!api) return { success: false, message: t("feishu.apiUnavailable") };
			setConnecting(true);
			setError(null);
			try {
				const result = await api.connectByBot(botId);
				if (result.success) {
					setActiveBotId(botId);
					const [s, b, bi] = await Promise.all([api.statusRequest(), api.botsList(), api.bindingsList()]);
					setStatus(s);
					setBots(b);
					setBindings(bi);
				} else {
					setError(result.message);
				}
				return result;
			} catch (e) {
				console.error("[Feishu] Saved Bot connection failed", e);
				const msg = t("config.im.connectFailed");
				setError(msg);
				return { success: false, message: msg };
			} finally {
				setConnecting(false);
			}
		},
		[api],
	);

	const disconnect = useCallback(async () => {
		if (!api) return;
		await api.disconnect();
		setBindings([]);
		setActiveBotId(undefined);
	}, [api]);

	const addBot = useCallback(
		async (input: FeishuConnectInput) => {
			if (!api) return { success: false, error: t("feishu.apiUnavailable") };
			const result = await api.botAdd(input);
			if (result.success) {
				setBots((prev) => [...prev, result.bot!]);
			}
			return result;
		},
		[api],
	);

	const removeBot = useCallback(
		async (botId: string) => {
			if (!api) return false;
			const ok = await api.botRemove(botId);
			if (ok) {
				setBots((prev) => prev.filter((b) => b.id !== botId));
				if (activeBotId === botId) {
					setActiveBotId(undefined);
				}
			}
			return ok;
		},
		[api, activeBotId],
	);

	const updateBotConfig = useCallback(
		async (botId: string, patch: Partial<FeishuBotConfig>) => {
			if (!api) return undefined;
			const updated = await api.botConfig(botId, patch);
			if (updated) {
				setBots((prev) => prev.map((b) => (b.id === botId ? updated : b)));
			}
			return updated;
		},
		[api],
	);

	const testConnection = useCallback(
		async (appId: string, appSecret: string) => {
			if (!api) return { success: false, message: t("feishu.apiUnavailable") };
			setTesting(true);
			try {
				return await api.testConnection(appId, appSecret);
			} catch (e) {
				console.error("[Feishu] Connection test failed", e);
				return { success: false, message: t("config.im.testFailed") };
			} finally {
				setTesting(false);
			}
		},
		[api],
	);

	const removeBinding = useCallback(
		async (chatId: string) => {
			if (!api) return false;
			const ok = await api.bindingRemove(chatId);
			if (ok) {
				setBindings((prev) => prev.filter((b) => b.chatId !== chatId));
			}
			return ok;
		},
		[api],
	);

	const refreshBindings = useCallback(async () => {
		if (!api) return;
		const bi = await api.bindingsList();
		setBindings(bi);
	}, [api]);

	// 判断当前状态
	const isConnected = status.status === "connected";
	const isConnecting = status.status === "connecting";
	const hasConfig = bots.length > 0;

	return {
		status,
		bots,
		bindings,
		messages,
		connecting,
		testing,
		error,
		isConnected,
		isConnecting,
		hasConfig,
		activeBotId,
		connect,
		connectTemp,
		connectByBot,
		disconnect,
		addBot,
		removeBot,
		updateBotConfig,
		testConnection,
		removeBinding,
		refreshBindings,
		getSessionBot,
		setSessionBot,
		clearError: () => setError(null),
	};
}
