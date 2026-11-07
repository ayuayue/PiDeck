import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const binaryPreview = loadTsCommonJs("src/renderer/src/utils/binaryPreview.ts");
const base64Bytes = loadTsCommonJs("src/renderer/src/utils/base64Bytes.ts");

test("binaryPreview: Office / archive / media classification by extension", () => {
	const { getBinaryPreviewKind } = binaryPreview;
	assert.equal(getBinaryPreviewKind("docs/report.docx"), "docx");
	assert.equal(getBinaryPreviewKind("C:\\\\tmp\\\\Report.DOCM"), "docx");
	assert.equal(getBinaryPreviewKind("budget.xlsx"), "spreadsheet");
	assert.equal(getBinaryPreviewKind("legacy.XLS"), "spreadsheet");
	assert.equal(getBinaryPreviewKind("bundle.zip"), "archive");
	assert.equal(getBinaryPreviewKind("voice.mp3"), "audio");
	assert.equal(getBinaryPreviewKind("clip.MP4"), "video");
	// 不支持的格式必须回 null（继续走「二进制不支持编辑」提示），不能误报成可预览
	assert.equal(getBinaryPreviewKind("slides.pptx"), null);
	assert.equal(getBinaryPreviewKind("legacy.doc"), null);
	assert.equal(getBinaryPreviewKind("app.exe"), null);
	assert.equal(getBinaryPreviewKind("README.md"), null);
	assert.equal(getBinaryPreviewKind(".hidden"), null);
});

test("binaryPreview: media MIME is only defined for audio/video extensions", () => {
	const { getMediaMimeForPath } = binaryPreview;
	assert.equal(getMediaMimeForPath("a.mp3"), "audio/mpeg");
	assert.equal(getMediaMimeForPath("a.webm"), "video/webm");
	assert.equal(getMediaMimeForPath("a.docx"), undefined);
	assert.equal(getMediaMimeForPath("a.png"), undefined);
});

test("base64ToBytes: decodes UTF-8 bytes back to the original buffer", () => {
	const source = Buffer.from("PiDeck preview 预览", "utf8");
	const decoded = base64Bytes.base64ToBytes(source.toString("base64"));
	assert.deepEqual(Buffer.from(decoded), source);
	// 返回 ArrayBuffer（不是 SharedArrayBuffer 视图），才能直接交给 Blob/docx-preview
	assert.equal(decoded.buffer.constructor.name, "ArrayBuffer");
});

test("FileDiffViewer: office/archive/media previews are dispatched lazily instead of erroring out", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	// 图片/PDF/音视频统一走 Blob URL；Office/zip 交给自带读盘的 BinaryFilePreview
	assert.match(viewer, /getBinaryPreviewKind\(props\.filePath\)/);
	assert.match(viewer, /getMediaMimeForPath\(props\.filePath\)/);
	assert.match(viewer, /<BinaryFilePreview\s/);
	assert.match(viewer, /<audio\s/);
	assert.match(viewer, /<video\s/);
	// 预览器必须按类型懒加载，不能把 docx/xlsx 解析库拖进首屏 chunk
	const host = readFileSync("src/renderer/src/components/app/preview/BinaryFilePreview.tsx", "utf8");
	assert.match(host, /lazy\(\(\) => import\("\.\/DocxPreview"\)\)/);
	assert.match(host, /lazy\(\(\) => import\("\.\/SheetPreview"\)\)/);
	assert.match(host, /lazy\(\(\) => import\("\.\/ArchivePreview"\)\)/);
	assert.match(host, /BINARY_PREVIEW_MAX_BYTES\[/);
});

test("docx/zip previews never navigate to document-supplied targets", () => {
	const docx = readFileSync("src/renderer/src/components/app/preview/DocxPreview.tsx", "utf8");
	assert.match(docx, /anchor\.removeAttribute\("href"\)/);
	assert.match(docx, /anchor\.removeAttribute\("target"\)/);
	assert.match(docx, /if \(!\/\^\(\?:data:\|blob:\)\/i\.test\(src\)\) img\.removeAttribute\("src"\)/);
	assert.match(docx, /closest\("a"\)/);
	const archive = readFileSync("src/renderer/src/components/app/preview/ArchivePreview.tsx", "utf8");
	// filter 返回 false：只读中央目录列条目，不把内容解压进内存
	assert.match(archive, /filter: \(file\) => \{/);
	assert.match(archive, /return false;/);
});

test("media playback CSP allows blob: sources", () => {
	const html = readFileSync("src/renderer/index.html", "utf8");
	assert.match(html, /media-src 'self' blob: pideck-sound: pideck-video: pideck-we:/);
});

test("ToolCard: exposes open-file entry points and an output context menu", () => {
	const tools = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
	assert.match(tools, /const openableFilePath =\s*diffTarget\?\.path \?\?\s*getToolFilePath\(/);
	assert.match(tools, /ContextMenuTrigger asChild/);
	assert.match(tools, /tool\.copyOutput/);
	// pi 截断提示行同时提供「复制路径」与「打开文件」
	assert.match(tools, /void copyTextWithCopiedNotice\(\s*piTruncation\.fullOutputPath \?\? "",?\s*\)/);
	assert.match(tools, /props\.onOpenFile\?\.\(piTruncation\.fullOutputPath \?\? ""\)/);
});

test("preview i18n keys exist in zh-CN / en-US and survive into generated zh-TW", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const tw = readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8");
	for (const key of ["editor.previewFailed", "editor.previewUnavailable", "editor.mediaUnsupported", "editor.archiveEmpty", "editor.archiveSummary", "editor.sheetTruncated", "editor.sheetEmpty", "tool.copyOutput"]) {
		assert.match(zh, new RegExp(`"${key.replace(/\./g, "\\.")}":`), `${key} missing in zh-CN`);
		assert.match(en, new RegExp(`"${key.replace(/\./g, "\\.")}":`), `${key} missing in en-US`);
		assert.match(tw, new RegExp(`"${key.replace(/\./g, "\\.")}":`), `${key} missing in generated zh-TW`);
	}
});
