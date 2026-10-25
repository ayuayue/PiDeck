import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { FeishuBridge, type SessionRuntimeBindingGateway } from "../feishu/FeishuBridge";
import { listBots, getBot, addBot as addFeishuBot, removeBot as removeFeishuBot, updateBot as updateFeishuBot, getDecryptedBotAppSecret, getSessionBotId, setSessionBotId } from "../feishu/FeishuConfig";
import { feishuT, type FeishuLocale } from "../feishu/FeishuI18n";
import type { FeishuBotConfig, FeishuBridgeStatus, FeishuChatBinding, FeishuConnectInput } from "../../shared/types/feishu";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { ipcChannels } from "../../shared/ipc";
import { getAppLogger } from "../logging/sharedLogger";

/**
 * 飞书域 IPC 注册（自 src/main/index.ts registerFeishuIpc 迁出，2027-02）。
 * 处理器逻辑保持原样；feishuBridge 是跨域可变单例，经 ref 对象共享，
 * 停止/重建路径（临时连接、正式连接、按 Bot 重连、删除 Bot）仍由这里驱动。
 */
export interface FeishuIpcDeps {
	getMainWindow(): BrowserWindow | null;
	/** 跨域共享的 bridge 实例槽位（index.ts 持有同一对象：退出清理/setLocale/会话绑定查询都读它）。 */
	feishuBridgeRef: { current: FeishuBridge | null };
	agentManager: AgentManager;
	projectStore: ProjectStore;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	feishuSessionRuntimeBindings: SessionRuntimeBindingGateway;
	/** 当前飞书文案 locale（由 index.ts 的 currentFeishuLocale 提供，读设置与系统语言）。 */
	getCurrentLocale(): FeishuLocale;
}

