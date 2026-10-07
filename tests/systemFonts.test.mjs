import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 系统字体枚举回归测试（main/fonts/SystemFonts.ts）。
 *
 * 在「伪 Linux」环境下跑：fc-list 不存在（走目录兜底）、home 指向临时目录，
 * 通过往 ~/.fonts 造字体文件验证：文件名兜底族名、点前缀/@前缀过滤、去重排序、
 * 进程内缓存与 resetSystemFontCache。不 spawn 真实 PowerShell / fc-list。
 */

async function withPlatform(platform, fn) {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		// 必须 await：fn() 返回 promise，若同步 return，finally 会在首个 await
		// 挂起点就恢复 platform，后续调用（如 refresh 重扫）会走回真实平台分支
		return await fn();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
	}
}

/** 在临时 home 下造字体文件并加载模块（每次调用得到独立模块实例 = 独立缓存）。 */
function loadSystemFonts(homeDir) {
	const electronStub = { app: { getPath: (name) => (name === "home" ? homeDir : tmpdir()) } };
	return loadTsCommonJs("src/main/fonts/SystemFonts.ts", { stubs: { electron: electronStub } });
}

test("fontFamilyFromFileName：剥扩展名与尾部样式词（含直接相连的 BoldItalic）", async () => {
	const { fontFamilyFromFileName } = loadSystemFonts(tmpdir());
	assert.equal(fontFamilyFromFileName("Arial.ttf"), "Arial");
	assert.equal(fontFamilyFromFileName("Arial Bold Italic.ttf"), "Arial");
	assert.equal(fontFamilyFromFileName("HackNerdFont-BoldItalic.ttf"), "HackNerdFont");
	assert.equal(fontFamilyFromFileName("Foo-Regular.otf"), "Foo");
	assert.equal(fontFamilyFromFileName("JetBrainsMono-Regular.ttf"), "JetBrainsMono");
	assert.equal(fontFamilyFromFileName("Source Code Pro Semibold.ttf"), "Source Code Pro");
});

test("listSystemFontFamilies：目录兜底扫描 + 过滤 ./@ 前缀 + 去重排序", async () => {
	const home = mkdtempSync(join(tmpdir(), "system-fonts-home-"));
	try {
		const userFonts = join(home, ".fonts");
		mkdirSync(userFonts);
		// name 表解析失败（假文件）→ 文件名兜底；两个文件同族名 → 去重
		writeFileSync(join(userFonts, "Zebra Sans Bold.ttf"), "not a real font");
		writeFileSync(join(userFonts, "Zebra Sans Italic.ttf"), "not a real font");
		writeFileSync(join(userFonts, "Alpha Mono.ttf"), "not a real font");
		// 系统内部族名：`.` 前缀（macOS 私有族）与 `@` 前缀（本地化别名）都要被过滤
		writeFileSync(join(userFonts, ".LastResort.ttf"), "not a real font");
		writeFileSync(join(userFonts, "@宋体.ttf"), "not a real font");

		const result = await withPlatform("linux", async () => {
			const fonts = loadSystemFonts(home);
			return fonts.listSystemFontFamilies();
		});

		assert.deepEqual([...result], ["Alpha Mono", "Zebra Sans"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("listSystemFontFamilies：结果进程内缓存，refresh/reset 才重扫", async () => {
	const home = mkdtempSync(join(tmpdir(), "system-fonts-cache-"));
	try {
		const userFonts = join(home, ".fonts");
		mkdirSync(userFonts);
		writeFileSync(join(userFonts, "Cache Probe.ttf"), "not a real font");

		await withPlatform("linux", async () => {
			const fonts = loadSystemFonts(home);
			const first = await fonts.listSystemFontFamilies();
			assert.deepEqual([...first], ["Cache Probe"]);

			// 删掉文件后普通调用仍返回缓存（不重扫）
			rmSync(join(userFonts, "Cache Probe.ttf"));
			const cached = await fonts.listSystemFontFamilies();
			assert.equal(cached, first, "缓存未生效：第二次调用重新扫描了目录");
			assert.deepEqual([...cached], ["Cache Probe"]);

			// refresh / reset 后重扫
			const refreshed = await fonts.listSystemFontFamilies({ refresh: true });
			assert.deepEqual([...refreshed], []);
			writeFileSync(join(userFonts, "Back Again.ttf"), "not a real font");
			fonts.resetSystemFontCache();
			const afterReset = await fonts.listSystemFontFamilies();
			assert.deepEqual([...afterReset], ["Back Again"]);
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("listSystemFontFamilies：过滤超长脏族名（目录名可注入超长条目）", async () => {
	const home = mkdtempSync(join(tmpdir(), "system-fonts-len-"));
	try {
		const userFonts = join(home, ".fonts");
		mkdirSync(userFonts);
		writeFileSync(join(userFonts, `${"x".repeat(120)}.ttf`), "not a real font");
		writeFileSync(join(userFonts, "Ok Short.ttf"), "not a real font");

		const result = await withPlatform("linux", async () => loadSystemFonts(home).listSystemFontFamilies());
		assert.deepEqual([...result], ["Ok Short"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
