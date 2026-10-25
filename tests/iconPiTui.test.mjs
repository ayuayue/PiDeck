import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const { PI_TUI_COLORS, PI_TUI_LOGO_CELLS } = loadTsCommonJs("src/renderer/src/components/app/piTuiLogoData.ts");

/**
 * 应用图标 pi-tui 风格资源契约：
 * 1) build/icon-pi-tui.svg 与 renderer 的 piTuiLogoData 位图逐格一致（三色像素标），
 *    且容器规格与 classic build/icon.svg 同款（rx 228 深色渐变底 + shine），中心高 520 等高；
 * 2) scripts/make-icon.js 产出的 build/icon-pi-tui.png 是 256×256 透明留白 PNG（运行时 setIcon 用）；
 * 3) 打包静态图标（icon.ico / icon.icns / icons/*.png）底图是 pi-tui，而运行时 classic 选项用的
 *    build/icon.png 仍是 pi 字标——两者混淆会让「Logo 风格」切到 classic 时显示成 pi-tui 标。
 * 4) 官网顶栏 logo / favicon（docs-site/public/icon.svg）已换成同一枚 pi-tui 位图，
 *    它是一份手写的 120 视口版本，位图逐格必须与上面同源，否则会出现「站点 logo 与安装包不是同一枚」。
 */

/** pi-tui 品牌三色；按容差匹配像素，避免抗锯齿边缘导致的精确比较失败。 */
const TUI_RGB = [
	[0xe4, 0x8a, 0x7a],
	[0x4f, 0x8e, 0xb3],
	[0xea, 0xb6, 0x5d],
];

/** 统计图片中 pi-tui 三色像素占不透明像素的比例。 */
async function tuiColorRatio(file) {
	const { data, info } = await sharp(file).resize(64, 64, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
	let hit = 0;
	let total = 0;
	for (let i = 0; i < data.length; i += info.channels) {
		if (info.channels === 4 && data[i + 3] < 128) continue;
		total += 1;
		const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
		if (TUI_RGB.some(([cr, cg, cb]) => Math.abs(r - cr) < 30 && Math.abs(g - cg) < 30 && Math.abs(b - cb) < 30)) hit += 1;
	}
	return total === 0 ? 0 : hit / total;
}

test("icon-pi-tui.svg contains the same 10-cell bitmap as renderer piTuiLogoData", () => {
	const svg = fs.readFileSync(path.join(root, "build", "icon-pi-tui.svg"), "utf8");

	const rects = [...svg.matchAll(/<rect x="(\d)" y="(\d)" width="1" height="1" fill="(#(?:[0-9A-Fa-f]{6}))"\/>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), fill: m[3].toUpperCase() }));
	assert.equal(rects.length, 10, "must be exactly 10 bitmap cells");

	// piTuiLogoData 的单元格键是 "y:x"、值是颜色名；svg 是 x/y 属性 + hex，两套坐标对齐比较。
	const expectedByCell = new Map(Object.entries(PI_TUI_LOGO_CELLS).map(([key, colorName]) => [key, PI_TUI_COLORS[colorName].toUpperCase()]));
	for (const [key, expectedFill] of expectedByCell) {
		const [y, x] = key.split(":").map(Number);
		const rect = rects.find((r) => r.x === x && r.y === y);
		assert.ok(rect, `svg must contain cell ${key}`);
		assert.equal(rect.fill, expectedFill, `cell ${key} color must match piTuiLogoData`);
	}
	// 颜色只允许品牌三色（coral/blue/yellow）
	for (const rect of rects) {
		assert.ok(["#E48A7A", "#4F8EB3", "#EAB65D"].includes(rect.fill), `unexpected fill color ${rect.fill}`);
	}
});

test("icon-pi-tui.svg keeps the classic container spec and stays vector-only", () => {
	const svg = fs.readFileSync(path.join(root, "build", "icon-pi-tui.svg"), "utf8");
	assert.match(svg, /rx="228"/, "container corner radius must match classic icon.svg");
	assert.match(svg, /viewBox="0 0 4 4"/, "bitmap viewport must be 4x4");
	assert.match(svg, /width="693" height="520"/, "bitmap height 520 matches classic wordmark; width is 4:3");
	assert.match(svg, /translate\(166, 252\)/, "bitmap centered horizontally and vertically in the icon container");
	assert.ok(!svg.includes("data:image/png"), "must not embed raster data");
});

