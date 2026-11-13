import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 编译 .ts 模块并在 vm 中加载（相对 import 按源文件目录解析，见 helper 注释）。
 * LiveDuration 只用到 formatDuration，用固定值桩替身（`${ms}ms`）观察 tick 行为。
 */
const loadTsModule = createTsSandbox({
	stubs: { "./TimelineFormat": { formatDuration: (ms) => `${ms}ms` } },
});

test("formatDuration: ms / seconds / minutes / hours buckets", () => {
	const { formatDuration } = loadTsModule("src/renderer/src/components/session/TimelineFormat.ts");
	assert.equal(formatDuration(850), "850ms");
	assert.equal(formatDuration(3200), "3.2s");
	assert.equal(formatDuration(64000), "1m4s");
	assert.equal(formatDuration(120000), "2m");
	// 小时档：长任务（挂机跑几小时）不能只显示分钟（「3120m」读不出来）
	assert.equal(formatDuration(3_600_000), "1h");
	assert.equal(formatDuration(3_720_000), "1h2m");
	assert.equal(formatDuration(3_723_000), "1h2m3s");
	// 分钟为 0 时省略该档位（1h0m3s → 1h3s）
	assert.equal(formatDuration(3_603_000), "1h3s");
	assert.equal(formatDuration(47_000_000), "13h3m20s");
});

test("getToolLiveStartTimestamp: 优先 meta.startedAt，消息 timestamp 被刷新时秒表不归零", () => {
	const { getToolLiveStartTimestamp } = loadTsModule("src/renderer/src/components/session/TimelineFormat.ts");
	// 主进程契约（AgentManager.upsertToolMessage）：tool_execution_start 写入
	// meta.startedAt 后不再变化；message.timestamp 会在每次 tool_execution_update/
	// tool_execution_end 时被刷新（existing.timestamp = Date.now()）。
	// 若以刷新后的 timestamp 为秒表起点，长命令（如 npm test 流式输出期间）
	// 显示会反复归零到几毫秒，结束才突然跳到 durationMs 总时长。
	const refreshedTimestamp = 2_000_000;
	assert.equal(getToolLiveStartTimestamp({ timestamp: refreshedTimestamp, meta: { startedAt: 1_000, status: "running" } }), 1_000);
	// 连续多次 update 后 startedAt 仍保持首值
	assert.equal(getToolLiveStartTimestamp({ timestamp: refreshedTimestamp + 50_000, meta: { startedAt: 1_000, status: "running" } }), 1_000);
	// 无 startedAt（如 DSH 投影消息）：回退消息时间戳（DSH 的 timestamp 本身稳定）
	assert.equal(getToolLiveStartTimestamp({ timestamp: 42_000, meta: { status: "running" } }), 42_000);
	// meta 缺失同样回退
	assert.equal(getToolLiveStartTimestamp({ timestamp: 7 }), 7);
	// startedAt 异常值（非数字/非正数）不采用，避免秒表渲染被 0 吞掉
	assert.equal(getToolLiveStartTimestamp({ timestamp: 7, meta: { startedAt: "abc" } }), 7);
	assert.equal(getToolLiveStartTimestamp({ timestamp: 7, meta: { startedAt: 0 } }), 7);
});

test("LiveDuration: live tick only while streaming, fixed after end", () => {
	const source = readFileSync("src/renderer/src/components/session/LiveDuration.tsx", "utf8");
	// 100ms tick：仅 isStreaming 时启动 interval，结束/卸载清理
	assert.match(source, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 100\)/);
	assert.match(source, /if \(!props\.isStreaming \|\| !active\) return;/);
	assert.match(source, /const active = useSessionPaneActive\(\);/);
	assert.match(source, /clearInterval\(timer\)/);
	// 结束截止：endedAt > 0 时用固定差值，不再依赖 now
	assert.match(source, /ended \?\? now\) - started/);
	// 无 startedAt 不渲染
	assert.match(source, /if \(started == null \|\| started <= 0\) return null;/);
});

