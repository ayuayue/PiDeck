import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const encoderModule = { exports: {} };
const encoderSource = ts.transpileModule(readFileSync("src/renderer/src/utils/voiceWavEncoder.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(encoderSource, { module: encoderModule, exports: encoderModule.exports });
const segmenterModule = { exports: {} };
const segmenterSource = ts.transpileModule(readFileSync("src/renderer/src/utils/voicePcmSegmenter.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(segmenterSource, {
	module: segmenterModule,
	exports: segmenterModule.exports,
	require: (specifier) => {
		assert.equal(specifier, "./voiceWavEncoder");
		return encoderModule.exports;
	},
});
const { VoicePcmSegmenter } = segmenterModule.exports;

function audioFrames(values, samplesPerFrame) {
	const samples = new Float32Array(values.length * samplesPerFrame);
	values.forEach((value, frame) => samples.fill(value, frame * samplesPerFrame, (frame + 1) * samplesPerFrame));
	return samples;
}

test("emits local PCM transcription chunks after detected speech and trailing silence", () => {
	const segmenter = new VoicePcmSegmenter(1000, { frameMs: 20, silenceMs: 60, preRollMs: 0, minSegmentSeconds: 0.04, maxSegmentSeconds: 1, peakThreshold: 0.02 });
	const chunks = segmenter.push(audioFrames([0.2, 0.2, 0.2, 0, 0, 0, 0, 0.2, 0.2, 0.2], 20));
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].length, 6 * 20);
	assert.ok(Array.from(chunks[0].slice(0, 20)).every((sample) => Math.abs(sample - 0.2) < 0.000001));
});

test("flushes the final utterance and ignores pure silence / sub-threshold noise", () => {
	const segmenter = new VoicePcmSegmenter(1000, { frameMs: 20, silenceMs: 60, preRollMs: 0, minSegmentSeconds: 0.04, maxSegmentSeconds: 1, peakThreshold: 0.02 });
	assert.equal(segmenter.push(audioFrames([0, 0.005, 0], 20)).length, 0);
	assert.equal(segmenter.flush().length, 0);
	segmenter.push(audioFrames([0.1, 0.1, 0.1], 20));
	const final = segmenter.flush();
	assert.equal(final.length, 1);
	assert.equal(final[0].length, 60);
});

test("splits long speech at a bounded maximum duration", () => {
	const segmenter = new VoicePcmSegmenter(1000, { frameMs: 20, silenceMs: 60, preRollMs: 0, minSegmentSeconds: 0.04, maxSegmentSeconds: 0.12, peakThreshold: 0.02 });
	const chunks = segmenter.push(audioFrames(Array(12).fill(0.1), 20));
	assert.equal(chunks.length, 2);
	assert.ok(chunks.every((chunk) => chunk.length <= 120));
});

test("短句在停止录音时不能丢：flush 必须交出最后一段", () => {
	// 回归：用户说一句话就松手（未触发静音切段），早前 finishSegment 按 minSegmentSeconds
	// 直接丢弃 → 表现为「我还没松开就自动停止，而且话没转出来」。
	const segmenter = new VoicePcmSegmenter(16000, { frameMs: 20, silenceMs: 650 });
	// 0.3s 语音：短于 VOICE_MIN_SPEAKING_SECONDS(0.4s) 的默认下限，且不足以触发静音切段。
	const short = audioFrames([0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4], 320);
	assert.equal(segmenter.push(short).length, 0, "录音进行中不该提前收尾");
	const flushed = segmenter.flush();
	assert.equal(flushed.length, 1, "停止录音时最后一段必须交出来，否则用户说的话凭空消失");
	assert.ok(flushed[0].length >= short.length, "交出的分段应包含已捕获的语音样本");
});

test("纯静音即使 flush 也不产出分段（不制造幻觉输入）", () => {
	const segmenter = new VoicePcmSegmenter(16000, { frameMs: 20, silenceMs: 650 });
	segmenter.push(new Float32Array(16000));
	assert.equal(segmenter.flush().length, 0, "没有语音活动时 flush 不应产出任何分段");
});

test("默认分段窗口：累计 400ms 静音切段、连续说话 10s 封顶", () => {
	// 段长放宽是本次提速决策的一部分：whisper 编码器固定按 30 秒窗口计算，
	// **每段**都要付一次这个成本，所以切得越碎总延迟越高（旧默认 650ms / 5s）。
	const speech = audioFrames([0.2], 320);
	const silence = audioFrames([0], 320);

	const quiet = new VoicePcmSegmenter(16000);
	quiet.push(speech);
	for (let frame = 1; frame < 20; frame += 1) assert.equal(quiet.push(silence).length, 0, `仅 ${frame} 帧静音（${frame * 20}ms）不该切段`);
	assert.equal(quiet.push(silence).length, 1, "静音累计到 400ms 必须切段，否则段尾拖长");

	const long = new VoicePcmSegmenter(16000);
	const chunks = [];
	for (let frame = 0; frame < 500; frame += 1) chunks.push(...long.push(speech));
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].length, 160000, "连续说话满 10 秒要封顶切段，把段数减半");
});
