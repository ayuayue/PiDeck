import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归守卫：心跳快照里的 projects_total 取自 projectStore.list()，而项目表在 index.ts 装配时是
// 异步加载的（窗口先显示、随后 load，见 projectStoreLoadPromise 处注释）。历史上心跳发在 load()
// 之前，导致 2026-10 线上 389 条快照的 projects_total 全为 0 —— 静默错了几天没人发现。
// 这里锁住「唯一的心跳调用点必须挂在项目表加载之后」，防止有人把调用挪回启动早期。
const source = readFileSync("src/main/index.ts", "utf8");

test("telemetry heartbeat call site is chained after the project store load", () => {
	// 去掉函数定义本身（`function sendTelemetryHeartbeat() {`），只留调用点。
	const withoutDefinition = source.replace(/function\s+sendTelemetryHeartbeat\s*\([^)]*\)\s*\{/, "");
	const calls = [...withoutDefinition.matchAll(/sendTelemetryHeartbeat\(\)/g)];

	assert.equal(calls.length, 1, "expected exactly one sendTelemetryHeartbeat() call site in src/main/index.ts");

	const callIndex = calls[0].index;
	const preceding = withoutDefinition.slice(Math.max(0, callIndex - 200), callIndex);
	assert.match(preceding, /projectStore(?:Ready|LoadPromise)\s*\.\s*(?:then|catch)/, "sendTelemetryHeartbeat() must be chained after projectStore.load() so projects_total is populated");
});