test("官网顶栏 logo 与打包标是同一枚 pi-tui 位图", () => {
	// 站点 logo 是 120 视口的手写版（容器几何不同，不能直接 `cp` 打包标），
	// 所以用与 icon-pi-tui.svg 同一套断言锁住 10 格位图，防止「改了一边」的漂移。
	const svg = fs.readFileSync(path.join(root, "docs-site", "public", "icon.svg"), "utf8");

	const rects = [...svg.matchAll(/<rect x="(\d)" y="(\d)" width="1" height="1" fill="(#(?:[0-9A-Fa-f]{6}))"\/>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), fill: m[3].toUpperCase() }));
	assert.equal(rects.length, 10, "site logo must be exactly the 10-cell pi-tui bitmap");
	for (const [key, colorName] of Object.entries(PI_TUI_LOGO_CELLS)) {
		const [y, x] = key.split(":").map(Number);
		const rect = rects.find((r) => r.x === x && r.y === y);
		assert.ok(rect, `site logo must contain cell ${key}`);
		assert.equal(rect.fill, PI_TUI_COLORS[colorName].toUpperCase(), `site logo cell ${key} color must match piTuiLogoData`);
	}

	assert.match(svg, /viewBox="0 0 4 4"/, "bitmap viewport must be 4x4");
	assert.match(svg, /shape-rendering="crispEdges"/, "pixel mark must not be smoothed");
	// 经典 π 字标几何：留在站点里说明换标没真正生效（打包标已改 pi-tui 时漏改官网）
	assert.ok(!svg.includes("165.29 165.29"), "site logo must not keep the classic lettermark geometry");
});

test("make-icon.js emitted build/icon-pi-tui.png as a 256x256 transparent PNG", async () => {
	const pngPath = path.join(root, "build", "icon-pi-tui.png");
	assert.ok(fs.existsSync(pngPath), "icon-pi-tui.png must be generated (npm run make-icon)");
	const meta = await sharp(pngPath).metadata();
	assert.equal(meta.width, 256);
	assert.equal(meta.height, 256);
	assert.equal(meta.channels, 4, "must keep alpha channel for icon padding");
});

test("packaging icons (ico/icns/icons dir) are rendered from the pi-tui mark", async () => {
	// 安装包/exe/Dock/Linux 的静态图标在构建期烘进二进制，运行时改不了 → 固定取 pi-tui 底图。
	for (const rel of ["icons/256x256.png", "icons/512x512.png", "icons/1024x1024.png"]) {
		const file = path.join(root, "build", rel);
		assert.ok(fs.existsSync(file), `${rel} must be generated (npm run make-icon)`);
		const ratio = await tuiColorRatio(file);
		assert.ok(ratio > 0.05, `${rel} must use the pi-tui tri-color mark (got ${(ratio * 100).toFixed(1)}% brand pixels)`);
	}

	// ico/icns 的容器头完整性：损坏的产物会让 electron-builder 静默回退到默认 Electron 图标。
	const ico = await fs.promises.readFile(path.join(root, "build", "icon.ico"));
	assert.equal(ico.readUInt16LE(0), 0, "ico reserved field");
	assert.equal(ico.readUInt16LE(2), 1, "ico type must be icon");
	assert.ok(ico.readUInt16LE(4) >= 7, "ico must embed the full size ladder");
	const icns = await fs.promises.readFile(path.join(root, "build", "icon.icns"));
	assert.equal(icns.subarray(0, 4).toString("ascii"), "icns", "icns header");
});

test("runtime classic icon stays the Pi lettermark, not a copy of the pi-tui packaging set", async () => {
	// 回归门禁：icon.png 曾经是 icons/512x512.png 的拷贝；那套改成 pi-tui 之后若还拷贝，
	// 设置里切到「PiDeck 经典」会显示成 pi-tui 标（两个选项看起来一模一样）。
	const file = path.join(root, "build", "icon.png");
	assert.ok(fs.existsSync(file), "icon.png must be generated (npm run make-icon)");
	const ratio = await tuiColorRatio(file);
	assert.ok(ratio < 0.01, `classic icon.png must not contain pi-tui brand colors (got ${(ratio * 100).toFixed(1)}%)`);
});

