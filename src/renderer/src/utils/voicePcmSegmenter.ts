import { VOICE_MIN_SPEAKING_PEAK, VOICE_MIN_SPEAKING_SECONDS } from "./voiceWavEncoder";

export type VoicePcmSegmenterOptions = {
	frameMs?: number;
	silenceMs?: number;
	preRollMs?: number;
	maxSegmentSeconds?: number;
	minSegmentSeconds?: number;
	peakThreshold?: number;
};

/**
 * Turns arbitrary PCM chunks into speech segments. Short frame-level peak detection keeps
 * trailing silence for recognition context, while a hard duration cap bounds memory and latency.
 */
export class VoicePcmSegmenter {
	private readonly frameSamples: number;
	private readonly silenceFrames: number;
	private readonly preRollFrames: number;
	private readonly maxSegmentSamples: number;
	private readonly minSegmentSamples: number;
	private readonly peakThreshold: number;
	private pending = new Float32Array(0);
	private preRoll: Float32Array[] = [];
	private segment: Float32Array[] = [];
	private segmentSamples = 0;
	private activeFrames = 0;
	private trailingSilence = 0;
	private active = false;

	constructor(
		private readonly sampleRate: number,
		options: VoicePcmSegmenterOptions = {},
	) {
		if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Invalid PCM sample rate");
		this.frameSamples = Math.max(1, Math.round((sampleRate * (options.frameMs ?? 20)) / 1000));
		// silenceMs 650→400、maxSegmentSeconds 5→10：whisper 的编码器固定按 30 秒窗口算，
		// 所以**每段**都要付一次这个成本。切得越碎、总耗时越长（用户表现为「点了停止还在转」）。
		// 400ms 仍能守住自然停顿的边界，10 秒上限把段数减半，实测端到端等待明显下降。
		this.silenceFrames = Math.max(1, Math.ceil((options.silenceMs ?? 400) / (options.frameMs ?? 20)));
		this.preRollFrames = Math.max(0, Math.ceil((options.preRollMs ?? 120) / (options.frameMs ?? 20)));
		this.maxSegmentSamples = Math.max(this.frameSamples, Math.round(sampleRate * (options.maxSegmentSeconds ?? 10)));
		this.minSegmentSamples = Math.max(0, Math.round(sampleRate * (options.minSegmentSeconds ?? VOICE_MIN_SPEAKING_SECONDS)));
		this.peakThreshold = options.peakThreshold ?? VOICE_MIN_SPEAKING_PEAK;
	}

	/** Accepts a worklet block and returns any completed segments in recording order. */
	push(samples: Float32Array): Float32Array[] {
		if (samples.length === 0) return [];
		const joined = new Float32Array(this.pending.length + samples.length);
		joined.set(this.pending);
		joined.set(samples, this.pending.length);
		const completeLength = Math.floor(joined.length / this.frameSamples) * this.frameSamples;
		this.pending = joined.slice(completeLength);
		const completed: Float32Array[] = [];
		for (let offset = 0; offset < completeLength; offset += this.frameSamples) {
			const frame = joined.subarray(offset, offset + this.frameSamples);
			const speech = framePeak(frame) >= this.peakThreshold;
			if (!this.active) {
				if (!speech) {
					this.pushPreRoll(frame);
					continue;
				}
				this.active = true;
				this.segment = [...this.preRoll, frame];
				this.segmentSamples = this.segment.reduce((total, part) => total + part.length, 0);
				this.activeFrames = 1;
				this.preRoll = [];
				this.trailingSilence = 0;
			} else {
				this.segment.push(frame);
				this.segmentSamples += frame.length;
				this.activeFrames += 1;
				this.trailingSilence = speech ? 0 : this.trailingSilence + 1;
			}

			if (this.active && this.trailingSilence >= this.silenceFrames) {
				const result = this.finishSegment();
				if (result) completed.push(result);
				continue;
			}
			if (this.active && this.segmentSamples >= this.maxSegmentSamples) {
				const result = this.finishSegment();
				if (result) completed.push(result);
			}
		}
		return completed;
	}

	/** Flushes the final partial frame and any active speech segment when recording stops. */
	flush(): Float32Array[] {
		if (this.pending.length > 0 && this.active) {
			this.segment.push(this.pending);
			this.segmentSamples += this.pending.length;
			this.activeFrames += this.pending.length / this.frameSamples;
		}
		this.pending = new Float32Array(0);
		const result = this.finishSegment({ relaxed: true });
		return result ? [result] : [];
	}

	reset(): void {
		this.pending = new Float32Array(0);
		this.preRoll = [];
		this.segment = [];
		this.segmentSamples = 0;
		this.trailingSilence = 0;
		this.active = false;
		this.activeFrames = 0;
	}

	private pushPreRoll(frame: Float32Array): void {
		if (this.preRollFrames === 0) return;
		this.preRoll.push(frame);
		if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
	}

	/**
	 * 收尾当前分段。`relaxed` 用于停止录音时的最后一次 flush：此时录音已经结束，
	 * 不再有后续音频可以补足时长，若还按 minSegmentSeconds 丢掉短句，用户说的话就
	 * 会凭空消失（表现为「说了但没转出来」）。只有真正没捕获到语音（无 active 帧）
	 * 才丢弃。
	 */
	private finishSegment(options: { relaxed?: boolean } = {}): Float32Array | null {
		const parts = this.segment;
		const length = this.segmentSamples;
		this.segment = [];
		this.segmentSamples = 0;
		this.trailingSilence = 0;
		this.active = false;
		const hasEnoughAudio = this.activeFrames > 0 && (options.relaxed === true || this.activeFrames * this.frameSamples >= this.minSegmentSamples);
		this.activeFrames = 0;
		if (!hasEnoughAudio) return null;
		const output = new Float32Array(length);
		let offset = 0;
		for (const part of parts) {
			output.set(part, offset);
			offset += part.length;
		}
		return output;
	}
}

function framePeak(samples: Float32Array): number {
	let peak = 0;
	for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
	return peak;
}
