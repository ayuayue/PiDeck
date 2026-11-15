/**
 * bridge/commands — 飞书命令路由（/help /new /stop /status /model /sendfile /newdoc /whoami /refresh）。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：命令分诊 + 只读状态卡 + 模型选择卡 + 帮助卡。
 * 会话建立/中止、文件发送、文档创建仍留在宿主（与绑定和 runtime 网关耦合），
 * 这里只按窄接口调用它们。
 */

import type { AgentRuntimeState, AvailableModel, FeishuBridgeStatus, FeishuChatBinding } from "../../../shared/types";
import type { FeishuMessageContext } from "../types";
import { buildModelPickerCard } from "../ModelPickerCard";
import { feishuT, type FeishuLocale } from "../FeishuI18n";
import { logErr } from "./bridgeLog";

/** 协作者对宿主的最小依赖面：绑定查表 + runtime 网关 + 出站消息。 */
export type FeishuCommandsHost = {
	locale: () => FeishuLocale;
	bridgeStatus: () => FeishuBridgeStatus;
	sendSmartMessage: (chatId: string, text: string) => Promise<boolean>;
	sendCardMessage: (chatId: string, card: Record<string, unknown>) => Promise<void>;
	sendWhoamiResult: (userId: string) => void;
	createNewSession: (ctx: FeishuMessageContext) => Promise<void>;
	handleStopCommand: (ctx: FeishuMessageContext) => Promise<void>;
	doSetModel: (chatId: string, rawId: string) => Promise<void>;
	reloadBindings: () => Promise<void>;
	sendFeishuFile: (chatId: string, filePath: string) => Promise<string>;
	createFeishuDoc: (chatId: string, title: string, body?: string) => Promise<string>;
	findBinding: (chatId: string) => FeishuChatBinding | undefined;
	bindingCount: () => number;
	ensureRuntimeAgent: (binding: FeishuChatBinding) => Promise<string | undefined>;
	setRuntimeModel: (sessionId: string, provider: string, modelId: string) => Promise<void>;
	listRuntimeModels: (sessionId: string) => Promise<AvailableModel[]>;
	getRuntimeState: (sessionId: string) => Promise<AgentRuntimeState | undefined>;
	isChatBusy: (chatId: string) => boolean;
	queuedCount: (chatId: string) => number;
};

export class FeishuCommands {
	constructor(private readonly host: FeishuCommandsHost) {}

	// ===== 命令处理 =====

