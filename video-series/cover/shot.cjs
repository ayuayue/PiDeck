// 封面出图：node shot.cjs [--ratio both|16x9|3x4] [--scale 1|2] [--ep "..."] [--title 前半] [--accent 金色部分] [--lead "..."] [--chips "a, b, c"]
// 原理：走 cover.html 里的 window.__buildPng（DOM → SVG foreignObject → canvas），
// 所以出图与浏览器里点「导出 PNG」完全同一条路径，不依赖额外渲染器。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DIR = __dirname;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SIZE = { "16x9": [1920, 1080], "3x4": [1080, 1440] };

const argv = process.argv.slice(2);
const flag = (name, def) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ratioArg = flag("ratio", "both");
const scale = Number(flag("scale", "2"));
const ratios = ratioArg === "both" ? ["16x9", "3x4"] : [ratioArg];
if (ratios.some((r) => !SIZE[r])) {
	console.error(`✗ --ratio 只支持 both / 16x9 / 3x4，收到：${ratioArg}`);
	process.exit(1);
}
if (![1, 2].includes(scale)) {
	console.error(`✗ --scale 只支持 1 / 2，收到：${scale}`);
	process.exit(1);
}

/** 读出 PNG 头里的像素宽高，用来核对出图尺寸（不用额外依赖） */
function pngSize(buf) {
	return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

(async () => {
	const browser = await chromium.launch(fs.existsSync(EDGE) ? { executablePath: EDGE } : { channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e.message));
	await page.goto(pathToFileURL(path.join(DIR, "cover.html")).href);
	await page.waitForTimeout(300);

	const patched = await page.evaluate((over) => {
		const pick = { ep: "--ep", titleMain: "--title", titleAccent: "--accent", lead: "--lead", chips: "--chips" };
		const applied = {};
		for (const k of Object.keys(pick)) if (over[k]) applied[k] = (state[k] = over[k]);
		renderCover(state);
		return applied;
	}, { ep: flag("ep", ""), titleMain: flag("title", ""), titleAccent: flag("accent", ""), lead: flag("lead", ""), chips: flag("chips", "") });
	if (Object.keys(patched).length) console.log(`已套用命令行覆盖：${JSON.stringify(patched)}`);

	let failed = false;
	for (const r of ratios) {
		await page.evaluate((cls) => {
			state.ratio = cls;
			renderCover(state);
		}, r === "16x9" ? "r-169" : "r-34");
		await page.waitForTimeout(150);
		const [wantW, wantH] = SIZE[r];
		const dataUrl = await page.evaluate((s) => window.__buildPng(s), scale);
		const buf = Buffer.from(dataUrl.split(",")[1], "base64");
		const [gotW, gotH] = pngSize(buf);
		const ep = await page.evaluate(() => state.ep);
		const out = path.join(DIR, `${ep.replace(/[^\w\u4e00-\u9fa5-]+/g, "")}_封面_${r}_${scale}x.png`);
		if (gotW !== wantW * scale || gotH !== wantH * scale) {
			// 先判定再落盘：尺寸不对就不写文件，避免拿错图去发
			console.error(`✗ ${r} 出图尺寸异常：期望 ${wantW * scale}x${wantH * scale}，实得 ${gotW}x${gotH}`);
			failed = true;
			continue;
		}
		fs.writeFileSync(out, buf);
		console.log(`已生成 ${out}（${gotW}x${gotH}）`);
	}
	await browser.close();
	if (pageErrors.length) {
		console.error(`✗ 封面页有 JS 报错，图不可信：\n  ${pageErrors.join("\n  ")}`);
		failed = true;
	}
	process.exit(failed ? 1 : 0);
})();
