// 模型请求快照存储（src/main/logging/ModelTrace.ts）的单元测试。
// 覆盖：写入/回读往返、非法 traceId 拒绝（路径穿越防线）、响应行不落盘、
// 清理（按 agent 清空 / 按保留期淘汰）、以及时间线条目构造（direction/summary/data）。
// 加载方式：Node 原生 TS 类型擦除 + createTsSandbox（本模块不 import electron，可直接加载）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const mod = createTsSandbox()("src/main/logging/ModelTrace.ts");

/** 测试用请求快照（字段与 ModelTraceRecord 对齐）。 */
function makeRecord(overrides = {}) {
	return {
		kind: "request",
		traceId: "m1abc-xyz",
		ts: 1_750_000_000_000,
		model: "claude-sonnet-4",
		provider: "anthropic",
		sessionId: "session-1",
		payloadJson: '{"model":"claude-sonnet-4"}',
		payloadBytes: 26,
		truncated: false,
		agentId: "agent-1",
		...overrides,
	};
}

const roots = [];
function makeStore() {
	const root = mkdtempSync(join(tmpdir(), "pideck-model-trace-"));
	roots.push(root);
	return { store: new mod.ModelTraceStore(root), root };
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("ModelTraceStore: 写入与回读", () => {
	it("写入后可按 agentId + traceId 回读（payloadJson 原样保留）", async () => {
		const { store } = makeStore();
		const record = makeRecord({ payloadJson: '{"messages":[{"role":"user","content":"你好"}]}', truncated: true, payloadBytes: 999_999 });
		await store.write(record);
		const read = await store.read("agent-1", "m1abc-xyz");
		assert.ok(read, "应能读回");
		assert.equal(read.payloadJson, record.payloadJson);
		assert.equal(read.truncated, true);
		assert.equal(read.payloadBytes, 999_999);
	});

	it("不存在的 traceId 回读为 null（不抛错）", async () => {
		const { store } = makeStore();
		assert.equal(await store.read("agent-1", "never-written"), null);
	});

	it("非法 traceId 读与写都被拒绝（文件名是拼接的，防路径穿越）", async () => {
		const { store } = makeStore();
		for (const bad of ["../escape", "a/b", "x".repeat(65), ""]) {
			assert.equal(await store.read("agent-1", bad), null, `read 应拒绝 ${bad}`);
			await assert.rejects(() => store.write(makeRecord({ traceId: bad })), `write 应拒绝 ${bad}`);
		}
	});

	it("内容被外部改坏时回读为 null（不把半截 JSON 抛给面板）", async () => {
		const { store, root } = makeStore();
		await store.write(makeRecord());
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(root, "model-agent-1-m1abc-xyz.json"), "{ not json", "utf8");
		assert.equal(await store.read("agent-1", "m1abc-xyz"), null);
	});

	it("同名文件里存的是响应行（kind 不符）时回读为 null", async () => {
		const { store } = makeStore();
		await store.write(makeRecord({ kind: "response" }));
		assert.equal(await store.read("agent-1", "m1abc-xyz"), null, "响应行不该在 traces 里被当成请求回读");
	});
});

describe("ModelTraceStore: 统计与清理", () => {
	it("getSize 统计目录占用，可按 agent 过滤", async () => {
		const { store } = makeStore();
		await store.write(makeRecord({ traceId: "t1", payloadJson: "x".repeat(100) }));
		await store.write(makeRecord({ traceId: "t2", payloadJson: "y".repeat(100) }));
		await store.write(makeRecord({ agentId: "agent-2", traceId: "t3", payloadJson: "z".repeat(100) }));
		const all = await store.getSize();
		const onlyAgent1 = await store.getSize("agent-1");
		assert.ok(all > onlyAgent1, "总占用应大于单 agent");
		assert.ok(onlyAgent1 >= 200, `agent-1 至少 200 字节，实际 ${onlyAgent1}`);
	});

	it("clear 可按 agent 清空，其余 agent 的文件保留", async () => {
		const { store } = makeStore();
		await store.write(makeRecord({ traceId: "t1" }));
		await store.write(makeRecord({ agentId: "agent-2", traceId: "t2" }));
		await store.clear("agent-1");
		assert.equal(await store.read("agent-1", "t1"), null, "agent-1 的文件应被清掉");
		assert.ok(await store.read("agent-2", "t2"), "其他 agent 的文件不应受影响");
	});

	it("prune 淘汰超过保留期的旧文件、保留新文件", async () => {
		const { store, root } = makeStore();
		await store.write(makeRecord({ traceId: "old" }));
		await store.write(makeRecord({ traceId: "fresh" }));
		// 把 old 的 mtime 拨到 40 天前（超过 30 天保留期）
		const longAgo = new Date(Date.now() - 40 * 86_400_000);
		utimesSync(join(root, "model-agent-1-old.json"), longAgo, longAgo);
		const result = await store.prune();
		assert.equal(result.removed, 1);
		assert.equal(await store.read("agent-1", "old"), null);
		assert.ok(await store.read("agent-1", "fresh"), "保留期内文件不该被清");
	});
});

