import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const engineSource = readFileSync(
  "src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts",
  "utf8",
);

// 用户反馈 bug：流式回复过程中「滚动到底部」按钮频繁闪现。
// 根因：引擎的上滚逃逸（handleScroll isScrollingUp）与 wheel 逃逸（handleWheel
// deltaY<0）都是无条件解锁锁底——流式回复中滚轮/触控板轻微上滚（含贴底时
// 滚不动但仍产生事件、或上滚不足 25px 仍算在实时尾部附近）会误逃逸，
// 后续内容增长不再贴底，底部按钮随即出现。
// 修复（对照 dsh-web ChatView 的 movedByReader + 距底 <=25px 判定）：
// 两处逃逸都加「距底 > 25px」守卫，距底容差带内（<=25px）的滚动仍视为在底部。
test("escape tolerance band keeps near-bottom scrolls attached", () => {
  // 容差带常量：dsh-web 同值 25px，小于 STICK_TO_BOTTOM_OFFSET_PX（70，近底重锁带）
  assert.match(
    engineSource,
    /const AT_BOTTOM_TOLERANCE_PX = 25;/,
  );
  // 上滚逃逸必须带距离守卫：只有距底 > 25px 且越过增长守卫带才解锁锁底
  // （2026-08 追加守卫带，见 growth-guard-band 用例）。
  // 2026-09：用户上滚意图（reportUserIntent）与逃逸同点触发——真正进入历史浏览
  // 才上报，容差带内/守卫带内的轻微上滚不算浏览（防与内容收缩 clamp 叠加误扩窗）。
  assert.match(
    engineSource,
    /if \(\s*distanceFromBottom > AT_BOTTOM_TOLERANCE_PX &&[\s\S]*?!isWithinGrowthGuardBand\(distanceFromBottom, state\)\s*\) \{\s*reportUserIntent\("up", "scroll"\);\s*setEscapedFromLock\(true\);\s*setIsAtBottom\(false\);/,
  );
  // wheel 逃逸同样带距离守卫（贴底时向上滚轮无位移，不算逃逸意图）
  assert.match(
    engineSource,
    /scrollRef\.current\.scrollHeight -\s*scrollRef\.current\.scrollTop -\s*scrollRef\.current\.clientHeight >\s*AT_BOTTOM_TOLERANCE_PX/,
  );
});

// 用户反馈 bug：流式渲染「推着推着就不动了」，只能手动点回底按钮。
// 根因：流式逐行增高时弹簧追底存在物理滞后（scrollTop 落后 target 数十到上百 px，
// 距底远超 25px 容差带），此时用户/触控板轻微上滚（含惯性误触）被误判为逃逸，
// 之后内容增长不再跟随，且 turn 窗口 3→15 轮展开放大为「视口突然停住」。
// 修复：最后一次正增长后 500ms 内、距底 <= 200px 的上滚视为「仍在跟随」，
// 不逃逸；流式结束约 500ms 后恢复正常逃逸语义；距底更远的上滚（明确读历史）
// 即使流式中也立即逃逸，不被长时间锁死。
test("growth guard band blocks escape while streaming lags behind", () => {
  // 守卫常量：500ms 锁定窗口 + 200px 守卫带
  assert.match(engineSource, /const POSITIVE_RESIZE_ESCAPE_LOCKOUT_MS = 500;/);
  assert.match(engineSource, /const GROWTH_ESCAPE_GUARD_PX = 200;/);
  // 判定辅助函数：距底 <= 守卫带 && 距上次正增长 < 锁定窗口
  assert.match(
    engineSource,
    /function isWithinGrowthGuardBand\([\s\S]*?distanceFromBottom <= GROWTH_ESCAPE_GUARD_PX &&\s*performance\.now\(\) - state\.lastPositiveResizeAt < POSITIVE_RESIZE_ESCAPE_LOCKOUT_MS/,
  );
  // 任何正增长（流式渲染）都刷新锁定计时
  assert.match(engineSource, /state\.lastPositiveResizeAt = performance\.now\(\);/);
  // 两处逃逸（scroll / wheel）都必须越过守卫带才生效
  assert.match(
    engineSource,
    /isWithinGrowthGuardBand\(distanceFromBottom, state\)/,
  );
  assert.match(engineSource, /!isWithinGrowthGuardBand\(/);
});

// 用户反馈 bug（2026-08-15）：会话输出完成后上滚被反复拽回底部，只能靠会话定位跳回。
// 根因：曾存在的「近底自动恢复」——RO 正增长分支里 `if (!state.isAtBottom &&
// state.isNearBottom) { setEscapedFromLock(false); setIsAtBottom(true); }`。输出完成后
// 仍有正增长（settle 全量渲染/图片加载/尾部组件），用户上滚 25~70px 读历史（距底
// 仍在 70px 近底带内）会被任何一次增长自动恢复锁底并拽回，无法阅读上方内容。
// 修复：移除该自动恢复，逃逸后只有用户主动下滚回近底带（handleScroll 重锁路径）
// 才恢复锁底；守卫带（增长活跃窗口内不逃逸）仍保留，覆盖流式中轻微上滚误逃逸。
test("escaped scroll is never dragged back by content growth", () => {
  // 正增长分支不再存在自动恢复：lastPositiveResizeAt 到 mergeAnimations 之间
  // 不得出现 setEscapedFromLock（若有，旧逻辑会在此处拽回已逃逸用户）
  assert.doesNotMatch(
    engineSource,
    /lastPositiveResizeAt = performance\.now\(\);[\s\S]*?setEscapedFromLock\(false\);[\s\S]*?const requested = mergeAnimations\(/,
  );
  // 自动恢复被说明注释替换，明确「不再自动恢复已逃逸的锁底」
  assert.match(
    engineSource,
    /这里不再自动恢复已逃逸的锁底/,
  );
});

// 逃逸后的重锁语义保持不变：向下滚动回实时尾部（近底 70px 带）仍恢复锁底
test("re-lock path after escape is preserved", () => {
  assert.match(
    engineSource,
    /if \(!state\.escapedFromLock && state\.isNearBottom\) \{\s*setIsAtBottom\(true\);/,
  );
  // 负增长（内容收缩）不主动滚动、不误重锁逃逸用户的守卫仍在
  assert.match(
    engineSource,
    /if \(!state\.escapedFromLock && state\.isNearBottom\) \{\s*setEscapedFromLock\(false\);\s*setIsAtBottom\(true\);/,
  );
});
