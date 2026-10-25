import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const edgeSrc = readFileSync("src/renderer/src/utils/sessionSplitEdge.ts", "utf8");
const stage = readFileSync("src/renderer/src/components/session/SessionSplitStage.tsx", "utf8");
const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

/** 与 sessionSplitEdge.ts 保持同步的纯函数副本（契约测试）。 */
const SESSION_SPLIT_EDGE_THRESHOLD = 0.28;
const SESSION_SPLIT_MAX_SESSIONS = 4;
const SESSION_SPLIT_ROOT_MAX_PANELS = 3;

function resolveSessionSplitEdge(clientX, clientY, rect, thresholdRatio = SESSION_SPLIT_EDGE_THRESHOLD) {
	if (rect.width <= 0 || rect.height <= 0) return null;
	const x = (clientX - rect.left) / rect.width;
	const y = (clientY - rect.top) / rect.height;
	if (x < 0 || x > 1 || y < 0 || y > 1) return null;
	const distLeft = x;
	const distRight = 1 - x;
	const distTop = y;
	const distBottom = 1 - y;
	const nearest = Math.min(distLeft, distRight, distTop, distBottom);
	if (nearest > thresholdRatio) return null;
	if (nearest === distLeft) return "left";
	if (nearest === distRight) return "right";
	if (nearest === distTop) return "top";
	return "bottom";
}

function splitLayoutSessionIds(layout) {
	const ids = [];
	for (const panel of layout.panels) {
		if (panel.kind === "session") ids.push(panel.sessionId);
		else ids.push(panel.first, panel.second);
	}
	return ids;
}

function countSplitSessions(layout) {
	return splitLayoutSessionIds(layout).length;
}

function isRootSplitPane(layout, sessionId) {
	return layout.panels.some((p) => p.kind === "session" && p.sessionId === sessionId);
}

function replaceSessionInLayout(layout, from, to) {
	return {
		...layout,
		panels: layout.panels.map((panel) => {
			if (panel.kind === "session") {
				return panel.sessionId === from ? { kind: "session", sessionId: to } : panel;
			}
			return {
				...panel,
				first: panel.first === from ? to : panel.first,
				second: panel.second === from ? to : panel.second,
			};
		}),
	};
}

function buildSplitLayoutFromDrop({ hostSessionId, draggedSessionId, edge }) {
	if (!hostSessionId || !draggedSessionId || hostSessionId === draggedSessionId) return null;
	const orientation = edge === "left" || edge === "right" ? "horizontal" : "vertical";
	const first = edge === "left" || edge === "top" ? draggedSessionId : hostSessionId;
	const second = edge === "left" || edge === "top" ? hostSessionId : draggedSessionId;
	return {
		orientation,
		panels: [
			{ kind: "session", sessionId: first },
			{ kind: "session", sessionId: second },
		],
	};
}

function insertRootPaneFromDrop({ layout, draggedSessionId, sessionId, edge }) {
	if (!draggedSessionId || draggedSessionId === sessionId) return null;
	const orientation = edge === "left" || edge === "right" ? "horizontal" : "vertical";
	if (orientation !== layout.orientation) return null;
	if (layout.panels.length >= SESSION_SPLIT_ROOT_MAX_PANELS) return null;
	if (countSplitSessions(layout) >= SESSION_SPLIT_MAX_SESSIONS) return null;
	if (splitLayoutSessionIds(layout).includes(draggedSessionId)) return null;
	const index = findRootPaneIndexForSession(layout, sessionId);
	if (index < 0) return null;
	const insertAt = edge === "left" || edge === "top" ? index : index + 1;
	const panels = [...layout.panels];
	panels.splice(insertAt, 0, { kind: "session", sessionId: draggedSessionId });
	return { ...layout, panels };
}

