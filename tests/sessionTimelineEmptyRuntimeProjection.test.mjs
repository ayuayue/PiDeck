/**
 * 空 runtime 投影不得让时间线永久停在「正在加载历史」。
 *
 * 现场（2026-10-08，Linux fork/copy）：主进程把坏路径的 ENOENT 当「空历史」返回
 * → 运行时下发 0 条的全量 flush → 渲染层写入 source="runtime"、messages=[] 的缓存
 * 条目 → 时间线挂载 effect 命中 `if (cachedEntry || knownEmpty) return` 跳过磁盘
 * 读取 → loadState 永远停在 undefined → deriveSessionSurfaceRuntime 把 undefined
 * 钉成 loading → 骨架屏永驻。
 *
 * 契约：初始磁盘加载的跳过条件必须是「已拿到真实内容」：
 *   - knownEmpty（草稿/无文件无消息）→ 跳过，起始页是合法终态；
 *   - 缓存条目非空（runtime 或 disk 来源都算真实内容）→ 跳过；
 *   - 缓存条目为空但来源是 disk → 跳过（磁盘已应答，空即空会话终态）；
 *   - 缓存条目为空且来源是 runtime → **不得跳过**：这是唯一能区分
 *     「会话本来就空」与「读盘还没应答/失败」的状态，必须读盘，
 *     让磁盘给出 ready（空会话起始页）或 error（错误卡片 + 重试）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const sandbox = createTsSandbox({
	stubs: {
		"../atoms": {},
		"../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
		"../desktopApi": {},
		"../i18n": { t: (key) => key },
		"./timeline/autoExpandThreshold": { TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120, resolveAutoExpandThreshold: (h) => Math.max(120, Math.round(h * 0.4)) },
		"./timeline/scrollHistoryPolicy": {},
		"../components/session/timeline/turnRenderWindow": {
			TIMELINE_MOUNTED_TURN_LIMIT: 3,
			TIMELINE_SCROLLED_TURN_LIMIT: 3,
			TIMELINE_WINDOW_EXPAND_STEP: 3,
		},
	},
	globals: { Date },
});
const timeline = sandbox("src/renderer/src/hooks/useSessionTimelineController.ts");
const { shouldSkipInitialDiskLoad } = timeline;

test("empty runtime projection must still trigger the initial disk load", () => {
	// 现场形态：runtime 全量 flush 了 0 条。跳过读盘 = 骨架屏永驻。
	assert.equal(shouldSkipInitialDiskLoad({ source: "runtime", messages: [] }, false), false);
});

test("non-empty cache entries keep skipping the disk load (fast path)", () => {
	assert.equal(shouldSkipInitialDiskLoad({ source: "runtime", messages: [{ id: "m1" }] }, false), true);
	assert.equal(shouldSkipInitialDiskLoad({ source: "disk", messages: [{ id: "m1" }] }, false), true);
});

test("disk-sourced empty cache is a legitimate terminal empty session", () => {
	// 磁盘已应答「这个会话就是空的」：跳过，起始页是终态（不得反复读盘）。
	assert.equal(shouldSkipInitialDiskLoad({ source: "disk", messages: [] }, false), true);
});

test("known-empty sessions skip regardless of cache contents", () => {
	// 草稿/无文件会话：起始页终态，不读盘（空会话输入一半切回不闪骨架）。
	assert.equal(shouldSkipInitialDiskLoad(undefined, true), true);
	assert.equal(shouldSkipInitialDiskLoad({ source: "runtime", messages: [] }, true), true);
});

test("missing cache entry still loads from disk (LRU self-heal contract)", () => {
	assert.equal(shouldSkipInitialDiskLoad(undefined, false), false);
});

test("controller effect must consult shouldSkipInitialDiskLoad", () => {
	// 回归保险：effect 里不得再裸判断 `cachedEntry ||`（空 runtime 条目会误跳读盘）。
	const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	assert.match(source, /shouldSkipInitialDiskLoad\(cachedEntry, knownEmpty\)/);
	// 原裸判断必须消失（含空条目误判的根源）。
	assert.doesNotMatch(source, /if \(cachedEntry \|\| knownEmpty\) return/);
});
