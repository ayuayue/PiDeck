import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
// HtmlPreview 已从 FileDiffViewer 拆成独立模块（存量巨文件行数只准降，见 check:file-size）：隔离断言对着新模块看
const previewSource = readFileSync("src/renderer/src/components/app/preview/HtmlPreview.tsx", "utf8");

test("HTML files have an in-place preview without widening BrowserPanel access", () => {
	assert.match(source, /const isHtml = ext === "html" \|\| ext === "htm"/);
	assert.match(source, /\(isMarkdown \|\| isHtml \|\| isSvg \|\| isCsv\) && !isDiffMode/);
	assert.match(source, /<HtmlPreview content=\{content\} onOpenExternal=\{openPreviewExternal\} \/>/);
});

test("CSV 默认表格预览，且预览下不挂空编辑器", () => {
	// csv/tsv 是文本但默认走表格：打开就渲染，不要求用户先点「预览」。
	assert.match(source, /const isCsv = ext === "csv" \|\| ext === "tsv"/);
	assert.match(source, /const defaultPreview = !isDiffMode && \(isMarkdown \|\| isHtml \|\| isSvg \|\| isCsv\)/);
	// 专属预览同时排除图片/PDF/音视频/Office/压缩包与表格：二进制读成空串，
	// 挂编辑器只会和预览抢高度（媒体预览控制条被裁的直接原因）。
	assert.match(source, /const dedicatedPreview = !isDiffMode && \(isImage \|\| isPdf \|\| isAudio \|\| isVideo \|\| officePreviewKind !== null \|\| \(isCsv && preview\)\)/);
	assert.match(source, /\{!isDiffMode && preview && isCsv && <CsvPreview/);
	assert.match(source, /\{!isDiffMode && !preview && !dedicatedPreview && \(/);
});

test("视频预览不复用满高 video 元素（控制条会被撑到面板底部并裁掉）", () => {
	assert.match(source, /<MediaPreview url=\{mediaUrl\} fileName=\{fileName\}/);
	assert.doesNotMatch(source, /<video controls src=\{mediaUrl\}/, "video 标签应只在 MediaPreview 内");
});

test("HTML preview remains isolated from the renderer origin and popup capability", () => {
	// 内容经 pideck-html: 协议 URL 承载（CSP 由主进程响应头下发，与主窗口解耦）；
	// 超过 URL 上限时回退 srcDoc——两种写法都不得放宽下面三条隔离断言。
	assert.match(previewSource, /encodeHtmlPreviewUrl\(withPreviewLinkBridge\(content\)\)/);
	assert.match(previewSource, /srcDoc: content/);
	// 只看 sandbox 属性值：注释里会提到这些能力名（解释为什么不放开），不能把注释当违例
	assert.equal(previewSource.match(/sandbox="([^"]*)"/)?.[1], "allow-scripts allow-forms");
	assert.match(previewSource, /referrerPolicy="no-referrer"/);
});

test("HTML preview 的链接经宿主出口打开，而不放宽沙箱", () => {
	// 打开请求必须核对发起窗口：opaque origin 下 event.origin 恒为 "null"，只能比 event.source
	assert.match(previewSource, /event\.source !== frameRef\.current\?\.contentWindow/);
	assert.match(previewSource, /readHtmlPreviewOpenRequest\(event\.data\)/);
	assert.match(previewSource, /window\.addEventListener\("message", handleMessage\)/);
	// 出口与 markdown 正文同一条：desktopApi.app.openExternal（主进程只放行 http/https）
	assert.match(previewSource, /export function openPreviewExternal\(url: string, forceSystem\?: boolean\): void \{\n\tvoid desktopApi\.app\.openExternal\(url, forceSystem\)\.catch\(/, "外链出口必须带 catch：shell.openExternal 失败不能变成未处理 rejection");
	// 调用方：FileDiffViewer 不得把预览逻辑再搬回自己身上（行数门禁），且 markdown 预览不再传空 handler
	assert.match(source, /import \{ HtmlPreview, openPreviewExternal \} from "\.\/preview\/HtmlPreview"/);
	assert.match(source, /<MarkdownStream text=\{content\} onOpenExternal=\{openPreviewExternal\}/);
	assert.doesNotMatch(source, /noopOpenExternal/);
	assert.doesNotMatch(source, /function HtmlPreview\(/, "HtmlPreview 已在 preview\/HtmlPreview.tsx，不要再搬回 FileDiffViewer");
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

test("CSV 单元格编辑只在可保存的文件上开放，且走统一的脏/自动保存链路", () => {
	// 只读 tab（项目外文件）不能改单元格：传 undefined 让表格不渲染编辑入口，
	// 而不是渲染出来点了没反应。
	assert.match(source, /<CsvPreview[^>]*onChange=\{readOnlyView \? undefined : handleEditorChange\}/);
	// 单元格提交必须走 handleEditorChange（dirty 上报 + 500ms 防抖落盘 + Ctrl+S 前置），
	// 不能自己 setContent，否则保存链路与编辑器不一致。
	assert.match(source, /contentRef\.current = value;\n\t\t\tsetContent\(value\);\n\t\t\tsetDirty\(true\);/);
});

test("docx/xlsx 提供「用系统程序编辑」入口（预览本身只读）", () => {
	// 这两个格式 PiDeck 内无法回写，只能交给本机 Office/WPS：入口必须真实调起主进程 files:open。
	assert.match(source, /const officeEditHint = officePreviewKind === "docx" \|\| officePreviewKind === "spreadsheet"/);
	assert.match(source, /window\.piDesktop\?\.files\?\.open/);
	assert.match(source, /t\("editor\.editInOfficeApp"\)/);
	assert.match(source, /t\("editor\.openWithSystemHint"\)/);
});
