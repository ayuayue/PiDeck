import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ===== beui AnimatedBadge 组件拷贝 =====

test("animated-badge component copied with official markers", () => {
	const source = readFileSync(
		"src/renderer/src/components/motion/animated-badge.tsx",
		"utf8",
	);
	assert.match(source, /beui\.dev[\s\S]*animated-badge/);
	assert.match(source, /export type AnimatedBadgeStatus =[\s\S]*?\| "loading";/);
	assert.match(source, /export type AnimatedBadgeSize = "sm" \| "md"/);
	// 依赖：motion/react + 项目既有 @/lib/ease + @/lib/utils
	assert.match(source, /from "motion\/react"/);
	assert.match(source, /from "@\/lib\/ease"/);
	assert.match(source, /from "@\/lib\/utils"/);
	// 关键行为：loading 旋转、状态图标滚动、脉冲层
	// loading 旋转收敛到共享 spinner token（animate-pideck-spin，reduced-motion 下继续转），
	// 替代官方 rotate:360 写法——与 spinnerUtility.test.mjs 的 title-tab badge 断言一致（PR #171 统一 spinner）
	assert.match(source, /status === "loading" && !icon[\s\S]*?className="inline-flex animate-pideck-spin"/);
	assert.match(source, /ICON_ROLL_VARIANTS/);
	assert.match(source, /pulse = status === "loading"/);
	// 与官方 API 对齐：showIcon / contentKey / size + PiDeck bare 扩展
	assert.match(source, /showIcon = true/);
	assert.match(source, /contentKey/);
	assert.match(source, /bare\?: boolean;/);
	assert.match(source, /bare && "h-auto gap-0 rounded-none border-0 bg-transparent p-0"/);
});

test("motion dependency and ease helpers available", () => {
	const pkg = readFileSync("package.json", "utf8");
	assert.match(pkg, /"motion": "\^13\.0\.0"/);
	const ease = readFileSync("src/renderer/src/lib/ease.ts", "utf8");
	assert.match(ease, /export const EASE_OUT/);
});

// ===== 会话 Tab 栏接入 =====

test("session tab uses AnimatedBadge instead of raw pulse dot", () => {
	const source = readFileSync(
		"src/renderer/src/components/session/SessionTabsBar.tsx",
		"utf8",
	);
	const statusSource = readFileSync(
		"src/renderer/src/utils/sessionStatusBadge.ts",
		"utf8",
	);
	assert.match(source, /import \{ AnimatedBadge \} from "\.\.\/motion\/animated-badge";/);
	assert.match(source, /import \{ sessionStatusBadge \} from "\.\.\/\.\.\/utils\/sessionStatusBadge";/);
	// 旧的裸圆点渲染已移除
	assert.doesNotMatch(source, /size-1\.5 shrink-0 rounded-full/);
	// AnimatedBadge 自身关闭脉冲；停止操作图标仍可使用独立的 animate-pulse 提示进行中。
	assert.match(source, /pulse=\{false\}/);
	// 新渲染：bare 裸图标模式（无胶囊）+ [&_svg] 缩图标 + 运行中黄色覆盖
	assert.match(source, /<AnimatedBadge/);
	assert.match(source, /size="sm"/);
	assert.match(source, /bare/);
	assert.match(source, /pulse=\{false\}/);
	assert.match(source, /\[&_svg\]:h-2\.5 \[&_svg\]:w-2\.5/);
	assert.match(statusSource, /text-amber-500 dark:text-amber-400/);
	// 状态映射（颜色语义：启动蓝旋转 / 运行黄旋转 / 未启动白 / 失败红）
	assert.match(statusSource, /export function sessionStatusBadge\(/);
	assert.match(statusSource, /case "error":\s*\n\s*return \{ status: "danger" \};/);
	assert.match(statusSource, /case "idle":\s*\n\s*return \{ status: "neutral" \};/);
	assert.match(statusSource, /case "starting":\s*\n\s*return \{ status: "loading" \};/);
	assert.match(statusSource, /case "running":\s*\n\s*case "pending":\s*\n\s*case "waiting":\s*\n\s*return \{\s*\n\s*status: "loading",/);
	assert.match(statusSource, /if \(!status \|\| status === "detached"\) return undefined;/);
	assert.match(source, /const badge = sessionStatusBadge\(status, \{/);
	// 激活指示条（tab 下方弧形横条）已移除
	assert.doesNotMatch(source, /session-tabs-indicator/);
	assert.doesNotMatch(source, /measureIndicator/);
	assert.doesNotMatch(source, /INDICATOR_BASE_WIDTH/);
});

test("sidebar SessionTree still uses its own status dot (unchanged)", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
	assert.match(source, /sessionStatusDotClass/);
});

test("tab dropdown menu: no switch-to item, state-based disable with visible gray", () => {
	const source = readFileSync(
		"src/renderer/src/components/session/SessionTabsBar.tsx",
		"utf8",
	);
	// “切换到此会话”已移除（点击 Tab 本体即切换，菜单项冗余）
	assert.doesNotMatch(source, /tabs\.switchTo/);
	assert.doesNotMatch(source, /MousePointerClick/);
	// 运行控制已上收右上角 ⋯ 更多操作菜单（当前会话分组）：
	// 全状态可用——菜单项不再按 live/终态分两套渲染，能力统一走策略函数，
	// 置灰用内联 style（特异性最高，置灰可见）。
	assert.match(source, /function RunControlItems\(/);
	assert.match(source, /canRunSessionAction\(capabilities, "start"\)/);
	assert.match(source, /canRunSessionAction\(capabilities, "stop"\)/);
	assert.match(source, /canRunSessionAction\(capabilities, "reload"\)/);
	assert.match(source, /\? \{ opacity: 0\.4 \} : undefined/);
	// 主控项按状态切换文案：未启动/失败/已关闭 → 启动 Agent；live → 重启
	assert.match(source, /capabilities\.primaryAction === "start"/);
	assert.match(source, /t\("tabs\.startAgent"\)/);
	// ⋯ 菜单按功能分组：当前会话 / 工具（分组只做标签显示）
	assert.match(source, /DropdownMenuLabel>\{t\("tabs\.currentSessionGroup"\)\}/);
	assert.match(source, /DropdownMenuLabel>\{t\("tabs\.toolsGroup"\)\}/);
	// Tab 级菜单为右键 ContextMenu（固定/关闭等），下拉触发按钮已移除
	assert.match(source, /ContextMenuTrigger asChild/);
	assert.doesNotMatch(source, /role="tab-menu"/);
	// App 侧不再用 isLiveRuntimeStatus 挡状态：能力和动作都收敛到 runControl 对象
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /runControl: currentSessionId\n\s*\? \{/);
	assert.match(app, /getSessionRunCapabilities\(currentSessionId\)/);
	assert.match(app, /onAction: \(action: SessionRunAction\) => void runSessionControl\(currentSessionId, action\)/);
	// i18n key 同步删除
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.doesNotMatch(zh, /tabs\.switchTo/);
	assert.doesNotMatch(en, /tabs\.switchTo/);
});
