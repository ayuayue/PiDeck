import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { escapeHtml, sanitizeExportFileName, renderExportText, renderDshSessionHtml, EXPORT_IMAGE_MAX_DATA_URL_CHARS } = loadTsCommonJs("src/main/dsh/dshSessionHtmlExport.ts");

function message(overrides = {}) {
	return {
		id: "m1",
		agentId: "dsh:s1",
		role: "user",
		text: "hello",
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

test("escapeHtml：HTML 特殊字符全部转义", () => {
	assert.equal(escapeHtml("<script>alert(\"x\")</script> & 'y'"), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
});

test("sanitizeExportFileName：非法字符替换、空白收敛、限长、空回退", () => {
	assert.equal(sanitizeExportFileName('a/b\\c:d*e?f"g<h>i|j', "fallback"), "a_b_c_d_e_f_g_h_i_j.html");
	assert.equal(sanitizeExportFileName("  多  个 空格  ", "fb"), "多 个 空格.html");
	assert.equal(sanitizeExportFileName("x".repeat(100), "fb"), `${"x".repeat(60)}.html`);
	assert.equal(sanitizeExportFileName("", "session-1"), "session-1.html");
	assert.equal(sanitizeExportFileName("  \n\t ", "session-1"), "session-1.html");
});

test("renderExportText：代码围栏转 pre，行内 code 转 code，空行分段", () => {
	const html = renderExportText("before\n```ts\nconst x = 1 < 2;\n```\nafter");
	assert.ok(html.includes('<pre class="code-block"><code class="lang-ts">const x = 1 &lt; 2;'));
	assert.ok(html.includes("</code></pre>"));
	assert.ok(html.includes("<p>before</p>"));
	assert.ok(html.includes("<p>after</p>"));

	const inline = renderExportText("use `npm run typecheck` now");
	assert.ok(inline.includes("<code>npm run typecheck</code>"));

	const breaks = renderExportText("line1\nline2\n\npara2");
	assert.ok(breaks.includes("<p>line1<br>line2</p>"));
	assert.ok(breaks.includes("<p>para2</p>"));
});

test("renderExportText：注入脚本被转义", () => {
	const html = renderExportText("</p><script>alert(1)</script>");
	assert.ok(!html.includes("<script>"));
	assert.ok(html.includes("&lt;script&gt;"));
});

test("renderDshSessionHtml：user/assistant/tool 三类消息都渲染", () => {
	const messages = [
		message({ id: "u1", role: "user", text: "帮我写个函数" }),
		message({
			id: "a1",
			role: "assistant",
			text: "好的：\n```ts\nfunction f() { return 1; }\n```",
			thinking: "让我想想",
			thinkingStartedAt: 1_700_000_000_000,
		}),
		message({
			id: "t1",
			role: "tool",
			text: "write: 已写入 src/f.ts",
			meta: { toolName: "write", toolCallId: "c1", status: "done", durationMs: 120, args: { path: "src/f.ts" } },
		}),
	];
	const html = renderDshSessionHtml(messages, { title: "测试会话", cwd: "/ws", dshSessionId: "s1" });
	assert.ok(html.includes("<title>测试会话</title>"));
	assert.ok(html.includes("role-badge user"));
	assert.ok(html.includes("role-badge assistant"));
	assert.ok(html.includes("role-badge tool"));
	assert.ok(html.includes("thinking"));
	assert.ok(html.includes("tool-card done"));
	assert.ok(html.includes("write"));
	assert.ok(html.includes("workspace /ws"));
	assert.ok(html.includes("session s1"));
	// 消息文本已转义渲染
	assert.ok(html.includes("帮我写个函数"));
});

test("renderDshSessionHtml：超限图片跳过并注明，正常图片内联 data URL", () => {
	const small = message({
		id: "u2",
		role: "user",
		text: "看图",
		images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
	});
	const smallHtml = renderDshSessionHtml([small], { title: "t" });
	assert.ok(smallHtml.includes("data:image/png;base64,aGVsbG8="));

	const big = message({
		id: "u3",
		role: "user",
		text: "大图",
		images: [{ type: "image", mimeType: "image/png", data: "x".repeat(EXPORT_IMAGE_MAX_DATA_URL_CHARS) }],
	});
	const bigHtml = renderDshSessionHtml([big], { title: "t" });
	assert.ok(bigHtml.includes("image-skipped"));
	assert.ok(!bigHtml.includes("base64,"));
});

test("renderDshSessionHtml：system/error 消息低调展示且文本转义", () => {
	const messages = [message({ id: "e1", role: "error", text: "<boom> & failed" }), message({ id: "s1", role: "system", text: "system note" })];
	const html = renderDshSessionHtml(messages, { title: "t" });
	assert.ok(html.includes("&lt;boom&gt; &amp; failed"));
	assert.ok(html.includes("system note"));
});
