import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 轨迹刷新契约（计划 docs/trajectory-session-consumer-plan.md §4 S2）。
 *
 * 为什么用源码断言：hook 依赖 jotai store 与 preload desktopApi，完整执行需要大量 stub；
 * 这里守住几条「一改就会退化回高频重拉」的结构约束。正则一律空白容忍。
 */

const hook = readFileSync("src/renderer/src/hooks/useSessionTrajectorySource.ts", "utf8");
const view = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryView.tsx", "utf8");

test("事实刷新不再挂在 token flush 的 revision/updatedAt 上", () => {
	const effect = hook.slice(hook.indexOf("readProcessEvents"), hook.indexOf("readProcessEvents") + 200);
	assert.match(effect, /readProcessEvents/);
	// 事实 effect 的依赖必须只来自语义触发键，不能含 cachedEntry 的 revision/updatedAt。
	const deps = hook.match(/\}\s*,\s*\[([^\]]*factsTriggerKey[^\]]*)\]/);
	assert.ok(deps, "事实 effect 依赖应包含 factsTriggerKey");
	assert.doesNotMatch(hook.slice(0, hook.indexOf("modelTraces")), /\[\s*sessionId\s*,\s*cachedEntry\?\.revision/);
});

test("触发键包含运行代次与回合/压缩状态（旧 runtime 的迟到结果不能覆盖当前数据）", () => {
	assert.match(hook, /factsTriggerKey\s*=\s*\[[^\]]*runtime\?\.runtimeGeneration/);
	assert.match(hook, /factsTriggerKey\s*=\s*\[[^\]]*turnRunning/);
	assert.match(hook, /factsTriggerKey\s*=\s*\[[^\]]*compacting/);
	assert.match(hook, /isSessionTurnRunning\s*\(/);
	assert.match(hook, /state\?\.isCompacting\s*===\s*true/);
});

test("兜底轮询只在会话活动时启动，并在清理时停止", () => {
	assert.match(hook, /setInterval\(\s*run\s*,\s*5000\s*\)/);
	assert.match(hook, /clearInterval\(\s*timer\s*\)/);
	assert.match(hook, /turnRunning\s*\|\|\s*compacting\s*\?\s*setInterval/);
});

test("单在途 + 待刷新标记 + 作用域作废", () => {
	assert.match(hook, /if\s*\(\s*inflight\s*\)\s*\{/);
	assert.match(hook, /pending\s*=\s*true/);
	assert.match(hook, /processSequenceRef\.current\s*!==\s*scope/);
	assert.match(hook, /processSequenceRef\.current\s*\+=\s*1/);
});

test("相同事实版本保持渲染引用，失败不清空旧数据", () => {
	assert.match(hook, /processVersionRef\.current\s*===\s*version\s*\?\s*previous\s*:\s*events/);
	const catchBlock = hook.slice(hook.indexOf("readProcessEvents"));
	assert.doesNotMatch(catchBlock.slice(0, catchBlock.indexOf("factsTriggerKey") > 0 ? catchBlock.indexOf("factsTriggerKey") : 600), /setProcessEvents\(\[\]\)/);
});

test("模型请求快照不再跟消息条数刷新", () => {
	assert.doesNotMatch(hook, /messages\.length\]\s*\)/);
});

test("hover 不再触发轨迹模型重算，活动时长走 1 秒低频时钟", () => {
	assert.doesNotMatch(view, /onHoverTick/);
	assert.doesNotMatch(view, /onHoverTick\s*=/);
	assert.match(view, /if\s*\(\s*!hasInFlight\s*\)\s*return;/);
	assert.match(view, /setInterval\(\(\)\s*=>\s*setNow\(Date\.now\(\)\),\s*1000\)/);
});

test("后端不可用时自动重试且有上限（DSH host 未就绪不再永久空白）", () => {
	assert.match(hook, /result\?\.coverage\.reason === "unavailable" && retries < 12/);
	assert.match(hook, /retryTimer = setTimeout\(run, 5000\)/);
	assert.match(hook, /if \(retryTimer\) clearTimeout\(retryTimer\)/);
});
