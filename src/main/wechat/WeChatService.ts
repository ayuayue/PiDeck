/**
 * WeChatService — 微信桥接的领域服务：IPC 与桥接之间的唯一适配层。
 *
 * 职责边界：
 * - `WeChatBridge` 只管「已登录之后的收发」；
 * - `WeChatLogin` 只管「扫码换 token 的状态机」；
 * - 本类管两者的生命周期与落盘时机，并把状态广播给渲染层。
 *
 * 为什么需要它而不是让 IPC 直接拿 Bridge：IPC handler 只该做入参校验与适配
 * （见 AGENTS.md），而「登录成功后要 saveAccount → 重启桥接」「关开关要停轮询」
 * 这类顺序约束属于业务规则，放在 handler 里会被下一次改动绕过去。
 */

import type { BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ImChannelBackend, WeChatBindingView, WeChatBridgeStatus, WeChatLoginState, WeChatModelChainEntry, WeChatSettings } from "../../shared/types";
import type { SessionRuntimeBindingGateway } from "../sessions/sessionRuntimeBinding";
import { IlinkClient, type IlinkLogFn } from "./IlinkClient";
import { ILINK_CHANNEL_VERSION } from "./ilinkProtocol";
import { WeChatBridge } from "./WeChatBridge";
import { WeChatLogin, type WeChatLoginOutcome } from "./WeChatLogin";
import { clearAccount, getPublicAccount, getSettings, loadBindings, removeBinding, saveAccount, setDisplayName, setEnabled, updateSettings } from "./WeChatConfig";

export type WeChatServiceDeps = {
	getProjects: () => Array<{ id: string; name: string }>;
	runtimeBindings: SessionRuntimeBindingGateway;
	getLocale: () => string | undefined;
	getWindow: () => BrowserWindow | null;
	botAgent?: string;
	logger?: IlinkLogFn;
};

export class WeChatService {
	private readonly deps: WeChatServiceDeps;
	private readonly bridge: WeChatBridge;
	private login: WeChatLogin | null = null;
	private loginState: WeChatLoginState = { phase: "idle" };

	constructor(deps: WeChatServiceDeps) {
		this.deps = deps;
		this.bridge = new WeChatBridge({
			getProjects: deps.getProjects,
			runtimeBindings: deps.runtimeBindings,
			getLocale: deps.getLocale,
			botAgent: deps.botAgent,
			logger: deps.logger,
			onStatusChange: (status) => this.broadcast(ipcChannels.wechatStatus, status),
			onBindingsChange: () => this.pushBindings(),
		});
	}

	/** 应用启动时调用：已启用且已登录才真的去连，否则只登记状态。 */
	async start(): Promise<void> {
		const settings = getSettings();
		if (!settings.enabled || !settings.account) {
			this.broadcast(ipcChannels.wechatStatus, this.bridge.getStatus());
			return;
		}
		await this.bridge.start();
	}

	async stop(): Promise<void> {
		this.cancelLogin();
		await this.bridge.stop();
	}

	// ===== 设置 =====

	getSettings(): WeChatSettings {
		return getSettings();
	}

	getStatus(): WeChatBridgeStatus {
		return this.bridge.getStatus();
	}

	/**
	 * 绑定快照 + 会话当前模型。设置页据此显示「现在用的是哪个模型」——链为空时仅凭
	 * 设置里的模型链说不出模型名。
	 *
	 * 只读视图：多出来的 currentModel 按运行时现算，不写进 wechat-bindings.json。
	 */
	async bindingsWithModel(): Promise<WeChatBindingView[]> {
		const bindings = loadBindings();
		return Promise.all(
			bindings.map(async (binding) => {
				const currentModel = await this.bridge.getBindingModel(binding);
				return currentModel ? { ...binding, currentModel } : { ...binding };
			}),
		);
	}

	async setEnabled(enabled: boolean): Promise<WeChatSettings> {
		setEnabled(enabled);
		if (enabled) {
			await this.bridge.start();
		} else {
			// 关开关只停连接，保留账号与绑定：用户重新打开时不该被迫重扫。
			await this.bridge.stop();
		}
		return getSettings();
	}

	updateSettings(patch: { defaultWorkspaceId?: string; defaultModelId?: string; backend?: ImChannelBackend; modelChain?: WeChatModelChainEntry[] }): WeChatSettings {
		const settings = updateSettings(patch);
		this.bridge.refresh();
		return settings;
	}

	renameAccount(displayName: string): WeChatSettings {
		const settings = setDisplayName(displayName);
		this.bridge.refresh();
		return settings;
	}

