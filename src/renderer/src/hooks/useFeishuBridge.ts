/**
 * useFeishuBridge — 飞书桥接状态 Hook
 *
 * 封装 IPC 调用 + 状态订阅，供前端组件使用。
 * 通过 window.piDesktop.feishu.* API 与主进程通信。
 */

import { useState, useEffect, useCallback } from "react";
import type {
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuChatMessage,
	FeishuConnectInput,
	FeishuTestResult,
} from "../../../shared/types";

type PiDesktopFeishuApi = {
	connect: (input: FeishuConnectInput) => Promise<{ success: boolean; message: string }>;
	disconnect: () => Promise<{ success: boolean }>;
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
};

function getApi(): PiDesktopFeishuApi | undefined {
	return (window as unknown as { piDesktop?: { feishu?: PiDesktopFeishuApi } }).piDesktop?.feishu;
}

export function useFeishuBridge() {
	const [status, setStatus] = useState<FeishuBridgeStatus>({ status: "disconnected", activeBindings: 0 });
	const [bots, setBots] = useState<FeishuBotConfig[]>([]);
	const [bindings, setBindings] = useState<FeishuChatBinding[]>([]);
	const [messages, setMessages] = useState<FeishuChatMessage[]>([]);
	const [connecting, setConnecting] = useState(false);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const api = getApi();

	// 初始状态加载
	useEffect(() => {
		if (!api) return;

		void (async () => {
			try {
				const [s, b, bi] = await Promise.all([
					api.statusRequest(),
					api.botsList(),
					api.bindingsList(),
				]);
				setStatus(s);
				setBots(b);
				setBindings(bi);
			} catch (e) {
				console.error("飞书状态加载失败:", e);
			}
		})();
	}, [api]);

	// 状态推送订阅
	useEffect(() => {
		if (!api) return;
		return api.onStatus(setStatus);
	}, [api]);

	// 消息推送订阅
	useEffect(() => {
		if (!api) return;
		return api.onMessages((msg) => {
			setMessages((prev) => [...prev.slice(-99), msg]);
		});
	}, [api]);

	const connect = useCallback(async (input: FeishuConnectInput) => {
		if (!api) return { success: false, message: "API 未就绪" };
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
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			return { success: false, message: msg };
		} finally {
			setConnecting(false);
		}
	}, [api]);

	const disconnect = useCallback(async () => {
		if (!api) return;
		await api.disconnect();
		setBindings([]);
	}, [api]);

	const addBot = useCallback(async (input: FeishuConnectInput) => {
		if (!api) return { success: false, error: "API 未就绪" };
		const result = await api.botAdd(input);
		if (result.success) {
			setBots((prev) => [...prev, result.bot!]);
		}
		return result;
	}, [api]);

	const removeBot = useCallback(async (botId: string) => {
		if (!api) return false;
		const ok = await api.botRemove(botId);
		if (ok) {
			setBots((prev) => prev.filter((b) => b.id !== botId));
		}
		return ok;
	}, [api]);

	const updateBotConfig = useCallback(async (botId: string, patch: Partial<FeishuBotConfig>) => {
		if (!api) return undefined;
		const updated = await api.botConfig(botId, patch);
		if (updated) {
			setBots((prev) => prev.map((b) => (b.id === botId ? updated : b)));
		}
		return updated;
	}, [api]);

	const testConnection = useCallback(async (appId: string, appSecret: string) => {
		if (!api) return { success: false, message: "API 未就绪" };
		setTesting(true);
		try {
			return await api.testConnection(appId, appSecret);
		} finally {
			setTesting(false);
		}
	}, [api]);

	const removeBinding = useCallback(async (chatId: string) => {
		if (!api) return false;
		const ok = await api.bindingRemove(chatId);
		if (ok) {
			setBindings((prev) => prev.filter((b) => b.chatId !== chatId));
		}
		return ok;
	}, [api]);

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
		connect,
		disconnect,
		addBot,
		removeBot,
		updateBotConfig,
		testConnection,
		removeBinding,
		refreshBindings,
		clearError: () => setError(null),
	};
}