test("tray icon follows logoStyle at creation and on settings change (source scan)", () => {
	// 托盘图标曾经硬编码 classic iconPath：切换「Logo 风格」时窗口/Dock 变了、托盘不变。
	// 两处契约：setupTray 首建按当前设置取图；settingsUpdate 的 logoStyle 分支同时刷托盘。
	const appWindowLogo = fs.readFileSync(path.join(root, "src", "main", "appWindowLogo.ts"), "utf8");
	const index = fs.readFileSync(path.join(root, "src", "main", "index.ts"), "utf8");
	const systemIpc = fs.readFileSync(path.join(root, "src", "main", "ipc", "systemIpc.ts"), "utf8");

	// 窗口与托盘共用一条图标解析路径，避免新增风格时漏改其中一处
	assert.match(appWindowLogo, /export function resolveLogoImage\(/, "shared icon resolver must exist");
	assert.match(appWindowLogo, /export function applyTrayLogoStyle\(/, "tray switcher must exist");
	assert.match(appWindowLogo, /tray\.setImage\(image\.resize\(/, "tray must resize before setImage");

	// setupTray 首建读设置值（风格 + 自定义图），资源缺失时降级回 iconPath（托盘必须建得出来）
	const setupTray = index.slice(index.indexOf("function setupTray()"));
	assert.match(setupTray.slice(0, 600), /resolveLogoImage\(\s*trayLogoSettings\.logoStyle,\s*trayLogoSettings\.logoCustomImage\s*\)/, "setupTray must honor the saved logoStyle and custom logo");

	// custom 风格：只收内联 data:image/*（挡路径/远程 URL），解不开时回落默认位图，不出现「无图标」
	assert.match(appWindowLogo, /createFromDataURL\(/, "custom logo must decode the inline data URL");
	assert.match(appWindowLogo, /startsWith\("data:image\/"\)/, "custom logo must only accept inline image data URLs");
	assert.match(appWindowLogo, /if \(!image\) resolved = "pi-tui"/, "custom without a usable image must fall back to a built-in mark");

	// 设置变更分支：窗口与托盘成对刷新；切风格、换图/移除自定义图都要刷，且只在真变化时刷
	const logoAnchor = '"logoStyle" in patch && prevSettings.logoStyle !== settings.logoStyle';
	assert.ok(systemIpc.includes(logoAnchor), "settings update must refresh icons when logoStyle changes");
	const logoBranch = systemIpc.slice(systemIpc.indexOf(logoAnchor));
	assert.match(logoBranch.slice(0, 400), /applyWindowLogoStyle\(settings\.logoStyle, getMainWindow, settings\.logoCustomImage\)/, "window icon refresh");
	assert.match(logoBranch.slice(0, 400), /applyTrayLogoStyle\(settings\.logoStyle, getTray, settings\.logoCustomImage\)/, "tray icon refresh");
	assert.match(logoBranch.slice(0, 400), /"logoCustomImage" in patch && prevSettings\.logoCustomImage !== settings\.logoCustomImage/, "custom image change must refresh icons too");
});

test("window icon is resolved at window creation (startup applyWindowLogoStyle runs before the window exists)", () => {
	// 回归：启动阶段的 applyWindowLogoStyle（settingsStore.load() 之后）早于 createWindow 执行，
	// 那时 mainWindow 还是 null → 调用是空操作；建窗参数若写死 iconPath，
	// 冷启动的任务栏/Alt-Tab 图标就永远不跟 logoStyle（要等用户改一次设置才纠正）。
	const index = fs.readFileSync(path.join(root, "src", "main", "index.ts"), "utf8");
	const createWindowStart = index.indexOf("async function createWindow()");
	assert.notEqual(createWindowStart, -1, "index.ts must define createWindow");
	const createWindow = index.slice(createWindowStart);
	const optionsIndex = createWindow.indexOf("settingsStore.createWindowOptions()");
	assert.notEqual(optionsIndex, -1, "createWindow must read window options");
	const iconOption = createWindow.slice(optionsIndex).match(/\bicon:\s*([^,\n]+)/);
	assert.ok(iconOption, "createWindow must set a window icon");
	assert.match(iconOption[1], /resolveLogoImage|initialWindowLogo/, "窗口 icon 必须来自 resolveLogoImage（写死 iconPath 会让冷启动图标不跟随）");
});
