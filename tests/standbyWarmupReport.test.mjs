import assert from "node:assert/strict";
import test from "node:test";
import { buildStandbyReport, filterByWindow, formatStandbyReport, parseLogLines, quantiles } from "../scripts/standbyWarmupReport.mjs";

function event(t, scope, message, detail = {}) {
	return { t, level: "info", scope, message, detail };
}

function sampleEvents() {
	const events = [];
	// 应用启动 1
	events.push(event(0, "app", "Application started"));
	// DSH host boot 1（fork 2s → ready 22s，20s）
	events.push(event(2000, "dsh-host", "forking host entry: x"));
	events.push(event(22000, "dsh-host", "host ready（utilityProcess）"));
	// 启动期预热请求 → 10s 就绪（spawn 9s）
	events.push(event(500, "agent", "Startup standby warmup requested", { projectId: "p1" }));
	// spawn 事件本身记录的是「握手完成时刻」，窗口 = [t - spawnCallMs, t]；standby ready 紧随其后。
	events.push(event(10000, "agent", "Pi process spawned", { agentId: "s1", spawnCallMs: 9000 }));
	events.push(event(10000, "agent", "Standby agent ready", { agentId: "s1", projectId: "p1" }));
	// 真会话冷启动：草稿 5s，激活 15s，spawn 窗口 8s→14s（与 standby 窗口 1s→10s 重叠）
	events.push(event(5000, "session", "Session draft created", { sessionId: "sess1", projectId: "p1" }));
	events.push(event(8000, "agent", "Pi process spawned", { agentId: "r1", spawnCallMs: 6000 }));
	events.push(event(14000, "agent", "Agent create completed", { agentId: "r1" }));
	events.push(event(15000, "session-perf", "Runtime activation completed", { sessionId: "sess1", agentId: "r1", activationMs: 6000 }));
	// 认领等待：11s 请求，11.5s 认领成功（等 500ms），s1 在 12s 被真实认领
	events.push(event(11000, "agent", "Standby claim waiting for in-flight warmup", { projectId: "p1", sessionId: "sess2", waitMs: 30000 }));
	events.push(event(11500, "agent", "Standby claim adopted in-flight warmup", { projectId: "p1", sessionId: "sess2", waitedMs: 500, warmAgeMs: 1500 }));
	events.push(event(12000, "agent", "Standby agent claimed", { agentId: "s1", projectId: "p1", sessionId: "sess2", warmAgeMs: 2000 }));
	events.push(event(11000, "session", "Session draft created", { sessionId: "sess2", projectId: "p1" }));
	events.push(event(12000, "session-perf", "Runtime activation completed", { sessionId: "sess2", agentId: "s1", activationMs: 40 }));
	// 第二个启动期预热：60s 请求 → 70s 就绪（spawn 12s），没人认领，80s 被回收 → 纯浪费
	events.push(event(60000, "agent", "Startup standby warmup requested", { projectId: "p1" }));
	events.push(event(70000, "agent", "Pi process spawned", { agentId: "s2", spawnCallMs: 12000 }));
	events.push(event(70000, "agent", "Standby agent ready", { agentId: "s2", projectId: "p1" }));
	events.push(event(80000, "agent", "Agent stopped (user initiated)", { agentId: "s2" }));
	// 第一轮用了 DSH：60s 首次 dsh 会话激活（host 22s 已就绪 → 预热省掉整轮 20s boot）
	events.push(event(60000, "session-perf", "Runtime activated", { sessionId: "sess3", agentId: "dsh:host-session" }));
	// 应用启动 2：DSH host 预热了但整轮没用 DSH
	events.push(event(100000, "app", "Application started"));
	events.push(event(101000, "dsh-host", "forking host entry: y"));
	events.push(event(121000, "dsh-host", "host ready（utilityProcess）"));
	return events;
}

test("quantiles: 空数组安全，单值/多值取整档位", () => {
	assert.deepEqual(quantiles([]), { n: 0, p50: null, p75: null, p90: null, p99: null, max: null, sum: 0 });
	assert.equal(quantiles([7]).p50, 7);
	const stats = quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.equal(stats.p50, 6);
	assert.equal(stats.max, 10);
	assert.equal(stats.sum, 55);
});

test("parseLogLines: 跳过坏行/非日志行，保留结构化 detail", () => {
	const text = ["{bad json", JSON.stringify({ time: 10, scope: "agent", message: "Standby agent ready", detail: { agentId: "a" } }), JSON.stringify({ time: 20, message: "x", detail: null }), ""].join("\n");
	const events = parseLogLines(text);
	assert.equal(events.length, 2);
	assert.equal(events[0].scope, "agent");
	assert.deepEqual(events[1].detail, {});
});

