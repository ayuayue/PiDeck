import { VOICE_STREAM_SAMPLE_RATE } from "../../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionErrorCode, VoiceTranscriptionResult, VoiceTranscriptionStreamPartial } from "../../../shared/types/voiceTranscription";
import { desktopApi } from "../desktopApi";
import type { VoiceTranscriptionTarget } from "./voiceTranscriptionInsert";

/** 渲染层只需要这三件事，窄接口便于单测（不用伪造整个 desktopApi）。 */
export type VoiceStreamApi = {
	startStream: (input: { requestId: string; sampleRate: number }) => Promise<{ ok: true } | { ok: false; error: VoiceTranscriptionErrorCode }>;
	sendStreamFrame: (frame: { requestId: string; pcm: ArrayBuffer }) => void;
	finishStream: (requestId: string) => Promise<VoiceTranscriptionResult>;
	cancel: (requestId: string) => Promise<void> | void;
};

export type VoiceStreamSessionDeps = {
	api?: VoiceStreamApi;
	/** 读输入框当前正文（整段替换每帧都要重读，才能区分「用户在我们的区间里改了字」）。 */
	captureTarget: () => VoiceTranscriptionTarget;
	applyText: (target: VoiceTranscriptionTarget, text: string) => boolean;
	/** 识别结果被用户编辑挤掉：本次录音作废，调用方负责提示与收尾。 */
	onStale: () => void;
	/** 服务端错误码（开流失败 / 收尾失败）的提示出口。 */
	onError: (error: VoiceTranscriptionErrorCode) => void;
};

/**
 * 一路流式识别的渲染层侧会话：把麦克风帧推给主进程，并把「整段累积文本」替换进输入框。
 *
 * 为什么是**整段替换**而不是追加：豆包流式每帧下发的是整段会话的累积文本，而且会回头
 * 修正已出片的标点（2026-09-27 实测）。逐次追加会把同一句话插两遍，且永远补不回改动的标点。
 *
 * 为什么要重读 `captureTarget()`：主进程替我们挡不住用户在这零点几秒里打的字。
 * 判据是「输入框里我们那段区间仍然等于上次写进去的文本」——不相等就说明用户动过，
 * 此时继续覆盖会吃掉他的输入，于是整次识别作废（与整段通路同一套 stale 语义）。
 */
export class VoiceStreamSession {
	readonly requestId = crypto.randomUUID();
	private readonly api: VoiceStreamApi;
	/** 我们那段文本在输入框里的位置与内容；null = 还没有任何结果上屏。 */
	private span: { sessionId: string; from: number; text: string } | null = null;
	private settled = false;

	constructor(private readonly deps: VoiceStreamSessionDeps) {
		this.api = deps.api ?? (desktopApi.voiceTranscription as unknown as VoiceStreamApi);
	}

	/** 开流：握手与 init ACK 都在主进程做完才回这里，失败即凭据/权限问题。 */
	async begin(): Promise<boolean> {
		const started = await this.api.startStream({ requestId: this.requestId, sampleRate: VOICE_STREAM_SAMPLE_RATE });
		if (started.ok) return true;
		if (!this.settled) this.deps.onError(started.error);
		return false;
	}

	push(pcm: ArrayBuffer): void {
		if (this.settled) return;
		this.api.sendStreamFrame({ requestId: this.requestId, pcm });
	}

	handlePartial(partial: VoiceTranscriptionStreamPartial): void {
		if (this.settled || partial.requestId !== this.requestId) return;
		this.write(partial.text);
	}

	/** 收尾：等主进程返回终值（拿到几算几），并把它写进输入框。 */
	async finish(): Promise<void> {
		if (this.settled) return;
		const result = await this.api.finishStream(this.requestId);
		this.settled = true;
		if (!result.ok) {
			// 已经有文本上屏时不再报错：那半句话该留下，重复提示只会盖住结果。
			if (!this.span) this.deps.onError(result.error);
			return;
		}
		this.write(result.text);
	}

	/** 用户取消：告诉主进程断开，本地不再接受任何回调。 */
	cancel(): void {
		if (this.settled) return;
		this.settled = true;
		void Promise.resolve(this.api.cancel(this.requestId)).catch(() => undefined);
	}

	/**
	 * 整段替换：第一次吃掉录音开始时的选区，之后每次替换自己上一次写进去的那段。
	 * 返回 false = 区间被用户改过（或会话已作废），调用方据此决定是否放弃本次识别。
	 */
	private write(text: string): boolean {
		const live = this.deps.captureTarget();
		const previous = this.span;
		const from = previous?.from ?? live.from;
		const to = previous ? from + previous.text.length : live.to;
		if (previous && live.draft.slice(from, to) !== previous.text) return this.discard();
		if (previous && previous.text === text) return true;
		if (!this.deps.applyText({ sessionId: live.sessionId, draft: live.draft, from, to }, text)) return this.discard();
		this.span = { sessionId: live.sessionId, from, text };
		return true;
	}

	private discard(): boolean {
		this.settled = true;
		this.cancel();
		this.deps.onStale();
		return false;
	}
}
