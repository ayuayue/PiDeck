import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");

test("HTML files have an in-place preview without widening BrowserPanel access", () => {
	assert.match(source, /const isHtml = ext === "html" \|\| ext === "htm"/);
	assert.match(source, /\(isMarkdown \|\| isHtml \|\| isSvg\) && !isDiffMode/);
	assert.match(source, /<HtmlPreview content=\{content\} \/>/);
});

test("HTML preview remains isolated from the renderer origin and popup capability", () => {
	const start = source.indexOf("function HtmlPreview(");
	assert.ok(start >= 0, "HtmlPreview should be defined");
	const preview = source.slice(start);
	// 内容经 pideck-html: 协议 URL 承载（CSP 由主进程响应头下发，与主窗口解耦）；
	// 超过 URL 上限时回退 srcDoc——两种写法都不得放宽下面三条隔离断言。
	assert.match(preview, /encodeHtmlPreviewUrl\(content\)/);
	assert.match(preview, /srcDoc: content/);
	assert.match(preview, /sandbox="allow-scripts allow-forms"/);
	assert.match(preview, /referrerPolicy="no-referrer"/);
	assert.doesNotMatch(preview, /allow-same-origin|allow-popups|allow-top-navigation/);
});

test("CodeMirror 编辑器保持懒加载：主 chunk 不得静态拉进 CodeMirror 6 全家桶", () => {
	// CodeMirrorEditor 静态链（@codemirror/view|state|commands|autocomplete|search|lint）
	// 经 WorkbenchContent → App 进入主 chunk，启动即解析；必须走 lazy 分包。
	assert.match(source, /const CodeMirrorEditor = lazy\(\(\) => import\("\.\/CodeMirrorEditor"\)/, "CodeMirrorEditor 必须懒加载");
	assert.doesNotMatch(source, /import \{ CodeMirrorEditor \} from/, "禁止静态 import 复活");
	// 用法处必须包 Suspense，首次加载有占位而不是白屏
	const usage = source.indexOf("<CodeMirrorEditor value=");
	assert.ok(usage > 0, "CodeMirrorEditor 用法应可被发现");
	const before = source.slice(Math.max(0, usage - 800), usage);
	assert.match(before, /<Suspense/, "用法必须包在 Suspense 内");
});
