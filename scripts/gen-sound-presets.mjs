// 生成内置提示音 WAV（16-bit PCM mono 44.1kHz），输出到 src/renderer/src/assets/sounds/。
// 运行：node scripts/gen-sound-presets.mjs
// 全部用纯正弦/谐波合成，无外部音频依赖；文件短小（单个 0.3–0.9s，约 30–80KB）。
// 预设 id 与 shared/types/soundAlert.ts 的 SOUND_ALERT_PRESETS 一一对应，改动需同步两处。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "src", "renderer", "src", "assets", "sounds");
const SAMPLE_RATE = 44100;

/** 单音符：正弦 + 2、3 次谐波（按 harm 比例），指数衰减包络。 */
function tone(freq, startSec, durSec, { amp = 0.5, decay = 6, harm = [1, 0.0, 0.0], phase = 0 } = {}) {
	const samples = [];
	const start = Math.floor(startSec * SAMPLE_RATE);
	const n = Math.floor(durSec * SAMPLE_RATE);
	for (let i = 0; i < n; i++) {
		const t = i / SAMPLE_RATE;
		const env = Math.exp(-decay * t);
		let v = 0;
		for (let h = 0; h < harm.length; h++) {
			if (harm[h]) v += harm[h] * Math.sin(2 * Math.PI * freq * (h + 1) * t + phase);
		}
		samples[start + i] = amp * env * v;
	}
	return samples;
}

/** 归一化到 [-1,1] 再写 16-bit WAV。 */
function writeWav(name, samples, durationSec) {
	const n = Math.floor(durationSec * SAMPLE_RATE);
	const buf = Buffer.alloc(44 + n * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16); // fmt chunk size
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(SAMPLE_RATE, 24);
	buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
	buf.writeUInt16LE(2, 32); // block align
	buf.writeUInt16LE(16, 34); // bits
	buf.write("data", 36);
	buf.writeUInt32LE(n * 2, 40);
	let peak = 0;
	for (let i = 0; i < n; i++) {
		const v = samples[i] ?? 0;
		if (Math.abs(v) > peak) peak = Math.abs(v);
	}
	const norm = peak > 0 ? 0.92 / peak : 1;
	for (let i = 0; i < n; i++) {
		const v = Math.round((samples[i] ?? 0) * norm * 32767);
		buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 44 + i * 2);
	}
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, name), buf);
	console.log(`wrote ${name} (${buf.length} bytes)`);
}

// ── done 类：上行双音叮咚 / 铃铛 / 短促气泡 ──
{
	// 叮咚：C5→E5，轻柔、留一点点混响感的尾音
	const s = new Array(Math.floor(1.0 * SAMPLE_RATE)).fill(0);
	const a = tone(523.25, 0.00, 0.45, { amp: 0.5, decay: 5.5, harm: [1, 0.18, 0.05] });
	const b = tone(659.25, 0.16, 0.55, { amp: 0.5, decay: 4.5, harm: [1, 0.22, 0.06] });
	for (let i = 0; i < s.length; i++) s[i] = (a[i] ?? 0) + (b[i] ?? 0);
	writeWav("done-chime.wav", s, 1.0);
}
{
	// 铃铛：单音 + 丰富泛音，衰减长
	const s = tone(880, 0, 0.9, { amp: 0.45, decay: 4.2, harm: [1, 0.55, 0.3, 0.15, 0.08] });
	writeWav("done-bell.wav", s, 0.9);
}
{
	// 气泡：短促上滑 + 快速衰减
	const s = new Array(Math.floor(0.35 * SAMPLE_RATE)).fill(0);
	for (let i = 0; i < s.length; i++) {
		const t = i / SAMPLE_RATE;
		const f = 400 + 900 * Math.min(1, t / 0.08);
		s[i] = 0.5 * Math.exp(-22 * t) * Math.sin(2 * Math.PI * f * t);
	}
	writeWav("done-pop.wav", s, 0.35);
}

// ── error 类：低频蜂鸣（两下） / 双音警报 ──
{
	// 蜂鸣：220Hz 方波感（奇次谐波），两下短促
	const s = new Array(Math.floor(0.8 * SAMPLE_RATE)).fill(0);
	for (const [start, dur] of [[0, 0.22], [0.32, 0.22]]) {
		const seg = tone(220, start, dur, { amp: 0.4, decay: 3.5, harm: [1, 0, 0.33, 0, 0.2], phase: Math.PI / 2 });
		for (let i = 0; i < seg.length; i++) if (seg[i]) s[i] = (s[i] ?? 0) + seg[i];
	}
	writeWav("error-buzz.wav", s, 0.8);
}
{
	// 警报：880→660 交替两轮，略带紧迫感
	const s = new Array(Math.floor(1.0 * SAMPLE_RATE)).fill(0);
	for (const [f, start, dur] of [[880, 0, 0.18], [660, 0.2, 0.18], [880, 0.4, 0.18], [660, 0.6, 0.18]]) {
		const seg = tone(f, start, dur, { amp: 0.42, decay: 5, harm: [1, 0.15, 0.08] });
		for (let i = 0; i < seg.length; i++) if (seg[i]) s[i] = (s[i] ?? 0) + seg[i];
	}
	writeWav("error-alert.wav", s, 1.0);
}

// ── waiting 类：单音 ping / 敲门两下 ──
{
	// ping：1320Hz 单音，清脆短促
	const s = tone(1320, 0, 0.35, { amp: 0.42, decay: 9, harm: [1, 0.12, 0.04] });
	writeWav("waiting-ping.wav", s, 0.35);
}
{
	// 敲门：两次低频闷响（快速衰减的 180Hz + 噪声感）
	const s = new Array(Math.floor(0.6 * SAMPLE_RATE)).fill(0);
	for (const [start, dur] of [[0, 0.12], [0.24, 0.12]]) {
		const seg = tone(180, start, dur, { amp: 0.55, decay: 22, harm: [1, 0.5, 0.3], phase: Math.PI / 2 });
		for (let i = 0; i < seg.length; i++) if (seg[i]) s[i] = (s[i] ?? 0) + seg[i];
	}
	writeWav("waiting-knock.wav", s, 0.6);
}
