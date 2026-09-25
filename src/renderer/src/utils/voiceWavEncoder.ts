/**
 * 录音 → whisper.cpp 可用的 WAV（16kHz 单声道 PCM16）。
 *
 * 为什么在渲染层转码：MediaRecorder 产出 webm/opus，whisper-cli 只吃 pcm/wav；
 * 浏览器侧 decodeAudioData + OfflineAudioContext 重采样是 Chromium 原生能力，
 * 零依赖、零体积。转码后的 WAV 仍不落盘，只经 IPC 传给主进程临时文件。
 *
 * encodeWavPcm 是纯函数（不碰 Web Audio），便于单测头部字节。
 */

/** WAV 采样率（whisper 训练口径 16kHz，重采样到此值识别质量最优）。 */
export const VOICE_WAV_SAMPLE_RATE = 16000;

/** RIFF 头固定 44 字节（16 字节 fmt + 8 字节 data 块头 + 20 字节块身）。 */
const WAV_HEADER_BYTES = 44;

/**
 * 把单声道 Float32 PCM（-1..1）编码为 16 位 PCM WAV（含 RIFF 头）。
 * 纯函数：小端、mono、PCM 格式（fmt=1）。
 */
export function encodeWavPcm(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const dataBytes = samples.length * 2;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk 长度
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // 单声道
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byteRate = sampleRate * channels * bits/8
	view.setUint16(32, 2, true); // blockAlign
	view.setUint16(34, 16, true); // bitsPerSample
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);
	let offset = 44;
	for (let i = 0; i < samples.length; i += 1) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
		offset += 2;
	}
	return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * 判定「这段录音里到底有没有说话」的峰值门限（0..1，约 -36 dBFS）。
 *
 * 为什么需要：whisper 对静音不返回空串，而是幻觉出 " you"、"我不想要我" 这类文本，
 * 或输出 `[BLANK_AUDIO]` 占位词——直接插进用户输入框就是脏数据。安静房间的噪声峰值
 * 通常 < 0.005，而正常说话（哪怕小声）峰值 > 0.03，这个门限足以分开两者。
 */
export const VOICE_MIN_SPEAKING_PEAK = 0.01;

/** 可判定的最短录音时长（秒）：低于此长度 whisper 基本只能靠猜，直接提示重录。 */
export const VOICE_MIN_SPEAKING_SECONDS = 0.4;

/**
 * 读取 PCM16 WAV 的峰值幅度（0..1）。纯函数、只依赖 RIFF 布局，
 * 不解析头部字段：入参一定是本模块 encodeWavPcm 的产物。
 */
export function measureWavPeakLevel(wav: ArrayBuffer): number {
	const samples = new Int16Array(wav, WAV_HEADER_BYTES);
	let peak = 0;
	for (let i = 0; i < samples.length; i += 1) {
		const magnitude = samples[i] < 0 ? -samples[i] : samples[i];
		if (magnitude > peak) peak = magnitude;
	}
	return peak / 32768;
}

/** 由峰值与采样率算出可送转写的音频时长（秒）。 */
export function wavDurationSeconds(wav: ArrayBuffer, sampleRate: number = VOICE_WAV_SAMPLE_RATE): number {
	return (wav.byteLength - WAV_HEADER_BYTES) / 2 / sampleRate;
}

/**
 * 解码任意浏览器可播放的录音 Blob（webm/ogg/mp4）为重采样后的 mono WAV。
 * AudioContext / OfflineAudioContext 由调用环境提供（浏览器原生），测试可注入替身。
 */
export async function encodeRecordingToWav(blob: Blob, audioContextCtor: typeof AudioContext = AudioContext): Promise<ArrayBuffer> {
	const raw = await blob.arrayBuffer();
	const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
		const ctx = new audioContextCtor();
		const handle = (buffer: AudioBuffer) => {
			void ctx.close().catch(() => undefined);
			resolve(buffer);
		};
		const fail = (error: unknown) => {
			void ctx.close().catch(() => undefined);
			reject(error);
		};
		// decodeAudioData 的 promise 与回调两种签名在旧实现里并存，用回调兜底。
		try {
			const promise = ctx.decodeAudioData(raw.slice(0), handle, fail);
			if (promise && typeof promise.then === "function") promise.then(handle, fail);
		} catch (error) {
			fail(error);
		}
	});
	// OfflineAudioContext 单声道 + 目标采样率 = 自动 down-mix + 重采样。
	const offline = new OfflineAudioContext(1, Math.ceil((decoded.duration * VOICE_WAV_SAMPLE_RATE) / 1) || 1, VOICE_WAV_SAMPLE_RATE);
	const source = offline.createBufferSource();
	source.buffer = decoded;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();
	return encodeWavPcm(rendered.getChannelData(0), VOICE_WAV_SAMPLE_RATE);
}
