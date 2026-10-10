// 改完 poster.html 后跑这个，重新生成成品图（2 倍图，2400px 宽）
// 用法：双击 重新生成图片.bat，或在命令行执行  node shot.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DIR = __dirname;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = path.join(DIR, "GPT充值价目表.png");
// 项目根 README 引用的那张：docs/images/ 是 README 与官网共用图的唯一数据源，改价后必须跟着刷新，否则 README 上挂着旧价
const ROOT_COPY = path.join(DIR, "..", "..", "docs", "images", "gpt-recharge-price.png");

(async () => {
	const browser = await chromium.launch(fs.existsSync(EDGE) ? { executablePath: EDGE } : { channel: "msedge" });
	const ctx = await browser.newContext({ viewport: { width: 1300, height: 2100 }, deviceScaleFactor: 2 });
	const page = await ctx.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e.message));
	await page.goto(pathToFileURL(path.join(DIR, "poster.html")).href);
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		window.removeEventListener("resize", window.fit);
		window.fit = () => {};
		const st = document.getElementById("stage");
		st.style.transform = "none";
		st.style.width = "auto";
		st.style.height = "auto";
		document.querySelector(".panel").style.display = "none";
		document.getElementById("poster").style.transform = "none"; // 预览自适应缩放不能带进出图
	});
	const box = await page.locator("#poster").boundingBox();
	// 先判定再落盘：海报页报错 / 尺寸为 0 时不能拿这张图去发
	if (pageErrors.length || !(box && box.width > 0 && box.height > 0)) {
		await browser.close();
		if (pageErrors.length) console.error(`✗ 海报页有 JS 报错，图不可信（未覆盖旧图）：\n  ${pageErrors.join("\n  ")}`);
		else console.error("✗ 海报渲染尺寸为 0（DEFAULT_STATE 可能被改坏了），未覆盖旧图");
		process.exit(1);
	}
	const dataUrl = await page.evaluate(() => window.__buildPng(2));
	fs.writeFileSync(OUT, Buffer.from(dataUrl.split(",")[1], "base64"));
	console.log(`已生成 ${OUT}（逻辑尺寸 ${box.width}x${box.height}，2 倍图 ${box.width * 2}x${box.height * 2}）`);
	if (fs.existsSync(path.dirname(ROOT_COPY))) {
		fs.copyFileSync(OUT, ROOT_COPY);
		console.log(`已同步根 README 用图 → ${ROOT_COPY}`);
	}
	await browser.close();
})();
