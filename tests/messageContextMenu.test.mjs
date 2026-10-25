import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { CONTEXT_MENU_IGNORE_SELECTOR, LIVE_ANSWER_SELECTOR, MESSAGE_BODY_SELECTOR, cleanMessageCopyText, hasMessageContextMenuCopy, isPointInsideRects, planMessageContextMenu, planMessageContextMenuCopyKinds } = loadTsCommonJs("src/renderer/src/components/session/timeline/messageContextMenuPolicy.ts");

/** 默认输入：无选区、无 live、无命中消息 */
const base = {
	selectionSnapshot: "",
	liveSelection: "",
	inLiveAnswer: false,
	liveText: "",
	messageText: null,
};

test("selection snapshot wins over live selection and is trimmed", () => {
	const plan = planMessageContextMenu({ ...base, selectionSnapshot: "  选中的一段文本\n", liveSelection: "右键后的实时选区" });
	assert.equal(plan.selectionText, "选中的一段文本");
	// 快照为空（右键前没有划选，或按下点不在选区内）时回退实时选区
	assert.equal(planMessageContextMenu({ ...base, liveSelection: "实时选区" }).selectionText, "实时选区");
	// 纯空白选区 = 没有选区：菜单不提供「复制」项，也不该单独为它打开菜单
	const blank = planMessageContextMenu({ ...base, selectionSnapshot: " \n\t " });
	assert.equal(blank.selectionText, "");
	assert.equal(hasMessageContextMenuCopy(blank), false);
});

test("settled message exposes raw markdown for both copy items", () => {
	const plan = planMessageContextMenu({ ...base, messageText: "## 标题\n\n正文 \u0060code\u0060" });
	// 原文（含 markdown 语法）作为两个菜单项的共同来源：「复制为文本」由调用方 stripMarkdown
	assert.equal(plan.messageText, "## 标题\n\n正文 \u0060code\u0060");
	assert.equal(plan.liveText, "");
	assert.equal(hasMessageContextMenuCopy(plan), true);
	// 空正文消息（例如只有图片的 user 消息）：两条消息复制项都隐藏
	const empty = planMessageContextMenu({ ...base, messageText: "  \n " });
	assert.equal(empty.messageText, "");
	assert.equal(hasMessageContextMenuCopy(empty), false);
});

test("live answer copies DOM text and ignores the nearest message anchor", () => {
	// live 正文最近的 data-message-id 是 turn row 的 run id（本轮首条成员，可能是工具/思考，
	// 甚至不在 activeMessages 里）：即使命中消息也绝不能当正文复制，只认 DOM 文本。
	const plan = planMessageContextMenu({ ...base, inLiveAnswer: true, liveText: "  正在流式输出的正文  ", messageText: "本轮首条工具消息" });
	assert.equal(plan.liveText, "正在流式输出的正文");
	assert.equal(plan.messageText, "");
	// live 正文没有原始 markdown，菜单侧只保留文本回退（视图据此不渲染「复制为 Markdown」）
	assert.equal(hasMessageContextMenuCopy(plan), true);
	// 流式期间选区复制同样可用
	const withSelection = planMessageContextMenu({ ...base, inLiveAnswer: true, liveText: "正文", selectionSnapshot: "流式正文里的划选" });
	assert.equal(withSelection.selectionText, "流式正文里的划选");
	// live 正文还没吐字且没有选区：没有可复制内容 → 不打开空菜单
	assert.equal(hasMessageContextMenuCopy(planMessageContextMenu({ ...base, inLiveAnswer: true, liveText: "  " })), false);
});

test("copy items are mutually exclusive: selection wins, then whole-message forms, then live text", () => {
	// 用户反馈「这选项有点重复了，复制就有三个」：有选区时「复制」= 复制选中内容，
	// 不能再并列整条消息的「复制为文本 / 复制为 Markdown」，否则三个复制项目标不同却同名。
	const kinds = (plan) => planMessageContextMenuCopyKinds(plan).join(",");
	const selected = planMessageContextMenu({ ...base, selectionSnapshot: "选中内容", messageText: "整条消息原文" });
	assert.equal(kinds(selected), "selection");
	// 无选区 → 整条消息的两种形态
	assert.equal(kinds(planMessageContextMenu({ ...base, messageText: "原文" })), "messageText,messageMarkdown");
	// 无选区、只有 live 流式正文 → 只有文本回退（无原始 markdown）
	assert.equal(kinds(planMessageContextMenu({ ...base, inLiveAnswer: true, liveText: "流式文本" })), "liveText");
	// live 正文里也有选区时同样只给「复制」
	assert.equal(kinds(planMessageContextMenu({ ...base, inLiveAnswer: true, liveText: "流式文本", selectionSnapshot: "选段" })), "selection");
	// 没有任何可复制内容 → 不打开空菜单
	assert.equal(kinds(planMessageContextMenu({ ...base })), "");
});

