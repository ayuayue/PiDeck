import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { stripCodeComments } from "./_sourceContract.mjs";

const SMOOTH = "src/renderer/src/utils/smoothStreamContent.ts";
const HOOK = "src/renderer/src/utils/useSmoothStream.ts";
const { classifySmoothStreamChange, pushGraphemes } = loadTsCommonJs(SMOOTH);

/**
 * 2026-10-27 事故回归：点「展开全文」把预览一次性换成 205KB 全文，useSmoothStream 的
 * append 分支把 delta 切出的十几万 grapheme `push(...chars)` spread 成一次函数调用的实参
 * ——V8 实参个数有引擎上限，直接 RangeError: Maximum call stack size exceeded，
 * passive effect 挂载阶段整树中断，展开按钮点了没反应且控制台报错。
 */

test("pushGraphemes 十万级 grapheme 不爆栈且保序", () => {
	const total = 200_001;
	const chars = Array.from({ length: total }, (unused, index) => String(index % 10));
	const queue = [];

	pushGraphemes(queue, chars);

	assert.equal(queue.length, total, "逐个推入不受实参个数上限约束");
	assert.equal(queue[0], "0");
	assert.equal(queue[total - 1], String((total - 1) % 10), "顺序必须与输入一致（打字机逐字输出）");
});

test("pushGraphemes 空数组是 no-op", () => {
	const queue = ["keep"];
	pushGraphemes(queue, []);
	assert.deepEqual(queue, ["keep"]);
});

test("useSmoothStream 不再含 push spread（事故源头钉死）", () => {
	// 剥注释再断言：修复说明里会写到 push(...chars) 这个反例本身。
	const code = stripCodeComments(readFileSync(HOOK, "utf8"));
	assert.doesNotMatch(code, /\.push\(\.\.\./, "队列入队必须走 pushGraphemes（spread 实参会爆栈）");
	assert.match(code, /pushGraphemes\(chunkQueueRef\.current/, "append 分支必须经 pushGraphemes 入队");
});

test("流已结束的 content 变更不再入队（入队是纯浪费，收口 effect 负责 dump）", () => {
	const code = stripCodeComments(readFileSync(HOOK, "utf8"));
	// delta 入队 effect 是文件里第一个 useEffect，收尾依赖是 [content, disabled, paused, background]。
	const deltaEffect = code.match(/useEffect\(\(\) => \{[\s\S]*?\n\t\}, \[content, disabled, paused, background\]\)/);
	assert.ok(deltaEffect, "找不到 delta 入队 effect");
	const skipAt = deltaEffect[0].indexOf("if (streamDoneRef.current)");
	const classifyAt = deltaEffect[0].indexOf("classifySmoothStreamChange");
	assert.ok(skipAt >= 0, "delta effect 必须在流已结束时早退（跳过 classify 与入队）");
	assert.ok(classifyAt > skipAt, "早退必须发生在 classify 之前");
});

test("205KB 级 append 分类语义不因长度改变", () => {
	const prev = "preview-";
	const next = prev + "x".repeat(205 * 1024);
	const change = classifySmoothStreamChange(prev, prev, next);
	assert.equal(change.kind, "append");
	assert.equal(change.delta.length, 205 * 1024);
});

test("暂停打字机：数据继续更新但不推进画面，恢复时一次追平", () => {
	const code = stripCodeComments(readFileSync(HOOK, "utf8"));
	// 暂停/折叠共用早退：只更新 prevContent，不 push、不 setState。
	assert.match(code, /if \(disabled \|\| paused\) \{/);
	// 暂停/后台中流结束不能 dump 全文，否则暂停等于没生效。
	assert.match(code, /if \(isStreaming \|\| paused \|\| background\) return;/);
	// 恢复 effect：清空队列 + 直接对齐最新权威文本（不重放暂停期间的逐字动画）。
	assert.match(code, /const latest = contentRef\.current;/);
	assert.match(code, /chunkQueueRef\.current = \[\];/);
	assert.match(code, /setDisplayedContent\(latest\);/);
	// rAF 回调自身再判一次暂停/后台，防止已排队的旧帧在切换后继续推进。
	assert.match(code, /if \(pausedRef\.current \|\| backgroundRef\.current\) \{/);
});

test("非激活栏 Markdown 保持轻量渲染，恢复后才调度 settle 全量", () => {
	const stream = stripCodeComments(readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8"));
	// paused/background 时即使 isStreaming 已结束也读冻结的 displayedContent，不能直接铺 props.text。
	assert.match(stream, /const rawDisplayText = props\.paused \|\| props\.background \? displayedContent/);
	// 轻量插件链保留既有前缀（props.light || isStreamingNow || !settleFull），paused 追加在其后。
	assert.match(stream, /props\.light \|\| isStreamingNow \|\| !settleFull \|\| Boolean\(props\.paused\)/);
	// settle 全量与渐进分块都必须等恢复。
	assert.match(stream, /if \(props\.paused \|\| props\.background\) return;/);
	assert.match(stream, /\|\| props\.paused \|\| props\.background\) return;/);
});

test("会话栏用 focused + 文档可见性推导三档渲染模式并下发到流式组件", () => {
	const pane = readFileSync("src/renderer/src/components/session/ChatSessionPane.tsx", "utf8");
	assert.match(pane, /useDocumentVisible/);
	assert.match(pane, /const paneActive = \(props\.active \?\? focused\) && documentVisible;/);
	assert.match(pane, /const renderMode: SessionPaneRenderMode = !documentVisible \? "hidden" : paneActive \? "active" : "background";/);
	assert.match(pane, /<SessionPaneRenderModeContext\.Provider value=\{renderMode\}>/);
	// live 正文 / 思考按模式读 atom：background 1s 粗采样，hidden 冻结。
	const answer = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
	assert.match(answer, /usePacedAtomValue\(streamingTextBySessionIdAtomFamily/);
	assert.match(answer, /paused=\{renderMode === "hidden"\}/);
	assert.match(answer, /background=\{renderMode === "background"\}/);
	const thinking = readFileSync("src/renderer/src/components/session/turn/ThinkingStep.tsx", "utf8");
	assert.match(thinking, /usePacedAtomValue\(streamingThinkingEntryByIdAtomFamily/);
	assert.match(thinking, /paused=\{renderMode === "hidden" \|\| props\.hidden\}/);
	assert.match(thinking, /background=\{renderMode === "background" && !props\.hidden\}/);
});

test("可见未聚焦栏走 1s 粗刷新：停 rAF 但不冻结文本", () => {
	const code = stripCodeComments(readFileSync(HOOK, "utf8"));
	// 后台分支直接跳变到最新文本，不建逐字队列。
	assert.match(code, /if \(background\) \{/);
	assert.match(code, /setDisplayedContent\(newContent\);/);
	// 后台/暂停都不挂 rAF。
	assert.match(code, /if \(disabled \|\| paused \|\| background\) return;/);
	assert.match(code, /if \(pausedRef\.current \|\| backgroundRef\.current\) \{/);
	const stream = stripCodeComments(readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8"));
	assert.match(stream, /background: Boolean\(props\.background\)/);
	assert.match(stream, /props\.light \|\| isStreamingNow \|\| !settleFull \|\| Boolean\(props\.paused\) \|\| Boolean\(props\.background\)/);
});
