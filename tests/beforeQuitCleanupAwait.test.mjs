/**
 * 退出清理与窗口生命周期源码契约（src/main/index.ts）：
 * - before-quit 必须 preventDefault + 等待 quitCleanup.runAll()（带总预算）后再
 *   app.quit()——旧实现 void 火后即忘，whisper/DSH dispose 等异步清理会被进程
 *   终止截断；
 * - feishuBridge 必须登记进 quitCleanup（此前唯一没登记的常驻资源）；
 * - child-process-gone 监听必须在模块级（createWindow 内注册会随窗口重建叠加）；
 * - activate 必须带 isDestroyed() 守卫（销毁实例上 show() 抛异常）。
 * 正则按仓库契约空白容忍（\s* / ^[\t ]* 锚点）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync("src/main/index.ts", "utf8");

test("before-quit：preventDefault + 有界等待清理后再 quit，重入放行", () => {
	const block = src.match(/^app\.on\("before-quit"[\s\S]*?^\}\);/m)?.[0] ?? "";
	assert.ok(block, "before-quit 监听存在");
	assert.match(block, /event\.preventDefault\(\)/, "必须挡住默认退出等异步清理完成");
	assert.match(block, /Promise\.race\(\[\s*quitCleanup\.runAll\(\)/, "清理必须被执行且有总预算兜底");
	assert.match(block, /\.finally\(\s*\(\)\s*=>\s*\{\s*app\.quit\(\)/, "清理结束后重新触发退出");
	assert.match(block, /quitCleanupStarted/, "重入守卫：quit() 重入 before-quit 时放行");
	assert.match(block, /setTimeout\(\s*resolve\s*,\s*5000\s*\)\.unref\(\)/, "预算定时器不得阻塞进程退出");
});

test("feishuBridge 已登记 quitCleanup（闭包读当前实例）", () => {
	assert.match(src, /quitCleanup\.register\(\s*"feishu-bridge"/);
});

test("child-process-gone：模块级注册，不在 createWindow 函数体内", () => {
	assert.match(src, /^app\.on\("child-process-gone"/m, "存在模块级注册");
	const start = src.search(/^(?:async )?function createWindow/m);
	assert.ok(start >= 0, "createWindow 定义存在");
	const end = src.indexOf("\n}", start);
	const body = src.slice(start, end);
	assert.doesNotMatch(body, /app\.on\("child-process-gone"/, "createWindow 内不得注册 app 级监听");
	assert.equal((src.match(/app\.on\("child-process-gone"/g) ?? []).length, 1, "全文件只注册一次");
});

test("activate：销毁守卫 + 正常 show/focus + 降级重建", () => {
	const block = src.match(/app\.on\("activate",\s*\(\)\s*=>\s*\{[\s\S]*?\n\t\t\}\);/)?.[0] ?? "";
	assert.ok(block, "activate 监听存在");
	assert.match(block, /mainWindow && !mainWindow\.isDestroyed\(\)/, "必须先判销毁再 show");
	assert.match(block, /mainWindow\.show\(\)/);
	assert.match(block, /void createWindow\(\)/, "销毁/无窗口时降级重建");
});
