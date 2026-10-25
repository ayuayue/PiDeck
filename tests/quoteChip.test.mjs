import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	createQuoteTokenRe,
	buildQuoteToken,
	createQuoteId,
	extractQuoteTokens,
	stripQuoteTokens,
	expandQuoteTokens,
	formatQuoteBlock,
	parseExpandedQuoteBlocks,
	parseExpandedSessionBlocks,
	parseExpandedSkillBlocks,
	parseExpandedPromptTemplateBlocks,
	parseExpandedRefBlocks,
	buildBubbleRefSegments,
	rehydrateDraftFromMessage,
	replaceExpandedRefBlocksWithLabels,
	formatPromptTemplateBlock,
	truncateQuoteLabel,
	buildDraftWithAppendedQuote,
	pruneUnreferencedQuotes,
} = loadTsCommonJs("src/renderer/src/components/session/composer/quoteChip.ts");

/** vm 跨 realm 时 deepEqual 会因原型不同误报，统一 JSON 比较（同 composerChips.test.mjs）。 */
function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const snippet = (id, text) => ({ id, text, messageId: "m1", createdAt: 0 });

test("token regex matches #q<hex> with safe boundaries", () => {
	const re = createQuoteTokenRe();
	const text = "看 #qabcdef12 和 x#q111111、##q222222、#q333333g 与 #q444444，";
	const ids = [...text.matchAll(re)].map((m) => m[1]);
	// x 前缀（\w）与 ## 双井号不命中；尾随字母 g 回溯失败不命中；中文标点后正常命中
	assert.deepEqual(ids, ["qabcdef12", "q444444"]);
});

test("buildQuoteToken / createQuoteId keep the same shape as the regex body", () => {
	const id = createQuoteId();
	assert.match(id, /^q[0-9a-f]{8}$/);
	assert.equal(buildQuoteToken(id), `#${id}`);
	assertJsonEqual(
		extractQuoteTokens(`前文 ${buildQuoteToken(id)} 后文`).map((o) => o.id),
		[id],
	);
});

test("extractQuoteTokens reports occurrences with offsets in order", () => {
	const text = "#qaaaaaa01 中间 #qbbbbbb02 再提 #qaaaaaa01";
	const tokens = extractQuoteTokens(text);
	assertJsonEqual(
		tokens.map((t) => [t.id, t.start, t.end]),
		[
			// token 长度 = 1(#)+1(q)+8(hex) = 10，偏移必须与文本严格对齐（caret 映射依赖）
			["qaaaaaa01", 0, 10],
			["qbbbbbb02", 14, 24],
			["qaaaaaa01", 28, 38],
		],
	);
});

test("stripQuoteTokens removes tokens and cleans leftover spaces", () => {
	assert.equal(stripQuoteTokens("#qaaaaaa01 为什么"), "为什么");
	assert.equal(stripQuoteTokens("为什么 #qaaaaaa01 不生效"), "为什么 不生效");
	assert.equal(stripQuoteTokens("没有引用的普通消息"), "没有引用的普通消息");
});

test("expandQuoteTokens returns null when no token present", () => {
	assert.equal(
		expandQuoteTokens("普通问题", () => undefined),
		null,
	);
});

test("expandQuoteTokens preserves quote-question order and dedupes repeated ids", () => {
	const text = "#qbbbbbb02 问题二 #qaaaaaa01 问题一 #qbbbbbb02 补充";
	const expanded = expandQuoteTokens(text, (id) => snippet(id, `${id} 内容`));
	// 自包含 XML 标记块：label/messageId/全文都编码在文本里，气泡可直接解析渲染 chip
	assert.equal(expanded, '<quoted_context label="qbbbbbb02 内容" message_id="m1">\nqbbbbbb02 内容\n</quoted_context>\n\n问题二\n\n<quoted_context label="qaaaaaa01 内容" message_id="m1">\nqaaaaaa01 内容\n</quoted_context>\n\n问题一\n\n补充');
});

test("expandQuoteTokens drops orphan tokens silently", () => {
	const expanded = expandQuoteTokens("#qdeadbeef 加上正文", () => undefined);
	assert.equal(expanded, "加上正文");
});

test("expandQuoteTokens keeps multi-line structure inside block", () => {
	const expanded = expandQuoteTokens("#qaaaaaa01 这段为什么错", () => snippet("qaaaaaa01", "\n第一行\n\n第三行\n"));
	assert.equal(expanded, '<quoted_context label="第一行" message_id="m1">\n第一行\n\n第三行\n</quoted_context>\n\n这段为什么错');
});

test("expandQuoteTokens with only quotes yields block-only message", () => {
	const expanded = expandQuoteTokens("#qaaaaaa01", () => snippet("qaaaaaa01", "只有引用"));
	assert.equal(expanded, '<quoted_context label="只有引用" message_id="m1">\n只有引用\n</quoted_context>');
});

