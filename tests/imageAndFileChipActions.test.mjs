import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 对话图片与文件 chip 的动作出口契约（2026-10 用户反馈补齐）：
 * 1. 上传图片：缩略图 hover 覆盖层 + 预览弹层底部都能复制/保存，两条路共用 ImageActionButtons；
 * 2. 粘贴转文件 chip：除删除外补「系统默认打开」「复制路径」；
 * 3. 对话内文件 chip：右键弹坐标菜单（默认打开/在文件夹中显示/复制路径）。
 *
 * 源码正则扫描测试：正则一律空白容忍（\s*），改格式不改变契约本身即应保持绿。
 */

const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const panels = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
const imageActions = readFileSync("src/renderer/src/components/session/imageActions.tsx", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("ImageActionButtons shares one copy/save implementation for thumbnails and preview modal", () => {
	assert.match(imageActions, /export\s+function\s+ImageActionButtons\(/);
	// 字节获取必须走 loadImageBase64（内联 base64 短路、ref 经 imagegen:read-image-blob 按需取回）
	assert.match(imageActions, /loadImageBase64\(/);
	// 复制走 writeClipboardImage：Electron 失焦时 ClipboardItem 会静默失败，data: fetch 也会被 CSP 拦
	assert.match(imageActions, /writeClipboardImage\(/);
	// 保存用 <a download> 下载，禁止把 base64 写回任何 JSONL/状态
	assert.match(imageActions, /link\.download\s*=/);
	// 缩略图 hover 覆盖层与预览弹层都要挂同一个组件
	assert.match(surface, /group-hover\/img:opacity-100[\s\S]{0,300}ImageActionButtons\s+image=\{img\}/);
	assert.match(surface, /image-preview-modal[\s\S]{0,600}ImageActionButtons\s+image=\{props\.image\}/);
});

test("user bubble file chips open a coordinate context menu with open/reveal/copy-path", () => {
	// 渲染链路把右键回调一路传到 renderChipText
	assert.match(surface, /onFileContextMenu\?:\s*\(path:\s*string,\s*x:\s*number,\s*y:\s*number\)\s*=>\s*void/);
	assert.match(surface, /onContextMenu=\{\s*chip\.kind\s*===\s*"file"[\s\S]{0,400}onFileContextMenu\?\.\(/);
	// 菜单三出口齐全：系统默认打开 / 在文件夹中显示 / 复制路径
	for (const key of ["menu.defaultOpen", "menu.revealFile", "menu.copyPath"]) {
		assert.ok(surface.includes(`t("${key}")`), `file chip menu must use ${key}`);
	}
	assert.match(surface, /desktopApi\.files\.open\(fileChipMenu\.path\)/);
	assert.match(surface, /desktopApi\.files\.showInFolder\(fileChipMenu\.path\)/);
	assert.match(surface, /writeClipboard\(fileChipMenu\.path\)/);
});

test("paste-file chips expose system open and copy-path alongside remove", () => {
	// 打开/复制按钮与删除按钮同款 hover 显隐（复用 image-remove-btn 锚点类，不新增手写 CSS）
	assert.match(panels, /desktopApi\.files\.open\(file\.path\)[\s\S]{0,300}<FolderOpen/);
	assert.match(panels, /writeClipboard\(file\.path\)[\s\S]{0,300}<Copy/);
	assert.match(panels, /paste-file-remove-btn/);
});

test("image action copy keys exist in both locales", () => {
	assert.match(zhCopy, /"imagegen\.copyFailed":\s*"[^"]+"/);
	assert.match(zhCopy, /"imagegen\.saveFailed":\s*"[^"]+"/);
	assert.match(enCopy, /"imagegen\.copyFailed":\s*"[^"]+"/);
	assert.match(enCopy, /"imagegen\.saveFailed":\s*"[^"]+"/);
});
