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

// 安装包/exe/Dock/Linux 的静态图标底图：pi-tui 三色像素标（与 pi 官方终端同款）。
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
const icnsSources = [
	[16, "icp4"],
	[32, "icp5"],
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

async function renderPng(size, target, sourceSvg = piTuiSvg) {
	let innerSize = Math.max(1, Math.round(size * iconContentRatio));
	if (innerSize > 1) innerSize -= innerSize % 2;
	const icon = await sharp(Buffer.from(sourceSvg)).resize(innerSize, innerSize).png().toBuffer();

	// Dock/Finder 会优先使用 icns 内的小尺寸图；如果小尺寸直接铺满画布，
	// 视觉上会比系统应用图标大一圈。所有平台图标都统一保留 6.25% 留白。
	await sharp({
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
		.toFile(target);
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

	const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map((size) => path.join(iconsDir, `${size}x${size}.png`)));
	await fs.promises.writeFile(path.join(out, "icon.ico"), ico);
	await writeIcns(path.join(out, "icon.icns"));

	// 运行时「Logo 风格」两枚图标：主进程按设置值 setIcon / Tray.setImage（见 src/main/appWindowLogo.ts）。
	// icon.png 必须独立按 classic SVG 渲染，不能再从 icons/512x512.png 拷贝——
	// 那套现在是 pi-tui 底图，拷过来会让 classic 选项显示成 pi-tui 标。
	await renderPng(512, path.join(out, "icon.png"), svg);
	await renderPng(256, path.join(out, "icon-pi-tui.png"), piTuiSvg);

	// 应用内侧栏/空态用同一枚正式标；不要直接拷系统 512（含 Dock 留白），按 SVG 铺满导出。
	const rendererMark = path.join(__dirname, "..", "src", "renderer", "src", "assets", "brand-mark.png");
	await sharp(Buffer.from(svg)).resize(256, 256).png().toFile(rendererMark);

	console.log("wrote build/icon.svg, build/icon.png (classic), build/icon-pi-tui.png, build/icon.ico + icon.icns + icons/*.png (pi-tui) and src/renderer/src/assets/brand-mark.png");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