export function registerFeishuIpc(deps: FeishuIpcDeps): void {
	const { feishuBridgeRef } = deps;

	/** Bot 配置变更后主动推送给 renderer，保证多个页面/弹窗中的 Bot 列表实时同步。 */
	function broadcastBotsChanged() {
		const mainWindow = deps.getMainWindow();
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.send(ipcChannels.feishuBotsChanged, listBots());
	}

	function logger() {
		return getAppLogger();
	}

	// 临时连接（不保存 bot 配置），用于添加 Bot 时先验证凭证可用性
	ipcMain.handle(ipcChannels.feishuConnectTemp, async (_event, input: FeishuConnectInput) => {
		const appId = input.appId?.trim() ?? "";
		const appSecret = input.appSecret?.trim() ?? "";
		void logger()?.info("feishu", "temp connect requested", { appId: appId ? appId.slice(0, 8) : "", name: input.name, hasSecret: Boolean(appSecret) });
		try {
			if (!appId || !appSecret) {
				return { success: false, message: feishuT(deps.getCurrentLocale(), "bridge.configRequired") };
			}
			if (feishuBridgeRef.current) {
				feishuBridgeRef.current.stop();
			}
			// 临时构造 botConfig，不做持久化；明文 secret 只传给当前 bridge，不写入磁盘。
			const botConfig: FeishuBotConfig = {
				id: "temp-" + randomUUID(),
				name: input.name?.trim() || feishuT(deps.getCurrentLocale(), "bridge.tempBotName"),
				enabled: true,
				appId,
				appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			};
			feishuBridgeRef.current = new FeishuBridge(
				botConfig,
				deps.agentManager,
				() => deps.getMainWindow(),
				() => deps.projectStore.list(),
				deps.feishuSessionRuntimeBindings,
				appSecret,
				deps.getCurrentLocale(),
			);
			await feishuBridgeRef.current.start();
			const status = feishuBridgeRef.current.getStatus();
			void logger()?.info("feishu", "temp connect ok", { status });
			return {
				success: true,
				message: feishuT(deps.getCurrentLocale(), "connection.success"),
				botInfo: { id: botConfig.id, name: botConfig.name },
			};
		} catch (error) {
			const detail = error instanceof Error ? ((error as Error & { cause?: unknown }).cause ?? error.message) : String(error);
			const message = error instanceof Error ? error.message : String(error);
			void logger()?.error("feishu", "temp connect failed", { detail });
			return { success: false, message, detail: String(detail) };
		}
	});

	// 连接飞书（保存 bot）
	ipcMain.handle(ipcChannels.feishuConnect, async (_event, input: FeishuConnectInput) => {
		void logger()?.info("feishu", "connect requested", { appId: input.appId?.slice(0, 8), name: input.name });
		try {
			if (feishuBridgeRef.current) {
				void logger()?.info("feishu", "stopping previous bridge", { previousStatus: feishuBridgeRef.current.getStatus() });
				feishuBridgeRef.current.stop();
			}

			// 先建立临时配置，不持久化；连接成功后再存盘
			const plainAppSecret = input.appSecret;
			const tempId = "pending-" + randomUUID();

			feishuBridgeRef.current = new FeishuBridge(
				{
					id: tempId,
					name: input.name || feishuT(deps.getCurrentLocale(), "bridge.defaultBotName"),
					enabled: true,
					appId: input.appId,
					appSecret: "",
					defaultUserOpenId: input.defaultUserOpenId,
				},
				deps.agentManager,
				() => deps.getMainWindow(),
				() => deps.projectStore.list(),
				deps.feishuSessionRuntimeBindings,
				plainAppSecret,
				deps.getCurrentLocale(),
			);
			await feishuBridgeRef.current.start();

			// 连接成功后再持久化
			const botConfig = addFeishuBot({
				name: input.name || feishuT(deps.getCurrentLocale(), "bridge.defaultBotName"),
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});
			feishuBridgeRef.current.updateBotConfig({ id: botConfig.id });

			void logger()?.info("feishu", "connect ok", { status: feishuBridgeRef.current.getStatus() });
			void logger()?.info("feishu", "Feishu connected", { botId: botConfig.id, name: botConfig.name });
			broadcastBotsChanged();
			return { success: true, message: feishuT(deps.getCurrentLocale(), "connection.success") };
		} catch (error) {
			const detail = error instanceof Error ? ((error as Error & { cause?: unknown }).cause ?? error.message) : String(error);
			const message = error instanceof Error ? error.message : String(error);
			void logger()?.error("feishu", "connect failed", { detail });
			void logger()?.error("feishu", "Feishu connect failed", error);
			// 返回详细错误信息（包含原始错误说明），供前端展示
			return { success: false, message, detail: String(detail) };
		}
	});

	// 断开连接
	ipcMain.handle(ipcChannels.feishuDisconnect, async () => {
		if (feishuBridgeRef.current) {
			void logger()?.info("feishu", "disconnecting bridge", { previousStatus: feishuBridgeRef.current.getStatus() });
			feishuBridgeRef.current.stop();
			feishuBridgeRef.current = null;
		}
		void logger()?.info("feishu", "Feishu disconnected");
		return { success: true };
	});

	// 查询状态
	ipcMain.handle(ipcChannels.feishuStatusRequest, async () => {
		if (feishuBridgeRef.current) {
			const s = feishuBridgeRef.current.getStatus();
			void logger()?.info("feishu", "status query", { status: s });
			return s;
		}
		void logger()?.info("feishu", "status query: bridge null, returning disconnected");
		return { status: "disconnected", activeBindings: 0 } as FeishuBridgeStatus;
	});

	// Bot 列表
	ipcMain.handle(ipcChannels.feishuBotsList, async () => {
		return listBots();
	});

	// 添加 Bot
	ipcMain.handle(ipcChannels.feishuBotAdd, async (_event, input: FeishuConnectInput) => {
		// 同 feishuConnect，但可以添加多个 Bot
		try {
			const botConfig = addFeishuBot({
				name: input.name || feishuT(deps.getCurrentLocale(), "bridge.defaultBotName"),
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});
			void logger()?.info("feishu", "Feishu bot added", { botId: botConfig.id, name: botConfig.name });
			broadcastBotsChanged();
			return { success: true, bot: { ...botConfig, appSecret: "" } };
		} catch (error) {
			void logger()?.warn("feishu", "Failed to add Feishu bot", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { success: false, error: feishuT(deps.getCurrentLocale(), "bridge.botAddFailed") };
		}
	});

	// 删除 Bot
	ipcMain.handle(ipcChannels.feishuBotRemove, async (_event, botId: string) => {
		if (feishuBridgeRef.current) {
			feishuBridgeRef.current.stop();
			feishuBridgeRef.current = null;
		}
		const result = removeFeishuBot(botId);
		if (result) {
			broadcastBotsChanged();
		}
		void logger()?.info("feishu", "Feishu bot removed", { botId });
		return result;
	});

	// 更新 Bot 配置
	ipcMain.handle(ipcChannels.feishuBotConfig, async (_event, botId: string, patch: Partial<FeishuBotConfig>) => {
		// 渲染层数据一律不可信：后端枚举在边界拦掉，不让非法值流进配置层。
		if (patch.backend !== undefined && patch.backend !== "pi" && patch.backend !== "dsh") {
			void logger()?.warn("feishu", "Rejected feishu bot backend", { botId, backend: patch.backend });
			return undefined;
		}
		const updated = updateFeishuBot(botId, patch);
		void logger()?.info("feishu", "Feishu bot config updated", { botId, keys: Object.keys(patch) });
		// 只热更新当前在线 Bot；修改其它 Bot 配置不应污染正在运行的 bridge。
		// appSecret 一律剥离：密文已入库，运行时内存不需要第二份（bridge 连接时
		// 经 getDecryptedBotAppSecret 现取），避免密钥生命周期超出必要范围。
		if (feishuBridgeRef.current && feishuBridgeRef.current.getStatus().status === "connected" && feishuBridgeRef.current.getStatus().botId === botId) {
			const { appSecret: _stripped, ...hotPatch } = patch;
			feishuBridgeRef.current.updateBotConfig(hotPatch);
			void logger()?.info("feishu", "bot config hot-reloaded", { botId, keys: Object.keys(patch).join(", ") });
		}
		if (updated) {
			broadcastBotsChanged();
		}
		return updated ? { ...updated, appSecret: "" } : undefined;
	});

	// 返回解密后的 Secret，仅用于用户主动复制/查看凭证。
	ipcMain.handle(ipcChannels.feishuBotSecret, async (_event, botId: string) => {
		return getDecryptedBotAppSecret(botId);
	});

	// 测试连接
	ipcMain.handle(ipcChannels.feishuTestConnection, async (_event, appId: string, appSecret: string) => {
		// 创建临时 bridge 实例来测试连接
		const testBridge = new FeishuBridge(
			{
				id: "test",
				name: "测试",
				enabled: true,
				appId,
				appSecret: "", // 将在 testConnection 中传入
			},
			deps.agentManager,
			() => deps.getMainWindow(),
			() => deps.projectStore.list(),
			deps.feishuSessionRuntimeBindings,
			undefined,
			deps.getCurrentLocale(),
		);
		return testBridge.testConnection(appId, appSecret);
	});

	// 绑定列表
	ipcMain.handle(ipcChannels.feishuBindingsList, async () => {
		if (feishuBridgeRef.current) {
			return feishuBridgeRef.current.listBindings();
		}
		return [];
	});

	// 移除绑定
	ipcMain.handle(ipcChannels.feishuBindingRemove, async (_event, chatId: string) => {
		if (feishuBridgeRef.current) {
			// 先查 binding 拿到 sessionId，移除后清理 session-bot 映射，
			// 使 FeishuLinkIndicator 等 UI 同步更新断开状态。
			const bindings = feishuBridgeRef.current.listBindings();
			const binding = bindings.find((b) => b.chatId === chatId);
			const result = feishuBridgeRef.current.removeBinding(chatId);
			if (result && binding) {
				setSessionBotId(binding.sessionId, undefined);
			}
			return result;
		}
		return false;
	});

	// 更新绑定
	ipcMain.handle(ipcChannels.feishuBindingUpdate, async (_event, chatId: string, patch: Partial<FeishuChatBinding>) => {
		if (feishuBridgeRef.current) {
			return feishuBridgeRef.current.updateBinding(chatId, patch);
		}
		return undefined;
	});

	// 通过已保存的 Bot ID 连接（自动解密 Secret）
	ipcMain.handle(ipcChannels.feishuConnectByBot, async (_event, botId: string) => {
		try {
			if (feishuBridgeRef.current) {
				feishuBridgeRef.current.stop();
			}
			const botConfig = getBot(botId);
			if (!botConfig) {
				return { success: false, message: feishuT(deps.getCurrentLocale(), "bridge.botMissing") };
			}
			feishuBridgeRef.current = new FeishuBridge(
				botConfig,
				deps.agentManager,
				() => deps.getMainWindow(),
				() => deps.projectStore.list(),
				deps.feishuSessionRuntimeBindings,
				undefined,
				deps.getCurrentLocale(),
			);
			await feishuBridgeRef.current.start();
			void logger()?.info("feishu", "Feishu connected by saved bot", { botId, name: botConfig.name });
			return { success: true, message: feishuT(deps.getCurrentLocale(), "connection.success") };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, message };
		}
	});

	// 获取稳定 Session 绑定的飞书 Bot ID，并一次性迁移旧 runtime agentId 键。
	ipcMain.handle(ipcChannels.feishuSessionBotGet, async (_event, sessionId: string) => {
		const current = getSessionBotId(sessionId);
		if (current) return current;
		const target = deps.sessionRuntimeCoordinator.getTarget(sessionId);
		if (!target || target.agentId === sessionId) return null;
		const legacy = getSessionBotId(target.agentId);
		if (!legacy) return null;
		setSessionBotId(sessionId, legacy);
		setSessionBotId(target.agentId, undefined);
		return legacy;
	});

	// 设置稳定 Session 使用的飞书 Bot ID。主进程始终重新解析当前 runtime，避免旧 agentId 操作替换后的会话。
	ipcMain.handle(ipcChannels.feishuSessionBotSet, async (_event, sessionId: string, botId: string | null) => {
		let target = deps.sessionRuntimeCoordinator.getTarget(sessionId);
		if (!botId) {
			setSessionBotId(sessionId, undefined);
			if (target && target.agentId !== sessionId) setSessionBotId(target.agentId, undefined);
			// 取消当前会话的飞书关联：移除绑定但不停止 Agent 进程
			if (feishuBridgeRef.current && feishuBridgeRef.current.getStatus().status === "connected") {
				feishuBridgeRef.current.removeBindingBySessionId(sessionId);
			}
			return { success: true };
		}
		const status = feishuBridgeRef.current?.getStatus();
		if (!feishuBridgeRef.current || status?.status !== "connected") {
			return { success: false, message: feishuT(deps.getCurrentLocale(), "session.bridgeUnavailable") };
		}
		if (status.botId !== botId) {
			return { success: false, message: feishuT(deps.getCurrentLocale(), "session.botMismatch") };
		}
		// 会话尚未启动 runtime（仅浏览过历史会话）：先启动 Agent 再建立飞书镜像，
		// 让「点会话连接飞书」在未启动 Agent 时也能成功；与桌面端启动走同一 activateRuntime 链路。
		if (!target) {
			try {
				await deps.feishuSessionRuntimeBindings.activateRuntime(sessionId);
				target = deps.sessionRuntimeCoordinator.getTarget(sessionId);
			} catch (error) {
				void logger()?.warn("feishu", "auto-start runtime for Feishu bind failed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (!target) {
			return { success: false, message: feishuT(deps.getCurrentLocale(), "session.runtimeUnavailable") };
		}
		// 会话后端不止 pi：DSH/ACP 的 tab 不在 pi 的 AgentManager 里。这里必须走网关的
		// 统一查找（桥接侧分发同样用它），否则「输入框飞书图标 → 选择 Bot」在
		// dsh:session-* 会话上恒定报「当前会话运行时不可用」且不留日志。
		const tab = deps.feishuSessionRuntimeBindings.findRuntimeAgent(target.agentId);
		if (!tab) {
			return { success: false, message: feishuT(deps.getCurrentLocale(), "session.runtimeUnavailable") };
		}
		const chatId = await feishuBridgeRef.current.ensureSessionMirrorForSession(sessionId, target.agentId, tab.title, tab.sessionPath);
		if (!chatId) {
			return { success: false, message: feishuT(deps.getCurrentLocale(), "session.bindFailed") };
		}
		setSessionBotId(sessionId, botId);
		if (target.agentId !== sessionId) setSessionBotId(target.agentId, undefined);
		return { success: true, chatId };
	});
}
