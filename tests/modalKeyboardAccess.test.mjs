/**
 * 模态 Escape 与键盘可达性契约（2026-03 键盘打磨轮引入）：
 * 背景：三个模态（BrowserSurface 全屏、图片预览、IM 指南弹窗）曾无 Escape 关闭路径，
 * 键盘用户被迫 Tab 寻找关闭钮；四处「点击展开」交互（IM Bot 卡、内置浏览器标签页、
 * Git 目录头、RPC 日志行）曾无键盘激活路径，其中 IM Bot 卡是键盘用户进入 Bot 配置的唯一入口。
 * 本测试用空白容忍正则锚定接线，防止未来重构把 Escape/键盘语义静默删除。
 * 新模态接入时把「Escape → 关闭」写进同一惯例并补断言。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(p, "utf8");

/** 空白容忍匹配：断言文件里存在匹配片段（正则需自带 \s* 容忍）。 */
function assertMatches(source, re, description) {
	assert.ok(re.test(source), `缺失：${description}\n正则：${re}`);
}

test("BrowserSurface 全屏模态：Escape 接 onClose", () => {
	const src = read("src/renderer/src/components/workspace/BrowserSurface.tsx");
	assertMatches(src, /Escape[\s\S]{0,200}props\.onClose\(\)/, "Escape 分支调用 props.onClose()");
	assertMatches(src, /useEffect\(\(\)\s*=>\s*\{[\s\S]*addEventListener\("keydown"[\s\S]*removeEventListener/s, "keydown 监听带清理");
});

test("图片预览模态：Escape 接 onClose", () => {
	// 浮层本体已抽到 ImageLightbox（Markdown 正文图片复用同一组件），
	// 模态壳 ImagePreviewModal 仍由 SurfaceComponents 提供。
	const src = read("src/renderer/src/components/session/ImageLightbox.tsx");
	const modal = src.slice(Math.max(0, src.indexOf("export function ImageLightbox") - 200), src.indexOf("export function ImageLightbox") + 2600);
	assertMatches(modal, /Escape[\s\S]{0,200}onClose\(\)/, "Escape 分支调用 onClose()");
	// 捕获阶段监听 + 阻止冒泡：否则下层会话的 Esc（停止生成）会同时触发
	assertMatches(modal, /addEventListener\("keydown",\s*onKeyDown,\s*true\)/, "Esc 用捕获阶段监听");
	assertMatches(modal, /stopPropagation\(\)/, "Esc 阻止冒泡");
});

test("图片预览模态：焦点进入与还原 + Tab 圈定 + dialog 语义", () => {
	const src = read("src/renderer/src/components/session/ImageLightbox.tsx");
	assertMatches(src, /role="dialog"/, "role=dialog");
	assertMatches(src, /aria-modal="true"/, "aria-modal");
	assertMatches(src, /aria-label=\{/, "可读名称");
	// 键盘用户打开预览后焦点必须进得去、关掉后回得来（否则掉回 body）
	assertMatches(src, /closeRef\.current\?\.focus\(\)/, "打开时焦点进关闭钮");
	assertMatches(src, /restore\?\.focus\(\)/, "卸载时还原焦点");
	assertMatches(src, /event\.key !== "Tab"/, "Tab 圈定处理");
});

test("IM 指南弹窗：Escape 与两个关闭入口共用统一关闭路径", () => {
	const src = read("src/renderer/src/components/app/settings/ImTab.tsx");
	assertMatches(src, /const closeGuide = useCallback/, "closeGuide 统一关闭函数");
	assertMatches(src, /Escape[\s\S]{0,120}closeGuide\(\)/, "Escape 接 closeGuide");
	// overlay 自点击与头部按钮也必须走同一函数（防三入口行为漂移）
	assertMatches(src, /e\.target === e\.currentTarget\)\s*closeGuide\(\)/, "overlay 点击走 closeGuide");
	assertMatches(src, /onClick=\{closeGuide\}/, "头部关闭钮走 closeGuide");
});

test("IM Bot 卡头：键盘可达的展开入口", () => {
	const src = read("src/renderer/src/components/app/settings/ImTab.tsx");
	const header = src.slice(src.indexOf("config-im-bot-header"), src.indexOf("config-im-bot-header") + 900);
	assertMatches(header, /role="button"/, "role=button（全局 focus-visible 环生效前提）");
	assertMatches(header, /tabIndex=\{0\}/, "可聚焦");
	assertMatches(header, /aria-expanded=\{isExpanded\}/, "展开状态可读");
	assertMatches(header, /onKeyDown=\{\(e\)\s*=>\s*\{[\s\S]{0,300}"Enter"\s*\|\|\s*e\.key\s*===\s*" "/s, "Enter/Space 激活");
	assertMatches(header, /toggleBotExpanded\(\)/, "键盘与鼠标共用 toggle");
});

test("内置浏览器标签页：tablist/tab 语义 + 键盘激活", () => {
	const src = read("src/renderer/src/components/app/BrowserPanel.tsx");
	assertMatches(src, /role="tablist"\s*aria-label=\{t\("browser\.tabsAriaLabel"\)\}/, "tablist 带可读名称");
	assertMatches(src, /role="tab"[\s\S]{0,400}aria-selected=\{tab\.id === activeTabId\}/s, "tab 语义 + 选中态");
	assertMatches(src, /onKeyDown=\{\(e\)\s*=>\s*\{[\s\S]{0,400}e\.key\s*===\s*"Enter"\s*\|\|\s*e\.key\s*===\s*" "\s*\)\s*\{[\s\S]{0,300}switchTab\(tab\.id\)/s, "Enter/Space 激活切换");
	assertMatches(src, /focus-visible:shadow-\[var\(--focus-ring\)\]/, "焦点环（仓库惯例）");
});

test("Git 目录头：键盘可达的折叠入口", () => {
	const src = read("src/renderer/src/components/app/git/GitResourceTree.tsx");
	const header = src.slice(src.indexOf("group/dir"), src.indexOf("group/dir") + 1100);
	assertMatches(header, /role="button"/, "role=button");
	assertMatches(header, /aria-expanded=\{!props\.collapsedDirs\.has\(dir\)\}/, "展开状态可读");
	assertMatches(header, /onKeyDown=\{\(e\)\s*=>\s*\{[\s\S]{0,400}e\.key\s*===\s*"Enter"\s*\|\|\s*e\.key\s*===\s*" "\s*\)\s*\{[\s\S]{0,300}props\.onToggleDir\(dir\)/s, "Enter/Space 激活折叠");
});

test("RPC 日志行：键盘可达的展开入口 + 焦点环", () => {
	const src = read("src/renderer/src/components/workspace/RpcLogPanel.tsx");
	const entry = src.slice(src.indexOf("rpc-log-entry ${directionClass}"), src.indexOf("rpc-log-entry ${directionClass}") + 800);
	assertMatches(entry, /role="button"/, "role=button");
	assertMatches(entry, /aria-expanded=\{expanded\}/, "展开状态可读");
	assertMatches(entry, /onKeyDown=\{\(e\)\s*=>\s*\{[\s\S]{0,400}e\.key\s*===\s*"Enter"\s*\|\|\s*e\.key\s*===\s*" "\s*\)\s*\{[\s\S]{0,300}onToggle\(log\)/s, "Enter/Space 激活");
	const css = read("src/renderer/src/styles/surfaces.css");
	assertMatches(css, /\.rpc-log-entry:focus-visible\s*\{[\s\S]{0,200}var\(--focus-ring\)/, "行焦点环样式");
});

test("tablist 可读名称三语言同步", () => {
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	const tw = read("src/renderer/src/i18n/rendererCopy.zh-TW.ts");
	assertMatches(zh, /"browser\.tabsAriaLabel":\s*"[^"]+"/, "zh-CN 存在");
	assertMatches(en, /"browser\.tabsAriaLabel":\s*"[^"]+"/, "en-US 存在");
	assertMatches(tw, /"browser\.tabsAriaLabel":\s*"[^"]+"/, "zh-TW 存在");
});
