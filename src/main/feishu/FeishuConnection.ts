/**
 * FeishuConnection — 飞书长连接生命周期管理。
 * Phase 4: 从 FeishuBridge.ts 中提取，管理 LarkClient + WebSocket 的创建/启停/测试。
 */

import type { FeishuBotConfig, FeishuTestResult } from "../../shared/types";
import type { LarkSDK, LarkClient, FeishuCardActionEvent } from "./types";
import { feishuT, type FeishuLocale } from "./FeishuI18n";
import { getDecryptedBotAppSecret } from "./FeishuConfig";
import { getAppLogger } from "../logging/sharedLogger";

/** 包装约定（AGENTS.md：日志走主进程 logging 模块）：所有出口必须同时落 appLogger
 *  （feishu scope）——打包版主进程的 stdout 不落盘，console-only 会让长连接断开
 *  （WSClient onError）、消息处理异常等关键故障在诊断报告里不可见。console 保留供
 *  dev 终端直接可见；EPIPE 兑底仅保护 console 侧（appLogger 落盘不经 stdout）。 */
const toAppLog = (level: "info" | "warn" | "error", args: unknown[]) => {
	const [first, ...rest] = args;
	const message = first instanceof Error ? first.message : String(first ?? "");
	const detail = rest.length === 1 ? rest[0] : rest.length > 0 ? rest : undefined;
	getAppLogger()?.[level]("feishu", message, detail);
};
const log = (...args: unknown[]) => {
	toAppLog("info", args);
	try {
		console.log(...args);
	} catch {
		/* EPIPE */
	}
};
const warn = (...args: unknown[]) => {
	toAppLog("warn", args);
	try {
		console.warn(...args);
	} catch {
		/* EPIPE */
	}
};
const logErr = (...args: unknown[]) => {
	toAppLog("error", args);
	try {
		console.error(...args);
	} catch {
		/* EPIPE */
	}
};

export class FeishuConnection {
	private wsClient: unknown = null;
	client: LarkClient | null = null;

	constructor(
		private botConfig: FeishuBotConfig,
		private plainAppSecret: string | undefined,
		private locale: FeishuLocale,
	) {}

	/** 创建 LarkClient + WebSocket，返回事件处理函数引用。 */
	async start(onRawMessage: (data: Record<string, unknown>) => Promise<void>, onCardAction: (event: FeishuCardActionEvent) => Promise<void>): Promise<{ botOpenId: string | null }> {
		const { appId } = this.botConfig;
		const plainSecret = this.plainAppSecret ?? getDecryptedBotAppSecret(this.botConfig.id);
		if (!appId || !plainSecret) throw new Error(feishuT(this.locale, "bridge.configRequired"));

		try {
			const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkSDK;
			this.client = new lark.Client({
				appId,
				appSecret: plainSecret,
				appType: lark.AppType.SelfBuild,
				domain: lark.Domain.Feishu,
				loggerLevel: lark.LoggerLevel.error,
			} as Record<string, unknown>) as LarkClient;

			let botOpenId: string | null = null;
			try {
				const botInfoResp = await this.client.request<{
					code?: number;
					bot?: { open_id?: string; app_name?: string };
					data?: { bot?: { open_id?: string; app_name?: string } };
				}>({ method: "GET", url: "https://open.feishu.cn/open-apis/bot/v3/info/" });
				botOpenId = botInfoResp?.bot?.open_id ?? botInfoResp?.data?.bot?.open_id ?? null;
				if (botOpenId) {
					log(`[飞书 Bridge] Bot 自身 open_id: ${botOpenId}`);
					if (this.botConfig.defaultUserOpenId === botOpenId) {
						warn(`[飞书 Bridge] ⚠️ 配置中的 defaultUserOpenId 是 Bot 自己的 open_id，不是你的！`);
						warn(`[飞书 Bridge] 💡 请在飞书中给 Bot 发送 /whoami 获取你的真实 open_id，然后填入配置`);
					}
				}
			} catch (e) {
				warn("[飞书 Bridge] 获取 Bot info 失败（非致命）:", e);
			}

			const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
				"im.message.receive_v1": async (data: unknown) => {
					await onRawMessage(data as Record<string, unknown>).catch((err) => logErr("[飞书 Bridge] handleRawMessage 异常:", err));
				},
				"card.action.trigger": async (data: unknown) => {
					const event = lark.normalizeCardAction(data as Record<string, unknown>, { includeRaw: true });
					if (event) await onCardAction(event);
				},
				"im.message.reaction.created_v1": async () => {},
				"im.chat.member.bot.added_v1": async () => {},
			});

			const ws = new lark.WSClient({
				appId,
				appSecret: plainSecret,
				domain: lark.Domain.Feishu,
				loggerLevel: lark.LoggerLevel.error,
				onError: (wsErr: unknown) => {
					logErr("[飞书 Bridge] WSClient 连接异常:", wsErr);
				},
			});
			this.wsClient = ws;
			ws.start({ eventDispatcher: dispatcher });
			// 对外建立常驻长连接（带机器人凭据），起停必须落应用日志而不只是 console
			getAppLogger()?.info("feishu", "Feishu connection started", { appId });
			log("[飞书 Bridge] WSClient 已启动");

			return { botOpenId };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const message = feishuT(this.locale, "connection.failed");
			getAppLogger()?.error("feishu", "Feishu connection start failed", { appId, error: detail });
			logErr("[飞书 Bridge] 启动失败:", detail);
			throw new Error(message + " (" + detail + ")", { cause: error });
		}
	}

	stop(): void {
		const ws = this.wsClient as { stop?: () => void } | null;
		if (ws?.stop)
			try {
				ws.stop();
			} catch {}
		this.wsClient = null;
		this.client = null;
		getAppLogger()?.info("feishu", "Feishu connection stopped", { appId: this.botConfig.appId });
		log("[Feishu Bridge] stopped");
	}

	async testConnection(appId: string, appSecret: string): Promise<FeishuTestResult> {
		try {
			const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkSDK;
			const client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild } as Record<string, unknown>) as LarkClient;
			const resp = await client.auth.tenantAccessToken.internal({ data: { app_id: appId, app_secret: appSecret } });
			if ((resp as Record<string, unknown>).code === 0) return { success: true, message: feishuT(this.locale, "connection.success"), botName: `App ${appId.slice(0, 8)}...` };
			logErr("[飞书 Bridge] 连接测试 API 校验失败:", resp);
			return { success: false, message: feishuT(this.locale, "connection.apiFailed") };
		} catch (error) {
			logErr("[飞书 Bridge] 连接测试失败:", error);
			return { success: false, message: feishuT(this.locale, "connection.failed") };
		}
	}
}
