/**
 * 麦克风实时电平采集：录音动效由此判断「用户到底有没有在说话」。
 *
 * 为什么不再用循环动画：beui `Loader variant="bars"` 是定时器驱动的无限循环，安静坐在
 * 麦克风前它也一样跳，用户无法据此判断录音有没有收到声音（2026-09-26 反馈）。电平表把
 * 动效换成真实信号驱动：无声时柱子停在静止位，说话才起伏。
 *
 * 为什么单独一条 AudioContext：AnalyserNode 只出现在主线程侧，本地引擎的 AudioWorklet
 * 切段与云端 MediaRecorder 都不经过它，两条引擎因此能共用同一份电平实现。Analyser 必须
 * 挂在「会被 destination 拉取」的图上才工作，所以经零增益节点接 destination（不发声）。
 */

/** 与静音预检同源的门限（`VOICE_MIN_SPEAKING_PEAK`）：低于它不算说话，动效不应起伏。 */
const SILENCE_PEAK = 0.01;
/** 峰值到该值即满格；再高不继续放大，避免喊话把柱子顶满后失去层次。 */
const FULL_PEAK = 0.5;
/** 平滑后的残值直接归零，否则指数衰减永远到不了 0，柱子会一直微抖。 */
const LEVEL_EPSILON = 0.01;
/** 上升快（跟得住音节起始）、下降慢（避免每帧抖动）。 */
const LEVEL_ATTACK = 0.6;
const LEVEL_RELEASE = 0.18;

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 峰值 → 0~1 电平。
 *
 * 用对数刻度而非线性：语音能量跨两个数量级，线性映射下正常说话只会顶到柱子底部一小截，
 * 看起来仍然像「没动」。
 */
export function voiceLevelFromPeak(peak: number): number {
	if (!Number.isFinite(peak) || peak <= SILENCE_PEAK) return 0;
	if (peak >= FULL_PEAK) return 1;
	const from = Math.log10(SILENCE_PEAK);
	const to = Math.log10(FULL_PEAK);
	return clamp01((Math.log10(peak) - from) / (to - from));
}

/** 单帧指数平滑：target 高于当前值时快速跟上，回落时缓慢收。 */
export function smoothVoiceLevel(previous: number, target: number): number {
	const from = clamp01(previous);
	const to = clamp01(target);
	const next = from + (to - from) * (to > from ? LEVEL_ATTACK : LEVEL_RELEASE);
	return Math.abs(next) < LEVEL_EPSILON ? 0 : next;
}

export type VoiceLevelMeter = {
	/** 当前电平（0~1，已按对数刻度归一）。图已关闭时返回 0。 */
	read: () => number;
	close: () => void;
};

/**
 * 为给定麦克风流建立电平表；任何一步失败都返回 null（调用方按「没有电平」降级），
 * 因为动效缺省不应影响录音本身。
 */
export async function createVoiceLevelMeter(stream: MediaStream): Promise<VoiceLevelMeter | null> {
	if (typeof AudioContext === "undefined") return null;
	let context: AudioContext | null = null;
	try {
		context = new AudioContext({ latencyHint: "interactive" });
		const source = context.createMediaStreamSource(stream);
		const analyser = context.createAnalyser();
		// fftSize 1024：48kHz 下约 21ms 窗口，够快且读缓冲的开销可忽略。
		analyser.fftSize = 1024;
		const buffer = new Float32Array(analyser.fftSize);
		const mute = context.createGain();
		mute.gain.value = 0;
		source.connect(analyser);
		analyser.connect(mute);
		mute.connect(context.destination);
		if (context.state === "suspended") await context.resume();
		const active = context;
		return {
			read: () => {
				if (active.state === "closed") return 0;
				analyser.getFloatTimeDomainData(buffer);
				let peak = 0;
				for (const sample of buffer) {
					const magnitude = Math.abs(sample);
					if (magnitude > peak) peak = magnitude;
				}
				return voiceLevelFromPeak(peak);
			},
			close: () => {
				source.disconnect();
				analyser.disconnect();
				mute.disconnect();
				if (active.state !== "closed") void active.close().catch(() => undefined);
			},
		};
	} catch {
		if (context && context.state !== "closed") void context.close().catch(() => undefined);
		return null;
	}
}
