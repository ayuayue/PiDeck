import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { normalizeBrowserWebLink } from "../src/shared/browserWebLink.ts";

test("the explicit browser action accepts HTTP(S) URLs and skips other links", () => {
	assert.equal(normalizeBrowserWebLink("HTTPS://Example.TEST/docs?q=2#part"), "https://example.test/docs?q=2#part");
	assert.equal(normalizeBrowserWebLink("http://127.0.0.1:5173/"), "http://127.0.0.1:5173/");
	for (const link of [undefined, "https://", "#section", "./page.html", "file:///page.html", "javascript:void(0)", "mailto:person@example.test"]) {
		assert.equal(normalizeBrowserWebLink(link), null);
	}
});

function setup() {
	const handlers = new Map();
	const protocolFor = (surface) => ({ handle: (scheme, handler) => handlers.set(surface + ":" + scheme, handler) });
	const load = createTsSandbox({
		stubs: { electron: { protocol: protocolFor("editor") } },
		globals: { Response, atob, btoa },
	});
	const { registerHtmlPreviewProtocol } = load("src/main/htmlPreviewProtocol.ts");
	registerHtmlPreviewProtocol();
	registerHtmlPreviewProtocol(protocolFor("browser"), "browser");
	return {
		...load("src/shared/htmlPreview.ts"),
		...load("src/main/browser/browserSecurity.ts"),
		...load("src/main/browser/browserHtmlSnapshots.ts"),
		request: (surface, url, method = "GET") => handlers.get(surface + ":pideck-html")({ url, method }),
	};
}

test("browser serves the Unicode HTML snapshot with its own opaque-origin sandbox", async () => {
	const { stageBrowserHtmlSnapshot, browserHtmlPreviewFileName, request } = setup();
	const html = "<script>document.body.textContent = '你好'</script>";
	const url = stageBrowserHtmlSnapshot("示例 #1.HTM", html);
	assert.equal(browserHtmlPreviewFileName(url + "#section"), "示例 #1.HTM");
	const response = await request("browser", url);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), html);
	assert.match(response.headers.get("Content-Security-Policy"), /(?:^|;\s*)sandbox allow-scripts(?:;|$)/);
	assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'none'/);
	assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
	assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("browser HTML can only be loaded as a main document and does not enable local file or Agent navigation", async () => {
	const { stageBrowserHtmlSnapshot, encodeHtmlPreviewUrl, isAllowedBrowserPanelFrameUrl, isAllowedBrowserPanelUrl, request } = setup();
	const url = stageBrowserHtmlSnapshot("index.html", "<p>hello</p>");
	const editorUrl = encodeHtmlPreviewUrl("<p>hello</p>");
	assert.ok(isAllowedBrowserPanelFrameUrl(url, true));
	assert.ok(isAllowedBrowserPanelFrameUrl("http://127.0.0.1:8080/", true));
	assert.ok(isAllowedBrowserPanelFrameUrl("https://example.test/", false));
	assert.equal(isAllowedBrowserPanelFrameUrl(url, false), false);
	assert.equal(isAllowedBrowserPanelUrl(url), false);
	assert.equal(isAllowedBrowserPanelFrameUrl("file:///index.html", true), false);
	assert.equal(isAllowedBrowserPanelFrameUrl(editorUrl, true), false);
	assert.equal((await request("editor", url)).status, 403);
	assert.equal((await request("browser", editorUrl)).status, 403);
	assert.equal((await request("browser", url, "POST")).status, 405);
});

test("large snapshots stay off the URL and can be refreshed", async () => {
	const { stageBrowserHtmlSnapshot, request } = setup();
	const html = "<p>" + "a".repeat(9_515_781) + "</p>";
	const url = stageBrowserHtmlSnapshot("index.html", html);
	assert.ok(url.length < 100);
	assert.equal(await (await request("browser", url)).text(), html);
	assert.equal(await (await request("browser", url + "#section")).text(), html);
});

test("browser preview cache removes old snapshots at its entry limit", async () => {
	const { stageBrowserHtmlSnapshot, request } = setup();
	const oldest = stageBrowserHtmlSnapshot("first.html", "<p>old</p>");
	for (let index = 0; index < 32; index++) stageBrowserHtmlSnapshot("latest.htm", "<p>new</p>");
	assert.equal((await request("browser", oldest)).status, 403);
});

test("browser preview rejects oversized HTML and malformed preview routes", async () => {
	const { stageBrowserHtmlSnapshot, MAX_BROWSER_HTML_PREVIEW_BYTES, isAllowedBrowserPanelFrameUrl, request } = setup();
	assert.equal(stageBrowserHtmlSnapshot("index.html", "中".repeat(Math.floor(MAX_BROWSER_HTML_PREVIEW_BYTES / 3) + 1)), null);
	const missing = "pideck-html://browser/index.html/11111111-1111-1111-1111-111111111111";
	assert.equal((await request("browser", missing)).status, 403);
	for (const url of ["pideck-html://browser/index.html/a", "pideck-html://browser/sub%2Findex.html/YQ", "pideck-html://browser/index.html/YQ?asset=1"]) {
		assert.equal(isAllowedBrowserPanelFrameUrl(url, true), false);
		assert.equal((await request("browser", url)).status, 403);
	}
});
