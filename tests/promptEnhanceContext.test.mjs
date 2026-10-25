import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { collectPromptEnhanceContext } = loadTsCommonJs("src/renderer/src/utils/promptEnhanceContext.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const message = (role, text, extra = {}) => ({ id: "message", agentId: "agent", role, text, timestamp: 1, ...extra });

test("只发送用户/助手正文，pi/DSH 统一消息不带思考、工具、图片与元数据", () => {
	assert.deepEqual(
		plain(
			collectPromptEnhanceContext([
				message("system", "system private"),
				message("tool", "file private"),
				message("user", "pi 用户", { images: [{ type: "image", mimeType: "image/png", data: "private" }] }),
				message("assistant", "DSH 回复", { thinking: "private", meta: { backend: "dsh", private: "private" } }),
				message("assistant", "  ", { thinking: "private" }),
				message("error", "error private"),
			]),
		),
		[
			{ role: "user", text: "pi 用户" },
			{ role: "assistant", text: "DSH 回复" },
		],
	);
});

test("仅保留最近 12 条正文并保持时间顺序，不修改缓存对象", () => {
	const messages = Array.from({ length: 20 }, (_, i) => message(i % 2 ? "assistant" : "user", `message-${i}`));
	const before = JSON.stringify(messages);
	assert.deepEqual(
		plain(collectPromptEnhanceContext(messages)),
		messages.slice(-12).map(({ role, text }) => ({ role, text })),
	);
	assert.equal(JSON.stringify(messages), before);
});

test("16,000 字符预算优先最近内容，截断较旧正文且不拆 Unicode 代理对", () => {
	const context = collectPromptEnhanceContext([message("user", "A😀B"), message("assistant", "x".repeat(15_998))]);
	assert.equal(context.at(-1).text.length, 15_998);
	assert.ok(context.reduce((n, item) => n + item.text.length, 0) <= 16_000);
	assert.ok(context.every(({ text }) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text)));
});

test("没有正文或没有当前会话消息时不生成上下文", () => {
	assert.deepEqual(plain(collectPromptEnhanceContext([])), []);
	assert.deepEqual(plain(collectPromptEnhanceContext([message("tool", "private")])), []);
});
