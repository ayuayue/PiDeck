import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("DropdownMenuItem and ContextMenuItem support descendant SVG coloring for destructive variant", () => {
	const dropdownMenuSrc = readFileSync("src/renderer/src/components/ui-shadcn/dropdown-menu.tsx", "utf8");
	const contextMenuSrc = readFileSync("src/renderer/src/components/ui-shadcn/context-menu.tsx", "utf8");

	// DropdownMenuItem 必须针对所有后代 svg 设置 !text-destructive，避免包裹在 span 内的图标被 muted-foreground 覆盖
	assert.match(dropdownMenuSrc, /data-\[variant=destructive\]:\[&_svg\]:!text-destructive/, "DropdownMenuItem should color all descendant SVGs as destructive");

	// ContextMenuItem 也必须具有后代 svg 的 !text-destructive 样式
	assert.match(contextMenuSrc, /data-\[variant=destructive\]:\[&_svg\]:!text-destructive/, "ContextMenuItem should color all descendant SVGs as destructive");
});

test("SessionTabsBar dangerous actions are configured with variant=destructive", () => {
	const tabsSrc = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	// ⋯ 菜单本体已拆到 SessionActionsMenu（Tab 栏只留右键菜单），破坏性项在那里断言。
	const actionsSrc = readFileSync("src/renderer/src/components/session/SessionActionsMenu.tsx", "utf8");

	// 破坏性语义归属「关闭 Agent」（杀进程 + 解绑）：必须标记 destructive。
	// 2026-09 语义拆分后「停止回答」= abort（只中断当前回合、进程保留）不再是破坏性操作，
	// 因此 destructive 从旧的 onAction("stop") 项移到了 onCloseAgent 项。
	assert.match(actionsSrc, /<DropdownMenuItem\s+variant="destructive"\s+title=\{t\("menu\.closeAgentHint"\)\}\s+onSelect=\{control\.onCloseAgent\}/, "Close Agent action in more dropdown menu should have variant='destructive'");

	// 反向断言：abort 项不得再被标记 destructive，防止「中断回合」与「杀进程」两种语义再次被合并。
	const abortPos = tabsSrc.indexOf('control.onAction("abort")');
	assert.ok(abortPos > 0, "abort action should be wired through control.onAction");
	const abortItemStart = tabsSrc.lastIndexOf("<DropdownMenuItem", abortPos);
	assert.doesNotMatch(tabsSrc.slice(abortItemStart, abortPos), /variant="destructive"/, "Stop Answer (abort) is not destructive and must not be marked as such");

	// Tab 右键 ContextMenu 中的“关闭其他标签页”和“关闭全部标签页”操作应标记为 destructive
	assert.match(tabsSrc, /<ContextMenuItem\s+variant="destructive"\s+onSelect=\{\(\)\s*=>\s*props\.onCloseOthers\(sessionId\)\}/, "Close others action in context menu should have variant='destructive'");
	assert.match(tabsSrc, /<ContextMenuItem\s+variant="destructive"\s+onSelect=\{props\.onCloseAll\}/, "Close all action in context menu should have variant='destructive'");
});
