/**
 * web.html 服务出口资源路径改写契约：
 * /s/<id> 会话路由下，构建产物的相对引用（./assets/...）会被浏览器解析成
 * /s/assets/... → 404 → 整页白屏（2027-02 手机 Web 刷新白屏根因）。
 * WebServiceManager 服务 web.html 时必须改写为绝对路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { rewriteWebHtmlAssetUrls } = loadTsCommonJs(resolve(import.meta.dirname, "../src/main/web/webHtmlAssetUrls.ts"));

test("rewriteWebHtmlAssetUrls: href/src 的 ./xxx 改写为 /xxx", () => {
	const html = [
		`<script type="module" crossorigin src="./assets/web-Ab12.js"></script>`,
		`<link rel="modulepreload" crossorigin href="./assets/vendor-react-Cd34.js">`,
		`<link rel="stylesheet" crossorigin href="./assets/web-Ef56.css">`,
		`<link rel="manifest" href="./manifest.webmanifest" />`,
		`<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />`,
	].join("\n");
	const out = rewriteWebHtmlAssetUrls(html);
	assert.match(out, /src="\/assets\/web-Ab12\.js"/);
	assert.match(out, /href="\/assets\/vendor-react-Cd34\.js"/);
	assert.match(out, /href="\/assets\/web-Ef56\.css"/);
	assert.match(out, /href="\/manifest\.webmanifest"/);
	assert.match(out, /href="\/icons\/apple-touch-icon\.png"/);
	assert.doesNotMatch(out, /"\.\//);
});

test("rewriteWebHtmlAssetUrls: 已是绝对路径或其他属性不动，普通正文文本不受影响", () => {
	const html = [`<script type="module" src="/assets/already-absolute.js"></script>`, `<img data-src="./keep-data-src.png">`, `<p>说明：./assets 也会出现在正文里，不能被误改。</p>`].join("\n");
	const out = rewriteWebHtmlAssetUrls(html);
	assert.match(out, /src="\/assets\/already-absolute\.js"/);
	assert.match(out, /data-src="\.\/keep-data-src\.png"/);
	assert.match(out, /\.\/assets 也会出现在正文里/);
});

test("源码契约：WebServiceManager 服务 web.html 时走改写出口（loadWebEntryHtml）而非 sendFile", () => {
	const src = readFileSync(resolve(import.meta.dirname, "../src/main/web/WebServiceManager.ts"), "utf8");
	assert.match(src, /import \{ rewriteWebHtmlAssetUrls \} from "\.\/webHtmlAssetUrls"/);
	assert.match(src, /loadWebEntryHtml\(webEntry\)/);
	// sendHtml 带 no-store：发版后旧壳不能驻留（引用旧 bundle 名）
	assert.match(src, /this\.sendHtml\(response, this\.loadWebEntryHtml\(webEntry\)\)/);
});