function nestSplitPaneFromDrop({ layout, draggedSessionId, sessionId, edge }) {
	if (!draggedSessionId || draggedSessionId === sessionId) return null;
	// 同向边缘属根层插入（真多栏），切分只处理垂直方向
	const orientation = edge === "left" || edge === "right" ? "horizontal" : "vertical";
	if (orientation === layout.orientation) return null;
	if (splitLayoutSessionIds(layout).includes(draggedSessionId)) return null;
	if (countSplitSessions(layout) >= SESSION_SPLIT_MAX_SESSIONS) return null;
	const index = layout.panels.findIndex((p) => p.kind === "session" && p.sessionId === sessionId);
	if (index < 0) return null;
	const nested = edge === "left" || edge === "top" ? { kind: "nested", orientation, first: draggedSessionId, second: sessionId } : { kind: "nested", orientation, first: sessionId, second: draggedSessionId };
	const panels = [...layout.panels];
	panels[index] = nested;
	return { ...layout, panels };
}

function resolveSplitHostSessionId({ draggedSessionId, hitSessionId, tabIds }) {
	if (!draggedSessionId || !hitSessionId) return null;
	if (hitSessionId !== draggedSessionId) return hitSessionId;
	const other = tabIds.find((id) => id && id !== draggedSessionId);
	return other ?? null;
}

function findRootPaneIndexForSession(layout, sessionId) {
	for (let i = 0; i < layout.panels.length; i++) {
		const panel = layout.panels[i];
		if (panel.kind === "session" && panel.sessionId === sessionId) return i;
		if (panel.kind === "nested" && (panel.first === sessionId || panel.second === sessionId)) {
			return i;
		}
	}
	return -1;
}

function canAcceptSplitDrop({ layout, draggedSessionId, sessionId, edge, tabCount }) {
	if (!draggedSessionId || !sessionId) return false;
	if (!layout) {
		if (!edge) return false;
		// 单栏拖当前会话自己：需要 Tab 栏里还有其它宿主
		return draggedSessionId !== sessionId || tabCount > 1;
	}
	const ids = splitLayoutSessionIds(layout);
	if (ids.includes(draggedSessionId)) return false;
	if (!edge) {
		// 中心替换：目标必须在布局内
		return ids.includes(sessionId);
	}
	if (edge === "left" || edge === "right") {
		if (layout.orientation !== "horizontal") return false;
		// 根层 <3 栏且总屏 <4（2×2 满员时同向边缘拒绝，避免预览承诺落空）
		return layout.panels.length < SESSION_SPLIT_ROOT_MAX_PANELS && countSplitSessions(layout) < SESSION_SPLIT_MAX_SESSIONS;
	}
	if (layout.orientation !== "vertical") return false;
	return layout.panels.some((p) => p.kind === "session" && p.sessionId === sessionId) && countSplitSessions(layout) < SESSION_SPLIT_MAX_SESSIONS;
}

function replaceSplitPaneFromDrop({ layout, draggedSessionId, sessionId }) {
	if (!draggedSessionId || draggedSessionId === sessionId) return null;
	if (splitLayoutSessionIds(layout).includes(draggedSessionId)) return null;
	if (!splitLayoutSessionIds(layout).includes(sessionId)) return null;
	return replaceSessionInLayout(layout, sessionId, draggedSessionId);
}

function resolveSplitAfterClose(layout, closedSessionId) {
	const panels = layout.panels.map((panel) => {
		if (panel.kind === "session") return panel;
		if (panel.first === closedSessionId) return { kind: "session", sessionId: panel.second };
		if (panel.second === closedSessionId) return { kind: "session", sessionId: panel.first };
		return panel;
	});
	const remaining = panels.filter((p) => !(p.kind === "session" && p.sessionId === closedSessionId));
	if (remaining.length === 0) return null;
	if (remaining.length === 1) {
		const only = remaining[0];
		if (only.kind === "session") return { soloSessionId: only.sessionId };
		return {
			layout: {
				orientation: only.orientation,
				panels: [
					{ kind: "session", sessionId: only.first },
					{ kind: "session", sessionId: only.second },
				],
			},
		};
	}
	return { layout: { ...layout, panels: remaining } };
}

