import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("FileDiffViewer: view mode is editable, diff mode is read-only render", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	// view 模式：CodeMirror 编辑器可编辑（readOnly=false），源码即编辑，无独立编辑按钮
	assert.match(viewer, /<CodeMirrorEditor/);
	assert.match(viewer, /readOnly=\{false\}/);
	// diff 模式：只读差异对比视图（CodeDiffView），不再有编辑态切换/编辑按钮
	assert.match(viewer, /<CodeDiffView/);
	assert.doesNotMatch(viewer, /Edit3/);
	assert.doesNotMatch(viewer, /PencilOff/);
	assert.doesNotMatch(viewer, /setReadOnly/);
	// markdown/html/svg 打开默认预览模式，点「源码」切换才进入编辑态；tab 切换同样重置为默认预览
	assert.match(viewer, /const defaultPreview = !isDiffMode && \(isMarkdown \|\| isHtml \|\| isSvg\)/);
	assert.match(viewer, /useState\(defaultPreview\)/);
	assert.match(viewer, /setPreview\(defaultPreview\)/);
});

test("FileDiffViewer: debounced auto-save with Ctrl+S immediate save", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	// 自动保存：编辑停止 500ms 后落盘（saveContent 存在时）；内容未变跳过
	assert.match(viewer, /scheduleAutoSave/);
	assert.match(viewer, /setTimeout\(\(\) => \{\n\s*saveTimerRef\.current = null;/);
	assert.match(viewer, /500\);/);
	assert.match(viewer, /lastSavedRef\.current/);
	assert.match(viewer, /if \(latest === lastSavedRef\.current\) return/);
	// 加载完成即建立「已落盘」基准，避免打开后无改动就写盘
	assert.match(viewer, /lastSavedRef\.current = result/);
	// Ctrl+S 立即保存（取消挂起 timer），卸载清理 timer（生命周期配对）
	assert.match(viewer, /void saveNow\(\);/);
	assert.match(viewer, /clearTimeout\(saveTimerRef\.current\)/);
});

test("FileDiffViewer: auto-save reads the latest edit and never reapplies a stale snapshot", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	// 编辑器回调与 debounce timer 之间不能捕获旧 render 的 content，否则停顿 500ms
	// 后会把最后一个字符回滚，CodeMirror 随后将光标带回文档开头。
	assert.match(viewer, /const contentRef = useRef\(content\)/);
	assert.match(viewer, /contentRef\.current = result;\n\s*setContent\(result\)/);
	assert.match(viewer, /const getLatestContent = useCallback\(\(\) => contentRef\.current, \[\]\)/);
	assert.match(viewer, /contentRef\.current = value;\n\s*setContent\(value\)/);
	// 保存完成后若用户已继续输入，不得用保存开始时的快照覆盖当前编辑内容。
	assert.match(viewer, /if \(contentRef\.current === latest\) \{\n\s*setDirty\(false\);\n\s*\}/);
	assert.doesNotMatch(viewer, /lastSavedRef\.current = latest;\n\s*setContent\(latest\)/);
});

test("editors bind Ctrl+/ comment toggle and JSON lint", () => {
	const editor = readFileSync("src/renderer/src/components/app/CodeMirrorEditor.tsx", "utf8");
	// Ctrl+/ 注释/取消注释（@codemirror/commands 的 toggleComment）
	assert.match(editor, /import \{[^}]*toggleComment/);
	assert.match(editor, /Mod-\//);
	// JSON 语法错误即时提示（lintGutter + jsonParseLinter，仅 json/jsonc）
	assert.match(editor, /lintGutter\(\), linter\(jsonParseLinter\(\)\)/);
	assert.match(editor, /resolvedLanguage\.language\.name === "json"/);
});

test("FileDiffViewer: markdown preview reuses .markdown-body + markdown-preview-chrome, no parallel legacy classes", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
	const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
	// 预览容器挂 markdown-body（与会话正文同一排版体系）+ markdown-preview-chrome（预览增量）
	assert.match(viewer, /markdown-body markdown-preview-chrome/);
	// 预览专属增量注册在 tailwind.css 的 @utility（新架构），不允许回落到 legacy surfaces.css 手写类
	assert.match(tailwind, /@utility markdown-preview-chrome/);
	assert.doesNotMatch(surfaces, /\.file-diff-preview/);
	// HTML 预览 iframe 改用 Tailwind 类，不再依赖 legacy 类
	assert.doesNotMatch(viewer, /className="file-diff-preview"/);
});

test("FileDiffViewer: image/PDF get inline preview via base64 Blob URL", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	const textFile = readFileSync("src/renderer/src/utils/isTextFile.ts", "utf8");
	const ipc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");
	// 判定函数：图片/PDF 从二进制集合中单独识别
	assert.match(textFile, /export function isImageFile/);
	assert.match(textFile, /export function isPdfFile/);
	assert.match(textFile, /IMAGE_EXTENSIONS = new Set/);
	// view 模式图片/PDF 走二进制预览分支；diff 模式维持不支持提示
	assert.match(viewer, /!isDiffMode && \(isImageFile\(props\.filePath\) \|\| isPdfFile\(props\.filePath\)\)/);
	// 不用 file:// 直链：dev 模式 http 页面加载 file:// 子资源会被 Chromium webSecurity 拦截
	// （"Not allowed to load local resource"）；改为主进程读 base64 → Blob URL
	assert.doesNotMatch(viewer, /file:\/\/\//);
	assert.match(viewer, /readBase64/);
	assert.match(viewer, /URL\.createObjectURL/);
	assert.match(viewer, /URL\.revokeObjectURL/);
	assert.match(viewer, /mimeFromImageExt/);
	assert.match(viewer, /className="file-diff-media-preview"/);
	assert.match(viewer, /className="file-diff-pdf-preview"/);
	assert.match(viewer, /editor\.pdfPreview/);
	// 主进程 handler：读文件转 base64，ENOENT 返回空串（渲染层走「不支持」提示）
	assert.match(ipc, /filesReadBase64/);
	assert.match(ipc, /readFile\(readablePath\)\)\.toString\("base64"\)/);
	assert.match(ipc, /code === "ENOENT"/);
});

test("FileDiffViewer: SVG preview via content data URL, media fills the pane", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	const css = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
	// SVG 是文本（可编辑），预览按钮与 md/html 同待遇；预览渲染为 data URL 图片
	assert.match(viewer, /const isSvg = ext === "svg"/);
	assert.match(viewer, /\(isMarkdown \|\| isHtml \|\| isSvg\) && !isDiffMode/);
	assert.match(viewer, /data:image\/svg\+xml;charset=utf-8/);
	assert.match(viewer, /encodeURIComponent\(content\)/);
	// 图片占满预览区：width/height 100% + contain（小图放大、大图缩小、不变形）
	assert.match(css, /\.file-diff-media-preview img \{\n\s*\/\* 占满预览区/);
	assert.match(css, /width: 100%;\n\s*height: 100%;\n\s*object-fit: contain;/);
});
