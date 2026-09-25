import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// encodeWavPcm 是纯函数（不碰 Web Audio），可直接在 vm 里加载，无需注入 AudioContext。
function loadEncoder() {
	const source = ts.transpileModule(readFileSync("src/renderer/src/utils/voiceWavEncoder.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(source, { module, exports: module.exports, ArrayBuffer, DataView, Math, Float32Array });
	return module.exports;
}

const { VOICE_WAV_SAMPLE_RATE, encodeWavPcm } = loadEncoder();

function ascii(view, offset, length) {
	let out = "";
	for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
	return out;
}

test("encodeWavPcm writes a valid 16kHz mono PCM16 RIFF header", () => {
	const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
	const buffer = encodeWavPcm(samples, VOICE_WAV_SAMPLE_RATE);
	const view = new DataView(buffer);
	const dataBytes = samples.length * 2;

	assert.equal(buffer.byteLength, 44 + dataBytes);
	assert.equal(ascii(view, 0, 4), "RIFF");
	assert.equal(view.getUint32(4, true), 36 + dataBytes);
	assert.equal(ascii(view, 8, 4), "WAVE");
	assert.equal(ascii(view, 12, 4), "fmt ");
	assert.equal(view.getUint32(16, true), 16); // fmt chunk 长度
	assert.equal(view.getUint16(20, true), 1); // PCM 格式
	assert.equal(view.getUint16(22, true), 1); // 单声道
	assert.equal(view.getUint32(24, true), VOICE_WAV_SAMPLE_RATE);
	assert.equal(view.getUint32(28, true), VOICE_WAV_SAMPLE_RATE * 2); // byteRate
	assert.equal(view.getUint16(32, true), 2); // blockAlign
	assert.equal(view.getUint16(34, true), 16); // bitsPerSample
	assert.equal(ascii(view, 36, 4), "data");
	assert.equal(view.getUint32(40, true), dataBytes);
});

test("encodeWavPcm maps float samples to int16 with asymmetric full-scale and clamps", () => {
	// 正满量程 1 → +32767（0x7fff），负满量程 -1 → -32768（0x8000），越界值被夹取。
	const samples = new Float32Array([1, -1, 2, -2, 0]);
	const view = new DataView(encodeWavPcm(samples, VOICE_WAV_SAMPLE_RATE));
	assert.equal(view.getInt16(44, true), 32767);
	assert.equal(view.getInt16(46, true), -32768);
	assert.equal(view.getInt16(48, true), 32767); // 2 夹到 1
	assert.equal(view.getInt16(50, true), -32768); // -2 夹到 -1
	assert.equal(view.getInt16(52, true), 0);
});
