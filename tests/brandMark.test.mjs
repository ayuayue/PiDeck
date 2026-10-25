import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mark = readFileSync("src/renderer/src/components/app/LogoMark.tsx", "utf8");
const lockup = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const canvas = readFileSync("src/renderer/src/components/app/PiLogoCanvas.tsx", "utf8");
const about = readFileSync("src/renderer/src/components/app/AboutPopover.tsx", "utf8");
const shimmer = readFileSync("src/renderer/src/components/motion/text-shimmer.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const boot = readFileSync("src/renderer/index.html", "utf8");
const webBrand = readFileSync("src/renderer/src/web/WebBrandLockup.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");

const PI_GLYPH = /M165\.29 165\.29H517\.36V400/;

test("in-app brand surfaces use the Pi glyph, not the spider mark", () => {
	assert.match(mark, /export function LogoMark/);
	assert.match(mark, PI_GLYPH);
	assert.doesNotMatch(mark, /brandMarkSrc/);
	assert.match(lockup, /<PiLogoCanvas size=\{18\}/);
	// 侧栏 π logo：只点击播官方积木拼装，不挂载自播、不跟会话启动。
	assert.match(lockup, /<PiLogoCanvas size=\{18\} playOnClick \/>/);
	assert.doesNotMatch(lockup, /autoPlay/);
	assert.doesNotMatch(lockup, /replayToken/);
	assert.doesNotMatch(app, /brandLogoReplayToken/);
	assert.doesNotMatch(app, /triggerBrandLogoReplay/);
	// 引擎默认不自播：只有显式 autoPlay 才挂载播放；点击必须 stopPropagation，避免侧栏打开关于弹窗。
	assert.match(canvas, /if \(props\.autoPlay\)/);
	assert.doesNotMatch(canvas, /autoPlay !== false/);
	assert.doesNotMatch(canvas, /replayToken/);
	assert.match(canvas, /event\?\.stopPropagation\(\)/);
	assert.match(about, /<PiLogoCanvas size=\{40\} playOnClick \/>/);
	assert.doesNotMatch(about, /autoPlay/);
	// beUI 两行字标（5fcca0b8）：wordmark 由 TextShimmer 承载，不再用 aria-hidden span；
	// 文本改为「应用显示名称」（设置项 appDisplayName，缺省 PiDeck），不再写死字面量。
	assert.match(lockup, /const displayName = useAppDisplayName\(\)/);
	assert.match(lockup, />\s*\{displayName\}\s*<\/TextShimmer>/);
	assert.match(about, /\{displayName\}\s*<\/div>/);
	// 侧栏字标扫光必须几分钟一轮；回退到 60s 会让常驻品牌位太勤。
	assert.match(lockup, /REST_MS = 5 \* 60_000/);
	assert.doesNotMatch(lockup, /REST_MS = 60_000/);
	// 启动不扫、后台/减少动效停扫：否则休息间隔再长也会在 hidden 窗口白烧 GPU。
	assert.match(lockup, /const \[shimmerOn, setShimmerOn\] = useState\(false\)/);
	assert.match(lockup, /arm\(REST_MS, true\)/);
	assert.match(lockup, /visibilitychange/);
	assert.match(lockup, /prefers-reduced-motion: reduce/);
	// 休息态必须卸掉 clip 渐变；只关 animation 仍会留合成层。
	assert.match(shimmer, /enabled \? TEXT_SHIMMER_CLASS_NAME : "text-foreground"/);
	assert.match(shimmer, /enabled \? <style>\{TEXT_SHIMMER_KEYFRAMES\}<\/style> : null/);
	assert.match(shimmer, /enabled \? textShimmerStyle\(duration\) : undefined/);
	assert.match(app, PI_GLYPH);
	assert.match(boot, /id="boot-logo-silver"/);
	assert.match(boot, PI_GLYPH);
	// Web 品牌位与桌面同构：按 logoStyle 分支（Web 无人写入 → 恒取默认 pi-tui 三色像素标）。
	assert.match(webBrand, /logoStyle === "pi-tui"\s*\?\s*<PiTuiLogoCanvas size=\{18\} playOnClick \/>\s*:\s*<PiLogoCanvas size=\{18\} playOnClick \/>/);
	assert.doesNotMatch(webBrand, /autoPlay/);
	assert.match(webBrand, />\s*PiDeck\s*</);
	assert.match(webTimeline, /<LogoMark size=\{66\} \/>/);
	for (const source of [mark, lockup, app, boot, webBrand, webTimeline]) {
		assert.doesNotMatch(source, /M7\.5 15\.5C3\.5 14/);
		assert.doesNotMatch(source, /<ellipse cx="60" cy="50"/);
	}
});
