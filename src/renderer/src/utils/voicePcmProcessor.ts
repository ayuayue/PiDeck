/**
 * 本地引擎「边录边出字」的 AudioWorklet 采集路径。
 *
 * 为什么用 AudioWorklet 而不是 MediaRecorder 分片：webm/opus 是连续流，除首个分片外
 * 都不带初始化头（EBML/Segment 头），单独解码必定失败或解出静音。AudioWorklet 在
 * 音频线程拿到的是原始 Float32 PCM，可以按帧判断语音边界并切段，每段都能独立编码成
 * whisper-cli 可用的 WAV。
 *
 * 为什么分段逻辑不在这里重写：`voicePcmSegmenter.ts` 的 `VoicePcmSegmenter` 是有单测
 * 覆盖的唯一实现。AudioWorklet 运行在独立全局作用域里、没有模块解析器，因此这里用
 * Vite 的 `?raw` 在构建时把该文件源码内联进 worklet 模块字符串，分段规则只有一个来源。
 */
import voicePcmSegmenterSource from "./voicePcmSegmenter.ts?raw";

/**
 * worklet 模块里没有模块解析器，所以 `voicePcmSegmenter.ts` 的 import 与 `export`
 * 关键字必须在拼接前剥掉，依赖的阈值常量改为内联字面量。
 * 取值与 `voiceWavEncoder.ts` 的 `VOICE_MIN_SPEAKING_PEAK / VOICE_MIN_SPEAKING_SECONDS` 一致。
 */
const WORKLET_PRELUDE = ["const VOICE_MIN_SPEAKING_PEAK = 0.01;", "const VOICE_MIN_SPEAKING_SECONDS = 0.4;"].join("\n");

/** 与 `voiceWavEncoder.VOICE_WAV_SAMPLE_RATE` 一致；whisper 训练口径 16kHz。 */
const VOICE_WORKLET_TARGET_RATE = 16000;

/**
 * worklet 侧处理器：接收麦克风单声道块，切段后线性重采样到 16kHz，
 * 以 transferable ArrayBuffer 回传主线程（避免结构化克隆拷贝音频数据）。
 */
function workletProcessorSource(): string {
	return `
class PiDeckVoiceProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.segmenter = new VoicePcmSegmenter(sampleRate);
		this.port.onmessage = (event) => {
			if (event.data === "flush") this.flush();
			else if (event.data === "reset") this.segmenter.reset();
		};
	}
	process(inputs) {
		const channels = inputs[0];
		if (!channels || channels.length === 0) return true;
		const mono = downMix(channels);
		for (const segment of this.segmenter.push(mono)) this.postSegment(segment);
		return true;
	}
	flush() {
		for (const segment of this.segmenter.flush()) this.postSegment(segment);
		this.port.postMessage({ type: "flushed" });
	}
	postSegment(segment) {
		const resampled = resampleLinear(segment, sampleRate, ${VOICE_WORKLET_TARGET_RATE});
		const buffer = resampled.buffer;
		this.port.postMessage({ type: "segment", audio: buffer }, [buffer]);
	}
}
registerProcessor("pideck-voice-processor", PiDeckVoiceProcessor);
`;
}

const WORKLET_HELPERS = `
/** 多声道下混为单声道；单声道直接拷贝，避免调用方拿到会被 worklet 复用的缓冲。 */
function downMix(channels) {
	if (channels.length === 1) return channels[0].slice();
	const length = channels[0] ? channels[0].length : 0;
	const mono = new Float32Array(length);
	for (const channel of channels) {
		for (let index = 0; index < length; index += 1) mono[index] += (channel[index] || 0) / channels.length;
	}
	return mono;
}

/** 线性插值重采样：whisper 只吃 16kHz，设备常见 44.1k/48k。 */
function resampleLinear(samples, sourceRate, targetRate) {
	if (sourceRate === targetRate) return samples;
	const length = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
	const result = new Float32Array(length);
	const scale = sourceRate / targetRate;
	for (let index = 0; index < length; index += 1) {
		const position = index * scale;
		const left = Math.min(samples.length - 1, Math.floor(position));
		const right = Math.min(samples.length - 1, left + 1);
		const fraction = position - left;
		result[index] = (samples[left] || 0) * (1 - fraction) + (samples[right] || 0) * fraction;
	}
	return result;
}
`;

/**
 * 剥掉模块语法后的分词器源码。
 *
 * `voicePcmSegmenter.ts?raw` 已被 `audioWorkletSegmenterPlugin` 转译成 JS（只剩模块语法），
 * worklet 里不能有 import/export，这里负责去掉；分段实现的正文保持零改动。
 * 注意 esbuild 会把 `export class X` 与具名导出拆成两种形式（行内 export 与尾部
 * `export { A, B };` 块），两者都要处理，否则 worklet 会 SyntaxError。
 */
function segmentationSource(): string {
	return voicePcmSegmenterSource
		.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
		.replace(/^export\s+(?=(class|function|const|let|var|enum))/gm, "")
		.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, "")
		.trim();
}

/**
 * 生成可直接交给 `audioWorklet.addModule` 的 Blob URL。
 *
 * 用 Blob URL 而不是构建产物 URL：Vite 没有 AudioWorklet 入口类型，把 .ts 当资源
 * 打包得不到模块；Blob 由渲染进程自建，不受 `script-src` 限制（同源 blob:）。
 * 调用方负责在停止录音时 `URL.revokeObjectURL` 释放。
 */
export function createVoicePcmProcessorModuleUrl(): string {
	const parts = [WORKLET_PRELUDE, segmentationSource(), WORKLET_HELPERS, workletProcessorSource()];
	const blob = new Blob([parts.join("\n")], { type: "text/javascript" });
	return URL.createObjectURL(blob);
}
