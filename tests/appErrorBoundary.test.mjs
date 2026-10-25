import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("AppErrorBoundary renders a system-consistent error card", () => {
	const boundary = readFileSync("src/renderer/src/components/app/AppErrorBoundary.tsx", "utf8");
	const css = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

	// 组件结构：品牌 Logo + 状态胶囊 + 折叠堆栈 + 主次按钮
	assert.match(boundary, /LogoMark/);
	assert.match(boundary, /app-error-boundary-brand/);
	assert.match(boundary, /app-error-boundary-badge/);
	assert.match(boundary, /app-error-boundary-dot/);
	assert.match(boundary, /<StackTrace/);
	assert.match(boundary, /app-error-boundary-stack/);
	assert.match(boundary, /renderErrorStack/);
	assert.match(boundary, /handleReset/);
	assert.match(boundary, /handleReload/);
	// 全局边界会整页替换 AppHeader：卡片必须提供真正退出，且不要再叠一套 min/max/pin 挂件。
	// 不能走 closeWindow——closeToTray 会把关窗吞成隐藏，崩溃页再藏起来就退不掉。
	assert.match(boundary, /handleQuit/);
	assert.match(boundary, /app\.quit\(\)/);
	assert.match(boundary, /t\("app\.quit"\)/);
	assert.doesNotMatch(boundary, /app\.closeWindow\(/);
	assert.doesNotMatch(boundary, /handleClose/);
	assert.doesNotMatch(boundary, /t\("app\.windowClose"\)/);
	assert.doesNotMatch(boundary, /AppHeader/);
	assert.doesNotMatch(boundary, /ErrorBoundaryWindowChrome/);
	assert.doesNotMatch(boundary, /minimizeWindow/);
	assert.doesNotMatch(boundary, /toggleMaximizeWindow/);
	assert.doesNotMatch(css, /app-error-boundary-chrome/);
	assert.doesNotMatch(css, /\.app-error-boundary \.window-controls/);
	assert.match(css, /\.app-error-boundary-actions \{[\s\S]*?flex-wrap/);

	// 与系统一致的卡片语言：token 颜色 + shadcn 圆角/阴影；状态胶囊用 danger 语义色
	assert.match(css, /\.app-error-boundary-card \{/);
	assert.match(css, /background: var\(--color-bg-panel/);
	assert.match(css, /border: 1px solid var\(--color-border-default/);
	assert.match(css, /var\(--shadow-modal/);
	assert.match(css, /var\(--radius-lg/);
	assert.match(css, /\.app-error-boundary-badge \{/);
	assert.match(css, /var\(--color-danger-soft/);
	assert.match(css, /\.app-error-boundary-dot \{/);
	assert.match(css, /error-boundary-pulse/);

	// 去掉花哨元素：无 glitch/扫描线/大图标块；动效克制（入场 0.25s + 状态点呼吸）
	assert.doesNotMatch(css, /error-boundary-glitch/);
	assert.doesNotMatch(css, /error-boundary-scan/);
	assert.doesNotMatch(css, /app-error-boundary-icon/);
	assert.match(css, /error-boundary-rise 0\.25s ease-out both/);
	// 可访问性：reduced-motion 关闭动画
	assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("AppErrorBoundary auto-reloads after crash with a 3-attempt cap", () => {
	const boundary = readFileSync("src/renderer/src/components/app/AppErrorBoundary.tsx", "utf8");

	// 崩溃后自动刷新：componentDidCatch 里调度，倒计时后 reload；timer 生命周期
	// 由独立的 AutoReloadTimer 管理（start/stop/ensure），StrictMode remount 后
	// componentDidMount 用 ensure 兜底重建（回归：倒计时停在 5 不递减）
	assert.match(boundary, /componentDidCatch/);
	assert.match(boundary, /scheduleAutoReload\(\)/);
	assert.match(boundary, /window\.location\.reload\(\)/);
	assert.match(boundary, /AutoReloadTimer/);
	assert.match(boundary, /autoReloadTimer\.start\(AUTO_RELOAD_SECONDS\)/);
	assert.match(boundary, /autoReloadTimer\.ensure\(/);
	assert.match(boundary, /autoReloadTimer\.stop\(\)/);
	// timer 实现本身（interval 创建/清理/倒计时）在可单测的独立模块里
	const timerSrc = readFileSync("src/renderer/src/utils/crashAutoReloadTimer.ts", "utf8");
	assert.match(timerSrc, /globalThis\.setInterval/);
	assert.match(timerSrc, /clearInterval/);
	assert.match(timerSrc, /ensure\(seconds: number \| null\)/);
	// 计数持久化到 sessionStorage（刷新后仍保留），并按时间窗口累计
	assert.match(boundary, /CRASH_AUTO_RELOAD_KEY/);
	assert.match(boundary, /sessionStorage\.getItem/);
	assert.match(boundary, /sessionStorage\.setItem/);
	assert.match(boundary, /computeCrashReloadPlan/);
	// 达到上限停止自动刷新（不再 reload），提示手动操作
	assert.match(boundary, /autoReloadExhausted/);
	assert.match(boundary, /shouldAutoReload/);
	// 局部边界（有 onReset）不自动整页刷新
	assert.match(boundary, /if \(this\.props\.onReset\) return/);

	// 倒计时 UI：提示文案 + 取消按钮；卸载时清理定时器（生命周期配对）
	assert.match(boundary, /componentWillUnmount/);
	assert.match(boundary, /app\.renderErrorAutoReload"/);
	assert.match(boundary, /app\.renderErrorAutoReloadCancel"/);
	assert.match(boundary, /app\.renderErrorAutoReloadExhausted"/);
	assert.match(boundary, /handleCancelAutoReload/);
	assert.match(boundary, /app-error-boundary-autoreload/);
	// 重试重置时同步停止自动刷新，避免旧定时器误刷
	assert.match(boundary, /handleReset/);
	assert.match(boundary, /autoReloadTimer\.stop\(\)/);

	// 崩溃计数/窗口常量来自独立纯函数模块（可单测）
	const policy = readFileSync("src/renderer/src/utils/autoReloadPolicy.ts", "utf8");
	assert.match(policy, /export function computeCrashReloadPlan/);
	assert.match(policy, /MAX_AUTO_RELOAD_ATTEMPTS = 3/);
	assert.match(policy, /CRASH_AUTO_RELOAD_WINDOW_MS = 60_000/);
});
