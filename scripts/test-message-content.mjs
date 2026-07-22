import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/main/pi/messageContent.ts", import.meta.url), "utf8");
const functionSource = source
	.replace(/import \{ stripFeishuDocActionHint \} from "\.\.\/feishu\/docActions";\n\n/, "")
	.replace(/export function extractMessageText/, "function extractMessageText");
const compiled = ts.transpileModule(functionSource, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stripFeishuDocActionHint = (text) => text;
const extractMessageText = new Function(
	"stripFeishuDocActionHint",
	`${compiled}\nreturn extractMessageText;`,
)(stripFeishuDocActionHint);

const fragmentedGlmContent = [
	{ type: "text", text: "你好！" },
	{ type: "text", text: "👋\n\n" },
	{ type: "text", text: "我已" },
	{ type: "text", text: "准备好帮助你" },
	{ type: "text", text: "。请" },
	{ type: "text", text: "告诉我你需要" },
	{ type: "text", text: "做什么——" },
	{ type: "text", text: "例如" },
	{ type: "text", text: "：\n\n-" },
	{ type: "text", text: " 读取" },
	{ type: "text", text: "或" },
	{ type: "text", text: "分析文件" },
	{ type: "text", text: "\n-" },
	{ type: "text", text: " 运行" },
	{ type: "text", text: "命令或" },
	{ type: "text", text: "批量研究" },
	{ type: "text", text: "\n\n随时" },
	{ type: "text", text: "告诉我你的" },
	{ type: "text", text: "需求！" },
];

assert.equal(
	extractMessageText(fragmentedGlmContent),
	"你好！👋\n\n我已准备好帮助你。请告诉我你需要做什么——例如：\n\n- 读取或分析文件\n- 运行命令或批量研究\n\n随时告诉我你的需求！",
	"fragmented text content should be concatenated without synthetic newlines",
);

assert.equal(
	extractMessageText([
		{ type: "text", text: "正文" },
		{ type: "thinking", thinking: "内部推理" },
		{ type: "text", text: "继续" },
	]),
	"正文\n<thinking>内部推理</thinking>继续",
	"thinking block keeps a semantic boundary while adjacent text stays contiguous",
);

assert.equal(
	extractMessageText("最终回答\n<CPA_DONE>"),
	"最终回答",
	"trailing CPA completion marker must not reach the UI",
);

assert.equal(
	extractMessageText("示例：<CPA_DONE> 不是传输尾标"),
	"示例：<CPA_DONE> 不是传输尾标",
	"only a standalone trailing CPA completion marker may be removed",
);

console.log("messageContent tests passed");
