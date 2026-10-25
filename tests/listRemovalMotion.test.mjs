import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 列表删除动画契约（2026-10 motion 体验优化，第二批位移线扩展）。
 *
 * 背景：智能体市场与收藏列表的重排已有 FLIP 落位（useListReorder），但**删除**
 * （单删确认 / 批量删除）是瞬时消失——卡片原地蒸发，兄弟条目瞬移补位。
 * 侧栏早有同一场景的原语（SidebarRemovalRow：AnimatePresence popLayout + 淡出 +
 * layout="position" 位移收拢，搜索隐藏 ≠ 删除、reduced-motion 归零），
 * 本批把它提炼为共享模块 components/removal/RemovalList 并接入两个列表。
 *
 * 与 useListReorder 的分工（防止双重动画）：重排不 bump 生成数——拖拽落位动画
 * 仍由 useListReorder 的手动 FLIP 独占；RemovalRow 只在真实删除时淡出 + 滑位。
 *
 * 正则一律空白容忍（\s*），格式化不应打红本契约。
 */

const read = (path) => readFileSync(`src/renderer/src/${path}`, "utf8");

test("RemovalList 是共享原语：侧栏薄包装零行为变化", () => {
	const primitive = read("components/removal/RemovalList.tsx");
	assert.match(primitive, /export function RemovalList/, "共享模块必须导出 RemovalList");
	assert.match(primitive, /export const RemovalRow = forwardRef/, "共享模块必须导出 RemovalRow");
	assert.match(primitive, /mode="popLayout"/, "popLayout：退出行一次性移出文档流，不逐帧压高度");
	assert.match(primitive, /layout="position"/, "存活行按位移收拢，不改自身尺寸");
	// 侧栏旧导入路径保留为薄包装：不许在包装里复活实现（会出现两份漂移的实现）
	const wrapper = read("components/sidebar/SidebarRemovalRow.tsx");
	assert.match(wrapper, /export \{ RemovalList as SidebarRemovalList, RemovalRow as SidebarRemovalRow \} from "\.\.\/removal\/RemovalList"/, "侧栏只做 re-export");
	assert.doesNotMatch(wrapper, /motion\/react/, "包装层不得自带实现");
});

test("智能体市场网格：删除淡出 + 网格位移收拢", () => {
	const source = read("components/agents/market/AgentMarketGrid.tsx");
	assert.match(source, /import \{ RemovalList, RemovalRow \} from "\.\.\/\.\.\/removal\/RemovalList"/);
	// remainingIds 必须用未过滤的 orderIds：搜索/分类隐藏 ≠ 删除（exit 时长 0）
	assert.match(source, /<RemovalList\s+remainingIds=\{orderIds\}>/, "remainingIds 必须来自未过滤的完整顺序");
	assert.match(source, /<RemovalRow\s+key=\{agent\.id\}\s+itemId=\{agent\.id\}>/, "卡片必须逐个包在 RemovalRow 里（key 上移到包装层）");
});

test("侧栏活动页：活动行与最近会话行删除淡出 + 位移收拢", () => {
	const active = read("components/sidebar/ActiveSessionsTree.tsx");
	// remainingIds 只圈活动行（agent.id）：会话关闭离开活动区也是一次移除，淡出后落到下方「最近」
	assert.match(active, /<RemovalList\s+remainingIds=\{liveRows\.map\(\(row\) => row\.agent\.id\)\}>/, "活动行 remainingIds 必须来自 liveRows 本身");
	assert.match(active, /<RemovalRow\s+key=\{agent\.id\}\s+itemId=\{agent\.id\}/, "活动行必须逐个包在 RemovalRow 里");
	// 活动行按最近活动排序：顺序随消息实时变化不是用户动作，不得开 orderSensitive
	assert.doesNotMatch(active, /orderSensitive/, "活动行排序非用户动作，开启会让每次流式刷新都整列测量");

	const recent = read("components/sidebar/RecentSessionsSection.tsx");
	assert.match(recent, /<RemovalList\s+remainingIds=\{props\.rows\.map\(\(row\) => row\.session\.id\)\}>/, "最近会话 remainingIds 必须来自 props.rows 本身");
	assert.match(recent, /<RemovalRow\s+key=\{row\.session\.id\}\s+itemId=\{row\.session\.id\}>/, "最近会话行必须逐个包在 RemovalRow 里");
});

test("收藏列表：删除淡出 + 列表位移收拢", () => {
	const source = read("components/favorites/FavoritesWorkspace.tsx");
	assert.match(source, /import \{ RemovalList, RemovalRow \} from "\.\.\/removal\/RemovalList"/);
	// remainingIds 必须用未过滤的 allIds：搜索/筛选隐藏 ≠ 删除
	assert.match(source, /<RemovalList\s+remainingIds=\{allIds\}>/, "remainingIds 必须来自未过滤的完整顺序");
	assert.match(source, /<RemovalRow\s+key=\{entry\.id\}\s+itemId=\{entry\.id\}>/, "卡片必须逐个包在 RemovalRow 里（key 上移到包装层）");
});

test("终端 Tab：关闭播淡出+位移收拢（与会话 Tab 同一原语）", () => {
	const source = read("components/terminal/TerminalDock.tsx");
	assert.match(source, /import \{ RemovalList, RemovalRow \} from "\.\.\/removal\/RemovalList"/);
	assert.match(source, /<RemovalList\s+remainingIds=\{tabs\.map\(\(tab\) => tab\.id\)\}>/, "remainingIds 必须来自当前 tabs 本身（关闭即移除）");
	assert.match(source, /<RemovalRow\s+key=\{tab\.id\}\s+itemId=\{tab\.id\}/, "Tab 必须逐个包在 RemovalRow 里");
});
