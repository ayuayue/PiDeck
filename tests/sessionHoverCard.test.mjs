import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("ui-shadcn hover-card primitive wraps radix hover card correctly", () => {
	const source = readFileSync("src/renderer/src/components/ui-shadcn/hover-card.tsx", "utf8");
	assert.match(source, /from "radix-ui"/);
	assert.match(source, /HoverCardPrimitive\.Root/);
	assert.match(source, /HoverCardPrimitive\.Trigger/);
	assert.match(source, /HoverCardPrimitive\.Content/);
	assert.match(source, /floatingWheelGuardRef/);
	assert.match(source, /openDelay=\{openDelay\}/);
	assert.match(source, /closeDelay=\{closeDelay\}/);
});

test("SessionHoverCard enforces 1.5s openDelay to prevent hover race condition", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/SessionHoverCard.tsx", "utf8");
	// 默认 1.5 秒延时（openDelay = 1500），鼠标划过列表时不触发
	assert.match(source, /openDelay\s*=\s*1500/);
	assert.match(source, /closeDelay\s*=\s*200/);
	// 右侧弹出，不遮挡侧栏列表项
	assert.match(source, /side="right"/);
	assert.match(source, /align="start"/);
	// 展示主要信息
	assert.match(source, /formatFullDateTime/);
	assert.match(source, /sidebar\.hoverCard\.workspace/);
	assert.match(source, /sidebar\.hoverCard\.updatedAt/);
	assert.match(source, /sidebar\.hoverCard\.localTask/);
	assert.match(source, /SessionBackendMark/);
	assert.match(source, /SessionSourceBadge/);
});

test("SessionTree wraps session rows with SessionHoverCard", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
	assert.match(source, /import \{ SessionHoverCard \} from "\.\/SessionHoverCard"/);
	// 运行中 Agent 行、历史会话行、草稿行、子 Agent 行均有接入 SessionHoverCard
	const matches = source.match(/<SessionHoverCard\b/g);
	assert.ok(matches && matches.length >= 4, `expected at least 4 SessionHoverCard usages, got ${matches?.length ?? 0}`);
	// 浮层在右键菜单激活时禁用（disabled={Boolean(props.controller.menu)}）
	assert.match(source, /disabled=\{Boolean\(props\.controller\.menu\)\}/);
});

test("ActiveSessionsTree wraps active session rows with SessionHoverCard", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/ActiveSessionsTree.tsx", "utf8");
	assert.match(source, /import \{ SessionHoverCard \} from "\.\/SessionHoverCard"/);
	assert.match(source, /<SessionHoverCard\b/);
	assert.match(source, /projectName=\{project\?\.name\}/);
	assert.match(source, /disabled=\{Boolean\(controller\.menu\)\}/);
});

test("hover-card i18n copy is synchronized between zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

	const keys = [
		"sidebar.hoverCard.workspace",
		"sidebar.hoverCard.updatedAt",
		"sidebar.hoverCard.emptyPreview",
		"sidebar.hoverCard.localTask",
		"sidebar.hoverCard.messageCount",
	];

	for (const key of keys) {
		assert.match(zh, new RegExp(`"${key.replace(/\./g, "\\.")}":`));
		assert.match(en, new RegExp(`"${key.replace(/\./g, "\\.")}":`));
	}
});

test("SessionHoverCard cancels hover-open on row click and suppresses post-click remounts", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/SessionHoverCard.tsx", "utf8");
	// 点击会话是导航：pointerdown 立即取消已开卡片并压制延迟 open。
	assert.match(source, /onPointerDown=\{handleTriggerPointerDown\}/);
	assert.match(source, /cancelPendingOpen/);
	// 模块级「最近一次行点击」时间戳：点击后列表按 updatedAt 重排、行可能重挂载，
	// 新实例自身的 suppressUntilRef 已归零，必须共享时间戳才能吞掉 1.5s 后的弹出。
	assert.match(source, /lastRowPointerDownAt/);
	assert.match(source, /HOVER_SUPPRESS_EXTRA_MS/);
	// 受控 open：Radix 的延迟 open 必须经 handleOpenChange 的 isSuppressed 校验。
	assert.match(source, /open=\{open\} onOpenChange=\{handleOpenChange\}/);
	assert.match(source, /const isSuppressed = \(\)/);
	// 压制窗口按 openDelay + closeDelay + 额外余量计算，与默认 1500ms 对齐。
	assert.match(source, /const suppressWindowMs = openDelay \+ closeDelay \+ HOVER_SUPPRESS_EXTRA_MS/);
});

test("SessionHoverCard closes reliably when the pointer leaves trigger and content", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/SessionHoverCard.tsx", "utf8");
	// 关闭安全网：列表重排会让触发行在光标下重挂载，pointerleave 不派发 → Radix 收不到
	// 关闭事件，卡片残留。open 期间全局捕获 pointermove，离开触发行+卡片即兜底关闭。
	assert.match(source, /addEventListener\("pointermove"/);
	assert.match(source, /triggerRef\.current\?\.contains\(target\)/);
	assert.match(source, /contentRef\.current\?\.contains\(target\)/);
	// 宽限期复刻 Radix closeDelay 语义：允许鼠标从行平滑移入卡片复制文字。
	assert.match(source, /clearTimeout/);
	// 外部 pointerdown 恢复默认关闭：preventDefault 会阻止 Radix dismissal，
	// 导致「点击别处也关不掉，卡片一直占屏」。
	assert.doesNotMatch(source, /onPointerDownOutside/);
});
