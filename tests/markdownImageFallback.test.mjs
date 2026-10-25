import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Markdown 图片的失败兜底契约（2026-10 对话内图片渲染）。
 *
 * 背景：改造前图片加载失败就是一块白/破图，用户既不知道是哪个路径、也没法重试；
 * 改造后的硬约束是三条，任何重构都不能回退：
 * 1. 解析不出可加载 URL → 显示 alt 原文（绝不产出空 src 的白图）；
 * 2. 加载失败 → 「失败文案 · alt 或原路径」+ 可重试；
 * 3. 失败态绑定具体 src（流式半截路径 404 之后，完整路径到达要能自愈）。
 *
 * 源码正则扫描测试：正则一律空白容忍（\s*），改格式不改变契约即应保持绿。
 */

const image = readFileSync("src/renderer/src/components/session/MarkdownImage.tsx", "utf8");
const actions = readFileSync("src/renderer/src/components/session/MarkdownImageActions.tsx", "utf8");
const indexHtml = readFileSync("src/renderer/index.html", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const twCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8");

test("解析不出 URL 时渲染 alt 原文，不产出空 src", () => {
	// 单图态：直接显示 alt（或原路径）
	assert.match(image, /<span className="text-text-tertiary">\{label\}<\/span>/);
	// 解不出地址时不再渲染占位框：流式期间会先闪一下占位框再变真图，改回纯 alt 文本
	assert.ok(!image.includes("ImageOff"), "不应再引入 ImageOff 占位图标");
});

test("加载失败：失败文案 + alt（或原路径）+ 可重试", () => {
	assert.match(image, /t\("markdown\.imageLoadFailed"\)/);
	// label 是 alt 缺失时的原路径兜底：用户能看见到底指的是哪个文件
	assert.match(image, /const label = props\.alt \|\| props\.destination/);
	assert.match(image, /t\("markdown\.imageRetry"\)/);
	// 重试 = 清掉失败态 → img 重新挂载重新请求（不是刷新整个会话）
	assert.match(image, /onClick=\{\(\)\s*=>\s*setFailedFor\(null\)\}/);
});

test("失败态绑定 src：换了地址要能自愈", () => {
	assert.match(image, /const failed = failedFor !== null && failedFor === src/);
	assert.match(image, /onError=\{\(\)\s*=>\s*setFailedFor\(src\)\}/);
});

test("图片可键盘打开预览（Enter/Space）且懒加载", () => {
	assert.match(image, /role="button"/);
	assert.match(image, /tabIndex=\{0\}/);
	assert.match(image, /event\.key === "Enter" \|\| event\.key === " "/);
	assert.match(image, /loading="lazy"/);
});

test("i18n 三份词典都有图片失败/重试/预览文案", () => {
	for (const copy of [zhCopy, enCopy, twCopy]) {
		for (const key of ["markdown.imageLoadFailed", "markdown.imageOpen", "markdown.imageRetry"]) {
			assert.ok(copy.includes(`"${key}"`), `缺少 i18n key：${key}`);
		}
	}
});

test("图片可下载：预览工具条注入 + hover 保存角标", () => {
	// 改造前由 streamdown 内置组件提供 hover 下载，换自研组件时丢了（用户反馈）；
	// 现在预览浮层工具条与大图 hover 角标都要在。
	assert.match(image, /actions=\{<MarkdownImageToolbar src=\{src\} alt=\{props\.alt\} \/>\}/);
	assert.match(image, /<MarkdownImageHoverSave src=\{src\} alt=\{props\.alt\} \/>/);
	assert.match(actions, /export function MarkdownImageToolbar/);
	assert.match(actions, /export function MarkdownImageHoverSave/);
	// 本地图必须走 IPC 取字节：pideck-file:// 是 corsEnabled:false 的自定义 scheme，fetch 会被拦
	assert.match(actions, /parseLocalImageUrl\(src\)/);
	assert.match(actions, /window\.piDesktop\.localImage\.readBytes\(localPath\)/);
	// 远程图才 fallback 到 fetch；保存用 <a download>，复制走 writeClipboardImage
	assert.match(actions, /await fetch\(src\)/);
	assert.match(actions, /link\.download = imageDownloadName\(alt, blob\.type\)/);
	assert.match(actions, /writeClipboardImage\(blob\)/);
	// 下载名走共享实现（与附件图/生图同一份映射），按钮带 testid 供 e2e 定位（不依赖中文文案）
	assert.match(actions, /import \{ imageDownloadName \} from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/imageFilename"/);
	assert.match(actions, /data-testid="markdown-image-save"/);
	assert.match(actions, /data-testid="markdown-image-copy"/);
	// 展示仍靠协议（img-src），保存不再依赖 connect-src 放开自定义 scheme
	assert.match(indexHtml, /img-src[^"]*pideck-file:/);
	assert.ok(!/connect-src[^"]*pideck-file:/.test(indexHtml), "connect-src 不应再放行 pideck-file");
});
