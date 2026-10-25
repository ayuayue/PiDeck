/**
 * 微信 iLink 扫码登录状态机。
 *
 * 与飞书最大的不同：飞书是「填 App ID/Secret 点连接」，微信是「扫码授权」，
 * 凭据由服务端在扫码确认时签发。所以登录必须是一个有进度的过程状态，而不是
 * 一次请求。这里只负责「拿到 bot_token」，落盘由调用方（WeChatService）决定。
 *
 * 两个协议坑（探针实测）：
 * 1. get_qrcode_status 是**长轮询**：没状态变化时服务端挂着连接，客户端超时
 *    意味着「还没变化」，必须继续等而不是判失败。探针第一版就是被默认 15s
 *    超时打死的。
 * 2. scaned_but_redirect 会要求换 base 域名，后续轮询与业务请求都要走新域名。
 */

import type { WeChatLoginPhase, WeChatLoginState } from "../../shared/types";
import type { IlinkQrCodeResponse, IlinkQrStatus, IlinkQrStatusResponse } from "./ilinkProtocol";
import { QR_STATUS_POLL_INTERVAL_MS } from "./ilinkProtocol";

/**
 * 登录结果的本地形状（刻意不用 shared 的 WeChatLoginResult）。
 * 那个类型承诺「account 已落盘」，而这一层不该知道落盘策略——
 * 它只负责把服务端签发的凭据交出去，由 WeChatService 决定怎么存、怎么命名。
 */
export type WeChatLoginOutcome = { ok: true; credentials: WeChatLoginCredentials } | { ok: false; error: string };
/** 登录阶段只用得上这三个方法，让测试可以传一个假传输层而不必伪造 fetch。 */
export type WeChatLoginTransport = {
	createQrcode: () => Promise<IlinkQrCodeResponse>;
	queryQrcodeStatus: (qrcode: string, verifyCode?: string) => Promise<IlinkQrStatusResponse>;
	setBaseUrl: (url: string | undefined) => void;
};

export type WeChatLoginOptions = {
	transport: WeChatLoginTransport;
	/** 状态回调。每次 phase 变化都会调一次，调用方据此推给渲染层。 */
	onState: (state: WeChatLoginState) => void;
	/** 轮询间隔，测试里压到 1ms。 */
	pollIntervalMs?: number;
	/** 整体超时。超过即判过期并停止轮询（服务端 expired 是权威，这里只是兜底防死循环）。 */
	deadlineMs?: number;
	/** 可注入的睡眠，测试里立即返回。 */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	logger?: (level: "debug" | "warn", message: string, detail?: unknown) => void;
};

/** 二维码有效期几分钟量级；给足余量，真正的过期由服务端 expired 状态判定。 */
const DEFAULT_DEADLINE_MS = 8 * 60 * 1000;

export class WeChatLogin {
	private readonly transport: WeChatLoginTransport;
	private readonly onState: (state: WeChatLoginState) => void;
	private readonly pollIntervalMs: number;
	private readonly deadlineMs: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly logger: ((level: "debug" | "warn", message: string, detail?: unknown) => void) | undefined;

	private state: WeChatLoginState = { phase: "idle" };
	private cancelled = false;
	private running = false;
	/** 本次登录的查询码与二维码内容，prepare 后才有值。 */
	private qrcode: string | null = null;
	private qrContent = "";
	/** 服务端要求输入验证码时暂存，下次轮询带上。 */
	private verifyCode: string | undefined;
	/** 记住上一次上报的 phase，避免长轮询每轮都推一次同样的 waiting。 */
	private lastReportedPhase: WeChatLoginPhase = "idle";

	constructor(options: WeChatLoginOptions) {
		this.transport = options.transport;
		this.onState = options.onState;
		this.pollIntervalMs = options.pollIntervalMs ?? QR_STATUS_POLL_INTERVAL_MS;
		this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.now = options.now ?? (() => Date.now());
		this.logger = options.logger;
	}

	getState(): WeChatLoginState {
		return this.state;
	}

	isRunning(): boolean {
		return this.running;
	}

	/** 用户主动取消（关掉弹窗）。停止轮询但保留最后状态供界面判断。 */
	cancel(): void {
		this.cancelled = true;
		this.running = false;
	}

	/** 提交验证码（服务端要求 need_verifycode 时）。返回是否被接受。 */
	submitVerifyCode(code: string): boolean {
		const trimmed = code.trim();
		if (!trimmed || this.state.phase !== "need-verify-code") return false;
		this.verifyCode = trimmed;
		this.setState({ phase: "waiting", qrcodeContent: this.state.qrcodeContent });
		return true;
	}

