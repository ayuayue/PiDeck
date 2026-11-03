/**
 * Web 端主题纯函数单测（第二批）：resolveWebTheme 三态解析与
 * readStoredWebTheme 的异常/非法值兜底（localStorage 缺失或脏数据都回 system）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveWebTheme, readStoredWebTheme, nextWebTheme, toggleWebTheme } = loadTsCommonJs("src/renderer/src/web/webTheme.ts");

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

// 头部一键明暗（Web 走查：触屏用户找不到 ⋮ 菜单里的三态循环）：一次点击必须翻转实际外观。
test("toggleWebTheme: 一键翻转永远切到当前外观的对立面（system 档退出自动）", () => {
	assert.equal(toggleWebTheme("light", "light"), "dark");
	assert.equal(toggleWebTheme("dark", "dark"), "light");
	// system 档按实际解析结果翻到对面：系统亮 → 显式暗，系统暗 → 显式亮
	assert.equal(toggleWebTheme("system", "light"), "dark");
	assert.equal(toggleWebTheme("system", "dark"), "light");
	// 任何可达状态下结果都必须与当前外观相反（不能出现“点了没反应”）
	for (const pref of ["light", "dark", "system"]) {
		for (const systemDark of [false, true]) {
			const resolved = resolveWebTheme(pref, systemDark);
			const next = toggleWebTheme(pref, resolved);
			assert.notEqual(resolveWebTheme(next, systemDark), resolved, `${pref}/systemDark=${systemDark}`);
		}
	}
});
