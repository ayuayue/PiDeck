import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseExpandedRefBlocks, replaceExpandedRefBlocksWithLabels, formatPromptTemplateBlock, textForSessionTitle, looksLikeExpandedRefBlockTitle } = loadTsCommonJs("src/shared/expandedRefBlocks.ts");

function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const SAMPLE = '<quoted_context label="引用A" message_id="m1">\nA 全文\n</quoted_context>\n\n' + '<referenced_session name="会话B">\n[User]: x\n</referenced_session>\n\n' + '<skill name="cv-writer">\n指令正文\n</skill>\n\n' + formatPromptTemplateBlock("review", "模板正文") + "\n\n@src/a.ts 帮我看下";

/**
 * 主进程 / 渲染进程共用一份自包含块解析（shared/expandedRefBlocks）。
 * 这里直接锁 shared 模块的对外契约：四类块都能折叠成 label，且顺序不变。
 */
test("shared expandedRefBlocks folds all four block kinds in place", () => {
	assertJsonEqual(
		parseExpandedRefBlocks(SAMPLE).map((block) => (block.kind === "session" ? block.name : block.label)),
		["引用A", "会话B", "skill:cv-writer", "review"],
	);

	const folded = replaceExpandedRefBlocksWithLabels(SAMPLE);
	// 原位替换：只把块换成 label，原有 \n\n 分隔保持不变（侧栏 preview 等仍保留段落结构）
	assert.equal(folded, "❝引用A\n\n&会话B\n\n/skill:cv-writer\n\n/review\n\n@src/a.ts 帮我看下");
	// 不能再漏出任何 XML 标签
	for (const tag of ["<quoted_context", "<referenced_session", "<skill", "<prompt_template"]) {
		assert.ok(!folded.includes(tag), `folded text must not contain ${tag}`);
	}
});

test("shared expandedRefBlocks leaves plain text untouched (zero-cost fast path)", () => {
	assert.equal(replaceExpandedRefBlocksWithLabels("普通消息"), "普通消息");
	assertJsonEqual(parseExpandedRefBlocks("普通消息"), []);
});

/**
 * 纯文本出口契约（回归）：消息文本里的自包含块是给模型读的上下文，任何面向人的
 * 文本出口都必须先折叠，否则会露出 <quoted_context …> 原文。
 * 气泡 / 复制 / 队列预览已覆盖；这里锁住其余五个曾漏出的出口。
 */
test("every plain-text surface folds self-contained reference blocks", () => {
	const surfaces = {
		"子代理转录（pi）": "src/renderer/src/components/session/SessionSubagentsStrip.tsx",
		"子代理转录（DSH）": "src/renderer/src/components/session/DshAgentToolsPanel.tsx",
		会话定位轴标题: "src/renderer/src/components/app/AppUtils.ts",
		"侧栏会话 preview（主进程）": "src/main/sessions/SessionScanner.ts",
		"Web 端消息渲染（主进程）": "src/main/web/WebServiceManager.ts",
	};
	for (const [label, file] of Object.entries(surfaces)) {
		const source = readFileSync(file, "utf8");
		assert.match(source, /replaceExpandedRefBlocksWithLabels/, `${label} must fold reference blocks before rendering plain text (${file})`);
	}
});

/**
 * 会话标题清洗（textForSessionTitle）。
 * 回归 2026-10 #250：首条消息用 /模板 时，标题链路把展开后的 `<prompt_template …>` 当用户第一句话，
 * 占位标题显示 XML 原文；总结旁路又因 1600 字截断只看到模板正文，标题变成模板里的章节名。
 */
