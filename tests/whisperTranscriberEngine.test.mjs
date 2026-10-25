import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const { VOICE_SIMPLIFIED_CHINESE_PROMPT } = createTsSandbox()("src/main/voice/simplifiedChinese.ts");

/**
 * 本地引擎路由（提速决策的行为面）：常驻 whisper-server 是首选，任何不可用都退回
 * 一次性 whisper-cli，而不是让语音输入失效；两条路径共用同一份临时 WAV。
 *
 * 真实进程与磁盘都不碰：spawn / fs / killProcessTree 全部替身，只观察行为。
 */

/**
 * 结果对象来自 vm 沙箱（另一个 realm），原型与测试文件里的字面量不同，
 * deepStrictEqual 会因「非同一引用」直接失败 —— 先按纯数据复制再比较。
 */
async function awaited(promise) {
	const value = await promise;
	const plain = {};
	for (const key of ["ok", "error", "text"]) if (value[key] !== undefined) plain[key] = value[key];
	return plain;
}

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = 4242;
	return child;
}

function harness({ server, cliText = "转写结果", spawnError, manual = false } = {}) {
	const spawnCalls = [];
	const killed = [];
	const children = [];
	const logs = [];
	const load = createTsSandbox({
		stubs: {
			"node:child_process": {
				spawn: (_command, args) => {
					const child = fakeChild();
					children.push(child);
					spawnCalls.push({ command: _command, args });
					// manual：由测试自己决定进程何时落定（取消路径要在途时按停止键）。
					if (manual) return child;
					setImmediate(() => {
						if (spawnError) child.emit("error", spawnError);
						else {
							child.stdout.emit("data", Buffer.from(cliText));
							child.emit("close", 0);
						}
					});
					return child;
				},
			},
			"node:fs/promises": {
				mkdir: async () => undefined,
				writeFile: async () => undefined,
				rm: async () => undefined,
			},
			"../git/gitProcess": {
				killProcessTree: (pid) => {
					killed.push(pid);
					const child = children[children.length - 1];
					setImmediate(() => child?.emit("close", 1));
				},
			},
		},
	});
	const { WhisperTranscriber } = load("src/main/voice/WhisperTranscriber.ts");
	const transcriber = new WhisperTranscriber({
		manager: {
			resolveCliPath: () => "C:/runtime/whisper-cli.exe",
			modelPath: () => "C:/runtime/models/small.ggml",
		},
		server,
		getTempRoot: () => "tmp",
		log: (message, details) => logs.push({ message, details }),
	});
	return { transcriber, spawnCalls, killed, logs, children };
}

const baseInput = { requestId: "req-1", audio: new ArrayBuffer(64), mimeType: "audio/wav", cliPath: "", modelId: "small-q5_1", language: "zh" };

test("常驻 server 命中时不再启动 whisper-cli（模型不重载）", async () => {
	const server = { transcribe: async () => ({ status: "ok", text: "  你好  " }), cancel: () => undefined };
	const { transcriber, spawnCalls } = harness({ server });
	assert.deepEqual(await awaited(transcriber.transcribe(baseInput)), { ok: true, text: "你好" });
	assert.equal(spawnCalls.length, 0, "server 成功就绝不回退，否则等于白等一次模型加载");
});

test("server 不可用时回退 whisper-cli，并带上贪心解码参数", async () => {
	const server = { transcribe: async () => ({ status: "fallback", error: "start-failed" }), cancel: () => undefined };
	const { transcriber, spawnCalls, logs } = harness({ server });
	assert.deepEqual(await awaited(transcriber.transcribe(baseInput)), { ok: true, text: "转写结果" });
	assert.equal(spawnCalls.length, 1);
	const args = spawnCalls[0].args;
	// 回退路径必须与 server 用同一套解码参数，否则「慢一倍」会在回退时突然出现。
	assert.ok(args.includes("-bo") && args[args.indexOf("-bo") + 1] === "1", "best_of 必须为 1");
	assert.ok(args.includes("-bs") && args[args.indexOf("-bs") + 1] === "1", "beam_size 必须为 1");
	assert.ok(args.includes("-nf"), "关闭温度回退");
	assert.equal(args[args.indexOf("--prompt") + 1], VOICE_SIMPLIFIED_CHINESE_PROMPT);
	assert.ok(args.includes("--carry-initial-prompt"));
	assert.equal(args[args.indexOf("-l") + 1], "zh");
	assert.equal(
		logs.some((entry) => entry.message.includes("falling back")),
		true,
		"回退要留日志，否则用户只看到变慢",
	);
});

test("未注入 server（自定义 cliPath 旁没有 whisper-server）时直接走 CLI", async () => {
	const { transcriber, spawnCalls } = harness({});
	assert.deepEqual(await awaited(transcriber.transcribe(baseInput)), { ok: true, text: "转写结果" });
	assert.equal(spawnCalls.length, 1);
});

test("空语言不传 -l，交给 whisper 自动检测", async () => {
	const { transcriber, spawnCalls } = harness({});
	await transcriber.transcribe({ ...baseInput, language: "  " });
	assert.equal(spawnCalls[0].args.includes("-l"), false);
});

test("server 报 cancelled：直接结束，不回退 CLI（用户点了停止就不该再转）", async () => {
	const server = { transcribe: async () => ({ status: "cancelled" }), cancel: () => undefined };
	const { transcriber, spawnCalls } = harness({ server });
	assert.deepEqual(await awaited(transcriber.transcribe(baseInput)), { ok: false, error: "cancelled" });
	assert.equal(spawnCalls.length, 0);
});

test("cancel 同时中断 server 与在途 whisper-cli 进程树", async () => {
	// server 桩模仿真实池：cancel(requestId) 让在途 transcribe 以 cancelled 落定。
	const cancelled = [];
	let settleTranscribe;
	const server = {
		transcribe: () => new Promise((resolvePromise) => (settleTranscribe = resolvePromise)),
		cancel: (requestId) => {
			cancelled.push(requestId);
			settleTranscribe?.({ status: "cancelled" });
		},
	};
	const { transcriber, killed } = harness({ server });
	const pending = transcriber.transcribe(baseInput);
	await new Promise((resolvePromise) => setImmediate(resolvePromise));
	transcriber.cancel("req-1");
	assert.deepEqual(cancelled, ["req-1"], "取消必须先递给常驻 server，否则要等它自己跑完");
	assert.deepEqual(await awaited(pending), { ok: false, error: "cancelled" });
	assert.deepEqual(killed, [], "server 路径没有 CLI 进程，不该去杀进程树");

	const cli = harness({ manual: true });
	const running = cli.transcriber.transcribe(baseInput);
	await new Promise((resolvePromise) => setImmediate(resolvePromise));
	cli.transcriber.cancel("req-1");
	assert.deepEqual(cli.killed, [4242]);
	assert.deepEqual(await awaited(running), { ok: false, error: "cancelled" });
});
