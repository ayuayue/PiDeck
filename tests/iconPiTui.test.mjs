import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainAssemblySource } from "./helpers/mainIpcSources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const { PI_TUI_COLORS, PI_TUI_LOGO_CELLS } = loadTsCommonJs("src/renderer/src/components/app/piTuiLogoData.ts");

/**
 * 应用图标 pi-tui 风格资源契约：
 * 1) build/icon-pi-tui.svg 与 renderer 的 piTuiLogoData 位图逐格一致（三色像素标），
 *    且容器沿用 classic 的 rx 228 圆角，系统图标固定白底，三色主体占底板宽高的 65%；
 * 2) scripts/make-icon.js 生成带 Dock 留白的 icon-pi-tui.png，以及不加外层留白的 Windows 运行时图标；
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

/** 解码生成器使用的 32-bit DIB ICO 帧，检查 Windows 实际读取的像素。 */
function decodeIcoFrames(ico) {
	assert.equal(ico.readUInt16LE(0), 0);
	assert.equal(ico.readUInt16LE(2), 1);
	return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
		const entry = 6 + index * 16;
		const width = ico[entry] || 256;
		const height = ico[entry + 1] || 256;
		const offset = ico.readUInt32LE(entry + 12);
		assert.equal(ico.readUInt32LE(offset), 40, "must use a BITMAPINFOHEADER");
		assert.equal(ico.readUInt16LE(offset + 14), 32, "must preserve 32-bit alpha");
		const data = Buffer.alloc(width * height * 4);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const source = offset + 40 + ((height - y - 1) * width + x) * 4;
				const target = (y * width + x) * 4;
				data[target] = ico[source + 2];
				data[target + 1] = ico[source + 1];
				data[target + 2] = ico[source];
				data[target + 3] = ico[source + 3];
			}
		}
		return { data, info: { width, height, channels: 4 } };
	});
}

/** 检查圆角底板的直边像素；避开字模和阴影，不把白底误判成灰色。 */
function assertWhitePlate({ data, info }, inset) {
	for (const [x, y] of [
		[Math.floor(info.width / 2), inset],
		[Math.floor(info.width / 2), info.height - inset - 1],
		[inset, Math.floor(info.height / 2)],
		[info.width - inset - 1, Math.floor(info.height / 2)],
	]) {
		const pixel = (y * info.width + x) * info.channels;
		assert.ok(data[pixel + 3] >= 128, `plate must reach (${x}, ${y}) in ${info.width}px icon`);
		assert.ok(
			[0, 1, 2].every((channel) => data[pixel + channel] >= 250),
			`plate must be white at (${x}, ${y})`,
		);
	}
	assert.equal(data[3], 0, "rounded corners must stay transparent");
}

test("系统图标采用白底，macOS 和 Linux 继续保留外层留白", async () => {
	for (const file of ["icon-pi-tui.png", "icons/256x256.png"]) {
		const decoded = await sharp(path.join(root, "build", file))
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		assertWhitePlate(decoded, 16);
		const topCenter = 128 * 4;
		assert.equal(decoded.data[topCenter + 3], 0, `${file} must keep its Dock padding`);
	}
	const svg = await sharp(path.join(root, "build", "icon-pi-tui.svg"))
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	assertWhitePlate(svg, 0);
});

/** 从渲染像素测量三色主体，避免 SVG 视口留白让声明尺寸与实际占比不一致。 */
function assertCenteredGlyph({ data, info }, plateSize, isClassic = false) {
	let left = info.width;
	let top = info.height;
	let right = -1;
	let bottom = -1;
	for (let y = 0; y < info.height; y += 1) {
		for (let x = 0; x < info.width; x += 1) {
			const pixel = (y * info.width + x) * info.channels;
			const rgb = [data[pixel], data[pixel + 1], data[pixel + 2]];
			const isGlyph = isClassic ? Math.max(...rgb) < 160 : Math.max(...rgb) - Math.min(...rgb) > 45;
			if (data[pixel + 3] < 128 || !isGlyph) continue;
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x);
			bottom = Math.max(bottom, y);
		}
	}
	const expected = plateSize * 0.65;
	assert.ok(Math.abs(right - left + 1 - expected) <= 1, `glyph width must be 65% of ${plateSize}px plate`);
	assert.ok(Math.abs(bottom - top + 1 - expected) <= 1, `glyph height must be 65% of ${plateSize}px plate`);
	assert.ok(Math.abs((left + right + 1) / 2 - info.width / 2) <= 0.5, "glyph must stay horizontally centered");
	assert.ok(Math.abs((top + bottom + 1) / 2 - info.height / 2) <= 0.5, "glyph must stay vertically centered");
}

