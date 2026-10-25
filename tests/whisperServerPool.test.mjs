import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 常驻推理进程（whisper-server）的生命周期契约。
 *
 * 判据不是「能不能转出字」（那是真实二进制的事，人工验），而是这几条会在无人值守时
 * 悄悄坏掉的规则：只拉起一次并复用、解码参数走贪心、换模型必须重启、拉不起来必须
 * 熔断并让调用方回退 CLI、退出必须杀进程树。
 */

const loadPool = ({ fetch: fetchImpl, stubs }) => createTsSandbox({ globals: { AbortSignal, Blob, FormData, URL, fetch: fetchImpl }, stubs });

function fakeChild() {
	const child = new EventEmitter();
	child.pid = 4242;
	child.stderr = new EventEmitter();
	child.stdout = new EventEmitter();
	return child;
}

function healthyResponse(body) {
	return { ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

/**
 * 造一套替身：记录 spawn / kill / fetch 调用，测试里只观察行为不碰真实进程。
 */
function harness({ spawnCalls = [], exitImmediately = false, inferenceBody = { text: "你好" }, blockInference = false } = {}) {
	const children = [];
	const killed = [];
	const requests = [];
	let port = 45000;
	const spawn = (command, args) => {
		const child = fakeChild();
		const entry = { command, args, child, alive: true };
		children.push(entry);
		spawnCalls.push({ command, args });
		child.on("exit", () => {
			entry.alive = false;
		});
		if (exitImmediately) queueMicrotask(() => child.emit("exit", 1));
		return child;
	};
	const net = {
		createServer: () => {
			const emitter = new EventEmitter();
			emitter.unref = () => undefined;
			emitter.address = () => ({ port });
			emitter.listen = (_p, _host, cb) => {
				port += 1;
				queueMicrotask(() => cb?.());
			};
			emitter.close = (cb) => queueMicrotask(() => cb?.());
			return emitter;
		},
	};
	const fetchImpl = async (url, init) => {
		const href = String(url);
		if (href.endsWith("/health")) {
			const current = children[children.length - 1];
			// 进程已经退出时连接必然被拒：不这样就测不出「早退」这条路径。
			if (!current?.alive) throw new Error("connect ECONNREFUSED");
			return healthyResponse("OK");
		}
		if (href.endsWith("/inference")) {
			requests.push({ url: href, form: init.body, signal: init.signal });
			if (blockInference) {
				// 真实 fetch 在 abort 时以 AbortError 拒绝，这里保持同样行为。
				return new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
				});
			}
			return healthyResponse(inferenceBody);
		}
		throw new Error(`unexpected url: ${href}`);
	};
	const stubs = {
		"node:child_process": { spawn },
		"node:net": net,
		"node:fs/promises": { readFile: async () => Buffer.from("fake-wav-bytes") },
		"../git/gitProcess": {
			killProcessTree: (pid) => {
				killed.push(pid);
				// 真实进程被 taskkill 后会触发 exit；替身必须同样收尾，否则 waitForExit 白等 2 秒。
				for (const entry of children) if (entry.child.pid === pid) queueMicrotask(() => entry.child.emit("exit", 1));
			},
		},
	};
	const load = loadPool({ fetch: fetchImpl, stubs });
	const { WhisperServerPool } = load("src/main/voice/WhisperServerPool.ts");
	const pool = new WhisperServerPool({
		resolveServerPath: ({ cliPath }) => (cliPath === "" ? null : `${cliPath}/whisper-server.exe`),
		log: () => undefined,
		threads: 4,
		idleStopMs: 20,
		breakerMs: 5000,
	});
	return { pool, children, killed, requests, spawnCalls };
}

const REQUEST = { requestId: "req-1", wavPath: "/tmp/a.wav", cliPath: "/rt/whisper-cli.exe", modelPath: "/m/small.bin", language: "zh" };

test("第一次转写拉起常驻进程，之后的请求复用同一个进程", async () => {
	const h = harness();
	assert.equal(h.children.length, 0, "未转写前不得拉起进程（懒启动）");
	const first = await h.pool.transcribe(REQUEST);
	assert.equal(first.status, "ok");
	assert.equal(first.text, "你好");
	const second = await h.pool.transcribe({ ...REQUEST, requestId: "req-2" });
	assert.equal(second.status, "ok");
	assert.equal(h.children.length, 1, "同模型同 server 的第二次请求必须复用进程");
});

