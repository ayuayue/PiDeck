import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const policy = loadTsCommonJs("src/renderer/src/utils/selectionToolPolicy.ts");
const { AGENT_TRANSLATE_TARGETS } = loadTsCommonJs("src/shared/types/agentProfile.ts");
const {
	SELECTION_TOOL_MIN_CHARS,
	SELECTION_TOOL_MAX_CHARS,
	SELECTION_TOOL_UI_SELECTOR,
	SELECTION_TOOL_IGNORED_MOUSEUP_SELECTOR,
	SELECTION_TOOL_EDITABLE_SELECTOR,
	SELECTION_TOOL_REPLY_SELECTOR,
	SELECTION_INLINE_WIDTH,
	SELECTION_INLINE_MIN_WIDTH,
	SELECTION_INLINE_MARGIN,
	AGENT_TRANSLATE_TARGET_LABEL_KEYS,
	SELECTION_INLINE_ACTION_LABEL_KEYS,
	normalizeSelectionText,
	isSelectionToolAnchorElement,
	isSelectionToolIgnoredMouseUpTarget,
	clampFloatingPosition,
	resolveSelectionInlineWidth,
	toSelectionAnchorRect,
	buildTranslateInstruction,
} = policy;

test("normalizeSelectionText trims, enforces the minimum length and caps oversized selections", () => {
	assert.equal(SELECTION_TOOL_MIN_CHARS, 2);
	assert.equal(SELECTION_TOOL_MAX_CHARS, 8000);
	// 首尾空白去掉再做长度判定：全空白/单字不弹按钮
	assert.equal(normalizeSelectionText("  你好  "), "你好");
	assert.equal(normalizeSelectionText("  a  "), null);
	assert.equal(normalizeSelectionText(" \n\t "), null);
	// 内部分段/换行保留（翻译要读到段落结构）
	assert.equal(normalizeSelectionText("  a\nb  "), "a\nb");
	// 超长截断到上限且保留前缀
	const long = "字".repeat(SELECTION_TOOL_MAX_CHARS + 500);
	const capped = normalizeSelectionText(long);
	assert.equal(capped.length, SELECTION_TOOL_MAX_CHARS);
	assert.equal(capped, long.slice(0, SELECTION_TOOL_MAX_CHARS));
});

/** 假元素：只实现策略真正用到的 tagName + closest（测试不需要真 DOM）。 */
function fakeAnchorElement({ tagName = "DIV", insideToolUi = false, insideEditable = false, insideReply = false } = {}) {
	return {
		tagName,
		closest(selector) {
			if (selector === SELECTION_TOOL_UI_SELECTOR) return insideToolUi ? { tagName: "DIV" } : null;
			if (selector === SELECTION_TOOL_EDITABLE_SELECTOR) return insideEditable ? { tagName: "DIV" } : null;
			if (selector === SELECTION_TOOL_REPLY_SELECTOR) return insideReply ? { tagName: "DIV" } : null;
			return null;
		},
	};
}

test("isSelectionToolAnchorElement only accepts assistant reply bodies", () => {
	assert.equal(isSelectionToolAnchorElement(null), false);
	// 回复正文（最终回答 / 中间回复 / 历史正文）：允许
	assert.equal(isSelectionToolAnchorElement(fakeAnchorElement({ insideReply: true })), true);
	assert.equal(isSelectionToolAnchorElement(fakeAnchorElement({ tagName: "P", insideReply: true })), true);
	// 非回复区域（侧栏 / 设置 / 用户气泡等纯文本面）：不再弹（2026-10 用户反馈）
	assert.equal(isSelectionToolAnchorElement(fakeAnchorElement()), false);
	assert.equal(isSelectionToolAnchorElement(fakeAnchorElement({ tagName: "P" })), false);
	// 编辑面：输入框/下拉/选项本身不允许（即使在外面也不允许，回复内同样不允许）
	for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "OPTION"]) {
		assert.equal(isSelectionToolAnchorElement(fakeAnchorElement({ tagName, insideReply: true })), false, tagName);
	}
	// 祖先命中编辑面（contenteditable 编辑器内部）不允许
	assert.equal(isSelectionToolAnchorElement(fakeAnchorElement({ insideEditable: true, insideReply: true })), false);
	// 工具自身 UI（浮出按钮/调用面板/结果区）不允许
	assert.equal(isSelectionToolAnchorElement(fakeAnchorElement({ insideToolUi: true, insideReply: true })), false);
	// 白名单必须覆盖两种助手正文根节点；新增回复渲染路径要同步这里
	assert.match(SELECTION_TOOL_REPLY_SELECTOR, /\.execution-interim/);
	assert.match(SELECTION_TOOL_REPLY_SELECTOR, /\.assistant-text/);
	// 排除规则必须落在选择器上：contenteditable 宿主（composer）要被覆盖
	assert.match(SELECTION_TOOL_EDITABLE_SELECTOR, /contenteditable/);
	assert.match(SELECTION_TOOL_EDITABLE_SELECTOR, /textarea/);
});

