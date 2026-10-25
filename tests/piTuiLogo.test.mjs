import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PI_TUI_COLORS, PI_TUI_LOGO_CELLS, PI_TUI_PIECES, resolveLogoStyle, LOGO_STYLE_STORAGE_KEY } = loadTsCommonJs("src/renderer/src/components/app/piTuiLogoData.ts");
const { BOOT_APP_NAME_STORAGE_KEY, BOOT_CUSTOM_LOGO_STORAGE_KEY } = loadTsCommonJs("src/renderer/src/components/app/bootBrandCache.ts");

test("official pi TUI logo bitmap matches pi source colors and cell layout", () => {
	// pi 源码 pi-logo.ts：coral #E48A7A / blue #4F8EB3 / yellow #EAB65D（品牌色固定）。
	// 沙箱加载的模块对象来自另一 realm，deepEqual 会因原型链不同误报，一律用标量断言。
	assert.equal(PI_TUI_COLORS.coral, "#E48A7A");
	assert.equal(PI_TUI_COLORS.blue, "#4F8EB3");
	assert.equal(PI_TUI_COLORS.yellow, "#EAB65D");
	// 4×4 位图 10 个有色格（y:x 锚定官方渲染行列）
	assert.deepEqual(Object.keys(PI_TUI_LOGO_CELLS).sort(), ["0:0", "0:1", "0:2", "1:0", "1:2", "2:0", "2:1", "2:3", "3:0", "3:3"]);
	assert.equal(PI_TUI_LOGO_CELLS["0:0"], "coral");
	assert.equal(PI_TUI_LOGO_CELLS["1:2"], "coral");
	assert.equal(PI_TUI_LOGO_CELLS["1:0"], "blue");
	assert.equal(PI_TUI_LOGO_CELLS["2:1"], "blue");
	assert.equal(PI_TUI_LOGO_CELLS["2:3"], "yellow");
	assert.equal(PI_TUI_LOGO_CELLS["3:3"], "yellow");
});

test("three animation pieces reassemble the settled bitmap exactly", () => {
	const reassembled = {};
	for (const piece of PI_TUI_PIECES) {
		assert.ok(piece.targetY >= 0, "piece target must land inside the 4x4 grid");
		assert.ok(piece.startY < piece.targetY, "piece must enter from above");
		for (const [dy, dx] of piece.cells) {
			reassembled[`${piece.targetY + dy}:${dx}`] = piece.color;
		}
	}
	// 逐格标量断言（跨 realm 对象不用 deepEqual）：三块落位后必须逐格还原定格位图
	assert.deepEqual(Object.keys(reassembled).sort(), Object.keys(PI_TUI_LOGO_CELLS).sort());
	for (const key of Object.keys(PI_TUI_LOGO_CELLS)) {
		assert.equal(reassembled[key], PI_TUI_LOGO_CELLS[key], `piece ${key} 颜色与定格位图不一致`);
	}
});

test("resolveLogoStyle treats classic as explicit opt-in, everything else falls back to pi-tui", () => {
	assert.equal(resolveLogoStyle("pi-tui"), "pi-tui");
	assert.equal(resolveLogoStyle("classic"), "classic");
	assert.equal(resolveLogoStyle(null), "pi-tui");
	assert.equal(resolveLogoStyle(undefined), "pi-tui");
	assert.equal(resolveLogoStyle("Pi-TUI"), "pi-tui");
	assert.equal(resolveLogoStyle("garbage"), "pi-tui");
});

test("logo 风格缓存键带版本后缀（翻默认值时必须升版本，否则开屏沿用旧默认）", () => {
	assert.match(LOGO_STYLE_STORAGE_KEY, /:v\d+$/u, "LOGO_STYLE_STORAGE_KEY 必须形如 pideck:logo-style:vN");
});

