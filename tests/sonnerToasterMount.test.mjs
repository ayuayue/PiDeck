// 回归测试：sonner Toaster 挂载探测必须走显式 ready 标记，不能用 DOM 探测。
// 背景：sonner 2.x 在没有可见 toast 时不渲染任何 DOM（`if (!filteredToasts.length) return null`），
// 旧的 querySelector("[data-sonner-toaster]") 探测会在每个首个 toast 前误判未挂载，
// 导致所有通知永远走 DOM 兜底（黑底药丸样式），sonner 美化样式完全不生效。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const notice = readFileSync("src/renderer/src/utils/notice.ts", "utf8");
const toaster = readFileSync("src/renderer/src/components/ui-shadcn/sonner.tsx", "utf8");
const card = readFileSync("src/renderer/src/components/ui-shadcn/notice-toast.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("toaster mounted state is reported explicitly, not probed via DOM", () => {
	assert.match(notice, /export function setToasterReady/);
	assert.doesNotMatch(notice, /querySelector\("\[data-sonner-toaster\]"\)/);
	assert.match(toaster, /setToasterReady\(true\)/);
	// 顶部 offset 必须让开自定义标题栏拖拽区，否则关闭按钮点击被 drag 命中测试吞掉
	assert.match(toaster, /var\(--window-drag-height/);
});

test("sonner toast uses neutral panel tokens instead of the dark pill", () => {
	// 单条 toast 外观由自定义卡片 NoticeToastCard 承担，走同一套面板 token
	assert.match(card, /bg-bg-panel/);
	assert.match(card, /shadow-\[var\(--shadow-popover\)\]/);
	assert.match(card, /border-border-subtle/);
	// 兜底 DOM toast 也不再使用黑色背景
	assert.doesNotMatch(notice, /rgba\(17,19,21/);
});

test("typed toast icons carry semantic colors", () => {
	assert.match(card, /CircleAlert/);
	assert.match(card, /TriangleAlert/);
	assert.match(card, /text-danger/);
	assert.match(card, /text-warning/);
	assert.match(card, /text-info/);
});

// Ask（等待回答）不能借用 warning 的黄三角：用户会误读成「会话出错」。
test("ask toast uses the dedicated question kind, not warning", () => {
	// 后台 Ask 提醒走 question 档。M7 把巡检从每栏的 useSessionRuntimeController
	// 收敛到 App 级单点挂载 useBackgroundAskPatrol，断言随之跟随新宿主文件；
	// 同时守住架构约束：分栏 hook 不得再寄生一份巡检。
	const patrol = readFileSync("src/renderer/src/hooks/useBackgroundAskPatrol.ts", "utf8");
	const runtimeController = readFileSync("src/renderer/src/hooks/useSessionRuntimeController.ts", "utf8");
	assert.match(patrol, /showNotice\(message, Number\.POSITIVE_INFINITY, "question"/);
	assert.doesNotMatch(runtimeController, /showNotice\(message, Number\.POSITIVE_INFINITY, "question"/);
	// question 档有独立图标（问号气泡）与身份色（--color-tool，跟会话内 ask 工具卡一致），
	// 既不是 warning 黄也不是主题强调色，避免「Ask = 出错」的误读
	assert.match(card, /question:\s*\{ Icon: MessageCircleQuestion/);
	assert.match(card, /question:.*--color-tool/);
	assert.match(notice, /question:\s*"var\(--color-tool\)"/);
	// 卡片与 DOM 兜底的 kind 联合类型同步包含 question
	assert.match(notice, /export type NoticeKind = "info" \| "error" \| "warning" \| "question"/);
});

test("dialogs ignore outside interactions coming from the toast region", () => {
	// Radix DismissableLayer 会把点 toast 关闭按钮误判为「点击弹框外部」而连带关弹框，
	// dialog 包装层必须组合 guard；AlertDialog 原生就不响应外部点击，无需处理
	const dialog = readFileSync("src/renderer/src/components/ui-shadcn/dialog.tsx", "utf8");
	const guard = readFileSync("src/renderer/src/components/ui-shadcn/toastOutsideGuard.ts", "utf8");
	assert.match(dialog, /isOutsideInteractionFromToast/);
	assert.match(dialog, /onPointerDownOutside=\{/);
	assert.match(guard, /data-sonner-toaster/);
	assert.match(guard, /#app-notice-fallback-host/);
});

test("toaster stays clickable while a Radix modal disables body pointer events", () => {
	// Radix Dialog 模态打开时 body{pointer-events:none}，toast 必须显式恢复，
	// 否则弹框期间关闭按钮与 hover 全部失效
	assert.match(surfaces, /\[data-sonner-toaster\][\s\S]*?pointer-events:\s*auto/);
});

test("toaster is excluded from the window drag region and drag height is exposed at :root", () => {
	// Electron 自定义标题栏的 -webkit-app-region: drag 命中测试优先于 z-index，
	// toaster 必须显式 no-drag，否则首个 toast 的关闭按钮/hover 全部失效
	assert.match(surfaces, /\[data-sonner-toaster\][\s\S]*?-webkit-app-region:\s*no-drag/);
	// toaster 不是 .wechat-shell 的后代，--window-drag-height 必须在 :root 可读
	const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	assert.match(foundation, /:root:has\(\.custom-titlebar-enabled\)/);
});
