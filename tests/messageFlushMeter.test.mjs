import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// Phase 0 投递计量（docs/acp-replay-batching-plan.md）：只记录、不改投递行为。
// 关闭时必须与直接 emit 完全等价，否则「测量」本身就成了新的行为变更。
const meter = loadTsCommonJs("src/main/perf/messageFlushMeter.ts");

const sample = (overrides = {}) => ({ backend: "acp", agentId: "agent-1", delivered: 3, total: 300, bytes: 1024, emitMs: 1, ...overrides });

test("disabled meter passes the payload through untouched", () => {
	delete process.env.PIDECK_PERF_LOG;
	const seen = [];
	const payload = { agentId: "a1", messages: [{ id: "m1" }], totalLength: 1 };
	meter.emitAgentMessageMeasured("acp", "a1", payload, (value) => seen.push(value));
	// 同一个对象引用透传，不复制、不改写
	assert.equal(seen.length, 1);
	assert.equal(seen[0], payload);
});

test("aggregates per backend without keeping every sample", () => {
	const lines = [];
	const instance = meter.createMessageFlushMeter({ enabled: () => true, log: (line) => lines.push(line), logIntervalMs: 0, measureBytes: () => 0 });
	instance.record(sample({ bytes: 2048, delivered: 5, emitMs: 2 }));
	instance.record(sample({ bytes: 4096, delivered: 9, emitMs: 7, windowStart: 12 }));
	instance.record(sample({ bytes: 1024, delivered: 1, emitMs: 1, upsertFrom: 3 }));
	const [acp] = instance.snapshot();
	assert.equal(acp.flushes, 3);
	assert.equal(acp.maxBytes, 4096);
	assert.equal(acp.maxDelivered, 9);
	assert.equal(acp.maxEmitMs, 7);
	assert.equal(acp.windowed, 1);
	assert.equal(acp.incremental, 1);
	// 只留最近一次样本：不随投递次数涨内存
	assert.equal(acp.last.delivered, 1);
	assert.equal(Object.keys(acp).sort().join(","), "backend,flushes,incremental,last,maxBytes,maxDelivered,maxEmitMs,totalBytes,windowed");
});

test("a single oversized flush is logged immediately", () => {
	const lines = [];
	const instance = meter.createMessageFlushMeter({ enabled: () => true, log: (line) => lines.push(line), logIntervalMs: 60_000, largeFlushBytes: 1024 });
	instance.record(sample({ bytes: 512 }));
	assert.equal(lines.length, 0);
	instance.record(sample({ bytes: 2048, delivered: 800, total: 800 }));
	assert.equal(lines.length, 1);
	assert.match(lines[0], /flush-large acp .*bytes=2KB delivered=800 total=800/);
});

test("summary is throttled and formatter reports the comparison numbers", () => {
	let now = 0;
	const lines = [];
	const instance = meter.createMessageFlushMeter({ enabled: () => true, log: (line) => lines.push(line), now: () => now, logIntervalMs: 1000, largeFlushBytes: 1e9 });
	instance.record(sample({ bytes: 2048 }));
	instance.record(sample({ bytes: 2048 }));
	now = 1500;
	instance.record(sample({ bytes: 2048 }));
	const summary = lines.at(-1);
	assert.match(summary, /flush-meter acp flushes=3 maxBytes=2KB/);
	assert.match(summary, /windowed=0\/3 incremental=0\/3/);
	instance.reset();
	assert.equal(instance.snapshot().length, 0);
});

test("every agents:message emit point goes through the meter", () => {
	// 绕过计量口就等于 Phase 0 只测到一半；新增后端必须显式选择「计量」或「不计量」。
	for (const file of ["src/main/acp/AcpUpdatePipeline.ts", "src/main/pi/AgentManager.ts", "src/main/dsh/DshAgentManager.ts"]) {
		const source = readFileSync(file, "utf8");
		assert.match(source, /emitAgentMessageMeasured\(/, `${file} 必须经计量口投递 agents:message`);
	}
});
