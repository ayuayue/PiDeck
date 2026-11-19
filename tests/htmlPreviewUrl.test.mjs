/**
 * HTML 预览的 URL 编解码（#377）。
 *
 * 复现路径：iframe srcDoc 会继承主窗口 CSP（script-src 无 'unsafe-inline'），
 * 用户单文件 HTML 的内联脚本被整段拦掉。改用 pideck-html: 协议后内容要经 URL 往返，
 * 这里锁定编解码的无损性与边界，避免中文/emoji/超长内容在预览里变形或整块丢失。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { HTML_PREVIEW_CSP, HTML_PREVIEW_OPEN_MESSAGE, HTML_PREVIEW_SCHEME, MAX_HTML_PREVIEW_CHARS, MAX_HTML_PREVIEW_URL_CHARS, decodeHtmlPreviewUrl, encodeHtmlPreviewUrl, readHtmlPreviewOpenRequest, withPreviewLinkBridge } = loadTsCommonJs("src/shared/htmlPreview.ts");

test("encode/decode round-trips plain HTML", () => {
	const html = "<!doctype html><html><body><h1>hi</h1></body></html>";
	const url = encodeHtmlPreviewUrl(html);
	assert.ok(url.startsWith(`${HTML_PREVIEW_SCHEME}://preview/`));
	assert.equal(decodeHtmlPreviewUrl(url), html);
});

test("encode/decode round-trips CJK and emoji content", () => {
	const html = "<p>中文标题</p><p>emoji: 🎉🚀</p><p>符号: +/=?</p>";
	const url = encodeHtmlPreviewUrl(html);
	assert.equal(decodeHtmlPreviewUrl(url), html);
	// base64url 不应把 + / = 留在路径里
	const path = url.slice(url.indexOf("/preview/") + 9);
	assert.ok(!/[+/=]/.test(path));
});

test("encode/decode round-trips content of awkward byte lengths", () => {
	// 1/2/3 字节余数分别覆盖 base64 补齐分支
	for (const len of [1, 2, 3, 4, 5, 6, 7]) {
		const html = "a".repeat(len);
		const url = encodeHtmlPreviewUrl(html);
		assert.equal(decodeHtmlPreviewUrl(url), html, `len=${len}`);
	}
});

test("encode returns null for empty or oversized content", () => {
	assert.equal(encodeHtmlPreviewUrl(""), null);
	const oversized = "x".repeat(MAX_HTML_PREVIEW_CHARS + 1);
	assert.equal(encodeHtmlPreviewUrl(oversized), null);
});

test("URL 长度上限按编码后长度判定（CJK/emoji 会膨胀 4–5.33 倍）", () => {
	// 回归（评审实测）：上限曾按 content.length（UTF-16）判，60 万汉字编码后是 2.4M 字符的 URL，
	// 超过 Chromium 约 2MB 的 URL 上限 → 导航不发起、iframe 白屏，且不会回退 srcDoc。
	const cjk = "中".repeat(600_000);
	assert.ok(cjk.length <= MAX_HTML_PREVIEW_CHARS, "content.length 仍在旧上限内");
	assert.equal(encodeHtmlPreviewUrl(cjk), null, "编码后 2.4M 字符必须拒绝，交给 srcDoc 回退");

	// 1M ASCII → 约 1.33M URL 字符，仍在限内，能正常往返
	const ascii = "a".repeat(1_000_000);
	const url = encodeHtmlPreviewUrl(ascii);
	assert.ok(url);
	assert.ok(url.length <= MAX_HTML_PREVIEW_URL_CHARS + 32, "URL 总长必须落在 Chromium 上限内");
	assert.equal(decodeHtmlPreviewUrl(url), ascii);
});

test("decode rejects foreign or malformed URLs", () => {
	assert.equal(decodeHtmlPreviewUrl("https://evil.test/preview/abc"), null);
	assert.equal(decodeHtmlPreviewUrl(`${HTML_PREVIEW_SCHEME}://other-host/abc`), null);
	assert.equal(decodeHtmlPreviewUrl(`${HTML_PREVIEW_SCHEME}://preview/`), null);
	assert.equal(decodeHtmlPreviewUrl("not a url at all"), null);
});

test("preview CSP allows inline scripts but blocks network egress", () => {
	// 这正是本次修复的核心：放开内联脚本
	assert.ok(HTML_PREVIEW_CSP.includes("script-src 'unsafe-inline'"));
	// 但预览不该变成网络客户端，也不该再嵌套页面
	assert.ok(HTML_PREVIEW_CSP.includes("connect-src 'none'"));
	assert.ok(HTML_PREVIEW_CSP.includes("frame-src 'none'"));
	assert.ok(HTML_PREVIEW_CSP.includes("default-src 'none'"));
});

test("链接桥注入在 </body> 前，且脚本本身可解析", () => {
	const html = '<!doctype html><html><body><a href="https://example.test/x">x</a></body></html>';
	const bridged = withPreviewLinkBridge(html);
	const open = bridged.indexOf("<script data-pideck-preview-bridge>");
	const bodyClose = bridged.indexOf("</body>");
	assert.ok(open > 0 && open < bodyClose, "桥接脚本应注入到 </body> 之前");
	// 转义错误（反斜杠多/少一层）会让内嵌正则直接 SyntaxError，而这条链路只在运行时才跑得到
	const script = bridged.slice(open, bridged.indexOf("</script>", open)).replace(/^<script data-pideck-preview-bridge>/, "");
	assert.doesNotThrow(() => new Function(script), "注入脚本必须是合法 JS");
	assert.ok(script.includes("/^https?:\\/\\//i.test(href)"), "只拦绝对 http(s) 链接");
	assert.ok(script.includes(`type: "${HTML_PREVIEW_OPEN_MESSAGE}"`), "消息类型必须与宿主的校验常量一致");
	assert.match(script, /event\.preventDefault\(\)/, "不 preventDefault 就会去撞 frame-src");
});

test("链接桥幂等：已注入的文档不重复注入", () => {
	const html = "<html><body>hi</body></html>";
	const once = withPreviewLinkBridge(html);
	assert.equal(withPreviewLinkBridge(once), once);
	// 无 </body> 的片段也要拿到桥（追加到末尾）
	assert.match(withPreviewLinkBridge("<p>fragment</p>"), /<p>fragment<\/p><script data-pideck-preview-bridge>/);
});

test("readHtmlPreviewOpenRequest 只放行 http(s) 的打开请求", () => {
	// 返回值来自 loadTsCommonJs 的独立上下文，不能用 deepStrictEqual 比原型
	const ok = readHtmlPreviewOpenRequest({ type: HTML_PREVIEW_OPEN_MESSAGE, url: "https://arxiv.org/abs/1", forceSystem: true });
	assert.equal(ok?.url, "https://arxiv.org/abs/1");
	assert.equal(ok?.forceSystem, true);
	assert.equal(readHtmlPreviewOpenRequest({ type: HTML_PREVIEW_OPEN_MESSAGE, url: "http://a.test" })?.forceSystem, false);
	const bad = [
		null,
		"str",
		42,
		{},
		{ type: "other", url: "https://a.test" },
		{ type: HTML_PREVIEW_OPEN_MESSAGE, url: "javascript:alert(1)" },
		{ type: HTML_PREVIEW_OPEN_MESSAGE, url: "file:///C:/x" },
		{ type: HTML_PREVIEW_OPEN_MESSAGE, url: "" },
		{ type: HTML_PREVIEW_OPEN_MESSAGE, url: `https://a.test/${"x".repeat(5000)}` },
	];
	for (const value of bad) assert.equal(readHtmlPreviewOpenRequest(value), null, JSON.stringify(value)?.slice(0, 80));
});