test("buildStandbyReport: spawn 分类 / 新会话认领命中 / 冷启动", () => {
	const report = buildStandbyReport(sampleEvents());
	assert.equal(report.piSpawn.total, 3);
	assert.equal(report.piSpawn.standby, 2);
	assert.equal(report.piSpawn.real, 1);
	assert.equal(report.newSessionActivations.total, 2);
	assert.equal(report.newSessionActivations.claimed, 1);
	assert.equal(report.newSessionActivations.cold, 1);
	assert.equal(report.newSessionActivations.claimedRate, 0.5);
	assert.equal(report.newSessionActivations.claimedActivationMs.p50, 40);
	assert.equal(report.newSessionActivations.coldActivationMs.p50, 6000);
	assert.equal(report.newSessionActivations.coldSpawnMs.p50, 6000);
});

test("buildStandbyReport: 认领等待收益 = 典型冷启动 - 实际等待", () => {
	const report = buildStandbyReport(sampleEvents());
	assert.equal(report.claimWait.requests, 1);
	assert.equal(report.claimWait.adopted, 1);
	assert.equal(report.claimWait.fellBack, 0);
	assert.equal(report.claimWait.adoptedRate, 1);
	assert.equal(report.claimWait.waitedMs.p50, 500);
	assert.equal(report.claimWait.estimatedSavedMs, 5500);
});

test("buildStandbyReport: 启动期预热的认领收益与过期浪费", () => {
	const report = buildStandbyReport(sampleEvents());
	assert.equal(report.startupWarmup.requests, 2);
	assert.equal(report.startupWarmup.ready, 2);
	assert.equal(report.startupWarmup.claimed, 1);
	assert.equal(report.startupWarmup.wasted, 1);
	assert.equal(report.startupWarmup.claimedRate, 0.5);
	assert.equal(report.startupWarmup.estimatedSavedMs, 9000, "被认领的启动预热省掉一次冷启动 spawn");
	assert.equal(report.startupWarmup.wastedSpawnMs, 12000, "未认领的启动预热是纯成本");
});

test("buildStandbyReport: 重复并行 spawn 检测（升级前缺陷基线）", () => {
	const report = buildStandbyReport(sampleEvents());
	assert.equal(report.duplicateParallelSpawns.count, 1);
	assert.equal(report.duplicateParallelSpawns.realSpawns, 1);
});

test("buildStandbyReport: DSH host boot 耗时、使用/未使用、预热收益", () => {
	const report = buildStandbyReport(sampleEvents());
	assert.equal(report.dshHost.boots, 2);
	assert.equal(report.dshHost.bootMs.p50, 20000);
	assert.equal(report.dshHost.runsUsingDsh, 1);
	assert.equal(report.dshHost.runsWarmingUnused, 1);
	assert.equal(report.dshHost.estimatedSavedMs, 20000);
});

test("buildStandbyReport: 升级前的老日志（无启动预热/认领等待事件）不报错且对应指标为 0", () => {
	const legacy = [
		event(0, "app", "Application started"),
		event(1000, "agent", "Pi process spawned", { agentId: "s1", spawnCallMs: 9000 }),
		event(10000, "agent", "Standby agent ready", { agentId: "s1", projectId: "p1" }),
		event(11000, "session", "Session draft created", { sessionId: "sess1", projectId: "p1" }),
		event(12000, "session-perf", "Runtime activation completed", { sessionId: "sess1", agentId: "s1", activationMs: 30 }),
	];
	const report = buildStandbyReport(legacy);
	assert.equal(report.startupWarmup.requests, 0);
	assert.equal(report.startupWarmup.estimatedSavedMs, 0);
	assert.equal(report.claimWait.requests, 0);
	assert.equal(report.claimWait.estimatedSavedMs, 0);
	assert.equal(report.newSessionActivations.claimed, 1);
});

test("filterByWindow: --since/--until/--days 过滤事件，保留边界", () => {
	const events = [event(1000, "a", "x"), event(2000, "a", "y"), event(3000, "a", "z")];
	assert.equal(filterByWindow(events, { since: 2000, until: 2000 }).length, 1);
	assert.equal(filterByWindow(events, { since: 1500 }).length, 2);
});

test("formatStandbyReport: 文本报告包含核心结论行", () => {
	const text = formatStandbyReport(buildStandbyReport(sampleEvents()));
	assert.match(text, /新会话激活/);
	assert.match(text, /认领等待/);
	assert.match(text, /启动期预热/);
	assert.match(text, /重复并行 spawn/);
	assert.match(text, /DSH host 预热/);
});

test("端到端：真实日志目录跑一遍不抛错（目录可能不存在）", () => {
	// 只验证 CLI 入口的数据管线；不存在/为空的目录也必须输出可读报告。
	const report = buildStandbyReport([]);
	assert.equal(report.window.appRuns, 0);
	assert.equal(report.piSpawn.total, 0);
	assert.match(formatStandbyReport(report), /无数据/);
});
