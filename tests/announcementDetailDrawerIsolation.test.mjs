/**
 * 公告详情抽屉与列表弹窗的关闭隔离回归测试。
 *
 * 曾现 bug：点详情抽屉的 X（或背板）时，公告父弹窗（列表 Dialog）被连带关掉。
 * 根因：抽屉 portal 到 body，与列表 Dialog 的 Radix portal 是兄弟节点，因此抽屉内
 * 任何指针交互在 Radix 眼里都是「Dialog 外部交互」。Radix modal 把
 * POINTER_DOWN_OUTSIDE 延迟到 click 才派发（deferPointerDownOutside），点 X 时
 * React onClick 已先把抽屉 state 置为关闭 → 提交 effect → 旧的 detailOpenRef
 * 守卫在延迟 click 到达时读到 false，弹窗照常关闭。
 *
 * 契约：用 DOM 标记（data-announcement-detail-drawer）识别抽屉交互，而不是用
 * 「抽屉是否打开」的 React state/ref —— state 在延迟 dismiss 到达前就已过期。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const center = readFileSync(
	"src/renderer/src/components/sidebar/AnnouncementCenter.tsx",
	"utf8",
);
const drawer = readFileSync(
	"src/renderer/src/components/motion/drawer.tsx",
	"utf8",
);

test("抽屉交互用 DOM 标记识别，而非基于打开状态的 ref", () => {
	// 标记常量 + 基于 closest() 的判定函数必须存在
	assert.match(center, /const DETAIL_DRAWER_ATTR = "data-announcement-detail-drawer"/);
	assert.match(
		center,
		/function isOutsideInteractionFromDetailDrawer\([\s\S]*?closest\(`\[\$\{DETAIL_DRAWER_ATTR\}\]`\)/,
	);
	// 标记必须传给 Drawer 的两个固定兄弟层（背板 + 面板），否则 closest() 命中不到
	assert.match(center, /rootAttributes=\{\{ \[DETAIL_DRAWER_ATTR\]: "" \}\}/);
	assert.match(drawer, /\{\.\.\.rootAttributes\}/);
	// 两个层都要挂（背板 button + 面板 aside）
	assert.equal((drawer.match(/\{\.\.\.rootAttributes\}/g) || []).length, 2);
});

test("Dialog 的两条 outside 路径都拦截抽屉交互", () => {
	// Radix 的指针路径：延迟到 click 派发，必须在源头 preventDefault 取消这次 dismiss
	assert.match(
		center,
		/onPointerDownOutside=\{\(event\) => \{[\s\S]*?isOutsideInteractionFromDetailDrawer\(event\)[\s\S]*?event\.preventDefault\(\)/,
	);
	// 非指针路径（焦点移出等）走同一判定
	assert.match(center, /onInteractOutside=\{\(event\) => \{[\s\S]*?isOutsideInteractionFromDetailDrawer\(event\)/);
	// Escape 由抽屉自己的 window keydown 监听处理，弹窗侧不得再叠一层主动关闭逻辑
	assert.doesNotMatch(center, /detailOpenRef/);
});

test("抽屉关闭只复位自身状态，不改写弹窗开关", () => {
	// closeDetail 只 setDetailItem(null)，不触碰 announcementCenterOpenAtom
	assert.match(center, /const closeDetail = useCallback\(\(\) => setDetailItem\(null\), \[\]\)/);
	// Dialog 的 onOpenChange 只认 setOpen(next)，不得因抽屉状态提前 return 掉请求
	assert.match(center, /onOpenChange=\{\(next\) => \{\s*setOpen\(next\);/);
});