test("三色主体在 SVG 与运行时 PNG 中均居中占底板宽高的 65%", async () => {
	for (const [file, plateSize] of [
		["icon-pi-tui.svg", 1024],
		["icon-pi-tui-windows.png", 256],
		["icon-pi-tui.png", 224],
	]) {
		const decoded = await sharp(path.join(root, "build", file))
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		assertCenteredGlyph(decoded, plateSize);
	}
});

test("Windows ICO 全尺寸帧使用白底且不再带 Dock 外层留白", () => {
	const frames = decodeIcoFrames(fs.readFileSync(path.join(root, "build", "icon.ico")));
	assert.deepEqual(
		frames.map(({ info }) => info.width),
		[16, 24, 32, 48, 64, 128, 256],
	);
	for (const frame of frames) {
		assertWhitePlate(frame, 0);
		assertCenteredGlyph(frame, frame.info.width);
	}
});

test("Windows 运行时图标采用同样的无额外留白白底", async () => {
	const decoded = await sharp(path.join(root, "build", "icon-pi-tui-windows.png"))
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	assert.equal(decoded.info.width, 256);
	assert.equal(decoded.info.height, 256);
	assertWhitePlate(decoded, 0);
});

test("经典资源同样使用白底、深灰 65% 主体及各平台对应留白", async () => {
	for (const [file, plateSize, inset] of [
		["build/icon.svg", 1024, 0],
		["build/icon.png", 448, 32],
		["build/icon-classic-windows.png", 256, 0],
		["src/renderer/src/assets/brand-mark.png", 256, 0],
	]) {
		const decoded = await sharp(path.join(root, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		assertWhitePlate(decoded, inset);
		assertCenteredGlyph(decoded, plateSize, true);
	}
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
	// setupTray 已迁到 src/main/window/tray.ts：读装配聚合面（index + startup + window），断言含义不变。
	const assembly = mainAssemblySource;
	const systemIpc = fs.readFileSync(path.join(root, "src", "main", "ipc", "systemIpc.ts"), "utf8");

	// 窗口与托盘共用一条图标解析路径，避免新增风格时漏改其中一处
	assert.match(appWindowLogo, /export function resolveLogoImage\(/, "shared icon resolver must exist");
	assert.match(appWindowLogo, /export function applyTrayLogoStyle\(/, "tray switcher must exist");
	assert.match(appWindowLogo, /tray\.setImage\(image\.resize\(/, "tray must resize before setImage");

	// setupTray 首建读设置值（风格 + 自定义图），资源缺失时降级回 iconPath（托盘必须建得出来）
	const setupTray = assembly.slice(assembly.indexOf("function setupTray("));
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
	// 建窗实现已迁到 src/main/window/mainWindow.ts：读装配聚合面，锁定 createMainWindow 内的取图标方式。
	const assembly = mainAssemblySource;
	const createWindowStart = assembly.indexOf("async function createMainWindow(");
	assert.notEqual(createWindowStart, -1, "createMainWindow must be defined in the window module");
	const createWindow = assembly.slice(createWindowStart);
	const optionsIndex = createWindow.indexOf("createWindowOptions()");
	assert.notEqual(optionsIndex, -1, "createWindow must read window options");
	const iconOption = createWindow.slice(optionsIndex).match(/\bicon:\s*([^,\n]+)/);
	assert.ok(iconOption, "createWindow must set a window icon");
	assert.match(iconOption[1], /resolveLogoImage|initialWindowLogo/, "窗口 icon 必须来自 resolveLogoImage（写死 iconPath 会让冷启动图标不跟随）");
});
