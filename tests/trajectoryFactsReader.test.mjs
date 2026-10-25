import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 轨迹事实读取器单测（计划 §3 S1）。
 *
 * 判定目标（全部是行为，不看内部实现）：
 * - 文件没变时正文读取 0 次，且 version 不变（渲染层据此保引用）；
 * - 普通事件由索引元数据生成，不占正文预算；
 * - 候选/单行/总量超预算时 readComplete=false，不静默丢；
 * - 同路径并发只物化一次（在途合并）；
 * - fork 祖先缺失时 chainComplete=false，不伪装成完整历史。
 */

const { createTrajectoryFactsReader, MAX_FACT_CANDIDATES, MAX_FACT_LINE_BYTES } = loadTsCommonJs("src/main/sessions/trajectoryFactsReader.ts");

function entry(overrides) {
	return { id: overrides.id, parentId: null, type: "message", role: "user", offset: 0, byteLength: 100, ...overrides };
}

function systemEntry(id, text) {
	const line = JSON.stringify({ type: "message", id, message: { role: "system", content: "", sections: { body: text } } });
	return { entry: entry({ id, role: "system", byteLength: Buffer.byteLength(line) }), line };
}

function makeSource(entries, lines, options = {}) {
	const state = { indexCalls: 0, lineCalls: 0, readEntries: 0, size: options.size ?? 1000, mtimeMs: options.mtimeMs ?? 1, chainMtime: options.chainSources?.[0]?.mtimeMs ?? 1 };
	return {
		state,
		source: {
			async getSessionFactIndex() {
				state.indexCalls += 1;
				if (options.chainSources) options.chainSources[0].mtimeMs = state.chainMtime;
				return {
					hostPath: "/repo/session.jsonl",
					size: state.size,
					mtimeMs: state.mtimeMs,
					entries,
					...(options.chainSources ? { chainSources: options.chainSources.map((source) => ({ ...source })) } : {}),
					...(options.headerParentSession ? { headerParentSession: options.headerParentSession } : {}),
				};
			},
			async readSessionFactLines(_path, requested) {
				state.lineCalls += 1;
				state.readEntries += requested.length;
				return requested.map((candidate) => lines.get(candidate.id) ?? "");
			},
		},
	};
}

test("文件未变时重复读取不读正文，version 保持不变", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source, state } = makeSource([sys], new Map([["sys-1", line]]));
	const reader = createTrajectoryFactsReader({ source });

	const first = await reader.read("/repo/session.jsonl");
	assert.equal(first.events.filter((event) => event.kind === "systemPrompt").length, 1);
	assert.equal(state.lineCalls, 1);

	const second = await reader.read("/repo/session.jsonl");
	assert.equal(state.lineCalls, 1, "缓存命中不得再读正文");
	assert.equal(second.version, first.version);
	assert.equal(second.events, first.events, "相同版本必须复用同一引用");
});

test("普通事件由索引元数据生成，不占正文读取", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source, state } = makeSource([entry({ id: "s1", type: "session", role: undefined, byteLength: 10 }), sys, entry({ id: "m1", type: "model_change", role: undefined, modelChangeProvider: "openai", modelChangeId: "gpt-4.1" })], new Map([["sys-1", line]]));
	const reader = createTrajectoryFactsReader({ source });
	const result = await reader.read("/repo/session.jsonl");
	assert.equal(result.events.map((event) => event.kind).join(","), "session,modelChange,systemPrompt");
	assert.equal(state.readEntries, 1, "只有系统条目需要读正文");
});

test("候选超过上限时标记 readComplete=false 并给出 budget 原因", async () => {
	const entries = [];
	const lines = new Map();
	for (let index = 0; index < MAX_FACT_CANDIDATES + 5; index += 1) {
		const created = systemEntry(`sys-${index}`, `TEXT-${index}`);
		entries.push(created.entry);
		lines.set(created.entry.id, created.line);
	}
	const { source } = makeSource(entries, lines);
	const reader = createTrajectoryFactsReader({ source });
	const result = await reader.read("/repo/session.jsonl");
	assert.equal(result.coverage.readComplete, false);
	assert.equal(result.coverage.reason, "budget");
});

