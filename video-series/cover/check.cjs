// 封面自检：node check.cjs
// 覆盖两类最容易出事的点：① 导出路径与浏览器原生渲染是否一致（导出只带 #cover-style，
// 漏一条布局规则就会出现「预览正常、出图右边被裁」）② 两种比例下内容是否溢出画布。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DIR = __dirname;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SIZE = { "r-169": [1920, 1080], "r-34": [1080, 1440] };
let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
	console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${info ? `  ${info}` : ""}`);
	cond ? pass++ : fail++;
};

/** 用 Playwright 元素截图拿「原生渲染」基准，再和 __buildPng 的导出图做缩略图比对 */
async function compareWithNative(page) {
	const shot = await page.locator("#cover").screenshot();
	return page.evaluate(
		async (shotUrl) => {
			const load = (src) => new Promise((res, rej) => {
				const i = new Image();
				i.onload = () => res(i);
				i.onerror = () => rej(new Error("load fail"));
				i.src = src;
			});
			const native = await load(shotUrl);
			const exported = await load(await window.__buildPng(1));
			const w = 240;
			const h = Math.round((w * native.height) / native.width);
			const pixels = (img) => {
				const c = document.createElement("canvas");
				c.width = w;
				c.height = h;
				c.getContext("2d").drawImage(img, 0, 0, w, h);
				return (c.getContext("2d").getImageData(0, 0, w, h) || {}).data;
			};
			const a = pixels(native);
			const b = pixels(exported);
			let sum = 0;
			let bad = 0;
			const n = a.length / 4;
			for (let i = 0; i < a.length; i += 4) {
				const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
				sum += d;
				if (d > 60) bad++;
			}
			return { mean: +(sum / n).toFixed(2), badPct: +((bad / n) * 100).toFixed(2), native: [native.width, native.height], exported: [exported.width, exported.height] };
		},
		"data:image/png;base64," + shot.toString("base64")
	);
}

(async () => {
	const browser = await chromium.launch(fs.existsSync(EDGE) ? { executablePath: EDGE } : { channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 2100, height: 1550 }, deviceScaleFactor: 1 });
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e.message));
	const file = pathToFileURL(path.join(DIR, "cover.html")).href;
	await page.goto(file);
	await page.waitForTimeout(300);
	// 去掉预览自适应缩放 + 隐藏右侧面板，保证元素截图拿到的是 1:1 原图
	await page.evaluate(() => {
		window.__fitReal = window.fit;
		window.fit = () => {};
		document.querySelector(".panel").style.display = "none";
		const c = document.getElementById("cover");
		c.style.transform = "none";
	});

	console.log("封面自检");
	ok("页面无 JS 报错", pageErrors.length === 0, pageErrors.join(" | "));

	for (const [cls, [w, h]] of Object.entries(SIZE)) {
		const r = await page.evaluate(async (c) => {
			state.ratio = c;
			renderCover(state);
			document.getElementById("cover").style.transform = "none";
			const box = document.getElementById("cover").getBoundingClientRect();
			const coverRect = box;
			const out = [...document.querySelectorAll("#cover *")]
				.filter((el) => !el.closest("svg"))
				.map((el) => {
					const x = el.getBoundingClientRect();
					return { t: el.className || el.tagName, dx: Math.round(Math.max(x.right - coverRect.right, coverRect.left - x.left)), dy: Math.round(Math.max(x.bottom - coverRect.bottom, coverRect.top - x.top)) };
				})
				.filter((o) => o.dx > 1 || o.dy > 1);
			const png = await window.__buildPng(1);
			const img = new Image();
			await new Promise((res) => {
				img.onload = res;
				img.src = png;
			});
			return { box: [Math.round(box.width), Math.round(box.height)], out: out.slice(0, 5), exp: [img.width, img.height] };
		}, cls);
		ok(`${cls} 画布尺寸 = ${w}×${h}`, r.box[0] === w && r.box[1] === h, `实得 ${r.box.join("×")}`);
		ok(`${cls} 导出图像素 = ${w}×${h}`, r.exp[0] === w && r.exp[1] === h, `实得 ${r.exp.join("×")}`);
		ok(`${cls} 无元素溢出画布`, r.out.length === 0, JSON.stringify(r.out));
	}

	// 导出保真度：这条能抓住「预览正常、出图被裁/掉样式」的整类问题。
	// 阈值经验值（实测）：本底噪声 mean 1.5（16:9）/ 4.0（3:4）、bad60Pct ≤ 0.6，
	// 来自文字抗锯齿 + 缩略图缩放的差异；真出问题（漏 box-sizing 导致右侧裁掉）时
	// bad60Pct 会顶到 ~3.9%、mean ~7.5——所以以 bad60Pct 为主判据。
	for (const cls of Object.keys(SIZE)) {
		await page.evaluate((c) => {
			state.ratio = c;
			renderCover(state);
			document.getElementById("cover").style.transform = "none";
		}, cls);
		await page.waitForTimeout(120);
		const d = await compareWithNative(page);
		ok(`${cls} 导出图与原生渲染一致`, d.mean < 6 && d.badPct < 2, `mean=${d.mean} bad60Pct=${d.badPct} native=${d.native.join("×")} export=${d.exported.join("×")}`);
	}

	// 文字与参数化
	const t = await page.evaluate(() => {
		state.ep = "EP99 · 自检";
		state.titleAccent = "自检标题";
		state.chips = "A, B";
		renderCover(state);
		const c = document.getElementById("cover");
		return { ep: c.querySelector(".ep-tag").textContent, h1: c.querySelector("h1").textContent, chips: c.querySelectorAll(".chip").length };
	});
	ok("改期数/标题/标签即时生效", t.ep === "EP99 · 自检" && t.h1.includes("自检标题") && t.chips === 2, JSON.stringify(t));

	// 预览模式：面板让位后封面要按整窗重算（不改 fit 的话会停在窄栏尺寸上）
	const pvBefore = await page.evaluate(() => {
		document.querySelector(".panel").style.display = "";
		window.fit = window.__fitReal;
		/* 上个用例停在 3:4（1080 宽），竖版在窄栏里也是 1:1 缩放，量不出适配差异——先换回 16:9 */
		state.ratio = "r-169";
		renderCover(state);
		return Math.round(document.getElementById("stage").getBoundingClientRect().width);
	});
	await page.click("#previewBtn");
	await page.waitForTimeout(150);
	const pvIn = await page.evaluate(() => ({
		panel: getComputedStyle(document.querySelector(".panel")).display === "none",
		exit: getComputedStyle(document.getElementById("exitPreview")).display !== "none",
		width: Math.round(document.getElementById("stage").getBoundingClientRect().width)
	}));
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	const pvOut = await page.evaluate(() => ({
		panel: getComputedStyle(document.querySelector(".panel")).display !== "none",
		exit: getComputedStyle(document.getElementById("exitPreview")).display === "none"
	}));
	ok("预览模式：隐藏面板并整窗适配，Esc 退回", pvIn.panel && pvIn.exit && pvIn.width > pvBefore && pvOut.panel && pvOut.exit, `stage ${pvBefore}→${pvIn.width}px`);

	// 示意面板行编辑：增行 / 改值 / 上下移 / 删行都必须即时进画布
	const rowsTest = await page.evaluate(() => {
		const rowCount = () => document.querySelectorAll("#cover .mock__rows li").length;
		const values = () => [...document.querySelectorAll("#cover .mock__rows .v")].map((el) => el.textContent);
		const before = rowCount();
		state.rows = state.rows.slice(0, 3); // 先瘦到 3 行，好验位移
		renderCover(state);
		renderPanel();
		document.querySelector('[data-act="add"]').click();
		const added = rowCount();
		const lastVal = document.querySelector(".row__v:last-of-type");
		const inp = [...document.querySelectorAll(".row__v")].pop();
		inp.value = "自检行";
		inp.dispatchEvent(new Event("input", { bubbles: true }));
		const typed = values().pop();
		document.querySelector('[data-act="down"][data-i="0"]').click();
		const moved = values()[1];
		document.querySelector('[data-act="del"][data-i="0"]').click();
		return { before, added, typed, moved, afterDel: rowCount() };
	});
	ok("示意面板可增行/改值/下移/删行", rowsTest.added === 4 && rowsTest.typed === "自检行" && rowsTest.moved === "供应商与密钥" && rowsTest.afterDel === 3, JSON.stringify(rowsTest));

	// 行数多时必须自动等比缩小，不能撑破画布
	const fitTest = await page.evaluate(() => {
		state.ratio = "r-169";
		state.rows = Array.from({ length: 14 }, (_, i) => ({ k: `K${i}`, v: `条目 ${i}`, s: "已配置" }));
		renderCover(state);
		const c = document.getElementById("cover").getBoundingClientRect();
		const m = document.querySelector("#cover .mock").getBoundingClientRect();
		return { over: Math.round(Math.max(m.bottom - c.bottom, c.top - m.top)), scale: document.querySelector("#cover .mock").style.transform };
	});
	ok("14 行时示意面板自动缩小且不溢出画布", fitTest.over <= 1 && fitTest.scale.startsWith("scale"), JSON.stringify(fitTest));

	// 导出路径的前提：只用系统字体、无外链图片（否则导出掉字/丢图）
	const src = fs.readFileSync(path.join(DIR, "cover.html"), "utf8");
	ok("无 @font-face（导出不依赖网络字体）", !/@font-face/.test(src));
	ok("无外链图片引用", !/<img|url\(["']?https?:/.test(src));

	await browser.close();
	console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 项）`);
	process.exit(fail === 0 ? 0 : 1);
})();
