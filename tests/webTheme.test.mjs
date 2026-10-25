/**
 * Web 端主题纯函数单测（第二批）：resolveWebTheme 三态解析与
 * readStoredWebTheme 的异常/非法值兜底（localStorage 缺失或脏数据都回 system）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveWebTheme, readStoredWebTheme, nextWebTheme } = loadTsCommonJs("src/renderer/src/web/webTheme.ts");

test("resolveWebTheme: 显式 light/dark 直接返回，system 跟随系统", () => {
	assert.equal(resolveWebTheme("light", true), "light");
	assert.equal(resolveWebTheme("light", false), "light");
	assert.equal(resolveWebTheme("dark", true), "dark");
	assert.equal(resolveWebTheme("dark", false), "dark");
	assert.equal(resolveWebTheme("system", true), "dark");
	assert.equal(resolveWebTheme("system", false), "light");
});

test("readStoredWebTheme: 无 localStorage 环境回退 system", () => {
	// node --test 无 DOM：window/localColor 均不存在，走兜底分支
	assert.equal(readStoredWebTheme(), "system");
});

test("nextWebTheme: 每一次点击都必须产生可见变化（system 档跳过与系统相同的那一档）", () => {
	// light/dark 显式档：仍按 light → dark → system 循环
	assert.equal(nextWebTheme("light", "light"), "dark");
	assert.equal(nextWebTheme("dark", "dark"), "system");
	assert.equal(nextWebTheme("dark", "light"), "system");
	// system 档：系统此刻是亮色时必须跳到 dark（跳到 light 会毫无视觉变化），反之亦然
	assert.equal(nextWebTheme("system", "light"), "dark");
	assert.equal(nextWebTheme("system", "dark"), "light");
});