test("解码参数必须是贪心且带简体提示词（默认值会让单段耗时翻倍）", async () => {
	const h = harness();
	await h.pool.transcribe(REQUEST);
	const form = h.requests[0].form;
	assert.equal(form.get("best_of"), "1");
	assert.equal(form.get("beam_size"), "1");
	assert.equal(form.get("temperature_inc"), "0");
	assert.equal(form.get("response_format"), "json");
	assert.equal(form.get("language"), "zh");
	assert.match(form.get("prompt"), /简体中文/);
	assert.equal(form.get("carry_initial_prompt"), "true");
});

test("配置里语言留空时交给自动检测，不能落到 server 默认的英文", async () => {
	const h = harness();
	await h.pool.transcribe({ ...REQUEST, language: "  " });
	assert.equal(h.requests[0].form.get("language"), "auto");
});

test("启动参数只带模型与端口：语言等走请求级字段，换语言不必重启进程", async () => {
	const h = harness();
	await h.pool.transcribe(REQUEST);
	await h.pool.transcribe({ ...REQUEST, requestId: "req-2", language: "en" });
	assert.equal(h.children.length, 1);
	const args = h.children[0].args;
	assert.ok(args.includes("-m"));
	assert.ok(args.includes("--port"));
	assert.ok(!args.includes("-l"), "语言不应固定在启动参数里");
});

test("换模型必须重启进程（模型在启动参数里，复用旧进程会转写出另一个模型的结果）", async () => {
	const h = harness();
	await h.pool.transcribe(REQUEST);
	await h.pool.transcribe({ ...REQUEST, requestId: "req-2", modelPath: "/m/turbo.bin" });
	assert.equal(h.children.length, 2);
	assert.equal(h.killed.length, 1, "旧进程必须被杀，否则模型内存一直挂着");
	assert.deepEqual(h.killed, [4242]);
});

test("健康检查等不到（进程立刻退出）时报可回退，并进入熔断冷却", async () => {
	const h = harness({ exitImmediately: true });
	const result = await h.pool.transcribe(REQUEST);
	assert.equal(result.status, "fallback");
	assert.equal(h.spawnCalls.length, 2, "允许一次重试，但不能无限重试拖慢这一次口述");
	assert.equal(h.pool.coolingDown, true);
	// 熔断期内不再尝试拉起：第二次请求 spawn 次数不变。
	const spawnsBefore = h.spawnCalls.length;
	const second = await h.pool.transcribe({ ...REQUEST, requestId: "req-2" });
	assert.equal(second.status, "fallback");
	assert.equal(h.spawnCalls.length, spawnsBefore, "冷却期内不得反复拉起");
});

test("解析不到 whisper-server 时静默回退（自定义 CLI 旁边没有 server 是常态）", async () => {
	const h = harness();
	const result = await h.pool.transcribe({ ...REQUEST, cliPath: "" });
	assert.equal(result.status, "fallback");
	assert.equal(result.error, "server-unavailable");
	assert.equal(h.children.length, 0);
});

test("空闲超时后自动退出，把模型内存还给用户", async () => {
	const h = harness();
	await h.pool.transcribe(REQUEST);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(h.killed.length, 1);
});

test("cancel 只中断在途请求并报 cancelled，常驻进程保留", async () => {
	const h = harness({ blockInference: true });
	const inFlight = h.pool.transcribe(REQUEST);
	while (h.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	h.pool.cancel(REQUEST.requestId);
	const result = await inFlight;
	assert.equal(result.status, "cancelled");
	assert.equal(h.killed.length, 0, "取消不该杀进程：下一次请求还要复用已加载好的模型");
});

test("shutdown 清掉进程与熔断（换运行时/退出应用后必须能重新拉起）", async () => {
	const h = harness({ exitImmediately: true });
	assert.equal((await h.pool.transcribe(REQUEST)).status, "fallback");
	await h.pool.shutdown("test");
	const afterReset = await h.pool.transcribe(REQUEST);
	// 熔断已清：这次会重新尝试拉起（仍失败，但说明确实又 spawn 了）。
	assert.equal(afterReset.status, "fallback");
	assert.ok(h.spawnCalls.length > 2);
});
