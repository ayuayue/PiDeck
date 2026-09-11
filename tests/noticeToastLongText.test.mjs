// toast 长文本「查看详情」契约（长标题/正文截断显示，完整内容进详情弹窗，复制不截断）。
//
// 背景：ask 等场景的 toast 标题可能特别长，卡片被撑得很高、观感差。契约：
//  1. 卡片对标题/正文做 max-height 截断，并用 scrollHeight > clientHeight 检测溢出；
//  2. 截断时提供「查看详情」入口，点击后先 dismiss toast 再打开详情弹窗
//     （toast z-index 远高于 dialog，卡片不关会浮在遮罩上方）；
//  3. 详情弹窗宿主必须挂在 Toaster 常驻层（sonner.tsx），不能挂在卡片内部——
//     点详情会卸载 toast 卡片，弹窗若在其内部会被连带卸载；
//  4. 复制按钮始终复制完整文本（标题 + 换行 + 正文），不受截断影响；
//  5. i18n key 在 zh-CN / en-US 同步存在。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const card = readFileSync("src/renderer/src/components/ui-shadcn/notice-toast.tsx", "utf8");
const toaster = readFileSync("src/renderer/src/components/ui-shadcn/sonner.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("toast card clamps long title/description and detects overflow", () => {
	// 标题最多 3 行（leading-5 → 60px），正文最多 4 行（leading-4 → 64px）
	assert.match(card, /max-h-\[60px\] overflow-hidden/);
	assert.match(card, /max-h-\[64px\] overflow-hidden/);
	// 溢出检测：scrollHeight > clientHeight（纯 overflow-hidden 方案，line-clamp 下不可靠）
	assert.match(card, /scrollHeight > el\.clientHeight \+ 1/);
	assert.match(card, /useLayoutEffect/);
});

test("truncated card offers view-details and dismisses toast before opening the dialog", () => {
	assert.match(card, /t\("notice\.viewDetails"\)/);
	// 点击详情：先 openNoticeDetails 带 kind/完整文本，再 toast.dismiss(toastId)
	assert.match(card, /openNoticeDetails\(\{ title, description, kind \}\)/);
	assert.match(card, /toast\.dismiss\(toastId\)/);
});

test("details dialog host lives in the Toaster layer, not inside the toast card", () => {
	// 弹窗组件导出自 notice-toast，但由 sonner.tsx 的 Toaster 常驻挂载并注册 opener
	assert.match(card, /export function NoticeDetailsDialog/);
	assert.match(card, /export function setNoticeDetailsOpener/);
	assert.match(card, /export function openNoticeDetails/);
	assert.match(toaster, /setNoticeDetailsOpener\(setDetails\)/);
	assert.match(toaster, /<NoticeDetailsDialog/);
	// 卡片内部不得直接渲染弹窗（否则随 toast 卸载被连带关闭）
	assert.doesNotMatch(card, /<NoticeDetailsDialog/);
});

test("copy keeps the full text regardless of truncation", () => {
	// 卡片与弹窗的复制语义一致：有正文时「标题\n正文」，否则仅标题（拼接在截断之后，不受显示截断影响）
	const copySemantic = (source) => source.match(/const copyText = ([^\n]+);/g) ?? [];
	const cardCopies = copySemantic(card).filter((line) => line.includes("description"));
	assert.ok(
		cardCopies.length >= 2,
		`card and dialog must each keep full-text copy semantics, got: ${cardCopies.length}`,
	);
	// 复制走完整 copyText，且复制入口不在 truncated 条件内（截断与否都可复制）
	assert.match(card, /writeClipboardText\(copyText\)/);
	assert.doesNotMatch(card, /truncated \?[\s\S]{0,200}handleCopy/);
});

test("notice details i18n keys exist in zh-CN and en-US", () => {
	assert.match(zh, /"notice\.viewDetails": "查看详情"/);
	assert.match(zh, /"notice\.detailsTitle": "通知详情"/);
	assert.match(en, /"notice\.viewDetails": "View details"/);
	assert.match(en, /"notice\.detailsTitle": "Notification details"/);
});
