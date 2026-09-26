import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/**
 * AudioWorklet 模块字符串必须能在「无模块解析器」的 worklet 作用域里真正跑起来。
 *
 * 这里踩过的两个真实坑，只能靠把模块执行一遍才拦得住（否则只有真人点麦克风才暴露）：
 * 1) `voicePcmSegmenter.ts?raw` 内联的是 TS 源码，不转译就 `addModule` SyntaxError；
 * 2) 剥掉 import/export 后留下未定义引用（如 VOICE_MIN_SPEAKING_PEAK）。
 *
 * 生成逻辑直接调用生产模块的 `createVoicePcmProcessorModuleUrl`（只桩掉 Blob/URL），
 * 避免测试自己拼一份字符串造成「两份真相」。
 */
const MODULE_SOURCE = loadWorkletModuleSource();

function loadWorkletModuleSource() {
	const processorSource = ts.transpileModule(readFileSync("src/renderer/src/utils/voicePcmProcessor.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	// 与 electron.vite.config.ts 的 audioWorkletSegmenterPlugin 同样的转译参数。
	const segmenterSource = ts.transpileModule(readFileSync("src/renderer/src/utils/voicePcmSegmenter.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
	}).outputText;

	let captured = "";
	const moduleScope = { exports: {} };
	vm.runInNewContext(processorSource, {
		module: moduleScope,
		exports: moduleScope.exports,
		require: (specifier) => {
			assert.equal(specifier, "./voicePcmSegmenter.ts?raw", "只允许内联分词器源码");
			// Vite 的 ?raw 导入是 default 导出，转成 CJS 后模块对象需要带 default 字段。
			return { default: segmenterSource };
		},
		Blob: class {
			constructor(parts) {
				captured = parts.join("");
			}
		},
		URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined },
	});
	moduleScope.exports.createVoicePcmProcessorModuleUrl();
	assert.ok(captured, "createVoicePcmProcessorModuleUrl 必须产出模块源码");
	return captured;
}

/** 在模拟的 AudioWorklet 作用域里实例化处理器，返回它回传给主线程的消息。 */
function createProcessor() {
	const messages = [];
	let registered = null;
	vm.runInNewContext(MODULE_SOURCE, {
		AudioWorkletProcessor: class {
			constructor() {
				this.port = { onmessage: null, postMessage: (message) => messages.push(message) };
			}
		},
		registerProcessor: (name, ctor) => {
			registered = { name, ctor };
		},
		sampleRate: 48000,
		Float32Array,
		Math,
		Number,
	});
	assert.ok(registered, "registerProcessor 必须被调用");
	assert.equal(registered.name, "pideck-voice-processor");
	return { processor: new registered.ctor(), messages };
}

test("worklet 模块可执行、注册处理器并把语音段重采样为 16kHz PCM", () => {
	const { processor, messages } = createProcessor();
	// 0.5 秒语音（超过 minSegmentSeconds=0.4），flush 后应产出 0.5s @16kHz。
	processor.process([[new Float32Array(24000).fill(0.4)]]);
	processor.flush();

	const segment = messages.find((message) => message.type === "segment");
	assert.ok(segment, "flush 后必须回传音频段");
	const samples = new Float32Array(segment.audio);
	assert.equal(samples.length, 8000, "0.5s @16kHz 应为 8000 采样");
	assert.ok(Array.from(samples.slice(0, 10)).every((sample) => Math.abs(sample - 0.4) < 1e-6));
	assert.ok(messages.some((message) => message.type === "flushed"));
});

test("纯静音不产出任何分段", () => {
	const { processor, messages } = createProcessor();
	processor.process([[new Float32Array(48000)]]);
	processor.flush();
	assert.equal(messages.filter((message) => message.type === "segment").length, 0);
});

test("长句在静音边界切段，不困在一段里等到停止录音", () => {
	const { processor, messages } = createProcessor();
	// 0.5s 语音 + 1s 静音 → 静音超过 silenceMs(650) 时应立即产出一段。
	const speech = new Float32Array(24000).fill(0.4);
	const silence = new Float32Array(48000);
	processor.process([[speech]]);
	processor.process([[silence]]);
	const firstSegment = messages.find((message) => message.type === "segment");
	assert.ok(firstSegment, "录音进行中（未 flush）就应产出分段，这是边录边出字的前提");

	// 再来 0.5s 语音，flush 后应得到第二段。
	processor.process([[new Float32Array(24000).fill(0.4)]]);
	processor.flush();
	assert.equal(messages.filter((message) => message.type === "segment").length, 2);
});

test("reset 丢弃未完成分段（取消录音不应残留音频）", () => {
	const { processor, messages } = createProcessor();
	processor.process([[new Float32Array(24000).fill(0.4)]]);
	processor.port.onmessage({ data: "reset" });
	processor.flush();
	assert.equal(messages.filter((message) => message.type === "segment").length, 0);
});