test("clampFloatingPosition prefers above, flips below near the top and clamps horizontally", () => {
	const viewport = { width: 1000, height: 800 };
	const size = { width: 120, height: 32 };
	// 选区在中间：浮层悬于上方居中，留 6px gap
	const above = clampFloatingPosition({ anchor: { left: 400, top: 400, right: 600, bottom: 424 }, viewport, size });
	assert.equal(above.placement, "above");
	assert.equal(above.top, 400 - 6 - 32);
	assert.equal(above.left, 400 + (200 - 120) / 2);
	// 贴近顶部：上方放不下 → 翻到下方
	const below = clampFloatingPosition({ anchor: { left: 100, top: 6, right: 300, bottom: 30 }, viewport, size });
	assert.equal(below.placement, "below");
	assert.equal(below.top, 30 + 6);
	// 水平溢出夹紧到视口留白内（左/右两个方向）
	const leftEdge = clampFloatingPosition({ anchor: { left: 0, top: 400, right: 20, bottom: 424 }, viewport, size });
	assert.equal(leftEdge.left, 8);
	const rightEdge = clampFloatingPosition({ anchor: { left: 980, top: 400, right: 1000, bottom: 424 }, viewport, size });
	assert.equal(rightEdge.left, 1000 - 8 - 120);
});

test("clampFloatingPosition honors prefer=below for the invoke panel and falls back above", () => {
	const viewport = { width: 1000, height: 800 };
	const size = { width: 320, height: 200 };
	// 面板优先贴选区下方
	const below = clampFloatingPosition({ anchor: { left: 400, top: 300, right: 600, bottom: 324 }, viewport, size, gap: 8, margin: 12, prefer: "below" });
	assert.equal(below.placement, "below");
	assert.equal(below.top, 324 + 8);
	assert.equal(below.left, 400 + (200 - 320) / 2);
	// 下方放不下（选区贴近底部）→ 翻到上方
	const flipped = clampFloatingPosition({ anchor: { left: 400, top: 650, right: 600, bottom: 760 }, viewport, size, gap: 8, margin: 12, prefer: "below" });
	assert.equal(flipped.placement, "above");
	assert.equal(flipped.top, 650 - 8 - 200);
	// 小视口里上下都放不下：垂直夹紧在留白内，宁可盖住选区也不出屏
	const clamped = clampFloatingPosition({ anchor: { left: 350, top: 20, right: 390, bottom: 80 }, viewport: { width: 400, height: 120 }, size: { width: 200, height: 100 }, margin: 8 });
	assert.equal(clamped.top, 12);
	assert.equal(clamped.left, 400 - 8 - 200);
});

test("buildTranslateInstruction maps action/target/locale to short renderer-side instructions", () => {
	// chat：文本原样交给智能体，不追加指令
	assert.equal(buildTranslateInstruction({ action: "chat", targetLanguage: "auto", targetLabel: "自动", locale: "zh" }), "");
	assert.equal(buildTranslateInstruction({ action: "chat", targetLanguage: "en-US", targetLabel: "English", locale: "en" }), "");
	// 中文界面：显式目标语言
	assert.equal(buildTranslateInstruction({ action: "translate", targetLanguage: "zh-CN", targetLabel: "中文", locale: "zh" }), "请翻译为中文。");
	assert.equal(buildTranslateInstruction({ action: "translate", targetLanguage: "ja-JP", targetLabel: "日文", locale: "zh" }), "请翻译为日文。");
	// auto：交给模型判断方向，指令必须说明「中文→英文，其余→中文」
	assert.match(buildTranslateInstruction({ action: "translate", targetLanguage: "auto", targetLabel: "自动", locale: "zh" }), /自动判断/);
	assert.match(buildTranslateInstruction({ action: "translate", targetLanguage: "auto", targetLabel: "自动", locale: "zh" }), /中文译为英文/);
	// 英文界面：英文指令
	assert.equal(buildTranslateInstruction({ action: "translate", targetLanguage: "en-US", targetLabel: "English", locale: "en" }), "Translate into English.");
	const autoEn = buildTranslateInstruction({ action: "translate", targetLanguage: "auto", targetLabel: "Auto", locale: "en" });
	assert.match(autoEn, /Chinese into English/);
	assert.match(autoEn, /anything else into Chinese/);
});

test("resolveSelectionInlineWidth keeps the browser-toolbar width but never overflows narrow viewports", () => {
	assert.equal(SELECTION_INLINE_WIDTH, 400);
	assert.equal(SELECTION_INLINE_MIN_WIDTH, 300);
	assert.equal(SELECTION_INLINE_MARGIN, 8);
	// 常规窗口：固定 400（头部动作一行放得下）
	assert.equal(resolveSelectionInlineWidth(1280), 400);
	// 中等窄窗：可用宽度 = 视口 - 两侧留白，仍大于下限
	assert.equal(resolveSelectionInlineWidth(400), 384);
	assert.equal(resolveSelectionInlineWidth(320), 304);
	// 小于下限：贴满可用宽度，绝不横向溢出
	assert.equal(resolveSelectionInlineWidth(250), 234);
	// 退化视口：返回 0，由 clampFloatingPosition 兜住（不出现负宽度）
	assert.equal(resolveSelectionInlineWidth(10), 0);
	assert.equal(resolveSelectionInlineWidth(0), 0);
});

