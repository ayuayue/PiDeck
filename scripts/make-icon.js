const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { Icns, IcnsImage } = require("@fiahfy/icns");
const pngToIcoModule = require("png-to-ico");
const pngToIco = pngToIcoModule.default ?? pngToIcoModule;

// 打包标必须是矢量 pi 字标（与 LogoMark / 启动画面同源，对齐 main 分支品牌）。
// 嵌 PNG 的旧稿会在小尺寸糊、圆角漏白；若改回跳蛛等其它品牌标，必须同步更新下面这道几何门禁。
const svg = fs.readFileSync(path.join(__dirname, "..", "build", "icon.svg"), "utf8");
if (svg.includes("data:image/png")) {
	throw new Error("build/icon.svg must stay a vector mark; do not embed a PNG");
}
if (!svg.includes("165.29 165.29")) {
	throw new Error("build/icon.svg must keep the Pi lettermark geometry");
}

// 安装包/exe/Dock/Linux 的静态图标底图：白底 pi-tui 三色像素标。
// 这些格式在构建期烘进二进制，运行时改不了——所以打包身份固定取 pi-tui；
// 设置里的「Logo 风格」只切运行时的窗口/任务栏/托盘图标（见 src/main/appWindowLogo.ts）。
// classic 一套仍然生成：它是运行时切换的另一个选项，也是应用内品牌位的来源。
const piTuiSvg = fs.readFileSync(path.join(__dirname, "..", "build", "icon-pi-tui.svg"), "utf8");
if (piTuiSvg.includes("data:image/png")) {
	throw new Error("build/icon-pi-tui.svg must stay a vector mark; do not embed a PNG");
}
if (!piTuiSvg.includes('viewBox="0 0 4 4"')) {
	throw new Error("build/icon-pi-tui.svg must keep the 4x4 TUI bitmap geometry");
}

const out = path.join(__dirname, "..", "build");
const iconsDir = path.join(out, "icons");
const iconContentRatio = 0.875;
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
// macOS decodes PNG-backed icp4/icp5 entries as corrupt pixels in Spotlight.
// Use RGB entries with separate alpha masks for the small 1x icons; unlike
// ARGB entries, these preserve straight-alpha PNG pixels without premultiplication.
const icnsSources = [
	[16, "is32"],
	[16, "s8mk"],
	[32, "il32"],
	[32, "l8mk"],
	[32, "ic11"],
	[64, "icp6"],
	[64, "ic12"],
	[128, "ic07"],
	[256, "ic08"],
	[256, "ic13"],
	[512, "ic09"],
	[512, "ic14"],
	[1024, "ic10"],
];

/** 渲染圆角图标；Dock/Linux 默认保留边距，Windows 传 1；省略 target 时直接供 ICO 编码。 */
async function renderPng(size, target, sourceSvg = piTuiSvg, contentRatio = iconContentRatio) {
	let innerSize = Math.max(1, Math.round(size * contentRatio));
	if (innerSize > 1) innerSize -= innerSize % 2;
	const icon = await sharp(Buffer.from(sourceSvg)).resize(innerSize, innerSize).png().toBuffer();

	// macOS Dock/Finder 需要每边 6.25% 留白；Windows 直接铺满画布，避免图标比同排软件小一圈。
	const png = await sharp({
		create: {
			width: size,
			height: size,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite([
			{
				input: icon,
				left: Math.floor((size - innerSize) / 2),
				top: Math.floor((size - innerSize) / 2),
			},
		])
		.png()
		.toBuffer();
	if (target) await fs.promises.writeFile(target, png);
	return png;
}

async function writeIcns(target) {
	const icns = new Icns();
	for (const [size, osType] of icnsSources) {
		const file = path.join(iconsDir, `${size}x${size}.png`);
		const buffer = await fs.promises.readFile(file);
		icns.append(IcnsImage.fromPNG(buffer, osType));
	}
	await fs.promises.writeFile(target, icns.data);

	const header = await fs.promises.readFile(target, { encoding: null });
	if (header.subarray(0, 4).toString("ascii") !== "icns") {
		throw new Error("generated icon.icns is invalid: missing icns file header");
	}
}

async function main() {
	fs.mkdirSync(iconsDir, { recursive: true });
	fs.writeFileSync(path.join(out, "icon.svg"), svg);

	// electron-builder 在 Linux 下会从 build/icons 读取多尺寸 PNG；
	// Windows 安装包需要 .ico，macOS 需要 .icns。显式生成这些格式，
	// 避免只存在 SVG 时各平台回退到默认 Electron 图标。
	// 这三者都是打包静态图标 → 统一取 pi-tui 底图（renderPng 的 sourceSvg 默认值）。
	await Promise.all(pngSizes.map((size) => renderPng(size, path.join(iconsDir, `${size}x${size}.png`))));

	// ICO 独立渲染，不能复用带 Dock 留白的 PNG；Windows 各档图标均铺满画布。
	const ico = await pngToIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map((size) => renderPng(size, undefined, piTuiSvg, 1))));
	await fs.promises.writeFile(path.join(out, "icon.ico"), ico);
	await writeIcns(path.join(out, "icon.icns"));

	// 运行时「Logo 风格」两枚图标：主进程按设置值 setIcon / Tray.setImage（见 src/main/appWindowLogo.ts）。
	// icon.png 必须独立按 classic SVG 渲染，不能再从 icons/512x512.png 拷贝——
	// 那套现在是 pi-tui 底图，拷过来会让 classic 选项显示成 pi-tui 标。
	await renderPng(512, path.join(out, "icon.png"), svg);
	await renderPng(256, path.join(out, "icon-classic-windows.png"), svg, 1);
	await renderPng(256, path.join(out, "icon-pi-tui.png"), piTuiSvg);
	// Windows 运行时窗口/任务栏/托盘同样取消外层留白，避免启动后又缩回 Dock 尺寸。
	await renderPng(256, path.join(out, "icon-pi-tui-windows.png"), piTuiSvg, 1);

	// 应用内侧栏/空态用同一枚正式标；不要直接拷系统 512（含 Dock 留白），按 SVG 铺满导出。
	const rendererMark = path.join(__dirname, "..", "src", "renderer", "src", "assets", "brand-mark.png");
	await sharp(Buffer.from(svg)).resize(256, 256).png().toFile(rendererMark);

	console.log("wrote white classic/pi-tui PNGs (Dock/Windows), icon.ico + icon.icns + icons/*.png and src/renderer/src/assets/brand-mark.png");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
