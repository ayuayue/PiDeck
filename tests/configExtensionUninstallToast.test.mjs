/**
 * 卸载失败通知（附手动卸载命令 + 一键复制）与 sonner toast「拖选文本不被
 * swipe 取消」的接线测试。
 * 背景：
 *  - 卸载失败 toast 只显示错误原因，用户无法在终端手动补救 → 附上与主进程
 *    同源的 `pi remove <source> [-l]` 命令和复制按钮。
 *  - sonner 的拖动取消手势会把「拖选 toast 文本复制」误判为 swipe 取消 →
 *    在 document 捕获阶段拦截 toast 非按钮区的 pointerdown。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("卸载失败 toast 附带手动卸载命令（含 project scope 的 -l）", () => {
	const source = read("src/renderer/src/ConfigModal.tsx");
	// 命令用用户直觉的 pi uninstall（与主进程内部执行的 pi remove 是同一命令的别名），project 加 -l
	assert.match(source, /`pi uninstall \$\{target\.source\}\$\{target\.scope === "project" \? " -l" : ""\}`/);
	// 正文内嵌手动命令（可直接选中复制）
	assert.match(source, /t\("config\.extensionUninstallManual", \{ command: uninstallCmd \}\)/);
	// 一键复制按钮：写剪贴板
	assert.match(source, /label: t\("config\.copyUninstallCmd"\)/);
	assert.match(source, /navigator\.clipboard\.writeText\(uninstallCmd\)/);
	// 给足复制时间（原 4500 → 6000）
	// 实参被格式化到不同行/带尾逗号：只锁 6000 与 error 档的组合。
	assert.match(source, /6000,\s*"error",?/);
});

test("sonner Toaster 拦截 toast 非按钮区的 pointerdown（防拖选文本触发 swipe 取消）", () => {
	const source = read("src/renderer/src/components/ui-shadcn/sonner.tsx");
	// 捕获阶段监听 + 仅拦 [data-sonner-toast] 内、且放过按钮
	assert.match(source, /addEventListener\("pointerdown", blockToastSwipe, true\)/);
	assert.match(source, /removeEventListener\("pointerdown", blockToastSwipe, true\)/);
	assert.match(source, /target\.closest\("button"\)\) return;/);
	assert.match(source, /target\.closest\("\[data-sonner-toast\]"\)/);
	// 不 preventDefault：保留文本选区默认行为
	assert.match(source, /stopImmediatePropagation\(\)/);
	// toast 内容显式允许选中（自定义卡片根节点 select-text）
	const card = read("src/renderer/src/components/ui-shadcn/notice-toast.tsx");
	assert.match(card, /select-text/);
});

test("卸载命令提示与复制按钮 i18n 双语文案齐全", () => {
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const key of ["config.extensionUninstallFailed", "config.extensionUninstallManual", "config.copyUninstallCmd"]) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
	// 占位符一致：{error} 与 {command} 都在
	assert.ok(zh.includes("{error}") && zh.includes("{command}"));
	assert.ok(en.includes("{error}") && en.includes("{command}"));
});
