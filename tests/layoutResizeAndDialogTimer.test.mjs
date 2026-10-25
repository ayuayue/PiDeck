/**
 * 悬浮层重算 / 用量弹窗自动关闭的清理契约（2027-02）。
 *
 * 背景：
 * - useNotifyLayoutResized 的拖拽 rAF 循环原先只靠 document pointerup 停止，
 *   指针移出窗口/被系统弹窗吞掉时会以 60fps 永久派发 window resize；
 *   且任一使用者卸载都会无条件停掉全局拖拽（跨实例互相打断）。
 * - UsageProbeConfigDialog 保存成功后的 600ms 自动关闭 timer 无清理，
 *   用户在窗口期内自行关闭会重复触发 onClose（可能连带关掉宿主设置窗口）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const layoutSource = readFileSync("src/renderer/src/hooks/useNotifyLayoutResized.ts", "utf8");
const dialogSource = readFileSync("src/renderer/src/config/UsageProbeConfigDialog.tsx", "utf8");

test("拖拽 rAF 循环可取消，并有失焦/超时兜底", () => {
	assert.match(layoutSource, /loopFrame/, "必须持有循环帧句柄才能取消");
	assert.match(layoutSource, /function stopDrag\(\)/, "必须有统一停止入口");
	assert.match(layoutSource, /cancelAnimationFrame\(tracker\.loopFrame\)/, "停止时必须取消未执行的循环帧");
	assert.match(layoutSource, /MAX_DRAG_LOOP_MS/, "必须有最长存活时间兜底");
	assert.match(layoutSource, /addEventListener\("blur"/, "窗口失焦必须收口");
	assert.match(layoutSource, /visibilitychange/, "页面隐藏必须收口");
});

test("使用者卸载只有最后一个才停循环（计数）", () => {
	assert.match(layoutSource, /tracker\.consumers \+= 1/, "挂载必须计数");
	assert.match(layoutSource, /if \(tracker\.consumers > 0\) return;/, "非最后一个卸载不得停循环");
});

test("用量弹窗的自动关闭 timer 可撤销", () => {
	assert.match(dialogSource, /closeTimerRef/, "必须用 ref 持有 timer id");
	assert.match(dialogSource, /window\.clearTimeout\(closeTimerRef\.current\)/, "手动关闭/卸载必须撤销");
	assert.doesNotMatch(dialogSource, /window\.setTimeout\(handleClose, 600\)/, "不得再有无清理的裸 setTimeout");
});
