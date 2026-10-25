/**
 * Web 端会话 → Markdown 导出纯函数单测（P3 复制为 Markdown）。
 * 覆盖：用户/助手轮次、thinking 折叠块、工具调用 Input/Output/error、
 * 图片 data URL 截断、空消息跳过、分隔符拼接。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionUiMessagesToMarkdown } = loadTsCommonJs("src/renderer/src/web/webMarkdown.ts");

function uiMessage(role, parts, id = "m1") {
	return { id, role, parts };
}

test("renders user and assistant turns with speaker headers and separators", () => {
	const markdown = sessionUiMessagesToMarkdown([uiMessage("user", [{ type: "text", text: "帮我看看 " }]), uiMessage("assistant", [{ type: "text", text: "好的" }], "m2")]);
	assert.match(markdown, /### 🧑 \*\*User\*\*/);
	assert.match(markdown, /### 🤖 \*\*Assistant\*\*/);
	assert.equal(markdown.includes("\n\n---\n\n"), true);
	// 文本 trim：首尾空白不应进入输出
	assert.equal(markdown.includes("帮我看看 \n"), false);
});

test("wraps thinking into a details block", () => {
	const markdown = sessionUiMessagesToMarkdown([
		uiMessage("assistant", [
			{ type: "reasoning", text: "推理中" },
			{ type: "text", text: "结论" },
		]),
	]);
	assert.match(markdown, /<details>\n<summary>Thinking<\/summary>/);
	assert.match(markdown, /推理中/);
	assert.match(markdown, /结论/);
});

test("renders tool calls with input/output json and error state", () => {
	const ok = sessionUiMessagesToMarkdown([uiMessage("assistant", [{ type: "tool-bash", toolCallId: "t1", state: "output-available", input: { command: "ls" }, output: { code: 0 } }])]);
	assert.match(ok, /<summary>Tool: bash<\/summary>/);
	assert.match(ok, /Input:\n```json\n\{\n  "command": "ls"\n\}\n```/);
	assert.match(ok, /Output:\n```json\n\{\n  "code": 0\n\}\n```/);

	const failed = sessionUiMessagesToMarkdown([uiMessage("assistant", [{ type: "tool-bash", toolCallId: "t2", state: "output-error", errorText: "boom" }])]);
	assert.match(failed, /<summary>Tool: bash \(error\)<\/summary>/);
	assert.match(failed, /Error: boom/);
	// 只有 errorText 时不应渲染空 Output 块
	assert.equal(failed.includes("Output:"), false);
});

test("truncates image data URLs and skips unrecognized parts", () => {
	const long = `data:image/png;base64,${"A".repeat(200)}`;
	const markdown = sessionUiMessagesToMarkdown([uiMessage("user", [{ type: "file", mediaType: "image/png", data: long }, { type: "step-start" }, { type: "text", text: "配图" }])]);
	assert.match(markdown, /!\[image\/png\]\(data:image\/png;base64,AAA/);
	assert.match(markdown, /…\)/);
	assert.equal(markdown.includes("step-start"), false);
});

test("skips messages without renderable content", () => {
	const markdown = sessionUiMessagesToMarkdown([uiMessage("assistant", [{ type: "step-start" }]), uiMessage("user", [{ type: "text", text: "   " }])]);
	assert.equal(markdown, "");
});
