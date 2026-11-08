import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripCodeComments } from "./_sourceContract.mjs";

/**
 * issue #510：运行/等待态的常驻动画必须留在合成器上，不能每帧回写内联样式。
 *
 * 背景（issue #510 的实测数据，v0.11.3 基线）：暂停全部动画后 renderer 主线程 CPU
 * 15.73% → 2.95%。根因是三个「看着无害」的写法：
 *
 * 1. `AnimatedBadge` 的入场变体把 `filter: "blur(0px)"` 留在元素上收尾。Steady 的
 *    blur(0px) 不是 no-op——它让元素成为 filtered layer，子级那个无限旋转的图标每帧
 *    都要重做图层（实测同一页面 2.5s 内 PaintArtifactCompositor::Update 374 → 0、
 *    Layerize 978.67ms → 1.78ms）。修法：入场用 `transitionEnd: { filter: "none" }`
 *    把滤镜层摘掉，入场模糊的观感不变。
 * 2. 九点等待动画（`Loader variant="dot-matrix"`，时间线里唯一一个）用 Motion 写
 *    `scale` 关键帧。Motion 只把 opacity/backgroundColor 交给 WAAPI，transform 仍由
 *    自己的 rAF 循环每帧写内联样式——动画一直在，就有一个常驻 JS driver。
 *    修法：`animate-pideck-dot` CSS keyframes（opacity + transform 都在合成器）。
 * 3. 胶囊 `pulse` 层同样的 scale 循环。修法：`animate-pideck-pulse`。
 *
 * 还有一条独立缺陷：`SessionSurfaceStage` 的遮罩 loader 在 `opacity: 0` 之后照样转
 * （透明度不停止动画）。修法：旋转类只在 `overlayVisible` 时挂上。
 *
 * 这些是源码契约而不是渲染快照：断言「不再走 Motion 的写法」与「token 与 keyframes
 * 成对存在」，改动后任何回退都会在这里变红。
 */

const BADGE = "src/renderer/src/components/motion/animated-badge.tsx";
const LOADER = "src/renderer/src/components/motion/loader.tsx";
const STAGE = "src/renderer/src/components/session/SessionSurfaceStage.tsx";
const TAILWIND = "src/renderer/src/styles/tailwind.css";

const read = (path) => stripCodeComments(readFileSync(path, "utf8"));
const count = (source, needle) => source.split(needle).length - 1;

test("AnimatedBadge 入场后摘掉滤镜层（两个 roll 变体都要有 transitionEnd）", () => {
	const source = read(BADGE);
	// 入场仍有模糊：blur(0px) 是终点，不能被顺手删掉
	assert.equal(count(source, 'filter: "blur(0px)"'), 2, "ICON/TEXT 两个变体的入场终点必须仍是 blur(0px)");
	assert.equal(count(source, 'transitionEnd: { filter: "none" }'), 2, "每个入场变体都必须用 transitionEnd 把 blur(0px) 收成 none——否则无限旋转的子元素永远跑在 filtered layer 上");
});

test("AnimatedBadge 的脉冲层不再是 Motion 循环", () => {
	const source = read(BADGE);
	assert.doesNotMatch(source, /repeat: Infinity/, "常驻循环必须交给 CSS keyframes；Motion 会把 scale 每帧写回内联 transform");
	assert.match(source, /animate-pideck-pulse/, "脉冲层走 token");
	assert.match(source, /opacity-10/, "保留基准透明度：全局减弱动效把动画压成 0 长度后，元素退回基准值而不是变成实心圆");
});

test("dot-matrix 九点用 CSS keyframes，不再由 Motion 驱动", () => {
	const source = read(LOADER);
	const start = source.indexOf("function DotMatrix(");
	const end = source.indexOf("\nfunction ", start);
	assert.ok(start > 0 && end > start, "必须能定位 DotMatrix");
	const dotMatrix = source.slice(start, end);
	assert.doesNotMatch(dotMatrix, /motion\./, "DotMatrix 内部不能再出现 motion.* —— opacity 会走 WAAPI 但 transform 不会");
	assert.match(dotMatrix, /animate-pideck-dot/, "九点走 token");
	assert.match(dotMatrix, /animationDelay/, "错峰仍用 animation-delay（原来的对角波不能丢）");
});

test("Tailwind token 与 keyframes 成对存在（少一边就等于没有动画）", () => {
	const css = read(TAILWIND);
	for (const name of ["pideck-dot", "pideck-pulse"]) {
		assert.match(
			css,
			new RegExp("--animate-" + name + ":\\s*" + name + " [^;]+infinite[^;]*;"),
			"--animate-" + name + " 必须指向同名 keyframes 且是 infinite",
		);
		assert.match(css, new RegExp("@keyframes " + name + " \\{"), "@keyframes " + name + " 必须存在");
	}
	// 错峰靠 animation-delay：必须 backwards 填充，否则延迟期显示基准样式（九点先实心亮一下）
	assert.match(css, /--animate-pideck-dot:[^;]+infinite backwards;/, "九点动画必须 backwards 填充，否则错峰变成先亮一下");
	// 缓动与原 Motion 一致（EASE_IN_OUT），且不散落曲线字面量
	assert.match(css, /--animate-pideck-dot:[^;]+cubic-bezier\(0\.77, 0, 0\.175, 1\)[^;]+;/, "九点缓动必须是 EASE_IN_OUT 曲线字面量（theme 变量会被 Tailwind 裁掉，var() 引用会让整条简写失效）");
	assert.match(css, /--animate-pideck-pulse:[^;]+cubic-bezier\(0\.77, 0, 0\.175, 1\)[^;]+;/, "脉冲缓动同上");
	assert.doesNotMatch(css, /--animate-pideck-(?:dot|pulse):[^;]*var\(--ease/, "animation token 不能引用 theme 缓动变量（未输出时会静默无动画）");
	const ease = read("src/renderer/src/lib/ease.ts");
	assert.match(ease, /EASE_IN_OUT = \[0\.77, 0, 0\.175, 1\]/, "lib/ease.ts 的 EASE_IN_OUT 改动时必须同步 --ease-in-out 与两个 keyframes token");
	// 九点的对角波观感：最小/最大缩放与透明度档位
	const dotKeyframes = css.slice(css.indexOf("@keyframes pideck-dot"));
	assert.match(dotKeyframes.slice(0, 260), /opacity: 0\.2;[\s\S]*?transform: scale\(0\.7\);/, "九点低谷仍是 0.2 / 0.7");
	assert.match(dotKeyframes.slice(0, 400), /opacity: 1;[\s\S]*?transform: scale\(1\);/, "九点高峰仍是 1 / 1");
});

test("遮罩隐藏后 loader 不再旋转", () => {
	const source = read(STAGE);
	assert.doesNotMatch(source, /className="loader animate-pideck-spin"/, "opacity: 0 不会停掉动画——隐藏态必须不挂旋转类");
	assert.match(source, /loader\$\{overlayVisible \? " animate-pideck-spin" : ""\}/, "旋转类必须跟随 overlayVisible");
});
