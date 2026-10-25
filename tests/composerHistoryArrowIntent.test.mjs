import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const behavior = loadTsCommonJs("src/renderer/src/composerBehavior.ts");
const { resolveComposerHistoryIntent } = behavior;

const caretCoordsSource = readFileSync("src/renderer/src/components/session/composer/caretCoords.ts", "utf8");
const caretBridgeSource = readFileSync("src/renderer/src/components/session/composer/tiptap/caretBridge.ts", "utf8");
const controllerSource = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");

/**
 * 用桩替换 caretBridge 载入 caretCoords，只验证适配层契约（不需要真实 DOM/编辑器）。
 * 相对 specifier 按源码原样作为 key（loadTsCommonJs 的桩约定）。
 */
function loadCaretCoords(editor) {
	return loadTsCommonJs("src/renderer/src/components/session/composer/caretCoords.ts", {
		stubs: {
			"./tiptap/caretBridge": {
				resolveComposerTipTapEditor: (root) => (root === "ROOT" ? editor : null),
				isComposerTipTapAtVisualEdge: (target, dir) => target.visualEdge?.(dir) ?? false,
				posToPlainOffset: () => 0,
				getTipTapComposerCaretCoords: () => null,
			},
		},
	});
}

const baseState = {
	key: "ArrowUp",
	atFirstBlock: true,
	atLastBlock: true,
	atVisualTop: true,
	atVisualBottom: true,
	historyIndex: -1,
	historyLength: 3,
	modifier: false,
	hasSelection: false,
};

const stateWith = (patch) => ({ ...baseState, ...patch });

/**
 * 复现（用户反馈）：一行超长文本软换行后，光标在视觉第 2 行按 ↑ 应该上移光标，
 * 而不是回填上一条历史消息。逻辑上它仍在首块（atFirstBlock=true），
 * 所以必须叠加视觉行判定（atVisualTop=false）才放行。
 */
test("soft-wrapped caret below the first visual row releases ArrowUp instead of recalling history", () => {
	assert.equal(resolveComposerHistoryIntent(stateWith({ atVisualTop: false })), "release");
	// 对照组：真的到视觉首行才回填
	assert.equal(resolveComposerHistoryIntent(stateWith({ atVisualTop: true })), "recall-older");
});

test("ArrowDown is symmetric: a wrapped draft's last logical line is not the last visual row", () => {
	const browsing = { key: "ArrowDown", historyIndex: 1 };
	// 软换行：逻辑末段但视觉不在末行 → 放行（光标下移）
	assert.equal(resolveComposerHistoryIntent(stateWith({ ...browsing, atVisualBottom: false })), "release");
	// 视觉末行才回退到更新的一条
	assert.equal(resolveComposerHistoryIntent(stateWith({ ...browsing, atVisualBottom: true })), "recall-newer");
});

test("history recall requires the first/last block as well", () => {
	// 第 2 块的第一视觉行：endOfTextblock("up") 在块内为 true，但上面还有上一块 → 放行
	assert.equal(resolveComposerHistoryIntent(stateWith({ atFirstBlock: false })), "release");
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "ArrowDown", historyIndex: 1, atLastBlock: false })), "release");
});

test("modifier combinations are always released (select / word / paragraph navigation)", () => {
	for (const patch of [{ modifier: true }, { hasSelection: true }]) {
		assert.equal(resolveComposerHistoryIntent(stateWith(patch)), "release", JSON.stringify(patch));
		assert.equal(resolveComposerHistoryIntent(stateWith({ ...patch, historyIndex: 1 })), "release", JSON.stringify(patch));
	}
});

test("ArrowUp without history and idle ArrowDown stay native caret movement", () => {
	assert.equal(resolveComposerHistoryIntent(stateWith({ historyLength: 0 })), "release");
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "ArrowDown" })), "release");
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "ArrowDown", historyIndex: 1, atVisualBottom: false })), "release");
});

test("Escape restores the stashed draft only while browsing", () => {
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "Escape", historyIndex: 0 })), "restore-draft");
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "Escape", historyIndex: -1 })), "release");
	// Esc 不参与修饰键/选区守卫：否则用户按住 Shift 或选着文本时会困在浏览态
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "Escape", historyIndex: 0, modifier: true })), "restore-draft");
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "Escape", historyIndex: 0, hasSelection: true })), "restore-draft");
});

test("unrelated keys are released", () => {
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "Enter" })), "release");
	assert.equal(resolveComposerHistoryIntent(stateWith({ key: "a" })), "release");
});

