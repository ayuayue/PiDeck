import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 环境检测/初始化引导弹框（EnvironmentCheckDialog）限高回归守卫。
 *
 * 2026-10 用户反馈：未安装 pi 时弹框内容堆叠 8 层（提示卡×3 + 路径输入 +
 * 三步安装引导 + stdout/stderr + 16 个搜索目录），远超屏幕高度，头部与
 * 底部「重新检测」按钮不可见、无法滚动。
 *
 * 根因是两条同时缺位：
 * 1. DialogContent 只有宽度约束（sm:max-w-…），fixed 居中定位下没有高度上限；
 * 2. .environment-body 虽有 overflow-y:auto + flex:1，但 flex 子项默认
 *    min-height:auto 阻止收缩——父级给了高度也不会滚，必须显式 min-height:0。
 *
 * 两条任一回退（删 max-h / 删 min-height:0）弹框就会重新溢出屏幕。
 * 正则按仓库惯例空白容忍（\s* 代替字面空格），避免格式化破坏断言。
 */

const overlaySource = readFileSync(join(repoRoot, "src/renderer/src/components/overlays/OverlayComponents.tsx"), "utf8");
const cssSource = readFileSync(join(repoRoot, "src/renderer/src/styles/foundation.css"), "utf8");

/** 找到 environment 弹框 DialogContent 的 className 行（cn( 参数顺序无关）。 */
function findEnvironmentDialogClassLine(source) {
	const lines = source.split(/\r?\n/);
	return lines.find((line) => line.includes("environment-dialog") && line.includes("<DialogContent")) ?? null;
}

test("环境检测弹框 DialogContent 必须带视口高度上限", () => {
	const line = findEnvironmentDialogClassLine(overlaySource);
	assert.ok(line, "EnvironmentCheckDialog 的 DialogContent 不见了？检查 <DialogContent … environment-dialog 写法");
	assert.match(line, /max-h-\[calc\(100vh-48px\)\]/, "DialogContent 缺 max-h-[calc(100vh-48px)]：内容超过一屏时弹框会溢出屏幕且无法滚动");
	assert.match(line, /overflow-hidden/, "DialogContent 需保持 overflow-hidden（内容滚动收在 body 层）");
});

test("environment-body 必须显式 min-height:0，否则限高弹框内不会滚动", () => {
	const block = cssSource.match(/\.environment-body\s*\{[^}]*\}/);
	assert.ok(block, "foundation.css 里找不到 .environment-body 规则块");
	assert.match(block[0], /min-height:\s*0/, ".environment-body 缺 min-height:0：flex 子项默认 min-height:auto 阻止收缩，overflow-y:auto 不会生效");
	assert.match(block[0], /overflow-y:\s*auto/, ".environment-body 缺 overflow-y:auto");
});
