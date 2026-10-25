import assert from "node:assert/strict";
import test from "node:test";

/**
 * VideoJobRunner 生命周期：提交受理即持久化占位、轮询到终态、事件对账、
 * 取消、恢复窗口、错误分类。fetch/timer/时钟全部注入替身，不联网。
 */

const { loadTsCommonJs } = await import("./helpers/loadTsCommonJs.mjs");
const { VideoJobRunner } = loadTsCommonJs("src/main/videogen/VideoJobRunner.ts");

function jsonResponse(payload, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => payload,
		text: async () => JSON.stringify(payload),
		headers: { get: () => "application/json" },
	};
}

function makeHarness({ submitResponse, queryResponses = [], credentials } = {}) {
	const emitted = [];
	const persistedMessages = [];
	const savedJobs = [];
	const timerQueue = [];
	let clock = 1_000_000;
	let queryIndex = 0;
	const runner = new VideoJobRunner({
		loadJobs: async () => [],
		saveJobs: async (jobs) => {
			savedJobs.push(jobs.map((job) => ({ ...job })));
		},
		getCredentials: async () => (credentials === undefined ? { baseUrl: "https://gw.example.com", apiKey: "sk", protocol: "minimax-v2", name: "GW" } : credentials),
		putVideo: async () => "a".repeat(64) + ".mp4",
		persistMessages: async (sessionId, messages) => {
			persistedMessages.push({ sessionId, messages });
		},
		emit: (snapshot) => emitted.push(snapshot),
		log: () => undefined,
		fetchImpl: async (url) => {
			if (url.endsWith("/video_generation") || url.endsWith("/generations/tasks")) return submitResponse ?? jsonResponse({ task_id: "t1" });
			if (url.includes("/query/") || url.includes("/generations/tasks/")) {
				const response = queryResponses[Math.min(queryIndex, queryResponses.length - 1)];
				queryIndex += 1;
				return response ?? jsonResponse({ status: "succeed", content: { url: "https://cdn.example.com/v.mp4" } });
			}
			// 产物下载
			return jsonResponse({ ignored: true });
		},
		now: () => clock,
		sleep: async () => undefined,
		setTimer: (callback) => {
			timerQueue.push(callback);
			return { _fake: true };
		},
		clearTimer: () => undefined,
	});
	return {
		runner,
		emitted,
		persistedMessages,
		savedJobs,
		stepTimers: async (count = 1) => {
			for (let index = 0; index < count; index += 1) {
				const callback = timerQueue.shift();
				if (!callback) return;
				await callback();
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		advanceClock: (ms) => {
			clock += ms;
		},
	};
}

test("submit：受理即持久化占位 + emit queued，messageId 沿用渲染层传入值", async () => {
	const h = makeHarness();
	const result = await h.runner.submit({
		sessionId: "s1",
		messageId: "m-100",
		provider: "vg-p1",
		model: "minimax-h3-max",
		prompt: "一只猫在弹钢琴",
		resolution: "480P",
		duration: "5",
		ratio: "16:9",
	});
	assert.equal(result.ok, true);
	assert.equal(result.messageId, "m-100");
	const snapshot = h.emitted.at(-1);
	assert.equal(snapshot.status, "queued");
	assert.equal(snapshot.messageId, "m-100");
	assert.equal(snapshot.model, "minimax-h3-max");
	// 占位消息已写入会话存储（重启后时间线可恢复）
	assert.equal(h.persistedMessages.length, 1);
	assert.equal(h.persistedMessages[0].sessionId, "s1");
});

test("轮询到 succeeded：下载落盘 → 终态持久化 + emit videoRef", async () => {
	const h = makeHarness({
		queryResponses: [jsonResponse({ task: { status: "queued" } }), jsonResponse({ task: { status: "running" } }), jsonResponse({ task: { status: "succeed", content: { url: "https://cdn.example.com/v.mp4" } } })],
	});
	await h.runner.submit({ sessionId: "s1", messageId: "m-1", provider: "vg-p1", model: "m", prompt: "p" });
	await h.stepTimers(1);
	assert.equal(h.emitted.at(-1).status, "queued"); // 与初始一致则不重复 emit
	await h.stepTimers(1);
	assert.equal(h.emitted.at(-1).status, "running");
	await h.stepTimers(1);
	const final = h.emitted.at(-1);
	assert.equal(final.status, "succeeded");
	assert.match(final.videoRef, /^[0-9a-f]{64}\.mp4$/);
	// 终态再次持久化（同 messageId 覆盖占位）
	assert.equal(h.persistedMessages.length, 2);
});

test("取消：停止轮询并标记 cancelled，后续 tick 不再产生状态迁移", async () => {
	const h = makeHarness({ queryResponses: [jsonResponse({ task: { status: "running" } })] });
	const result = await h.runner.submit({ sessionId: "s1", messageId: "m-1", provider: "vg-p1", model: "m", prompt: "p" });
	assert.equal(result.ok, true);
	const cancelled = await h.runner.cancel(result.jobId);
	assert.equal(cancelled, true);
	assert.equal(h.emitted.at(-1).status, "cancelled");
	const emitCount = h.emitted.length;
	await h.stepTimers(3);
	assert.equal(h.emitted.length, emitCount);
	assert.equal(await h.runner.cancel(result.jobId), false);
});

test("提交 401：结构化 invalidKey，且不产生任何持久化副作用", async () => {
	const h = makeHarness({ submitResponse: jsonResponse({ error: { message: "bad key" } }, 401) });
	const result = await h.runner.submit({ sessionId: "s1", messageId: "m-1", provider: "vg-p1", model: "m", prompt: "p" });
	assert.equal(result.ok, false);
	assert.equal(result.error, "invalidKey");
	assert.equal(result.detail, "401: bad key");
	assert.equal(h.persistedMessages.length, 0);
	assert.equal(h.emitted.length, 0);
});

test("凭据缺失：notConfigured", async () => {
	const h = makeHarness({ credentials: null });
	const result = await h.runner.submit({ sessionId: "s1", messageId: "m-1", provider: "vg-p1", model: "m", prompt: "p" });
	assert.equal(result.ok, false);
	assert.equal(result.error, "notConfigured");
});

test("上游 failed：终态带 errorDetail（厂商文案透传）", async () => {
	const h = makeHarness({
		queryResponses: [jsonResponse({ task: { status: "failed", error: { message: "content policy" } } })],
	});
	await h.runner.submit({ sessionId: "s1", messageId: "m-1", provider: "vg-p1", model: "m", prompt: "p" });
	await h.stepTimers(1);
	const final = h.emitted.at(-1);
	assert.equal(final.status, "failed");
	assert.equal(final.errorDetail, "content policy");
	assert.equal(h.persistedMessages.length, 2);
});

test("网络抖动容忍：连续失败 <10 次不判死，恢复后继续", async () => {
	const h = makeHarness({
		queryResponses: [jsonResponse({}, 500), jsonResponse({}, 502), jsonResponse({ task: { status: "succeed", content: { url: "https://cdn.example.com/v.mp4" } } })],
	});
	await h.runner.submit({ sessionId: "s1", messageId: "m-1", provider: "vg-p1", model: "m", prompt: "p" });
	await h.stepTimers(1);
	await h.stepTimers(1);
	assert.equal(h.emitted.at(-1).status, "queued");
	await h.stepTimers(1);
	assert.equal(h.emitted.at(-1).status, "succeeded");
});

test("轮询超时：超过 20 分钟窗口判 timeout", async () => {
	const h = makeHarness({ queryResponses: [jsonResponse({ task: { status: "running" } })] });
	await h.runner.submit({ sessionId: "s1", messageId: "m-1", provider: "vg-p1", model: "m", prompt: "p" });
	h.advanceClock(21 * 60 * 1000);
	await h.stepTimers(1);
	assert.equal(h.emitted.at(-1).status, "timeout");
});

test("resume：未终态任务恢复轮询；超过 24h 的按超时结清", async () => {
	const fresh = {
		jobId: "j-fresh",
		sessionId: "s1",
		messageId: "m-old-fresh",
		provider: "vg-p1",
		providerName: "GW",
		model: "m",
		prompt: "p",
		protocol: "minimax-v2",
		baseUrl: "https://gw.example.com",
		taskId: "t-fresh",
		status: "running",
		createdAt: 99_000_000,
	};
	const stale = { ...fresh, jobId: "j-stale", messageId: "m-old-stale", taskId: "t-stale", createdAt: 1_000_000 };
	const emitted = [];
	const persistedMessages = [];
	const timerQueue = [];
	let resumed = -1;
	const runner = new VideoJobRunner({
		loadJobs: async () => [fresh, stale],
		saveJobs: async () => undefined,
		getCredentials: async () => ({ baseUrl: "https://gw.example.com", apiKey: "sk", protocol: "minimax-v2" }),
		putVideo: async () => "b".repeat(64) + ".mp4",
		persistMessages: async (sessionId, messages) => persistedMessages.push({ sessionId, messages }),
		emit: (snapshot) => emitted.push(snapshot),
		log: () => undefined,
		fetchImpl: async () => jsonResponse({ task: { status: "succeed", content: { url: "https://cdn.example.com/v.mp4" } } }),
		now: () => 100_000_000,
		sleep: async () => undefined,
		setTimer: (callback) => {
			timerQueue.push(callback);
			return { _fake: true };
		},
		clearTimer: () => undefined,
	});
	resumed = await runner.resume();
	assert.equal(resumed, 1);
	const staleEvent = emitted.find((event) => event.jobId === "j-stale");
	assert.equal(staleEvent.status, "timeout");
	// fresh 任务继续轮询到终态
	await new Promise((resolve) => setImmediate(resolve));
	const callback = timerQueue.shift();
	await callback();
	await new Promise((resolve) => setImmediate(resolve));
	const freshEvent = emitted.filter((event) => event.jobId === "j-fresh").at(-1);
	assert.equal(freshEvent.status, "succeeded");
});
