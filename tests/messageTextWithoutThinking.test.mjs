import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { extractMessageText } = loadTsCommonJs("src/main/pi/messageContent.ts");

const withThinking = [
	{ type: "thinking", thinking: "先看目录再动手" },
	{ type: "text", text: "正文在这里" },
];

test("不传选项时 thinking 仍按标签拼进正文", () => {
	assert.equal(extractMessageText(withThinking), "<thinking>先看目录再动手</thinking>正文在这里");
});

test("思考夹在正文中间时旧行为照旧带换行边界", () => {
	const content = [
		{ type: "text", text: "开场" },
		{ type: "thinking", thinking: "先看目录" },
		{ type: "text", text: "正文在这里" },
	];
	assert.equal(extractMessageText(content), "开场\n<thinking>先看目录</thinking>正文在这里");
});

test("includeThinking 为 false 时正文里没有标签副本", () => {
	const text = extractMessageText(withThinking, { includeThinking: false });
	assert.equal(text, "正文在这里");
	assert.equal(text.includes("<thinking>"), false);
});

test("只有思考没有正文时新选项不给空标签", () => {
	assert.equal(extractMessageText([{ type: "thinking", thinking: "只想不说" }], { includeThinking: false }), "");
});

test("字符串形态的 content 不受选项影响", () => {
	assert.equal(extractMessageText("纯文本", { includeThinking: false }), "纯文本");
});
