import { randomUUID } from "node:crypto";
import { VOICE_STREAM_MAX_FRAMES, type VOLC_STREAM_ENDPOINT } from "../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionErrorCode, VoiceTranscriptionFailureDetail, VoiceTranscriptionResult, VoiceTranscriptionStreamStartResult } from "../../shared/types/voiceTranscription";
import { classifyVolcFailure, volcFailureDetail } from "./volcErrorCodes";
import { decodeVolcStreamPacket, encodeVolcStreamAudio, encodeVolcStreamInit } from "./volcStreamProtocol";

/** 端点由共享层常量提供（不开放自定义），这里只取它的类型。 */
type VolcStreamEndpoint = typeof VOLC_STREAM_ENDPOINT;

/** 握手 + init 首帧的上界：正常在几百毫秒内完成，超时即按网络问题处理。 */
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
/** 收尾包发出后等终值的时间：服务端还要解码尾部音频。 */
const DEFAULT_FINISH_TIMEOUT_MS = 10_000;
/**
 * ACK 前允许积压的帧数。渲染层按 200ms/帧 推送，150 帧 = 30 秒；
 * 积压到这个量说明链路已经堵死，继续收只会把用户的话丢在内存里。
 */
const MAX_QUEUED_FRAMES = 150;
/** 单帧字节上限（200ms 的 16k 单声道 16bit = 6400 字节，留足余量挡住脏输入）。 */
const MAX_FRAME_BYTES = 64 * 1024;

/**
 * 会话状态机：opening →（拿到服务端首帧）open →（发了收尾包）finishing → closed。
 * closed 是终态，任何路径都会走 teardown 把等待者结算干净，不留悬空 promise。
 */
type SessionStatus = "opening" | "open" | "finishing" | "closed";

export type VolcStreamSocket = {
	/** 发送一个已编码好的二进制帧。 */
	send(data: Uint8Array): void;
	close(): void;
	/** 订阅事件；message 回传原始帧字节，close 回传关闭码。 */
	on(type: "open" | "message" | "error" | "close", listener: (value: unknown) => void): void;
};

export type VolcStreamCredentials = { appId: string; accessToken: string; resourceId: string; language: string };

export type VolcStreamSessionDeps = {
	/** 建立连接（含握手头）。测试注入假 socket，线上用 Electron 主进程的内建 WebSocket。 */
	createSocket: (url: string, headers: Record<string, string>) => VolcStreamSocket;
	/** 中间结果回调：text 是整段累积文本（协议语义如此），final 标记这是终值。 */
	onPartial: (text: string, final: boolean) => void;
	log: (message: string, details?: Record<string, unknown>) => void;
	openTimeoutMs?: number;
	finishTimeoutMs?: number;
};

/**
 * 豆包流式识别 2.0 的一次会话（一条 WebSocket）。
 *
 * 生命周期：{@link open}（握手 + 整包，等首帧）→ {@link push}（边录边推 PCM）→
 * {@link finish}（发收尾包，等终值）或 {@link cancel}（用户取消，直接断开）。
 * 首帧之前到达的帧先进内存队列，首帧一到就补发——录音不能因为握手慢而丢开头几个字。
 */
export class VolcengineStreamSession {
	private status: SessionStatus = "opening";
	private nextSequence = 2; // 整包占 1
	private framesSent = 0;
	private queued: Uint8Array[] = [];
	/** 服务端最近一次下发的累积文本；任何失败只要有它就按成功收口（半分钟的话不该跟着断线一起丢）。 */
	private lastText = "";
	private failure: { error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail } | null = null;
	private cancelled = false;
	/** finish() 在首帧之前被调用过：等 markOpen 补发积压后再补收尾包。 */
	private endRequested = false;
	/** 终文本是否已推给渲染层（complete 与 teardown 都可能推，只能推一次）。 */
	private finalEmitted = false;
	private readonly requestLogId = randomUUID();
	private socket: VolcStreamSocket | null = null;
	private openTimer: ReturnType<typeof setTimeout> | undefined;
	private finishTimer: ReturnType<typeof setTimeout> | undefined;
	private settleOpen: ((result: VoiceTranscriptionStreamStartResult) => void) | null = null;
	private finishPromise: Promise<VoiceTranscriptionResult> | null = null;
	private settleFinish: ((result: VoiceTranscriptionResult) => void) | null = null;

	constructor(
		private readonly deps: VolcStreamSessionDeps,
		private readonly credentials: VolcStreamCredentials,
		private readonly url: VolcStreamEndpoint,
	) {}