describe("buildModelTraceLogEntry: 时间线紧凑条目", () => {
	it("请求行：direction=model，summary 含模型/条数/体积与截断标记", () => {
		const entry = mod.buildModelTraceLogEntry("agent-1", {
			kind: "request",
			traceId: "t-1",
			ts: 1_750_000_000_000,
			model: "claude-sonnet-4",
			provider: "anthropic",
			payloadJson: "{}",
			payloadBytes: 2_097_152,
			truncated: true,
			messageCount: 12,
			toolCount: 5,
		});
		assert.equal(entry.direction, "model");
		assert.equal(entry.agentId, "agent-1");
		assert.equal(entry.time, 1_750_000_000_000);
		assert.equal(entry.summary, "claude-sonnet-4 · 12 msgs · 5 tools · 2.0 MB (truncated)");
		// vm 沙箱里创建的对象与宿主 realm 的原型不同，深比较前先 JSON 归一
		assert.deepEqual(JSON.parse(JSON.stringify(entry.data)), {
			kind: "request",
			traceId: "t-1",
			model: "claude-sonnet-4",
			provider: "anthropic",
			messageCount: 12,
			toolCount: 5,
			payloadBytes: 2_097_152,
			truncated: true,
		});
		// 完整请求体不进条目（保存/复制路径都靠 traceId 回读）
		assert.equal(JSON.stringify(entry).includes("messages"), false);
	});

	it("请求行：字段缺失时用占位符，不抛错", () => {
		const entry = mod.buildModelTraceLogEntry("agent-1", { kind: "request", traceId: "t-2", ts: 0, payloadJson: "{}", payloadBytes: 512, truncated: false });
		assert.match(entry.summary, /^unknown-model · 512 B$/);
		assert.ok(Number.isFinite(entry.time) && entry.time > 0, "ts 非法时回落到当前时间");
	});

	it("响应行：summary 是 HTTP 状态 + 秒级耗时", () => {
		const entry = mod.buildModelTraceLogEntry("agent-1", { kind: "response", traceId: "t-1", ts: 1_750_000_000_500, status: 200, durationMs: 1234 });
		assert.equal(entry.direction, "model");
		assert.equal(entry.summary, "HTTP 200 · 1.2s");
		assert.deepEqual(JSON.parse(JSON.stringify(entry.data)), { kind: "response", traceId: "t-1", status: 200, durationMs: 1234 });
	});

	it("响应行：没有耗时（终态失败路径）时不拼耗时段", () => {
		const entry = mod.buildModelTraceLogEntry("agent-1", { kind: "response", traceId: "t-1", ts: 1_750_000_000_500, status: 502 });
		assert.equal(entry.summary, "HTTP 502");
	});
});

describe("ModelTraceStore: 有界回读", () => {
	it("超过回读上限的快照按损坏处理返回 null（内存保护，摘要不受影响）", async () => {
		const { store, root } = makeStore();
		// 稀疏文件：瞬时占位 65MB（上限 64MB），不实际写内容
		const bigPath = join(root, "model-agent-big-tracetoolong000000000000000001.json");
		const fsPromises = await import("node:fs/promises");
		const handle = await fsPromises.open(bigPath, "w");
		try {
			await handle.truncate(65 * 1024 * 1024);
		} finally {
			await handle.close();
		}
		assert.equal(await store.read("agent-big", "tracetoolong000000000000000001"), null);
	});
});