	/**
	 * 取一次二维码并把状态推到 waiting。
	 *
	 * 拆成 prepare/run 两步的原因：界面要先把二维码渲染出来给人扫，再开始轮询——
	 * 合成一个 promise 的话调用方只能等「有人扫码」这个几分钟量级的事件才能拿到二维码。
	 */
	async prepare(): Promise<WeChatLoginState> {
		if (this.running) {
			this.setState({ phase: "error", error: "login already running" });
			return this.state;
		}
		this.running = true;
		this.cancelled = false;
		this.verifyCode = undefined;
		this.qrcode = null;
		this.qrContent = "";
		try {
			const qr = await this.transport.createQrcode();
			if (!qr.qrcode) throw new Error("get_bot_qrcode returned no qrcode");
			this.qrcode = qr.qrcode;
			// 二维码内容才是给人扫的东西；qrcode 只是查询用的不透明码。
			this.qrContent = qr.qrcode_img_content ?? "";
			this.setState({ phase: "waiting", qrcodeContent: this.qrContent });
		} catch (error) {
			this.running = false;
			const message = error instanceof Error ? error.message : String(error);
			this.setState({ phase: "error", error: message });
		}
		return this.state;
	}

	/**
	 * 轮询到确认/过期/取消。成功时返回 bot_token 等凭据；调用方负责落盘。
	 */
	async run(): Promise<WeChatLoginOutcome> {
		const qrcode = this.qrcode;
		if (!this.running || !qrcode) return { ok: false, error: "login not prepared" };
		const qrContent = this.qrContent;

		const deadline = this.now() + this.deadlineMs;
		while (!this.cancelled && this.now() < deadline) {
			await this.sleep(this.pollIntervalMs);
			if (this.cancelled) break;
			try {
				const status = await this.transport.queryQrcodeStatus(qrcode, this.verifyCode);
				const outcome = this.applyStatus(status, qrContent);
				if (outcome) {
					this.running = false;
					return outcome;
				}
			} catch (error) {
				// 长轮询超时是正常现象（状态没变化），继续下一轮；
				// 其余错误也容忍重试——扫码期间的网络抖动不该让用户重扫码。
				this.logger?.("debug", "扫码状态轮询失败，继续重试", error instanceof Error ? error.message : String(error));
			}
		}

		this.running = false;
		if (this.cancelled) return { ok: false, error: "cancelled" };
		this.setState({ phase: "expired" });
		return { ok: false, error: "expired" };
	}

	/** 便捷入口：取码后直接轮询到底（不用先给界面看二维码的场景）。 */
	async start(): Promise<WeChatLoginOutcome> {
		await this.prepare();
		return this.run();
	}

	/** 处理一次状态响应。返回非空即表示登录已终态（成功/失败）。 */
	private applyStatus(status: IlinkQrStatusResponse, qrContent: string): WeChatLoginOutcome | undefined {
		const value: IlinkQrStatus = status.status ?? "wait";
		switch (value) {
			case "wait":
				// 保持 waiting，不发新状态（长轮询每轮都推一次等于刷屏）
				return undefined;
			case "scaned":
				this.setState({ phase: "scanned", qrcodeContent: qrContent });
				return undefined;
			case "scaned_but_redirect":
			case "binded_redirect":
				// 服务端要求换域名，后续查询与业务请求都要走新 base。
				this.transport.setBaseUrl(status.redirect_host);
				this.logger?.("debug", "扫码重定向到新 base", status.redirect_host);
				return undefined;
			case "need_verifycode":
				this.setState({ phase: "need-verify-code", qrcodeContent: qrContent });
				return undefined;
			case "verify_code_blocked":
				this.setState({ phase: "error", error: "verify_code_blocked" });
				return { ok: false, error: "verify_code_blocked" };
			case "expired":
				this.setState({ phase: "expired" });
				return { ok: false, error: "expired" };
			case "confirmed": {
				// 确认后服务端才签发凭据；缺 token 说明协议形态变了，宁可报错也不写半截账号。
				if (!status.bot_token || !status.ilink_bot_id) {
					this.setState({ phase: "error", error: "confirmed without credentials" });
					return { ok: false, error: "confirmed without credentials" };
				}
				this.transport.setBaseUrl(status.baseurl);
				this.setState({ phase: "confirmed" });
				return {
					ok: true,
					credentials: { botToken: status.bot_token, ilinkBotId: status.ilink_bot_id, ilinkUserId: status.ilink_user_id ?? "", baseUrl: status.baseurl ?? "" },
				};
			}
			default:
				this.logger?.("warn", "未知扫码状态", value);
				return undefined;
		}
	}

	private setState(next: WeChatLoginState): void {
		this.state = next;
		if (next.phase === this.lastReportedPhase) return;
		this.lastReportedPhase = next.phase;
		try {
			this.onState(next);
		} catch (error) {
			// 回调抛错不能把登录流程带走
			this.logger?.("warn", "扫码状态回调抛错", error instanceof Error ? error.message : String(error));
		}
	}
}

/** 登录成功后由调用方落盘的凭据形状。 */
export type WeChatLoginCredentials = {
	botToken: string;
	ilinkBotId: string;
	ilinkUserId: string;
	baseUrl: string;
};