test("textForSessionTitle keeps only the user's own words outside reference blocks", () => {
	const template = formatPromptTemplateBlock("翻译官", "# 翻译官工作规则\n" + "规则正文。".repeat(500));
	// 核心现场：模板正文两千多字，用户真正说的话在块外。
	assert.equal(textForSessionTitle(`${template}\n\nhow are you`), "how are you");
	assert.equal(textForSessionTitle(`帮我翻译 ${template}\n\n这段话`), "帮我翻译 这段话");
	// 块外没有文字（只插了模板就发送）：回退到块标签，标题不能是空串。
	assert.equal(textForSessionTitle(template), "/翻译官");
	assert.equal(textForSessionTitle('<skill name="cv-writer">\n指令正文\n</skill>\n帮我写简历'), "帮我写简历");
	assert.equal(textForSessionTitle('<skill name="cv-writer">\n指令正文\n</skill>'), "/skill:cv-writer");
	assert.equal(textForSessionTitle('<quoted_context label="引用A" message_id="m1">\nA 全文\n</quoted_context>\n照着改'), "照着改");
	assert.equal(textForSessionTitle('<referenced_session name="会话B">\n[User]: x\n</referenced_session>'), "&会话B");
	// 纯文本零成本直通；块外多段文本合并为单空格（标题不保留排版换行）。
	assert.equal(textForSessionTitle("普通消息"), "普通消息");
	assert.equal(textForSessionTitle(`${formatPromptTemplateBlock("a", "A")}\n${formatPromptTemplateBlock("b", "B")}`), "/a /b");
});

test("textForSessionTitle skips nested blocks inside a referenced session", () => {
	// 会话引用正文里可能再嵌历史引用块：只能折叠成最外层标签，否则标题会重复插入标签。
	const nested = '<referenced_session name="会话B">\n<quoted_context label="引用A" message_id="m1">\nA 全文\n</quoted_context>\n</referenced_session>';
	assert.equal(textForSessionTitle(nested), "&会话B");
});

test("looksLikeExpandedRefBlockTitle flags dirty titles written by the old bug", () => {
	// 旧代码把整段块原文写进标题：必须判定为占位名，才能被首条消息/扫描结果覆盖（自愈）。
	assert.equal(looksLikeExpandedRefBlockTitle('<prompt_template name="翻译官"> # 翻译官工作规则 规则正文'), true);
	// 写入方截断（没有闭合标签）时同样要能识别，否则脏标题永远洗不掉。
	assert.equal(looksLikeExpandedRefBlockTitle('<prompt_template name="翻译官">'), true);
	assert.equal(looksLikeExpandedRefBlockTitle('帮我看看 <quoted_context label="引用A" message_id="m1">\nA\n</quoted_context>'), true);
	// 正常标题与用户手写的尖括号文本不能被误判。
	assert.equal(looksLikeExpandedRefBlockTitle("修复登录流程"), false);
	assert.equal(looksLikeExpandedRefBlockTitle("<skill> 是什么意思"), false);
	assert.equal(looksLikeExpandedRefBlockTitle("a < b 的边界处理"), false);
	assert.equal(looksLikeExpandedRefBlockTitle(undefined), false);
});

test("session title surfaces strip reference block bodies", () => {
	// 标题是纯文本出口：占位标题（主进程）与异步总结（内置扩展）都必须剥块。
	// 扩展是 pi 用 -e 加载的独立文件，不能 import shared，因此断言各自的入口函数名。
	const surfaces = {
		"占位标题（主进程）": ["src/main/pi/agentUtils.ts", /textForSessionTitle/],
		"历史扫描回退（主进程）": ["src/main/sessions/SessionScanner.ts", /textForSessionTitle/],
		"catalog 脏标题识别": ["src/main/sessions/SessionCatalog.ts", /looksLikeExpandedRefBlockTitle/],
		"异步总结标题（内置扩展）": ["resources/extensions/pi-deck-session-title.ts", /titleTextFromUserInput/],
	};
	for (const [label, [file, pattern]] of Object.entries(surfaces)) {
		const source = readFileSync(file, "utf8");
		assert.match(source, pattern, `${label} must strip expanded reference blocks before deriving a title (${file})`);
	}
});