test("单行超过 1MiB 时不读该行并标记 partial", async () => {
	const huge = entry({ id: "sys-huge", role: "system", byteLength: MAX_FACT_LINE_BYTES + 1 });
	const small = systemEntry("sys-ok", "OK");
	const { source, state } = makeSource([huge, small.entry], new Map([["sys-ok", small.line]]));
	const reader = createTrajectoryFactsReader({ source });
	const result = await reader.read("/repo/session.jsonl");
	assert.equal(result.coverage.readComplete, false);
	assert.ok(state.readEntries <= 1, "超限行不得进入正文读取");
	assert.ok(result.events.some((event) => event.kind === "systemPrompt"));
});

test("同路径并发读取只物化一次", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source, state } = makeSource([sys], new Map([["sys-1", line]]));
	const reader = createTrajectoryFactsReader({ source });
	const [left, right] = await Promise.all([reader.read("/repo/session.jsonl"), reader.read("/repo/session.jsonl")]);
	assert.equal(state.indexCalls, 1, "在途请求必须合并");
	assert.equal(left, right);
});

test("fork 祖先未合并时 chainComplete=false，并给出 ancestor-missing", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source } = makeSource([sys], new Map([["sys-1", line]]), { headerParentSession: "/repo/parent.jsonl" });
	const reader = createTrajectoryFactsReader({ source });
	const result = await reader.read("/repo/session.jsonl");
	assert.equal(result.coverage.chainComplete, false);
	assert.equal(result.coverage.reason, "ancestor-missing");
});

test("祖先已合并（chainSources 有记录）时 chainComplete=true", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source } = makeSource([sys], new Map([["sys-1", line]]), {
		headerParentSession: "/repo/parent.jsonl",
		chainSources: [{ hostPath: "/repo/parent.jsonl", size: 1, mtimeMs: 1 }],
	});
	const reader = createTrajectoryFactsReader({ source });
	const result = await reader.read("/repo/session.jsonl");
	assert.equal(result.coverage.chainComplete, true);
	assert.equal(result.coverage.reason, undefined);
});

test("源文件改版但候选未变时复用事实（version 不变、正文不重读）", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source, state } = makeSource([sys], new Map([["sys-1", line]]));
	const reader = createTrajectoryFactsReader({ source });
	const first = await reader.read("/repo/session.jsonl");
	state.size = 2000;
	state.mtimeMs = 2;
	const second = await reader.read("/repo/session.jsonl");
	assert.equal(state.lineCalls, 1, "候选集合未变时不必重读正文");
	assert.equal(second.version, first.version, "事实内容未变 → version 必须稳定");
});

test("普通消息追加（候选不变）复用事实，不重读正文", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source, state } = makeSource([sys], new Map([["sys-1", line]]));
	const reader = createTrajectoryFactsReader({ source });
	const first = await reader.read("/repo/session.jsonl");
	state.size += 4096;
	state.mtimeMs += 5;
	const second = await reader.read("/repo/session.jsonl");
	assert.equal(state.lineCalls, 1, "候选集合未变时不得重读旧事实行");
	assert.equal(second.version, first.version);
});

test("祖先文件改版（宿主未变）同样使缓存失效", async () => {
	const { entry: sys, line } = systemEntry("sys-1", "ROOT");
	const { source, state } = makeSource([sys], new Map([["sys-1", line]]), {
		headerParentSession: "/repo/parent.jsonl",
		chainSources: [{ hostPath: "/repo/parent.jsonl", size: 1, mtimeMs: 1 }],
	});
	const reader = createTrajectoryFactsReader({ source });
	await reader.read("/repo/session.jsonl");
	state.chainMtime = 2;
	await reader.read("/repo/session.jsonl");
	assert.equal(state.lineCalls, 2, "祖先版本变化必须重新读取");
});
