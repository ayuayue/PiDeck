/**
 * 从 WAV 里取出裸 PCM 数据段。
 *
 * 为什么主进程要解 WAV：豆包流式 2.0 的上行只吃 16bit 小端裸 PCM（无 RIFF 头），
 * 而渲染层为极速版/本地引擎编好的是完整 WAV。与其让渲染层为两种通路各编一份，
 * 不如在通路上做一次字节级剥头 —— RIFF 头是 44 字节的定长成本，可忽略。
 *
 * 按 chunk 遍历而不是「跳过前 44 字节」：LIST/fact 等可选块会把 data 推到任意偏移，
 * 硬算偏移会在带元数据的录音上稳定解出错位音频（表现为识别出乱码而不是报错）。
 */
const RIFF_MAGIC = 0x52494646; // "RIFF"
const WAVE_MAGIC = 0x57415645; // "WAVE"
const DATA_MAGIC = 0x64617461; // "data"
/** chunk 头：4 字节 ID + 4 字节长度。 */
const CHUNK_HEADER_BYTES = 8;

export function extractWavPcm(wav: ArrayBuffer): Uint8Array | null {
	// fmt(16) + 头两个 chunk = 至少 12 字节 RIFF 头 + 8 字节 chunk 头才可能有 data。
	if (wav.byteLength < 20) return null;
	const view = new DataView(wav);
	if (view.getUint32(0) !== RIFF_MAGIC || view.getUint32(8) !== WAVE_MAGIC) return null;
	let offset = 12;
	while (offset + CHUNK_HEADER_BYTES <= wav.byteLength) {
		const id = view.getUint32(offset);
		// 长度按 uint32 读，块与块之间可能 1 字节对齐（奇数长度补一字节 0）。
		const size = view.getUint32(offset + 4, true);
		const body = offset + CHUNK_HEADER_BYTES;
		if (id === DATA_MAGIC) {
			const end = Math.min(body + size, wav.byteLength);
			return end > body ? new Uint8Array(wav, body, end - body) : null;
		}
		if (size <= 0) return null;
		offset = body + size + (size % 2);
	}
	return null;
}