	/** 建立连接并发出整包；只有拿到服务端第一帧（ACK 或结果帧）才算成功。 */
	open(): Promise<VoiceTranscriptionStreamStartResult> {
		const socket = this.deps.createSocket(this.url, this.authHeaders());
		this.socket = socket;
		socket.on("open", () => this.handleSocketOpen());
		socket.on("message", (value) => this.handleMessage(value));
		socket.on("error", () => this.fail({ error: "network" }));
		socket.on("close", (code) => this.handleClose(code));
		return new Promise((resolve) => {
			this.settleOpen = resolve;
			this.openTimer = setTimeout(() => this.fail({ error: "timeout" }), this.deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
		});
	}

	/**
	 * 推一帧 PCM。返回 false = 会话已不可用（超限/已断开），调用方据此停止继续送数据。
	 * 刻意不抛错也不回错误码：帧是 fire-and-forget 的上行，真正的问题会在 partial/finish 上暴露。
	 */
	push(pcm: Uint8Array): boolean {
		if (this.status === "closed" || this.status === "finishing" || this.failure) return false;
		if (!pcm.length || pcm.byteLength > MAX_FRAME_BYTES) return false;
		if (this.framesSent >= VOICE_STREAM_MAX_FRAMES) {
			// 麦克风忘关时的止损：把已识别的字作为结果收口，而不是无限占住一条 WS。
			this.fail({ error: "sessionTooLong" });
			void this.finish();
			return false;
		}
		this.framesSent += 1;
		if (this.status !== "open") {
			if (this.queued.length >= MAX_QUEUED_FRAMES) {
				this.fail({ error: "network" });
				return false;
			}
			this.queued.push(pcm);
			return true;
		}
		this.sendAudio(pcm, false);
		return true;
	}

	/**
	 * 发收尾包并等终值。幂等：重复调用（例如用户停录与会话超限同时发生）复用同一次等待，
	 * 只发一个收尾包——服务端对第二个收尾包会回错误帧。
	 */
	finish(): Promise<VoiceTranscriptionResult> {
		if (this.status === "closed") return Promise.resolve(this.resultFor({ error: "cancelled" }));
		if (this.finishPromise) return this.finishPromise;
		// 先建好等待再发包：服务端首帧可能在 send 的同一轮里就到达，晚一步建等待就没人结算了。
		this.finishPromise = new Promise<VoiceTranscriptionResult>((resolve) => {
			this.settleFinish = resolve;
		});
		this.endRequested = true;
		// 握手期就停录（按下又立刻松开）：init 包还在路上，音频包排在它前面会被服务端判协议错误，
		// 所以只记账，等 markOpen 补发积压后接着收尾。
		if (this.status === "opening") this.armFinishTimer();
		else this.closeStream();
		return this.finishPromise;
	}

	/** 用户取消：直接断开，已上屏的中间文本由渲染层负责回滚，这里只保证不再回结果。 */
	cancel(): void {
		this.cancelled = true;
		this.teardown();
	}

	/** 本次会话的服务端请求号（X-Api-Request-Id），失败文案与工单要用它定位。 */
	get requestId(): string {
		return this.requestLogId;
	}

	private authHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "X-Api-Resource-Id": this.credentials.resourceId, "X-Api-Request-Id": this.requestLogId };
		// 与极速版同一套控制台形态：旧版 App ID + Access Token 成对，新版单 API Key。
		if (this.credentials.accessToken) {
			headers["X-Api-App-Key"] = this.credentials.appId;
			headers["X-Api-Access-Key"] = this.credentials.accessToken;
		} else {
			headers["X-Api-Key"] = this.credentials.appId;
		}
		return headers;
	}

	private handleSocketOpen(): void {
		if (this.status !== "opening") return;
		this.socket?.send(encodeVolcStreamInit({ uid: this.credentials.appId, language: this.credentials.language }, 1));
	}

	private handleMessage(value: unknown): void {
		if (this.status === "closed") return;
		const bytes = value instanceof ArrayBuffer || value instanceof Uint8Array ? value : null;
		if (!bytes) return;
		const packet = decodeVolcStreamPacket(bytes);
		if (packet.kind === "error") {
			this.deps.log("volcengine stream error frame", { statusCode: packet.errorCode, message: packet.errorMessage, logId: this.requestLogId });
			this.fail({ error: classifyVolcFailure(packet.errorCode), detail: volcFailureDetail(packet.errorCode, packet.errorMessage, this.requestLogId) });
			return;
		}
		// 未识别的帧只可能是服务端加了新消息类型：忽略它比误判成断线更可诊断。
		if (packet.kind === "unknown") return;
		if (this.status === "opening") this.markOpen();
		if (packet.kind !== "result") return;
		const text = packet.text.trim();
		if (packet.lastPackage) {
			if (text) this.lastText = text;
			this.complete();
			return;
		}
		if (!text || text === this.lastText) return;
		this.lastText = text;
		this.deps.onPartial(text, false);
	}

	/** 拿到服务端首帧（ACK 或结果）：握手期结束，把积压的帧补发出去。 */
	private markOpen(): void {
		this.status = "open";
		if (this.openTimer) clearTimeout(this.openTimer);
		this.openTimer = undefined;
		this.settleOpen?.({ ok: true });
		this.settleOpen = null;
		this.flush();
		// 首帧之前用户已停录：积压刚补完，接着发收尾包。
		if (this.endRequested) this.closeStream();
	}

	/** 进入收尾：补发积压 + 发一个空载荷的结束包，并开始等终值。 */
	private closeStream(): void {
		if (this.status === "closed" || this.status === "finishing") return;
		this.status = "finishing";
		this.flush();
		this.sendAudio(new Uint8Array(), true);
		this.armFinishTimer();
		// 收尾包还没落地会话就已判负（例如错误帧先到）：立刻结算，不等定时器。
		if (this.failure) this.teardown();
	}

	private armFinishTimer(): void {
		// 先清旧的：握手期停录会在 finish() 里挂一次，markOpen 补发积压后 closeStream 又挂一次，
		// 不清就把一个没人结算的定时器留在事件循环里（会话早已关闭，进程却要再多等 10 秒）。
		if (this.finishTimer) clearTimeout(this.finishTimer);
		this.finishTimer = setTimeout(() => this.fail({ error: "timeout" }), this.deps.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS);
	}

	/** 把 ACK 前积压的帧按原顺序补发。 */
	private flush(): void {
		const backlog = this.queued;
		this.queued = [];
		for (const frame of backlog) this.sendAudio(frame, false);
	}

	private sendAudio(pcm: Uint8Array, last: boolean): void {
		if (!this.socket) return;
		const sequence = this.nextSequence;
		this.nextSequence += 1;
		try {
			this.socket.send(encodeVolcStreamAudio(pcm, sequence, last));
		} catch {
			this.fail({ error: "network" });
		}
	}

	private handleClose(code: unknown): void {
		if (this.status === "closed") return;
		// 正常收尾是「last-package 结果帧 → 服务端关连接」；没拿到终值就被关闭，才是异常。
		if (code !== 1000 && !this.failure && !this.lastText) this.fail({ error: "network" });
		this.teardown();
	}

	/**
	 * 记录失败原因。首帧之前失败要立刻把 open 判负（否则设置页的检测按钮要等满超时）；
	 * 之后失败只记账，由调用 finish 或收尾帧/关闭事件结算，避免把「已经识别出的字」抹掉。
	 */
	private fail(reason: { error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail }): void {
		if (this.failure) return;
		this.failure = reason;
		if (this.status === "opening") {
			// detail 缺省时不挂键：渲染层按「有没有 detail」决定是否展示原始码，undefined 键会误判成有线索。
			this.settleOpen?.(reason.detail ? { ok: false, error: reason.error, detail: reason.detail } : { ok: false, error: reason.error });
			this.settleOpen = null;
			if (this.openTimer) clearTimeout(this.openTimer);
			this.openTimer = undefined;
			this.teardown();
			return;
		}
		if (this.status === "finishing") this.teardown();
	}

	/** 拿到 last-package 结果帧：正常终值。先给渲染层终文本，再结算等待方，最后拆连接。 */
	private complete(): void {
		const result = this.resultFor({ error: "empty" });
		this.emitFinal();
		// 必须先结算 finish 再 teardown：teardown 也会 settleFinish，但它拿的是
		// `resultFor({ error: "cancelled" })` 兜底值——全程静音时那就是「已取消」，
		// 用户看到的提示会从「没识别到内容」变成「你取消了」，而 finish 的等待方此时已被置空。
		this.settleFinish?.(result);
		this.settleFinish = null;
		this.teardown();
	}

	/** 终文本只推一次：teardown 也要兜「失败但已有部分结果」的场景，两边都推会让渲染层收到重复帧。 */
	private emitFinal(): void {
		if (this.finalEmitted || !this.lastText) return;
		this.finalEmitted = true;
		this.deps.onPartial(this.lastText, true);
	}

	/** 会话结果：有累积文本就算成功；取消优先于一切失败码（用户主动停，不该报网络错）。 */
	private resultFor(fallback: { error: VoiceTranscriptionErrorCode; detail?: VoiceTranscriptionFailureDetail }): VoiceTranscriptionResult {
		if (this.cancelled) return { ok: false, error: "cancelled" };
		if (this.lastText) return { ok: true, text: this.lastText };
		const reason = this.failure ?? fallback;
		return reason.detail ? { ok: false, error: reason.error, detail: reason.detail } : { ok: false, error: reason.error };
	}

	private teardown(): void {
		if (this.status === "closed") return;
		this.status = "closed";
		if (this.openTimer) clearTimeout(this.openTimer);
		if (this.finishTimer) clearTimeout(this.finishTimer);
		this.openTimer = undefined;
		this.finishTimer = undefined;
		const socket = this.socket;
		this.socket = null;
		this.queued = [];
		try {
			socket?.close();
		} catch {
			// 关闭失败无需处理：下面已经把等待方全部结算了。
		}
		this.settleOpen?.({ ok: false, error: this.failure?.error ?? "cancelled", detail: this.failure?.detail });
		this.settleOpen = null;
		// 先补一次终文本：正常收尾路径（complete）已经推过，这里只覆盖「失败但有部分结果」的场景，
		// 让渲染层至少知道断线前识别出了什么，而不是整段消失。
		this.emitFinal();
		this.settleFinish?.(this.resultFor({ error: "cancelled" }));
		this.settleFinish = null;
	}
}
