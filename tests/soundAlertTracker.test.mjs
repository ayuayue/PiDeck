import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTracker() {
	const source = readFileSync("src/main/sounds/soundAlertTracker.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	// tracker 现在运行时依赖 shared/types/soundAlert（预设/解析/钳制常量）：
	// 用 host 侧加载的同源模块做 require 垫片，保证常量与生产一致。
	const soundAlertModule = loadSoundAlertCommonJs();
	const requireShim = (id) => {
		if (id.includes("shared/types/soundAlert")) return soundAlertModule;
		throw new Error(`Unexpected require: ${id}`);
	};
	vm.runInNewContext(outputText, { module, exports: module.exports, require: requireShim }, {
		filename: "soundAlertTracker.ts",
	});
	return module.exports;
}

function loadSoundAlertCommonJs() {
	const source = readFileSync("src/shared/types/soundAlert.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	vm.runInNewContext(outputText, { module, exports: module.exports }, {
		filename: "soundAlert.ts",
	});
	return module.exports;
}

const T = loadTracker();
const create = () => T.createSoundAlertTrackerState();
const tab = (id, status, title = `Agent-${id}`) => ({ id, status, title });

/** vm 上下文的数组与宿主 Array 原型不同，deepEqual 会判「结构同但引用不同」；统一 JSON 序列化比较。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test("error edge fires only on transition into error, not on baseline", () => {
	const state = create();
	// 首帧：只建基线，不提醒（启动时已挂着的错误是历史状态）
	assert.deepEqual(plain(T.trackAgentTabs(state, [tab("a1", "error")], 1000)), []);
	// 第二次仍为 error：不重复提醒
	assert.deepEqual(plain(T.trackAgentTabs(state, [tab("a1", "error")], 2000)), []);
	// 恢复再出错：边沿触发
	assert.deepEqual(plain(T.trackAgentTabs(state, [tab("a1", "idle")], 3000)), []);
	const events = T.trackAgentTabs(state, [tab("a1", "error")], 4000);
	assert.equal(events.length, 1);
	assert.equal(events[0].kind, "error");
	assert.equal(events[0].agentId, "a1");
});

test("closed agents are pruned and do not emit", () => {
	const state = create();
	T.trackAgentTabs(state, [tab("a1", "running")], 1000);
	// closed 不算 live：清理残留，后续 error 也不来自它
	assert.deepEqual(plain(T.trackAgentTabs(state, [tab("a1", "closed")], 2000)), []);
	assert.deepEqual(plain(T.trackAgentTabs(state, [], 3000)), []);
	assert.equal(state.lastStatusByAgent.size, 0);
});

test("settled has per-agent 8s cooldown (settled + get_state fallback dedup)", () => {
	const state = create();
	const first = T.trackAgentSettled(state, "a1", "Task", 1000);
	assert.equal(first?.kind, "done");
	// 3 秒内再次 settled：冷却吞掉
	assert.equal(T.trackAgentSettled(state, "a1", "Task", 4000), null);
	// 9 秒后再次触发
	const later = T.trackAgentSettled(state, "a1", "Task", 10000);
	assert.equal(later?.kind, "done");
});

test("settled global cooldown prevents overlapping multi-agent chimes", () => {
	const state = create();
	assert.ok(T.trackAgentSettled(state, "a1", "A", 1000));
	// 同一时刻第二个 Agent 完成：全局 1.5s 冷却吞掉（避免叠音）
	assert.equal(T.trackAgentSettled(state, "a2", "B", 1100), null);
	assert.ok(T.trackAgentSettled(state, "a2", "B", 3000));
});

test("waiting notifies once per batch and resets after clear", () => {
	const state = create();
	const req = (method, requestId, extra = {}) => ({ agentId: "a1", requestId, method, title: "T", ...extra });
	assert.equal(T.trackUiRequest(state, req("select", "r1"), 1000)?.kind, "waiting");
	// 同批第二个请求：不再提醒
	assert.equal(T.trackUiRequest(state, req("confirm", "r2"), 1100), null);
	// 全部清空后可再次提醒
	T.trackUiRequest(state, { ...req("select", "r1"), completed: true }, 1200);
	T.trackUiRequest(state, { ...req("select", "r2"), completed: true }, 1300);
	assert.equal(T.trackUiRequest(state, req("input", "r3"), 5000)?.kind, "waiting");
});

test("non-blocking ui methods do not trigger waiting", () => {
	const state = create();
	const req = (method, requestId) => ({ agentId: "a1", requestId, method, title: "T" });
	assert.equal(T.trackUiRequest(state, req("notify", "r1"), 1000), null);
	assert.equal(T.trackUiRequest(state, req("tool_approval", "r2"), 1100), null);
});

// ── resolveSoundPlayback：设置门控 + 回落（纯函数） ──

const validSettings = () => ({
	enabled: true,
	volume: 0.6,
	done: { enabled: true, sound: "done-bell" },
	error: { enabled: true, sound: "error-alert" },
	waiting: { enabled: false, sound: "waiting-ping" },
});

test("resolveSoundPlayback returns payload when enabled", () => {
	const payload = T.resolveSoundPlayback("done", "Task", validSettings());
	assert.equal(payload?.kind, "done");
	assert.equal(payload?.soundId, "done-bell");
	assert.equal(payload?.volume, 0.6);
});

test("resolveSoundPlayback is null when master or event switch off", () => {
	assert.equal(T.resolveSoundPlayback("done", "T", { ...validSettings(), enabled: false }), null);
	assert.equal(T.resolveSoundPlayback("waiting", "T", validSettings()), null); // waiting 默认关
});

test("resolveSoundPlayback falls back to default preset for invalid refs", () => {
	const settings = { ...validSettings(), done: { enabled: true, sound: "custom:../evil.wav" } };
	assert.equal(T.resolveSoundPlayback("done", "T", settings)?.soundId, "done-chime");
});

test("resolveSoundPlayback clamps volume out of range", () => {
	const settings = { ...validSettings(), volume: 5 };
	assert.equal(T.resolveSoundPlayback("done", "T", settings)?.volume, 1);
	const settings2 = { ...validSettings(), volume: -1 };
	assert.equal(T.resolveSoundPlayback("done", "T", settings2)?.volume, 0);
});

test("resolveSoundPlayback returns null for undefined settings (old data)", () => {
	assert.equal(T.resolveSoundPlayback("done", "T", undefined), null);
});
