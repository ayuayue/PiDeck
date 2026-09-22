import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 恢复 dsh-web 形态的独立横栏卡（SessionTodoStrip / SessionFilesStrip /
 * SessionSubagentsStrip 取代 SessionWidgetsCard 分段条与悬浮弹层）后的契约断言：
 * i18n 文案、composer 挂载链、progressLabel / dismiss 纯函数、旧组件删除。
 */
const composerSource = () => readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const viewSource = () => readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const startSource = () => readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const stripSource = () => readFileSync("src/renderer/src/components/session/SessionTodoStrip.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("composer forwards widgets slot; session surfaces mount the three strips then goal", () => {
	const composer = composerSource();
	const view = viewSource();
	const start = startSource();
	// ComposerArea：widgets prop 透传到 ComposerMeasuredExtras
	assert.match(composer, /widgets\?: ReactNode/);
	assert.match(composer, /widgets=\{props\.widgets \?\? null\}/);
	// SessionView：todo → files → subagents → goal，独立横栏卡顺序挂载
	assert.match(view, /<SessionTodoStrip sessionId=\{sessionId\} \/>/);
	assert.match(view, /<SessionFilesStrip[\s\S]*?run=\{latestAgentRun\}[\s\S]*?onDiffFile=\{onDiffFile\}/);
	assert.match(view, /<SessionSubagentsStrip[\s\S]*?onOpenChildSession=\{onOpenBranchSession\}/);
	assert.match(view, /<SessionGoalStrip sessionId=\{sessionId\} \/>/);
	assert.ok(view.indexOf("<SessionTodoStrip") < view.indexOf("<SessionFilesStrip") && view.indexOf("<SessionFilesStrip") < view.indexOf("<SessionSubagentsStrip") && view.indexOf("<SessionSubagentsStrip") < view.indexOf("<SessionGoalStrip"), "strip order must be todo → files → subagents → goal in SessionView widgets");
	// SessionStartSurface：引导页同样挂三个横栏 + goal
	assert.match(start, /<SessionTodoStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(start, /<SessionFilesStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(start, /<SessionSubagentsStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(start, /<SessionGoalStrip sessionId=\{props\.sessionId\} \/>/);
});

test("todo strip copy is present in both locale dictionaries", () => {
	for (const locale of [zh(), en()]) {
		assert.match(locale, /"sessionTodo\.done": "\{done\}/);
		assert.match(locale, /"sessionTodo\.active": "\{active\}/);
		assert.match(locale, /"sessionTodo\.pending": "\{pending\}/);
		assert.match(locale, /"sessionTodo\.empty"/);
		// dismiss 随横栏形态回归：手动关闭 + 内容指纹变化后重新出现
		assert.match(locale, /"sessionTodo\.dismiss"/);
	}
});

test("progress label keeps zero-segment omission and en-space middot join in the strip", () => {
	const strip = stripSource();
	// progressLabel：零计数段过滤 + en-space(U+2002) · en-space 连接（与旧 todo 条同口径）
	assert.match(strip, /export function progressLabel/);
	assert.match(strip, /done > 0 \? t\("sessionTodo\.done"/);
	assert.match(strip, /active > 0 \? t\("sessionTodo\.active"/);
	assert.match(strip, /pending > 0 \? t\("sessionTodo\.pending"/);
	assert.match(strip, /join\("\\u2002·\\u2002"\)/);
});

test("dismiss helpers keep widget-lines fingerprints", () => {
	const strip = stripSource();
	// 手动关闭按「内容指纹」记录：指纹相同保持隐藏，工具更新列表后重新出现
	assert.match(strip, /export function widgetLinesSignature/);
	assert.match(strip, /export function isWidgetDismissed/);
	assert.match(strip, /export function dismissWidgetEntries/);
});

test("segmented bar and floating popover are removed; strip cards replaced them", () => {
	const view = viewSource();
	assert.throws(() => readFileSync("src/renderer/src/components/session/SessionWidgetsCard.tsx"));
	assert.throws(() => readFileSync("src/renderer/src/components/session/SessionWidgetsPopover.tsx"));
	assert.doesNotMatch(view, /SessionWidgetsCard|SessionWidgetsPopover/);
	// 弹层专用 atoms 一并移除：行级折叠统一走 composer 通道
	const composerAtoms = readFileSync("src/renderer/src/atoms/composer-atoms.ts", "utf8");
	assert.doesNotMatch(composerAtoms, /widgetsPopoverSegmentFamily|widgetsDisclosureCollapsedFamily/);
	// 悬浮弹层不在 timeline 面板内渲染：SessionSurfaceStage 只承载时间线
	const stage = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	assert.doesNotMatch(stage, /SessionWidgetsPopover/);
});

test("glyph circles widen canvas to 16x16 with 6.4 radius and overflow-visible to prevent clipping without shrinking", () => {
	const strip = stripSource();
	const subagents = readFileSync("src/renderer/src/components/session/SessionSubagentsStrip.tsx", "utf8");

	// 画板放宽至 16x16（viewBox -1 -1 16 16），r 保持 6.4（外径 14px 不变小）；
	// 左右各留 1px 安全边距，并带 overflow-visible 避免 Windows 125%/150% 等 DPI 缩放下右侧被裁切。
	for (const source of [strip, subagents]) {
		assert.match(source, /<svg[^>]*width=\{16\}[^>]*height=\{16\}[^>]*viewBox="-1 -1 16 16"[^>]*className="[^"]*overflow-visible[^"]*text-\[var\(--color-success\)\]"[^>]*>/, "CompletedGlyph must have 16x16 canvas, overflow-visible and success color class");
		assert.match(source, /<circle cx="7" cy="7" r="6\.4" stroke="currentColor" strokeWidth="1\.2" \/>/, "CompletedGlyph circle radius must stay at 6.4 to keep full 14px diameter");
	}

	// SessionTodoStrip 的进行中与待办环也必须保持 16x16 画板、原生 6.4 半径与 overflow-visible
	assert.match(strip, /<svg[^>]*width=\{16\}[^>]*height=\{16\}[^>]*viewBox="-1 -1 16 16"[^>]*className="[^"]*overflow-visible[^"]*animate-pideck-spin/);
	assert.match(strip, /<circle cx="7" cy="7" r="6\.4" stroke=\{`url\(#\$\{gradientId\}\)`\} strokeWidth="1\.2"/);
	assert.match(strip, /<svg[^>]*width=\{16\}[^>]*height=\{16\}[^>]*viewBox="-1 -1 16 16"[^>]*className="[^"]*overflow-visible[^"]*text-text-tertiary"/);
	assert.match(strip, /<circle cx="7" cy="7" r="6\.4" stroke="currentColor" strokeWidth="1\.2" strokeDasharray="2\.4 2\.4"/);
});

/**
 * 待办条滚动条闪烁回归（2027-01）：旋转图标的「变换后包围盒（AABB）」不得撑高列表 scrollHeight。
 *
 * Chromium 算滚动溢出时取后代变换后的 AABB：旋转 16×16 svg 方盒时 AABB 涨到
 * 16×√2 ≈ 22.6px > 20px 行高 → ul（overflow-y:auto）scrollHeight 104↔105 反复越界 →
 * 原生滚动条以旋转频率出现/消失。修法：行内 overflow-hidden 把 AABB 关在行内；
 * 旋转必须留在 svg 根（下放到 circle 会围绕默认 transform-origin:0 0 甩出盒子，
 * 被行裁剪成一道小弧）。真实布局断言见 e2e/todo-strip-scrollbar.spec.ts。
 */
test("in-progress glyph keeps its spin on the svg box and the row clips the rotated AABB", () => {
	const strip = stripSource();
	const progressGlyph = strip.slice(strip.indexOf("function ProgressGlyph"), strip.indexOf("function PendingGlyph"));
	assert.ok(progressGlyph.length > 0, "ProgressGlyph block must be locatable");
	// 旋转留在 svg 根：只有带 CSS 盒子的 svg 根，transform-origin 才是盒中心
	assert.match(progressGlyph, /<svg[^>]*className="[^"]*overflow-visible animate-pideck-spin[^"]*\[animation-duration:1s\][^"]*"/, "spin animation must stay on the <svg> box");
	// 不能下放到 circle：SVG 子元素默认 transform-origin:0 0，会围绕 viewBox 左上角甩出去
	assert.doesNotMatch(progressGlyph, /<circle[^>]*className="[^"]*animate-pideck-spin/, "spinning a <circle> swings it out of the viewBox (transform-origin defaults to 0 0)");
	// 行级裁剪：把旋转 AABB（≈22.6px）关在 20px 行内，否则外层 ul 的 scrollHeight 会反复越界
	assert.match(strip, /<li[^>]*className="flex min-w-0 items-center gap-2\.5 overflow-hidden[^"]*"/);
});