test("toSelectionAnchorRect converts the quote-toolbar rect into a four-edge fixed anchor", () => {
	// 引用浮层只记 top/left/width/height；工具栏定位要 right/bottom（同一套换算只写一处）
	const rect = toSelectionAnchorRect({ top: 120, left: 80, width: 200, height: 24 });
	assert.deepEqual({ ...rect }, { left: 80, top: 120, right: 280, bottom: 144 });
	// 零尺寸选区（折叠/未渲染）也要得到稳定锚点，不能出现 NaN
	const collapsed = toSelectionAnchorRect({ top: 0, left: 0, width: 0, height: 0 });
	assert.deepEqual({ ...collapsed }, { left: 0, top: 0, right: 0, bottom: 0 });
});

test("every invoke action has a selection-tool toolbar label key", () => {
	// 键由 Lead 预置在 rendererCopy 两份词典里；这里守住「枚举与映射表同步」，
	// 漏一个动作会让头部切换按钮渲染成 key 名（或 TS 直接报缺 key）。
	assert.deepEqual(Object.keys(SELECTION_INLINE_ACTION_LABEL_KEYS).sort(), ["chat", "translate"]);
	assert.equal(SELECTION_INLINE_ACTION_LABEL_KEYS.translate, "selectionTool.translate");
	assert.equal(SELECTION_INLINE_ACTION_LABEL_KEYS.chat, "selectionTool.ask");
});

test("copy/menu interactions do not re-open the floating translate button", () => {
	// 用户反馈：选中文字后点右键「复制」，已有 toast，但又冒出单独的翻译按钮。
	// 根因是复制菜单项的 mouseup 被当成新的划选手势；这些交互面必须由策略层统一排除。
	const selector = SELECTION_TOOL_IGNORED_MOUSEUP_SELECTOR;
	for (const marker of ["data-selection-tool-ui", "data-radix-popper-content-wrapper", '[role="menu"]', "data-quote-toolbar", "button"]) {
		assert.ok(selector.includes(marker), `交互面选择器漏了 ${marker}`);
	}
	const fakeTarget = (tokens) => ({ closest: (candidate) => (tokens.some((token) => candidate.includes(token)) ? {} : null) });
	assert.equal(isSelectionToolIgnoredMouseUpTarget(null), false);
	assert.equal(isSelectionToolIgnoredMouseUpTarget(fakeTarget(["data-selection-tool-ui"])), true);
	assert.equal(isSelectionToolIgnoredMouseUpTarget(fakeTarget(["data-radix-popper-content-wrapper"])), true);
	assert.equal(isSelectionToolIgnoredMouseUpTarget(fakeTarget(['[role="menu"]'])), true);
	assert.equal(isSelectionToolIgnoredMouseUpTarget(fakeTarget(["data-quote-toolbar"])), true);
	assert.equal(isSelectionToolIgnoredMouseUpTarget(fakeTarget(["button"])), true);
	assert.equal(isSelectionToolIgnoredMouseUpTarget(fakeTarget(["message-body"])), false);
});

test("selection hook dismisses the snapshot on outside pointerdown and native copy", () => {
	const hook = readFileSync("src/renderer/src/hooks/useSelectionTool.ts", "utf8");
	assert.match(hook, /isSelectionToolIgnoredMouseUpTarget/);
	assert.match(hook, /document\.addEventListener\("pointerdown"/);
	assert.match(hook, /document\.addEventListener\("copy"/);
	// 浮出按钮自身必须放行 pointerdown，否则点按钮时先清选区
	assert.match(hook, /closest\(SELECTION_TOOL_UI_SELECTOR\)\) return;\s*\n\s*dismiss\(\);/);
	assert.match(hook, /document\.removeEventListener\("pointerdown"/);
	assert.match(hook, /document\.removeEventListener\("copy"/);
});

test("every translate target has a pre-added i18n label key", () => {
	// 键在渲染层词典里已由 Lead 预置；这里只守住「枚举与映射表同步」——
	// 漏一个目标语言会让 chips 渲染成 key 名。
	assert.deepEqual(Object.keys(AGENT_TRANSLATE_TARGET_LABEL_KEYS).sort(), [...AGENT_TRANSLATE_TARGETS].sort());
	for (const target of AGENT_TRANSLATE_TARGETS) {
		assert.match(AGENT_TRANSLATE_TARGET_LABEL_KEYS[target], /^agentInvoke\.target\./);
	}
});