test("parseExpandedQuoteBlocks extracts self-contained blocks (roundtrip)", () => {
	const drafts = ["#qbbbbbb02 问题二 #qaaaaaa01 问题一", "#qaaaaaa01 这段为什么错"];
	const snippets = new Map([
		["qbbbbbb02", snippet("qbbbbbb02", "qbbbbbb02 内容")],
		["qaaaaaa01", snippet("qaaaaaa01", "\n第一行\n\n第三行\n")],
	]);
	for (const draft of drafts) {
		const expanded = expandQuoteTokens(draft, (id) => snippets.get(id));
		const blocks = parseExpandedQuoteBlocks(expanded);
		// 每块都能解析出 label/messageId/全文，不依赖运行时快照
		assert.ok(blocks.length > 0, `draft ${draft} should yield blocks`);
		for (const block of blocks) {
			assert.equal(block.messageId, "m1");
			assert.ok(block.label.length > 0);
			assert.ok(block.text.length > 0);
		}
	}
});

test("parseExpandedSessionBlocks extracts <referenced_session> blocks", () => {
	const text = '帮我看看\n\n<referenced_session name="拉取最新的代码">\n[User]: 拉取最新的代码\n[Assistant]: ok\n</referenced_session>\n\n为什么';
	const blocks = parseExpandedSessionBlocks(text);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].name, "拉取最新的代码");
	assert.ok(blocks[0].text.includes("[User]: 拉取最新的代码"));
	assert.ok(blocks[0].start > 0);
	assert.ok(blocks[0].end > blocks[0].start);
});

test("parseExpandedRefBlocks merges quote + session blocks in order", () => {
	const text = '<quoted_context label="引文" message_id="m1">\n引文内容\n</quoted_context>\n\n<referenced_session name="会话A">\n[User]: 你好\n</referenced_session>\n\n正文';
	const blocks = parseExpandedRefBlocks(text);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].kind, "quote");
	assert.equal(blocks[1].kind, "session");
	assert.equal(blocks[1].name, "会话A");
	// 排序：quote 在前（start 小），session 在后
	assert.ok(blocks[0].start < blocks[1].start);
});

test("expanded skill and prompt template blocks restore slash chip labels", () => {
	const skillText = '<skill location="C:/skills/cv" name="cv-project-writer">\n完整 skill 指令\n</skill>';
	const templateText = formatPromptTemplateBlock("review-pr", "完整模板正文");
	assert.equal(parseExpandedSkillBlocks(skillText)[0]?.name, "cv-project-writer");
	assert.equal(parseExpandedPromptTemplateBlocks(templateText)[0]?.name, "review-pr");

	const blocks = parseExpandedRefBlocks(`${skillText}\n\n${templateText}`);
	assertJsonEqual(
		blocks.map((block) => ({ kind: block.kind, label: block.kind === "session" ? block.name : block.label })),
		[
			{ kind: "skill", label: "skill:cv-project-writer" },
			// 模板块自 2026-10 起是独立 kind（与 pi 的 skill / prompt 两种资源对齐）
			{ kind: "template", label: "review-pr" },
		],
	);
	assert.equal(replaceExpandedRefBlocksWithLabels(`${skillText}\n\n${templateText}`), "/skill:cv-project-writer\n\n/review-pr");
});

test("outer referenced session blocks suppress nested reference chips", () => {
	const text = '<referenced_session name="会话A">\n<quoted_context label="内部引用" message_id="m1">\n引用正文\n</quoted_context>\n</referenced_session>';
	const blocks = parseExpandedRefBlocks(text);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].kind, "session");
	assert.equal(blocks[0].name, "会话A");
	assert.equal(replaceExpandedRefBlocksWithLabels(text), "&会话A");
});

test("buildBubbleRefSegments keeps chips inline by trimming block-adjacent whitespace", () => {
	// 单块 + 正文：块前的 \n\n 被裁掉，正文不再掉到第二行
	const quoted = '<quoted_context label="引文" message_id="m1">\n引文内容\n</quoted_context>\n\n你好';
	assertJsonEqual(
		buildBubbleRefSegments(quoted).map((segment) => segment.kind),
		["chip", "text"],
	);
	assert.equal(buildBubbleRefSegments(quoted)[1].value, "你好");

	// 中间块：正文内部段落换行保留，仅块两侧空白被裁
	const middle = '第一段\n\n第二段\n\n<quoted_context label="引文" message_id="m1">\n内容\n</quoted_context>\n\n问题';
	const segments = buildBubbleRefSegments(middle);
	assertJsonEqual(
		segments.map((segment) => segment.kind),
		["text", "chip", "text"],
	);
	assert.equal(segments[0].value, "第一段\n\n第二段");
	assert.equal(segments[2].value, "问题");

	// 纯空白分隔的连续块：不产生空文本片段（否则会多出空行）
	const adjacent = '<quoted_context label="a" message_id="m1">\nA\n</quoted_context>\n\n<referenced_session name="会话A">\n[User]: x\n</referenced_session>';
	assertJsonEqual(
		buildBubbleRefSegments(adjacent).map((segment) => segment.kind),
		["chip", "chip"],
	);

	// 无块：整段作为一个文本片段返回
	assertJsonEqual(buildBubbleRefSegments("普通消息"), [{ kind: "text", value: "普通消息" }]);
});