test("caret block edge comes from ProseMirror state instead of the draft string", () => {
	// 用真实 prosemirror-model 造 state：位置运算与运行时同源，不手算 before/after。
	const { Schema } = createRequire(import.meta.url)("@tiptap/pm/model");
	const schema = new Schema({
		nodes: {
			doc: { content: "block+" },
			paragraph: { content: "inline*", group: "block" },
			text: { group: "inline" },
		},
	});
	const doc = schema.nodeFromJSON({
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "a" }] },
			{ type: "paragraph", content: [{ type: "text", text: "b" }] },
		],
	});
	const stateAt = (pos) => ({ doc, selection: { $from: doc.resolve(pos) } });

	const firstBlock = loadCaretCoords({ isDestroyed: false, state: stateAt(1) });
	// 展开成当前 realm 的对象再比：被测模块跑在 vm 沙箱里，跨 realm 对象不能直接 deepEqual
	assert.deepEqual({ ...firstBlock.getComposerCaretBlockEdge("ROOT") }, { atFirstBlock: true, atLastBlock: false });

	const secondBlock = loadCaretCoords({ isDestroyed: false, state: stateAt(4) });
	assert.deepEqual({ ...secondBlock.getComposerCaretBlockEdge("ROOT") }, { atFirstBlock: false, atLastBlock: true });
});

test("caret block edge fails closed without an editor or at an abnormal position", () => {
	assert.deepEqual({ ...loadCaretCoords(null).getComposerCaretBlockEdge(null) }, { atFirstBlock: false, atLastBlock: false });

	const destroyed = loadCaretCoords({ isDestroyed: true, state: { selection: { $from: { depth: 1 } }, doc: {} } });
	assert.deepEqual({ ...destroyed.getComposerCaretBlockEdge("ROOT") }, { atFirstBlock: false, atLastBlock: false });

	// depth 0（全选 / gap cursor）取不到顶层块边界 → 视为不在边界，不抢键
	const docLevel = loadCaretCoords({ isDestroyed: false, state: { selection: { $from: { depth: 0 } }, doc: { content: { size: 0 } } } });
	assert.deepEqual({ ...docLevel.getComposerCaretBlockEdge("ROOT") }, { atFirstBlock: false, atLastBlock: false });
});

test("visual edge probe forwards the direction and fails closed", () => {
	const calls = [];
	const { isComposerAtVisualEdge } = loadCaretCoords({
		isDestroyed: false,
		visualEdge: (dir) => {
			calls.push(dir);
			return true;
		},
	});

	assert.equal(isComposerAtVisualEdge("ROOT", "up"), true);
	assert.equal(isComposerAtVisualEdge("ROOT", "down"), true);
	assert.deepEqual(calls, ["up", "down"]);

	// 没有编辑器（未挂载 / 已卸载）→ 不抢键
	assert.equal(isComposerAtVisualEdge(null, "up"), false);
	assert.equal(isComposerAtVisualEdge("OTHER_ROOT", "up"), false);
});

test("visual edge probe fails closed when the editor is destroyed or measurement throws", () => {
	const destroyed = loadCaretCoords({ isDestroyed: true, visualEdge: () => true });
	assert.equal(destroyed.isComposerAtVisualEdge("ROOT", "up"), false);

	const throwing = loadCaretCoords({
		isDestroyed: false,
		visualEdge: () => {
			throw new Error("no docView");
		},
	});
	// 测量失败宁可不回填，也不要把用户正在写的草稿换成历史消息
	assert.equal(throwing.isComposerAtVisualEdge("ROOT", "up"), false);
});

test("composer keydown wiring uses the shared visual edge probe and guards", () => {
	// 视觉行判定必须走 ProseMirror 的 endOfTextblock，而不是自写 getClientRects 测量；
	// 且必须传入用 DOM 真实插入点构造的 state（PM state.selection 会落后一拍）
	assert.match(caretBridgeSource, /syncSelectionFromDom\(\s*view\s*\);[\s\S]{0,40}?endOfTextblock\(\s*dir\s*\)/);
	assert.match(caretBridgeSource, /window\.getSelection\(\)/);
	assert.match(caretBridgeSource, /view\.posAtDOM\(/);
	assert.match(caretCoordsSource, /editor\.isDestroyed/);
	assert.match(caretCoordsSource, /catch\s*\{[\s\S]{0,60}?return false/);

	// 控制器必须把两个视觉边界与块边界交给纯函数判定，并在入口拦掉 IME 合成态
	assert.match(controllerSource, /resolveComposerHistoryIntent\(/);
	assert.match(controllerSource, /isComposerAtVisualEdge\(editorRef\.current,\s*"up"\)/);
	assert.match(controllerSource, /isComposerAtVisualEdge\(editorRef\.current,\s*"down"\)/);
	assert.match(controllerSource, /getComposerCaretBlockEdge\(editorRef\.current\)/);
	assert.match(controllerSource, /if\s*\(isComposingKeyboardEvent\(event\)\)\s*return;/);
	// 旧的「拿草稿字符串判逻辑行」写法必须消失（它是软换行误触发的来源）
	assert.doesNotMatch(controllerSource, /getComposerHistoryLineBounds/);
	assert.doesNotMatch(controllerSource, /event\.key\s*===\s*"ArrowUp"\s*&&\s*firstLine/);
});