test("right-click hit-test uses the highlighted rects, not the whole paragraph", () => {
	// 用户反馈场景：拖选后在高亮文字的末尾留白处右键，Chromium 会先收掉选区。
	// 命中判定必须按高亮行矩形（带 2px 容差）：压在高亮上才算「复制选中内容」，
	// 同一段里远离选区的点走整条消息复制，不能把旧选区当成用户的意图。
	const rects = [
		{ left: 100, top: 40, right: 220, bottom: 60 },
		{ left: 100, top: 62, right: 160, bottom: 82 },
	];
	assert.equal(isPointInsideRects(rects, 150, 50), true);
	assert.equal(isPointInsideRects(rects, 101, 61), true, "相邻两行之间 1-2px 的行高缝隙由 2px 容差覆盖");
	assert.equal(isPointInsideRects(rects, 300, 50), false, "同一行但远离选区的点不算");
	assert.equal(isPointInsideRects(rects, 150, 120), false, "选区下方空白不算");
	// 2px 容差覆盖高亮边缘（拖选终点常落在字形右侧一两像素）
	assert.equal(isPointInsideRects(rects, 222, 50), true);
	assert.equal(isPointInsideRects(rects, 226, 50), false);
	assert.equal(isPointInsideRects([], 100, 40), false);
});

test("menu view renders copy items from the policy plan (no three-copy regression)", () => {
	// 视图只负责按 plan 渲染，禁止再在 JSX 里逐项硬编码「复制 / 复制为文本 / 复制为 Markdown」，
	// 否则互斥规则会被视图绕过（用户反馈的重复菜单就是这么来的）。
	const view = readFileSync("src/renderer/src/components/session/timeline/MessageContextMenu.tsx", "utf8");
	assert.match(view, /planMessageContextMenuCopyKinds/);
	assert.match(view, /copyKinds\.map/);
	assert.doesNotMatch(view, /props\.onCopy\("messageText"\)/);
});

test("cleanMessageCopyText strips model-context protocol and ANSI before copying", () => {
	// 思考块 / skill 块 / ANSI 都是模型上下文或终端装饰，不能出现在用户复制出的正文里
	assert.equal(cleanMessageCopyText("前言\n<thinking>内部推理</thinking>\n正文"), "前言\n\n正文");
	assert.equal(cleanMessageCopyText("\u001b[31m红色\u001b[0m文本"), "红色文本");
	// skill 块按 chip 标签折叠（不把技能全文复制进剪贴板）
	assert.equal(cleanMessageCopyText('<skill name="review">技能全文</skill>保留'), "/skill:review保留");
	// 自包含引用块折叠成 chip 标签，禁止复制出 quoted_context XML
	const quoted = '<quoted_context label="引用片" message_id="m1">\n引用正文\n</quoted_context>\n用户补充';
	assert.equal(cleanMessageCopyText(quoted), "❝引用片\n用户补充");
	// 普通正文原样保留（只 trim 首尾空白），markdown 语法不被破坏
	assert.equal(cleanMessageCopyText("\n## 标题\n\n- 列表\n"), "## 标题\n\n- 列表");
});

test("timeline mounts the context menu on the message list wrapper", () => {
	// 挂载点契约（用户反馈「回复里选中没有操作」的回归点）：右键处理器必须挂在
	// .message-list 容器上（消息 / 用户气泡 / 工具卡都在容器内），菜单视图在同一条时间线渲染。
	// 正则按类名定位并容忍属性间距——改格式不应让契约测试误红。
	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(timeline, /className="message-list[^"]*"[\s\S]{0,120}?onContextMenu=\{messageContextMenu\.handleContextMenu\}/);
	assert.match(timeline, /<MessageContextMenu\s+state=\{messageContextMenu\.state\}/);
	// 会话切换必须收起旧菜单（scopeKey 变化清状态），否则跨会话右键会复制到另一条会话的文本。
	assert.match(timeline, /useMessageContextMenu\(\{\s*messages:\s*activeMessages,\s*scopeKey:\s*sessionId,\s*favoriteContext,\s*favoritedMessageKeys\s*\}\)/);
	// 收藏来源元信息随 hook 选项下发：右键菜单里的「收藏这条回复/收藏所选」要带会话上下文。
	assert.match(timeline, /const favoriteContext = useMemo\(\(\) => \(\{ sessionId,/);
});

test("selectors cover live body, message bodies and native editing controls", () => {
	// live 正文标记：右键落在流式回答里必须走 DOM 文本回退
	assert.match(LIVE_ANSWER_SELECTOR, /\[data-live-answer\]/);
	// 全选目标：live 正文 / markdown 正文 / 用户气泡 / 消息块锚点
	assert.match(MESSAGE_BODY_SELECTOR, /\[data-live-answer\]/);
	assert.match(MESSAGE_BODY_SELECTOR, /\.markdown-body/);
	assert.match(MESSAGE_BODY_SELECTOR, /\.user-turn-bubble/);
	assert.match(MESSAGE_BODY_SELECTOR, /\[data-message-id\]/);
	// 输入 / 编辑控件保留原生右键语义（消息内联编辑 textarea / contenteditable）
	assert.match(CONTEXT_MENU_IGNORE_SELECTOR, /textarea/);
	assert.match(CONTEXT_MENU_IGNORE_SELECTOR, /input/);
	assert.match(CONTEXT_MENU_IGNORE_SELECTOR, /contenteditable/);
});