test("开屏内联脚本按内容哈希进 CSP 白名单（否则被 script-src 静默拦截，开屏永远回落经典标）", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const html = readFileSync(`${repoRoot}src/renderer/index.html`, "utf8");
	// 逐块校验：开屏脚本拆成多段时，只查第一块会漏掉未授权的后续块
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
	assert.ok(scripts.length > 0, "index.html 必须保留开屏内联脚本");
	const csp = html.match(/Content-Security-Policy"\s*content="([^"]+)"/)?.[1] ?? "";
	for (const script of scripts) {
		const hash = `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;
		assert.ok(csp.includes(`'${hash}'`), `CSP script-src 必须含脚本内容哈希 ${hash}（改脚本文本后需同步更新 CSP）`);
	}
	assert.match(csp, /script-src [^;]*'self'/, "script-src 必须保留 'self'");
	assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, "禁止用 'unsafe-inline' 绕过内联限制（应改用内容哈希）");
});

test("boot splash reads the same localStorage key and embeds the same pi-tui bitmap", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const html = readFileSync(`${repoRoot}src/renderer/index.html`, "utf8");
	// 启动画面内联脚本（无法 import 共享常量）必须与 LOGO_STYLE_STORAGE_KEY 同步；空白容忍防格式化断言
	assert.match(html, new RegExp(`localStorage\\.getItem\\(\\s*["']${LOGO_STYLE_STORAGE_KEY.replace(":", "\\:")}["']\\s*\\)`), "boot splash must read LOGO_STYLE_STORAGE_KEY");
	// 新默认 pi-tui：仅显式选 classic 才不挂 class（与 shared/settings 默认同源）
	assert.match(html, /bootStyle\s*!==\s*["']classic["']/, "boot splash 默认 pi-tui（非 classic 即挂 class）");
	// 开屏 pi-tui SVG 与数据模块逐格一致（颜色 + 位置抽样锚定）
	assert.match(html, /class="boot-logo-pi-tui"[\s\S]*?fill="#E48A7A"[\s\S]*?fill="#4F8EB3"[\s\S]*?fill="#EAB65D"/);
	assert.match(html, /<rect x="3" y="3" width="1" height="1" fill="#EAB65D"\/>/);
	// classic / pi-tui 显隐互斥（html.logo-pi-tui class 切换）
	assert.match(html, /html\.logo-pi-tui \.boot-logo \.boot-logo-classic\s*\{\s*display:\s*none/);
	// 官方位图为 1:1 正方形（半块字符每格上下两个正方形像素），不得再按 4:3 压成 48×36
	const bootRule = html.match(/\.boot-logo \.boot-logo-pi-tui\s*\{[^}]*\}/u);
	assert.ok(bootRule, "boot splash 应有 pi-tui logo 尺寸规则");
	assert.match(bootRule[0], /height:\s*48px/, "开屏 pi-tui 高度须与宽度一致（48px，1:1）");
	// 自定义品牌：显示名称与自定义 logo 图都从 localStorage 缓存读（键与 bootBrandCache.ts 同步，内联脚本无法 import）
	assert.match(html, new RegExp(`localStorage\\.getItem\\(\\s*["']${BOOT_APP_NAME_STORAGE_KEY.replace(":", "\\:")}["']\\s*\\)`), "开屏必须读显示名称缓存键");
	assert.match(html, new RegExp(`localStorage\\.getItem\\(\\s*["']${BOOT_CUSTOM_LOGO_STORAGE_KEY.replace(":", "\\:")}["']\\s*\\)`), "开屏必须读自定义 logo 缓存键");
	// custom 且缓存里有图才挂 logo-custom（缺图回落 pi-tui，与 shared resolveLogoStyle 同源）
	assert.match(html, /bootStyle\s*===\s*["']custom["']\s*&&\s*bootCustomLogo[\s\S]{0,80}logo-custom/, "开屏 custom 分支必须同时要求缓存里有图");
	// 显示名称写回 .boot-title；自定义图写回 .boot-logo-custom 的 src（图/名称不能硬编码在标记里）
	assert.match(html, /bootTitle\.textContent\s*=\s*bootAppName/, "开屏必须用缓存的显示名称覆盖静态 PiDeck");
	assert.match(html, /bootLogoImage\.src\s*=\s*bootCustomLogo/, "开屏必须把缓存的 data URL 写进自定义 logo 图");
	assert.match(html, /<img class="boot-logo-custom"/, "开屏必须有自定义 logo 图元素");
	// 自定义图不套黑底 plate（与 LogoMark 自定义分支一致），内置两套标隐藏
	assert.match(html, /html\.logo-custom \.boot-logo \.boot-logo-custom\s*\{\s*display:\s*block/);
	assert.match(html, /html\.logo-custom \.boot-logo \.boot-logo-pi-tui\s*\{\s*display:\s*none/);
	// App.tsx 必须写入缓存（只加开屏读取而没有写入方，开屏永远拿不到自定义品牌）
	const appSource = readFileSync(`${repoRoot}src/renderer/src/App.tsx`, "utf8");
	assert.match(appSource, /writeBootBrandCache\(\s*displayName,\s*customLogo\s*\)/, "App.tsx 必须写入开屏品牌缓存");
});

test("PiTuiLogo component renders the 4x4 bitmap as a square (SVG and Canvas)", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const source = readFileSync(`${repoRoot}src/renderer/src/components/app/PiTuiLogo.tsx`, "utf8");
	// 官方 TUI 半块字符：每字符格上下叠两个正方形像素 → 4×4 位图整体 1:1。
	// 2026-12 曾误按「2 行字符」把高度算成 3/4：SVG 被挤出侧向留白、canvas 方形缓冲被 CSS 纵向压扁，
	// 品牌区 logo 明显偏扁——本测试锁住「正方形」契约（空白容忍，AGENTS.md 格式化要求）。
	assert.match(source, /width=\{size\}\s*height=\{size\}/, "svg 宽高必须相等（位图 1:1）");
	assert.doesNotMatch(source, /\(size \* 3\) \/ 4|\(cssSize \* 3\) \/ 4/, "不得再按 4:3 计算高度");
	const paintSection = source.slice(source.indexOf("function paintCells"));
	assert.match(paintSection, /const cssW = cssSize;\s*const cssH = cssSize;/, "canvas CSS 尺寸必须为 1:1");
});

test("LogoMark sidebar and about logo branch on logoStyle (source scan, whitespace tolerant)", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const appParts = readFileSync(`${repoRoot}src/renderer/src/components/app/AppParts.tsx`, "utf8");
	const about = readFileSync(`${repoRoot}src/renderer/src/components/app/AboutPopover.tsx`, "utf8");
	const logoMark = readFileSync(`${repoRoot}src/renderer/src/components/app/LogoMark.tsx`, "utf8");
	const piTuiLogo = readFileSync(`${repoRoot}src/renderer/src/components/app/PiTuiLogo.tsx`, "utf8");
	// 空白容忍（AGENTS.md 格式化契约）：定位代码块用 \s* 而非字面空白
	assert.match(appParts, /logoStyle === "pi-tui"\s*\?\s*<PiTuiLogoCanvas size=\{18\} playOnClick \/>\s*:\s*<PiLogoCanvas size=\{18\} playOnClick \/>/);
	assert.match(about, /logoStyle === "pi-tui"\s*\?\s*<PiTuiLogoCanvas size=\{40\} playOnClick \/>\s*:\s*<PiLogoCanvas size=\{40\} playOnClick \/>/);
	assert.match(logoMark, /logoStyle === "pi-tui"\s*\?\s*\(\s*\/\*[\s\S]*?PiTuiLogoMark size=\{glyph\} \/>/);
	// custom（自备图片）：品牌位改渲染用户图；useBrandGlyph 只在「风格=custom 且已上传图」时返回非空 customLogo，
	// 并把 style 解析成内置两档（custom 缺图 → pi-tui），因此三个落点共用「有图就用图」的同一判定。
	for (const [name, source] of [
		["AppParts", appParts],
		["AboutPopover", about],
		["LogoMark", logoMark],
	]) {
		assert.match(source, /const \{\s*style: logoStyle, customLogo \} = useBrandGlyph\(\)/, `${name} 必须经 useBrandGlyph 订阅自定义 logo 图`);
		assert.match(source, /(?:if \(customLogo\) return|customLogo \?)\s*\(?\s*<img src=\{customLogo\}/, `${name} 自定义风格必须渲染用户图片`);
	}
	// LogoMark：自定义图不套黑底方块（自带外形的应用图标再垫黑底会双层嵌套，也与「上传什么就显示什么」不符），必须早返回裸 img
	assert.match(logoMark, /if \(customLogo\) return <img src=\{customLogo\}/, "LogoMark 自定义风格必须早返回裸图（不套黑底容器）");
	// 自定义回落：custom（有图无图）都必须按 pi-tui 解析（应用默认品牌位，与主进程图标回落一致），不能落回 classic
	assert.match(piTuiLogo, /style: style === "classic" \? "classic" : "pi-tui"/, "useBrandGlyph 必须把非 classic 一律按 pi-tui 处理");
	// 侧栏品牌位不再写死 PiDeck 字面量，改读应用显示名称
	assert.match(appParts, /const displayName = useAppDisplayName\(\)/);
});

// SettingsStore 依赖 electron / 日志 / git 路径解析器，stub 顶掉（与 settingsStoreHiddenModules.test.mjs 同款）
function makeSettingsStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-logo-style-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-logo-style-home-"));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: {
					getPath: (key) => (key === "userData" ? userData : key === "home" ? home : tmpdir()),
				},
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, userData };
}

const seedSettings = (userData, extra) => {
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
};

test("SettingsStore: logoStyle 默认 pi-tui、旧配置缺字段回落新默认、非法值被清洗", async () => {
	const { SettingsStore, userData } = makeSettingsStore();
	seedSettings(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().logoStyle, "pi-tui", "旧 settings.json 缺 logoStyle 时回落新默认 pi-tui");

	await store.update({ logoStyle: "classic" });
	assert.equal(store.get().logoStyle, "classic", "显式选 classic 生效");

	await store.update({ logoStyle: "neon" });
	assert.equal(store.get().logoStyle, "classic", "非法枚举被丢弃，保持原设置");

	await store.update({ logoStyle: "custom" });
	assert.equal(store.get().logoStyle, "custom", "custom（自备图片）是合法枚举");
});

test("SettingsStore: 自定义 logo 图只收内联 data URL，显示名称裁剪/超长丢弃", async () => {
	const { SettingsStore, userData } = makeSettingsStore();
	seedSettings(userData, {});
	const store = new SettingsStore();
	await store.load();

	// 内联图（data URL）是唯一合法形态：本地路径与远程 URL 都必须被丢弃，否则设置文件会被当成路径代理。
	await store.update({ logoCustomImage: "data:image/png;base64,AAAA" });
	assert.equal(store.get().logoCustomImage, "data:image/png;base64,AAAA", "内联 data URL 图片写入设置");
	for (const bad of ["C:/tmp/logo.png", "https://example.com/logo.png", 42]) {
		await store.update({ logoCustomImage: bad });
		assert.equal(store.get().logoCustomImage, "data:image/png;base64,AAAA", `非法图片值 ${String(bad)} 被丢弃，保持原设置`);
	}
	// 超长 data URL 直接进设置文件，必须封顶
	await store.update({ logoCustomImage: `data:image/png;base64,${"A".repeat(1_500_001)}` });
	assert.equal(store.get().logoCustomImage, "data:image/png;base64,AAAA", "超长内联图被丢弃");

	await store.update({ appDisplayName: "  MyApp  " });
	assert.equal(store.get().appDisplayName, "MyApp", "显示名称两端空白裁掉");
	await store.update({ appDisplayName: "x".repeat(25) });
	assert.equal(store.get().appDisplayName, "MyApp", "超长显示名称被丢弃，保持原设置");
	await store.update({ appDisplayName: "" });
	assert.equal(store.get().appDisplayName, "", "清空显示名称 = 回落默认 PiDeck（空串可持久化）");
});

test("logoStyle 默认值三处同源（shared 默认 / SettingsStore 默认 / atom 初值）", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const sharedDefaults = readFileSync(`${repoRoot}src/shared/types/settings.ts`, "utf8");
	const storeDefaults = readFileSync(`${repoRoot}src/main/settings/SettingsStore.ts`, "utf8");
	const atoms = readFileSync(`${repoRoot}src/renderer/src/atoms/app-ui-atoms.ts`, "utf8");
	for (const [path, source] of [
		["src/shared/types/settings.ts", sharedDefaults],
		["src/main/settings/SettingsStore.ts", storeDefaults],
	]) {
		assert.match(source, /logoStyle\s*:\s*"pi-tui"/, `${path} 默认 pi-tui`);
	}
	assert.match(atoms, /logoStyleAtom\s*=\s*atom<LogoStyle>\("pi-tui"\)/, "atom 初值 pi-tui（风格联合类型只在 shared 维护一份）");
});