	async handleCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const { chatId, senderOpenId: userId } = ctx;
		const [command] = text.split(/\s+/);
		switch (command?.toLowerCase()) {
			case "/help":
			case "/h":
				await this.sendHelpCard(chatId);
				break;
			case "/new":
			case "/n":
				await this.host.createNewSession(ctx);
				break;
			case "/stop":
			case "/s":
				await this.host.handleStopCommand(ctx);
				break;
			case "/status":
				await this.handleStatusCommand(ctx);
				break;
			case "/model":
				await this.handleModelCommand(ctx, text);
				break;
			case "/sendfile": {
				const fp = text.split(/\s+/).slice(1).join(" ");
				if (!fp) {
					await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "command.sendFileUsage"));
					break;
				}
				const result = await this.host.sendFeishuFile(chatId, fp);
				await this.host.sendSmartMessage(chatId, result);
				break;
			}
			case "/newdoc": {
				const title = text.split(/\s+/).slice(1).join(" ") || feishuT(this.host.locale(), "doc.defaultTitle");
				const result = await this.host.createFeishuDoc(chatId, title);
				await this.host.sendSmartMessage(chatId, result);
				break;
			}
			case "/whoami":
				await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "command.whoami", { openId: userId }));
				// 将 open_id 推回前端，用于添加 Bot 时自动填入
				this.host.sendWhoamiResult(userId);
				break;
			case "/refresh":
			case "/r":
				await this.host.reloadBindings();
				await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "command.bindingsRefreshed", { count: this.host.bindingCount() }));
				break;
			default:
				await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "command.unknown", { command: command ?? "" }));
		}
	}

	async handleStatusCommand(ctx: FeishuMessageContext): Promise<void> {
		const binding = this.host.findBinding(ctx.chatId);
		const statusLabel = feishuT(this.host.locale(), `status.${this.host.bridgeStatus().status}` as "status.disconnected" | "status.connecting" | "status.connected" | "status.error");
		// 「桥接占用」与「后端真在跑」分开报：锁被占但后端已空闲 = 上一轮没收口就解锁失败，
		// 用户反馈的「/status 显示 running 但桌面端已回完」就是这种现场，方便确诊。
		const runtime = binding ? await this.host.getRuntimeState(binding.sessionId).catch(() => undefined) : undefined;
		const backendRunning = runtime?.isStreaming === true || runtime?.isTurnActive === true;
		const bridgeBusy = this.host.isChatBusy(ctx.chatId);
		const runState = bridgeBusy ? (backendRunning ? feishuT(this.host.locale(), "status.runRunning") : feishuT(this.host.locale(), "status.runBridgeOnly")) : backendRunning ? feishuT(this.host.locale(), "status.runBackendOnly") : feishuT(this.host.locale(), "status.runIdle");
		const queued = this.host.queuedCount(ctx.chatId);
		const lines = [
			feishuT(this.host.locale(), "status.heading"),
			feishuT(this.host.locale(), "status.status", { status: statusLabel }),
			feishuT(this.host.locale(), "status.run", { state: runState }),
			...(queued > 0 ? [feishuT(this.host.locale(), "status.queued", { count: queued })] : []),
			feishuT(this.host.locale(), "status.bindings", { count: this.host.bindingCount() }),
			binding ? feishuT(this.host.locale(), "status.session", { id: binding.sessionId.slice(0, 8) }) : feishuT(this.host.locale(), "status.sessionUnbound"),
		];
		await this.host.sendCardMessage(ctx.chatId, { config: { wide_screen_mode: true, update_multi: true }, header: { title: { tag: "plain_text", content: feishuT(this.host.locale(), "status.header") }, template: "blue" }, elements: [{ tag: "markdown", content: lines.join("\n") }] });
	}

	// ===== 模型命令 =====

	async handleModelCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const args = text.split(/\s+/).slice(1).join(" ");
		if (args) {
			await this.host.doSetModel(ctx.chatId, args);
			return;
		}
		const binding = this.host.findBinding(ctx.chatId);
		if (!binding) {
			await this.host.sendSmartMessage(ctx.chatId, feishuT(this.host.locale(), "session.notBoundCreateFirst"));
			return;
		}
		const agentId = await this.host.ensureRuntimeAgent(binding);
		if (!agentId) {
			await this.host.sendSmartMessage(ctx.chatId, feishuT(this.host.locale(), "session.runtimeUnavailable"));
			return;
		}
		const models = await this.host.listRuntimeModels(binding.sessionId).catch(() => [] as AvailableModel[]);
		if (!models.length) {
			await this.host.sendSmartMessage(ctx.chatId, feishuT(this.host.locale(), "model.unavailable"));
			return;
		}
		const state = await this.host.getRuntimeState(binding.sessionId).catch(() => undefined);
		const current = state ? `${state.provider}/${state.modelId}` : feishuT(this.host.locale(), "model.none");
		await this.host.sendCardMessage(ctx.chatId, buildModelPickerCard({ current, models, locale: this.host.locale() }));
	}

	/** 按 provider/model 设置会话模型（/model <provider>/<model> 与选择卡共用）。 */
	async doSetModel(chatId: string, rawId: string): Promise<void> {
		const parts = rawId.split("/");
		if (parts.length < 2) {
			await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "model.usage"));
			return;
		}
		const provider = parts.slice(0, -1).join("/");
		const modelId = parts[parts.length - 1];
		const binding = this.host.findBinding(chatId);
		if (!binding) {
			await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "session.notBound"));
			return;
		}
		const agentId = await this.host.ensureRuntimeAgent(binding);
		if (!agentId) {
			await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "session.runtimeUnavailable"));
			return;
		}
		try {
			await this.host.setRuntimeModel(binding.sessionId, provider, modelId);
			await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "model.switched", { model: `${provider}/${modelId}` }));
		} catch (e) {
			logErr("[飞书 Bridge] 模型切换失败:", e);
			await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "model.switchFailed"));
		}
	}

	async sendHelpCard(chatId: string): Promise<void> {
		await this.host.sendCardMessage(chatId, {
			config: { wide_screen_mode: true, update_multi: true },
			header: { title: { tag: "plain_text", content: feishuT(this.host.locale(), "help.title") }, template: "green" },
			elements: [{ tag: "markdown", content: feishuT(this.host.locale(), "help.body") }],
		});
	}
}