const twoPanes = () => ({
	orientation: "horizontal",
	panels: [
		{ kind: "session", sessionId: "a" },
		{ kind: "session", sessionId: "b" },
	],
});
const nestedLayout = () => ({
	orientation: "horizontal",
	panels: [
		{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
		{ kind: "session", sessionId: "c" },
	],
});
const gridLayout = () => ({
	orientation: "horizontal",
	panels: [
		{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
		{ kind: "nested", orientation: "vertical", first: "d", second: "c" },
	],
});

describe("session split edge resolution", () => {
	const rect = { left: 0, top: 0, width: 1000, height: 800 };

	it("exports shared MIME, types and helpers from source", () => {
		assert.match(edgeSrc, /SESSION_TAB_DRAG_MIME/);
		assert.match(edgeSrc, /export function resolveSessionSplitEdge/);
		assert.match(edgeSrc, /export function buildSplitLayoutFromDrop/);
		assert.match(edgeSrc, /export function insertRootPaneFromDrop/);
		assert.match(edgeSrc, /export function nestSplitPaneFromDrop/);
		assert.match(edgeSrc, /export function replaceSplitPaneFromDrop/);
		assert.match(edgeSrc, /export function resolveSplitAfterClose/);
		assert.match(edgeSrc, /export function resolveSplitHostSessionId/);
		assert.match(edgeSrc, /export function findRootPaneIndexForSession/);
		assert.match(edgeSrc, /export function canAcceptSplitDrop/);
		assert.match(edgeSrc, /export function splitLayoutSessionIds/);
		assert.match(edgeSrc, /export function isRootSplitPane/);
		// 焦点驱动视图：不再自动替换分屏面板（replaceSplitPaneFromFocus 已移除）
		assert.doesNotMatch(edgeSrc, /replaceSplitPaneFromFocus/);
		assert.match(edgeSrc, /SESSION_SPLIT_MAX_SESSIONS/);
		assert.match(edgeSrc, /SESSION_SPLIT_ROOT_MAX_PANELS/);
		assert.match(edgeSrc, /SessionSplitDropTarget/);
		assert.match(edgeSrc, /SESSION_SPLIT_MAX_SESSIONS = 4/);
		assert.match(edgeSrc, /SESSION_SPLIT_ROOT_MAX_PANELS = 3/);
	});

	it("resolves nearest edge inside threshold and ignores center", () => {
		assert.equal(resolveSessionSplitEdge(50, 400, rect), "left");
		assert.equal(resolveSessionSplitEdge(950, 400, rect), "right");
		assert.equal(resolveSessionSplitEdge(500, 40, rect), "top");
		assert.equal(resolveSessionSplitEdge(500, 760, rect), "bottom");
		assert.equal(resolveSessionSplitEdge(500, 400, rect), null);
	});

	it("builds two-pane layout with dragged session on drop side", () => {
		assert.deepEqual(buildSplitLayoutFromDrop({ hostSessionId: "a", draggedSessionId: "b", edge: "right" }), {
			orientation: "horizontal",
			panels: [
				{ kind: "session", sessionId: "a" },
				{ kind: "session", sessionId: "b" },
			],
		});
		assert.deepEqual(buildSplitLayoutFromDrop({ hostSessionId: "a", draggedSessionId: "b", edge: "left" }), {
			orientation: "horizontal",
			panels: [
				{ kind: "session", sessionId: "b" },
				{ kind: "session", sessionId: "a" },
			],
		});
		assert.deepEqual(buildSplitLayoutFromDrop({ hostSessionId: "a", draggedSessionId: "b", edge: "top" }), {
			orientation: "vertical",
			panels: [
				{ kind: "session", sessionId: "b" },
				{ kind: "session", sessionId: "a" },
			],
		});
		assert.equal(buildSplitLayoutFromDrop({ hostSessionId: "a", draggedSessionId: "a", edge: "right" }), null);
	});

	it("splits the hit root pane on perpendicular edges (terminal-style)", () => {
		// [A|B] 拖 C 到 A 上边缘 → A 上下切分，C 在上 → 左上下 + 右侧单栏
		assert.deepEqual(
			nestSplitPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "a",
				edge: "top",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "nested", orientation: "vertical", first: "c", second: "a" },
					{ kind: "session", sessionId: "b" },
				],
			},
		);
		// 拖到 B 下边缘 → B 上下切分，D 在下 → 左单栏 + 右上下
		assert.deepEqual(
			nestSplitPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "d",
				sessionId: "b",
				edge: "bottom",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "a" },
					{ kind: "nested", orientation: "vertical", first: "b", second: "d" },
				],
			},
		);
		// [A;B] 竖排：拖 C 到 A 左边缘 → A 左右切分，C 在左
		assert.deepEqual(
			nestSplitPaneFromDrop({
				layout: { orientation: "vertical", panels: twoPanes().panels },
				draggedSessionId: "c",
				sessionId: "a",
				edge: "left",
			}),
			{
				orientation: "vertical",
				panels: [
					{ kind: "nested", orientation: "horizontal", first: "c", second: "a" },
					{ kind: "session", sessionId: "b" },
				],
			},
		);
	});

	it("inserts a real root pane on same-direction edges (true multi-pane)", () => {
		// [A|B] 拖 C 到 A 左边缘 → 真三栏 [C,A,B]（同层，非嵌套）
		assert.deepEqual(
			insertRootPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "a",
				edge: "left",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "c" },
					{ kind: "session", sessionId: "a" },
					{ kind: "session", sessionId: "b" },
				],
			},
		);
		// 拖到 B 右边缘 → [A,B,C]
		assert.deepEqual(
			insertRootPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "b",
				edge: "right",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "a" },
					{ kind: "session", sessionId: "b" },
					{ kind: "session", sessionId: "c" },
				],
			},
		);
		// 拖到 B 左边缘（两栏中间）→ [A,C,B]
		assert.deepEqual(
			insertRootPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "b",
				edge: "left",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "a" },
					{ kind: "session", sessionId: "c" },
					{ kind: "session", sessionId: "b" },
				],
			},
		);
		// [A;B] 竖排：拖 C 到 A 上边缘 → 真上中下 [C;A;B]
		assert.deepEqual(
			insertRootPaneFromDrop({
				layout: { orientation: "vertical", panels: twoPanes().panels },
				draggedSessionId: "c",
				sessionId: "a",
				edge: "top",
			}),
			{
				orientation: "vertical",
				panels: [
					{ kind: "session", sessionId: "c" },
					{ kind: "session", sessionId: "a" },
					{ kind: "session", sessionId: "b" },
				],
			},
		);
		// 方向与根层垂直（切分语义）→ 插入拒绝
		assert.equal(
			insertRootPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "a",
				edge: "top",
			}),
			null,
		);
	});

	it("rejects splitting beyond two levels or pane cap", () => {
		// 切分面板内的会话（[左上下|C] 中的 A）不可再切分
		assert.equal(
			nestSplitPaneFromDrop({
				layout: nestedLayout(),
				draggedSessionId: "d",
				sessionId: "a",
				edge: "top",
			}),
			null,
		);
		// 拖已在布局内的会话 → 忽略
		assert.equal(
			nestSplitPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "a",
				sessionId: "b",
				edge: "top",
			}),
			null,
		);
		// 拖自己到自己边缘 → 忽略
		assert.equal(
			nestSplitPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "a",
				sessionId: "a",
				edge: "top",
			}),
			null,
		);
		// 同向边缘归根层插入，切分函数拒绝
		assert.equal(
			nestSplitPaneFromDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "a",
				edge: "left",
			}),
			null,
		);
	});

	it("caps root panes at 3 (true multi-pane)", () => {
		// 真三栏后再拖同向边缘 → 3 栏封顶拒绝
		assert.equal(
			insertRootPaneFromDrop({
				layout: {
					orientation: "horizontal",
					panels: [
						{ kind: "session", sessionId: "c" },
						{ kind: "session", sessionId: "a" },
						{ kind: "session", sessionId: "b" },
					],
				},
				draggedSessionId: "d",
				sessionId: "a",
				edge: "left",
			}),
			null,
		);
		// 三栏中某栏仍可切分（总屏数 4 封顶）
		assert.deepEqual(
			nestSplitPaneFromDrop({
				layout: {
					orientation: "horizontal",
					panels: [
						{ kind: "session", sessionId: "c" },
						{ kind: "session", sessionId: "a" },
						{ kind: "session", sessionId: "b" },
					],
				},
				draggedSessionId: "d",
				sessionId: "a",
				edge: "top",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "c" },
					{ kind: "nested", orientation: "vertical", first: "d", second: "a" },
					{ kind: "session", sessionId: "b" },
				],
			},
		);
		// 4 屏后无法再切分
		assert.equal(
			nestSplitPaneFromDrop({
				layout: gridLayout(),
				draggedSessionId: "e",
				sessionId: "a",
				edge: "top",
			}),
			null,
		);
	});

	it("resolves solo host so every open tab can initiate split, including the focused one", () => {
		// 拖非当前 → 宿主=命中的唯一面板（单栏当前会话）
		assert.equal(resolveSplitHostSessionId({ draggedSessionId: "a", hitSessionId: "b", tabIds: ["a", "b"] }), "b");
		// 拖当前 → 宿主=Tab 栏另一个会话（否则「当前 Tab 无法分屏」）
		assert.equal(resolveSplitHostSessionId({ draggedSessionId: "b", hitSessionId: "b", tabIds: ["a", "b"] }), "a");
		// 只有自己一个 Tab 且拖的是自己 → 无法分屏
		assert.equal(resolveSplitHostSessionId({ draggedSessionId: "a", hitSessionId: "a", tabIds: ["a"] }), null);
	});

	it("gates drop acceptance so preview always matches behavior", () => {
		// solo：中心落点无效（避免「替换该栏」预览落空）
		assert.equal(
			canAcceptSplitDrop({
				layout: null,
				draggedSessionId: "b",
				sessionId: "a",
				edge: null,
				tabCount: 2,
			}),
			false,
		);
		// solo：拖自己到边缘，Tab 栏无其它宿主 → 拒绝
		assert.equal(
			canAcceptSplitDrop({
				layout: null,
				draggedSessionId: "a",
				sessionId: "a",
				edge: "right",
				tabCount: 1,
			}),
			false,
		);
		// solo：拖自己到边缘，Tab 栏有其它宿主 → 接受（host 解析兜底）
		assert.equal(
			canAcceptSplitDrop({
				layout: null,
				draggedSessionId: "a",
				sessionId: "a",
				edge: "right",
				tabCount: 2,
			}),
			true,
		);
		// 已分屏：拖已在布局内的会话 / 拖自己 → 拒绝
		assert.equal(
			canAcceptSplitDrop({
				layout: twoPanes(),
				draggedSessionId: "a",
				sessionId: "b",
				edge: "left",
				tabCount: 2,
			}),
			false,
		);
		// 三栏同向边缘（根层封顶）→ 拒绝
		assert.equal(
			canAcceptSplitDrop({
				layout: {
					orientation: "horizontal",
					panels: [
						{ kind: "session", sessionId: "c" },
						{ kind: "session", sessionId: "a" },
						{ kind: "session", sessionId: "b" },
					],
				},
				draggedSessionId: "d",
				sessionId: "a",
				edge: "left",
				tabCount: 4,
			}),
			false,
		);
		// 四屏垂直边缘（总屏封顶）→ 拒绝
		assert.equal(
			canAcceptSplitDrop({
				layout: gridLayout(),
				draggedSessionId: "e",
				sessionId: "a",
				edge: "top",
				tabCount: 5,
			}),
			false,
		);
		// 四屏同向边缘（2×2 满员，根层 <3 栏但总屏已满）→ 拒绝（预览承诺落空修复）
		assert.equal(
			canAcceptSplitDrop({
				layout: gridLayout(),
				draggedSessionId: "e",
				sessionId: "a",
				edge: "left",
				tabCount: 5,
			}),
			false,
		);
		// 切分面板内会话的同向边缘 → 接受（根层插入，按所属面板定位）
		assert.equal(
			canAcceptSplitDrop({
				layout: nestedLayout(),
				draggedSessionId: "d",
				sessionId: "a",
				edge: "left",
				tabCount: 4,
			}),
			true,
		);
		// 切分面板内会话的垂直边缘 → 拒绝（两层封顶）
		assert.equal(
			canAcceptSplitDrop({
				layout: nestedLayout(),
				draggedSessionId: "d",
				sessionId: "a",
				edge: "top",
				tabCount: 4,
			}),
			false,
		);
		// 中心替换：目标必须在布局内
		assert.equal(
			canAcceptSplitDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "x",
				edge: null,
				tabCount: 3,
			}),
			false,
		);
		assert.equal(
			canAcceptSplitDrop({
				layout: twoPanes(),
				draggedSessionId: "c",
				sessionId: "a",
				edge: null,
				tabCount: 3,
			}),
			true,
		);
	});

	it("inserts at the containing root pane so nested-pane outer edges are reachable", () => {
		// [左上下|C] 拖 D 到 A（嵌套内）左边缘 → 插到根层 index 0 → [D, 左上下, C]
		assert.deepEqual(
			insertRootPaneFromDrop({
				layout: nestedLayout(),
				draggedSessionId: "d",
				sessionId: "a",
				edge: "left",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "d" },
					{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
					{ kind: "session", sessionId: "c" },
				],
			},
		);
		// 命中嵌套内 B 右边缘 → 插到根层 index 1 → [左上下, D, C]（嵌套面板后）
		assert.deepEqual(
			insertRootPaneFromDrop({
				layout: nestedLayout(),
				draggedSessionId: "d",
				sessionId: "b",
				edge: "right",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
					{ kind: "session", sessionId: "d" },
					{ kind: "session", sessionId: "c" },
				],
			},
		);
		// 3 会话布局插入第 4 个 → 合法（总屏 4 封顶）
		assert.equal(
			countSplitSessions(
				insertRootPaneFromDrop({
					layout: nestedLayout(),
					draggedSessionId: "d",
					sessionId: "c",
					edge: "right",
				}),
			),
			4,
		);
		// 4 会话布局再插入 → 总屏封顶拒绝
		assert.equal(
			insertRootPaneFromDrop({
				layout: gridLayout(),
				draggedSessionId: "e",
				sessionId: "a",
				edge: "right",
			}),
			null,
		);
	});

	it("collapses a three-pane layout with nested panel on close", () => {
		// [左上下|C|D] 关 C → [左上下|D]
		assert.deepEqual(
			resolveSplitAfterClose(
				{
					orientation: "horizontal",
					panels: [
						{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
						{ kind: "session", sessionId: "c" },
						{ kind: "session", sessionId: "d" },
					],
				},
				"c",
			),
			{
				layout: {
					orientation: "horizontal",
					panels: [
						{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
						{ kind: "session", sessionId: "d" },
					],
				},
			},
		);
		// 三栏关掉两栏只剩一个切分面板 → 展平为根层双栏
		assert.deepEqual(
			resolveSplitAfterClose(
				{
					orientation: "horizontal",
					panels: [
						{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
						{ kind: "session", sessionId: "c" },
						{ kind: "session", sessionId: "d" },
					],
				},
				"c",
			).layout &&
				resolveSplitAfterClose(
					{
						orientation: "horizontal",
						panels: [
							{ kind: "nested", orientation: "vertical", first: "a", second: "b" },
							{ kind: "session", sessionId: "d" },
						],
					},
					"d",
				),
			{
				layout: {
					orientation: "vertical",
					panels: [
						{ kind: "session", sessionId: "a" },
						{ kind: "session", sessionId: "b" },
					],
				},
			},
		);
	});

	it("replaces any level session when dropping on pane center", () => {
		// 2×2 四宫格中心替换嵌套内会话
		assert.deepEqual(replaceSplitPaneFromDrop({ layout: gridLayout(), draggedSessionId: "e", sessionId: "b" }), {
			orientation: "horizontal",
			panels: [
				{ kind: "nested", orientation: "vertical", first: "a", second: "e" },
				{ kind: "nested", orientation: "vertical", first: "d", second: "c" },
			],
		});
	});

	it("grows to 4 panes and stops there", () => {
		// [左上下|C] 拖 D 到 C 上边缘 → 2×2 四宫格（4 屏封顶）
		const grid = nestSplitPaneFromDrop({
			layout: nestedLayout(),
			draggedSessionId: "d",
			sessionId: "c",
			edge: "top",
		});
		assert.deepEqual(grid, gridLayout());
		assert.equal(countSplitSessions(grid), 4);
		// 4 屏后无法再切分（切分面板内会话且总屏数已达上限）
		assert.equal(
			nestSplitPaneFromDrop({
				layout: gridLayout(),
				draggedSessionId: "e",
				sessionId: "a",
				edge: "left",
			}),
			null,
		);
		// 4 屏后：a 位于切分面板内（两层封顶）且总屏数已满，任何落点都拒绝
	});

	it("replaces the hit session when dropping on pane center (any level)", () => {
		// 根层面板中心替换
		assert.deepEqual(replaceSplitPaneFromDrop({ layout: twoPanes(), draggedSessionId: "c", sessionId: "a" }), {
			orientation: "horizontal",
			panels: [
				{ kind: "session", sessionId: "c" },
				{ kind: "session", sessionId: "b" },
			],
		});
		// 嵌套层内会话中心替换
		assert.deepEqual(
			replaceSplitPaneFromDrop({
				layout: nestedLayout(),
				draggedSessionId: "d",
				sessionId: "b",
			}),
			{
				orientation: "horizontal",
				panels: [
					{ kind: "nested", orientation: "vertical", first: "a", second: "d" },
					{ kind: "session", sessionId: "c" },
				],
			},
		);
		// 拖已在布局内 / 目标不存在 / 拖自己 → 忽略
		assert.equal(replaceSplitPaneFromDrop({ layout: twoPanes(), draggedSessionId: "a", sessionId: "b" }), null);
		assert.equal(replaceSplitPaneFromDrop({ layout: twoPanes(), draggedSessionId: "c", sessionId: "x" }), null);
	});

	it("collapses panes after close: solo / degrade nested / flatten nested-only", () => {
		// 关根层会话 → 退回单栏
		assert.deepEqual(resolveSplitAfterClose(twoPanes(), "a"), { soloSessionId: "b" });
		// 关嵌套层内会话 → 该面板退化为幸存会话，布局保持双栏
		assert.deepEqual(resolveSplitAfterClose(nestedLayout(), "a"), {
			layout: {
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "b" },
					{ kind: "session", sessionId: "c" },
				],
			},
		});
		// 2×2 四宫格关掉一个 → 对应嵌套退化，仍为双栏（3 屏）
		assert.deepEqual(resolveSplitAfterClose(gridLayout(), "b"), {
			layout: {
				orientation: "horizontal",
				panels: [
					{ kind: "session", sessionId: "a" },
					{ kind: "nested", orientation: "vertical", first: "d", second: "c" },
				],
			},
		});
		// 不相关会话关闭 → 布局不变
		assert.deepEqual(resolveSplitAfterClose(twoPanes(), "x"), { layout: twoPanes() });
	});

	it("wires SessionSplitStage, tab drag, i18n and styles", () => {
		assert.match(stage, /session-split-drop-preview/);
		assert.match(stage, /onDragOverCapture/);
		assert.match(stage, /onDropCapture/);
		assert.match(stage, /data-split-session-id/);
		assert.match(stage, /SESSION_SPLIT_EDGE_THRESHOLD|resolveSessionSplitEdge/);
		assert.match(tabs, /SESSION_TAB_DRAG_MIME/);
		assert.match(tabs, /onDragSessionChange/);
		assert.match(app, /SessionSplitStage/);
		assert.match(app, /ChatSessionPane/);
		assert.match(app, /workspaceChrome\.dropSplit/);
		assert.match(app, /renderSession=/);
		assert.doesNotMatch(app, /layout\.firstSessionId/);
		assert.match(zh, /"session\.split\.preview\.right"/);
		assert.match(en, /"session\.split\.preview\.right"/);
		assert.match(zh, /"session\.split\.preview\.center"/);
		assert.match(en, /"session\.split\.preview\.center"/);
		assert.match(surfaces, /\.session-split-drop-preview/);
	});

	it("sidebar sessions share drag MIME and preview/permanent open modes", () => {
		const tree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
		const injector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
		const chrome = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
		const runtime = readFileSync("src/renderer/src/hooks/useSessionRuntimeController.ts", "utf8");
		const actions = readFileSync("src/renderer/src/hooks/useSessionActions.ts", "utf8");
		assert.match(tree, /SESSION_TAB_DRAG_MIME/);
		assert.match(tree, /onDoubleClick/);
		assert.match(tree, /openSession\(session\.id, "permanent"\)/);
		// chrome 域从 App 抽出，App 只装配；Tab 登记与 selectSession 解耦
		assert.match(app, /useSessionWorkspaceChrome/);
		assert.match(app, /workspaceChrome\.dropSplit/);
		assert.match(app, /registerOpenSession/);
		assert.match(app, /SessionPaneServicesProvider/);
		assert.match(chrome, /export function useSessionWorkspaceChrome/);
		assert.match(chrome, /nestSplitPaneFromDrop/);
		assert.match(chrome, /registerOpenSession/);
		assert.match(chrome, /splitLayoutSessionIds/);
		// 焦点驱动视图：焦点会话不在布局时全屏 solo（不再自动替换进分屏面板）
		assert.doesNotMatch(chrome, /replaceSplitPaneFromFocus/);
		assert.match(chrome, /splitGroupCollapsed/);
		// 视图投影表达式本身（不只是注释）：焦点在布局才渲染分屏
		assert.match(app, /splitLayoutSessionIds\(workspaceChrome\.splitLayout\)\.includes\(currentSessionId\)/);
		// 分屏组胶囊接线：props、i18n、持久化 key
		assert.match(app, /splitGroupIds:/);
		assert.match(tabs, /splitGroupCollapsed\?:/);
		assert.match(zh, /"session\.splitGroup\.label"/);
		assert.match(en, /"session\.splitGroup\.label"/);
		assert.match(chrome, /SPLIT_GROUP_COLLAPSED_KEY = "pideck\.splitGroupCollapsed"/);
		// 分屏组增强：自定义名称/颜色/取消分屏
		assert.match(chrome, /exitAllSplit/);
		assert.match(chrome, /SPLIT_GROUP_CONFIG_KEY = "pideck\.splitGroupConfig"/);
		assert.match(tabs, /SPLIT_GROUP_COLOR_PALETTE/);
		assert.match(zh, /"session\.splitGroup\.exitAll"/);
		assert.match(en, /"session\.splitGroup\.exitAll"/);
		assert.doesNotMatch(actions, /tabMode|onSessionSelected|"keep"/);
		// 分屏栏不再挂右侧抽屉按钮；共享服务走 context；runtime 按 session family 订阅
		assert.match(injector, /useSessionPaneServices/);
		assert.doesNotMatch(injector, /onToggleDrawer|chrome === "full"/);
		assert.match(runtime, /sessionRuntimeBySessionIdAtomFamily\(sessionKey\)/);
		assert.match(runtime, /始终按 sessionId 订阅 family/);
	});
});