test("live turn duration lives in the status bar; the footer only shows the fixed total", () => {
	const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	const actions = readFileSync("src/renderer/src/components/session/turn/TurnRowActions.tsx", "utf8");
	const cards = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
	// 2026-10 用户反馈：轮末单独挂一个实时秒表「有点突兀」→ 实时读数移到状态条，
	// 轮尾只在结束后显示固定耗时，同一个数字不会两处同时跳。
	assert.doesNotMatch(actions, /LiveDuration/);
	assert.match(actions, /\{formatDuration\(props\.duration\)\}/);
	assert.match(turnRow, /const showDuration = isComplete && !isRunLive && duration > 0;/);
	// 状态条秒表：与「正在执行命令…」同行、每段竖线分隔
	assert.match(cards, /runStartedAt=\{props\.runStartedAt\}/);
	assert.match(cards, /elapsedRunMs\(runStartedAt, now, runFrozenAt\)/);
	assert.match(cards, /className="responding-fact"/);
	// 状态条只显示本轮进行中的读数（startedAt 由 SessionMessageTimeline 按轮传入）
	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(timeline, /runStartedAt=\{liveRunTiming\?\.startedAt\}/);
});

test("remaining LiveDuration call sites: thinking block and running tool card", () => {
	const toolCard = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
	const thinking = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
	// ThinkingBlock 思考耗时（新架构在 TimelineEventCards.tsx）
	assert.match(thinking, /<LiveDuration[\s\S]*?startedAt=\{props\.startedAt\}/);
	// 思考流式中即带「思考了」前缀（结束时不蹦文案）
	assert.match(thinking, /thinking\.durationPrefix/);
	// ToolCard 工具耗时：running 时以 meta.startedAt 为秒表起点（消息 timestamp 会被
	// 主进程在每次 update/end 时刷新，直接用会导致流式期间反复归零）
	assert.match(toolCard, /<LiveDuration[\s\S]*?startedAt=\{getToolLiveStartTimestamp\(props\.message\)\}/);
});

test("tool row keeps a fixed duration after completion (no longer hover-only)", () => {
	const toolCard = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
	// 运行时锚：完成态渲染的字符串由 formatDuration 生成，先钉住它的真实输出。
	const { formatDuration } = loadTsModule("src/renderer/src/components/session/TimelineFormat.ts");
	assert.equal(formatDuration(1500), "1.5s");
	assert.equal(formatDuration(870), "870ms");
	// 坏样本：完成态若只把耗时塞进行 tooltip（rowTitleParts），重开会话后用户看到的
	// 工具行没有任何耗时——用户 2026-11 反馈「工具调用没有时间」。
	// 契约：完成态与运行中同一位置渲染，运行中走 LiveDuration，完成走落盘的 durationMs。
	assert.match(toolCard, /\(status === "running" \|\| \(!isAskCard && durationMs !== undefined\)\)/);
	assert.match(toolCard, /\) : status === "running" \? \(/);
	assert.match(toolCard, /formatDuration\(durationMs as number\)/);
	// 位置不变量（2026-11 用户反馈「时间出现的位置，不统一」）：耗时紧贴动词标签、
	// 位于折叠箭头之前，与思考行「思考了 10.2s ›」同构。坏样本：把耗时挪回 chevron
	// 之后（紧跟命令预览），下面的交叉断言转红。
	const toolCardSection = toolCard.slice(toolCard.indexOf("export const ToolCard = memo"), toolCard.indexOf("export const ToolGroupCard = memo"));
	const verbAt = toolCardSection.indexOf("phrase.verb}");
	const durationAt = toolCardSection.indexOf("tabular-nums text-text-tertiary");
	const chevronAt = toolCardSection.indexOf("<ChevronRight size={14}");
	assert.ok(verbAt > 0 && durationAt > 0 && chevronAt > 0, "三个锚点必须都在 ToolCard 段内，否则本断言恒假绿");
	assert.ok(verbAt < durationAt && durationAt < chevronAt, `耗时必须落在动词标签之后、折叠箭头之前：verb=${verbAt} duration=${durationAt} chevron=${chevronAt}`);
});