	/** 登出：清凭据并停桥接。绑定刻意保留，重扫后能接回同一个 pi 会话。 */
	async logout(): Promise<WeChatSettings> {
		await this.bridge.stop();
		clearAccount();
		this.setLoginState({ phase: "idle" });
		this.broadcast(ipcChannels.wechatStatus, this.bridge.getStatus());
		this.pushBindings();
		return getSettings();
	}

	// ===== 扫码登录 =====

	getLoginState(): WeChatLoginState {
		return this.loginState;
	}

	/**
	 * 取二维码并开始轮询。返回时的状态一定已经带 qrcodeContent（取码失败则 phase=error），
	 * 界面据此直接渲染二维码，不需要再等一次事件。
	 */
	async beginLogin(): Promise<WeChatLoginState> {
		this.cancelLogin();
		// 未登录状态下 baseUrl 还是默认值；登录确认时服务端可能回传新域名，由状态机 setBaseUrl。
		this.login = new WeChatLogin({
			transport: new IlinkClient({ baseUrl: getPublicAccount()?.baseUrl, channelVersion: ILINK_CHANNEL_VERSION, botAgent: this.deps.botAgent ?? "PiDeck", logger: this.deps.logger }),
			onState: (state) => this.setLoginState(state),
			logger: this.deps.logger,
		});
		const prepared = await this.login.prepare();
		if (prepared.phase === "error") return prepared;

		void this.login
			.run()
			.then((result) => this.onLoginFinished(result))
			.catch((error) => {
				this.deps.logger?.("error", "扫码登录异常结束", error instanceof Error ? error.message : String(error));
				this.setLoginState({ phase: "error", error: error instanceof Error ? error.message : String(error) });
			});
		return prepared;
	}

	cancelLogin(): void {
		this.login?.cancel();
		this.login = null;
	}

	submitVerifyCode(code: string): WeChatLoginState {
		if (!this.login) return this.loginState;
		if (!this.login.submitVerifyCode(code)) {
			return this.loginState;
		}
		return this.login.getState();
	}

	private async onLoginFinished(result: WeChatLoginOutcome): Promise<void> {
		if (!result.ok) {
			if (result.error === "cancelled") this.setLoginState({ phase: "idle" });
			return;
		}
		const account = saveAccount({
			ilinkBotId: result.credentials.ilinkBotId,
			ilinkUserId: result.credentials.ilinkUserId,
			botToken: result.credentials.botToken,
			baseUrl: result.credentials.baseUrl,
		});
		this.login = null;
		this.setLoginState({ phase: "confirmed" });
		// 换了账号（或重新扫码）后必须重启桥接：轮询循环持有的是旧 token 与旧游标。
		await this.bridge.stop();
		if (account) await this.bridge.start();
		this.pushBindings();
	}

	// ===== 绑定 =====

	/** 解绑单个 chat。绑定记录刻意保留到用户手动解绑，重扫后同一个人还能接回原会话。 */
	unbindChat(chatId: string): boolean {
		const removed = removeBinding(chatId);
		if (removed) this.pushBindings();
		return removed;
	}

	removeBindingsForSession(sessionId: string): number {
		return this.bridge.removeBindingsForSession(sessionId);
	}

	refresh(): void {
		this.bridge.refresh();
	}

	// ===== 广播 =====

	/**
	 * 绑定变化推送。读运行时模型是异步的（每绑定一次 get_state），所以推送 fire-and-forget：
	 * 拿不到模型只影响展示，不能让广播失败把绑定/解绑这些业务动作带崩。
	 */
	private pushBindings(): void {
		void this.bindingsWithModel()
			.then((bindings) => this.broadcast(ipcChannels.wechatBindingsChanged, bindings))
			.catch((error) => this.deps.logger?.("warn", "微信绑定快照推送失败", error instanceof Error ? error.message : String(error)));
	}

	private setLoginState(state: WeChatLoginState): void {
		// confirmed 后二维码内容已作废，留在界面状态里会让人以为还能扫。
		this.loginState = state.phase === "confirmed" ? { phase: "confirmed" } : state;
		this.broadcast(ipcChannels.wechatLoginState, this.loginState);
	}

	private broadcast(channel: string, payload: unknown): void {
		const window = this.deps.getWindow();
		if (!window || window.isDestroyed()) return;
		try {
			window.webContents.send(channel, payload);
		} catch (error) {
			this.deps.logger?.("warn", "微信状态广播失败", error instanceof Error ? error.message : String(error));
		}
	}
}