test("buildBubbleRefSegments keeps quote/description pairing in original order", () => {
	// 回归（用户实测）：引用A + 描述A + 引用B + 描述B 不能被重排成「两个引用都在最上面」。
	const text = '<quoted_context label="引用A" message_id="m1">\nA 全文\n</quoted_context>\n\ndd\n\n' + '<quoted_context label="引用B" message_id="m2">\nB 全文\n</quoted_context>\n\nde3d';
	const segments = buildBubbleRefSegments(text);
	assertJsonEqual(
		segments.map((segment) => (segment.kind === "text" ? segment.value : segment.block.label)),
		["引用A", "dd", "引用B", "de3d"],
	);

	// 无块：整段作为一个文本片段
	assertJsonEqual(buildBubbleRefSegments("普通消息"), [{ kind: "text", value: "普通消息" }]);
});

test("rehydrateDraftFromMessage restores chips instead of raw XML", () => {
	let seq = 0;
	const text = '<quoted_context label="引文" message_id="m1">\n引用正文\n</quoted_context>\n\n' + '<referenced_session name="会话A">\n[User]: x\n</referenced_session>\n\n' + '<skill name="cv-writer">\n指令正文\n</skill>\n\n' + formatPromptTemplateBlock("review", "模板正文") + "\n\n@src/a.ts 帮我看下";
	const { draft, quotes } = rehydrateDraftFromMessage(text, () => `q${++seq}0000000`);

	// quote → 快照 + #q token（全文/出处不丢，重发时会再展开）
	assert.equal(quotes.length, 1);
	assert.equal(quotes[0].text, "引用正文");
	assert.equal(quotes[0].messageId, "m1");
	assert.ok(draft.includes(`#${quotes[0].id}`));
	// 其余块还原为 composer 能重新解析成 chip 的 mention 文本
	assert.ok(draft.includes("&会话A"));
	assert.ok(draft.includes("/skill:cv-writer"));
	assert.ok(draft.includes("/review"));
	assert.ok(draft.includes("@src/a.ts"));
	// 回归：不能把 XML 原文塞回输入框
	for (const tag of ["<quoted_context", "<referenced_session", "<skill", "<prompt_template"]) {
		assert.ok(!draft.includes(tag), `draft must not contain ${tag}`);
	}

	// 幂等：还原后的草稿再还原不变
	const again = rehydrateDraftFromMessage(draft, () => "qdeadbeef");
	assert.equal(again.draft, draft);
	assertJsonEqual(again.quotes, []);

	// 无块：原样返回
	const plain = rehydrateDraftFromMessage("普通消息");
	assert.equal(plain.draft, "普通消息");
	assertJsonEqual(plain.quotes, []);
});

test("parseExpandedRefBlocks leaves plain text untouched", () => {
	assertJsonEqual(parseExpandedRefBlocks("普通消息"), []);
	assertJsonEqual(parseExpandedRefBlocks(""), []);
});

test("formatQuoteBlock escapes XML attributes and guards closing tag", () => {
	const block = formatQuoteBlock("有 </quoted_context> 注入的文本", { label: 'a"b<c>', messageId: "m&1" });
	assert.ok(block.includes('label="a&quot;b&lt;c&gt;"'));
	assert.ok(block.includes('message_id="m&amp;1"'));
	// 注入的闭合标签被改写，解析不会提前截断
	assert.ok(!block.includes("</quoted_context>文本"));
	assert.ok(block.includes("</quoted_context_> 注入"));
	// 往返：转义后仍能解析回原始 label/messageId
	const parsed = parseExpandedQuoteBlocks(block);
	assert.equal(parsed[0]?.label, 'a"b<c>');
	assert.equal(parsed[0]?.messageId, "m&1");
	assert.equal(parsed[0]?.text, "有 </quoted_context_> 注入的文本");
});

test("truncateQuoteLabel uses first non-empty line and truncates", () => {
	assert.equal(truncateQuoteLabel("\n  \n第二行内容"), "第二行内容");
	assert.equal(truncateQuoteLabel("短"), "短");
	assert.equal(truncateQuoteLabel("一".repeat(40)), `${"一".repeat(18)}…`);
});

test("buildDraftWithAppendedQuote appends with spacing and trims tail", () => {
	assert.equal(buildDraftWithAppendedQuote("", "#qaaaaaa01"), "#qaaaaaa01 ");
	assert.equal(buildDraftWithAppendedQuote("为什么   ", "#qaaaaaa01"), "为什么 #qaaaaaa01 ");
});

test("pruneUnreferencedQuotes keeps only ids present in the draft", () => {
	const map = {
		qaaaaaa01: snippet("qaaaaaa01", "a"),
		qbbbbbb02: snippet("qbbbbbb02", "b"),
	};
	const kept = pruneUnreferencedQuotes(map, new Set(["qbbbbbb02"]));
	assertJsonEqual(Object.keys(kept), ["qbbbbbb02"]);
});
