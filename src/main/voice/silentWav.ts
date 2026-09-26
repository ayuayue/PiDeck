/**
 * 连通性检测用的静音 WAV：16kHz / 16bit / 单声道全零 PCM + 44 字节 RIFF 头。
 *
 * 为什么不复用渲染层的 voiceWavEncoder：那是渲染进程模块，main 不能反向依赖；
 * 这里只需要「一段合法的短 WAV」，自己写头比跨层引依赖干净。
 * 采样率必须与渲染层编码器一致（VOICE_WAV_SAMPLE_RATE = 16000），否则检测通过、
 * 真录音失败的偏差会来自编码参数而不是凭据。
 */
const PROBE_SAMPLE_RATE = 16000;
const WAV_HEADER_BYTES = 44;

export function createSilentWav(durationMs: number): ArrayBuffer {
	const samples = Math.max(1, Math.round((PROBE_SAMPLE_RATE * durationMs) / 1000));
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples * 2);
	const view = new DataView(buffer);
	view.setUint32(0, 0x52494646); // "RIFF"
	view.setUint32(4, buffer.byteLength - 8, true);
	view.setUint32(8, 0x57415645); // "WAVE"
	view.setUint32(12, 0x666d7420); // "fmt "
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, PROBE_SAMPLE_RATE, true);
	view.setUint32(28, PROBE_SAMPLE_RATE * 2, true); // byteRate = rate * channels * bits/8
	view.setUint16(32, 2, true); // blockAlign
	view.setUint16(34, 16, true); // bitsPerSample
	view.setUint32(36, 0x64617461); // "data"
	view.setUint32(40, samples * 2, true);
	return buffer; // PCM 区保持全零 = 静音
}
