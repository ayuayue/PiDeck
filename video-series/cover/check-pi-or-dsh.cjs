// Pi Or Dsh 封面自检：node check-pi-or-dsh.cjs
// 覆盖两类最容易出事的点：① 导出路径与浏览器原生渲染是否一致（导出只带 #cover-style，
// 漏一条布局规则就会出现「预览正常、出图右边被裁」）② 两种比例下内容是否溢出画布。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DIR = __dirname;
const FILE = "pi-or-dsh.html";
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
			/* 1/8 缩略图：只看结构（元素是否丢失/错位），不看文字抗锯齿 */
			const w = Math.round(native.width / 8);
			const h = Math.round((w * native.height) / native.width);
			const pixels = (img) => {
				const c = document.createElement("canvas");
				c.width = w;
				c.height = h;
				c.getContext("2d").drawImage(img, 0, 0, w, h);
				return c.getContext("2d").getImageData(0, 0, w, h).data;
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
	await page.goto(pathToFileURL(path.join(DIR, FILE)).href);
	await page.waitForTimeout(300);
	// 去掉预览自适应缩放 + 隐藏右侧面板，保证元素截图拿到的是 1:1 原图
	await page.evaluate(() => {
		window.__fitReal = window.fit;
		window.fit = () => {};
		document.querySelector(".panel").style.display = "none";
		document.getElementById("cover").style.transform = "none";
	});

	console.log("Pi Or Dsh 封面自检");
	ok("页面无 JS 报错", pageErrors.length === 0, pageErrors.join(" | "));

	for (const [cls, [w, h]] of Object.entries(SIZE)) {
		const r = await page.evaluate(async (c) => {
			state.ratio = c;
			renderCover(state);
			document.getElementById("cover").style.transform = "none";
			const box = document.getElementById("cover").getBoundingClientRect();
			const out = [...document.querySelectorAll("#cover *")]
				.filter((el) => !el.closest("svg"))
				.map((el) => {
					const x = el.getBoundingClientRect();
					return { t: el.className || el.tagName, dx: Math.round(Math.max(x.right - box.right, box.left - x.left)), dy: Math.round(Math.max(x.bottom - box.bottom, box.top - x.top)) };
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
	// 阈值经验值（实测）：1/8 缩略图 mean ≈1.4（16:9）/2.5（3:4）、bad60Pct ≤0.3——
	// 全部集中在等宽小字（品牌行/右上标签/✓ 胶囊/页脚）的字形边缘，成因是
	// 元素截图走 LCD 次像素抗锯齿、导出走 SVG 图像素抗锯齿，与 check.cjs 同源；
	// 真出问题（漏 box-sizing 导致右侧裁掉）时 bad60Pct 会顶到 ~3.9%、mean ~7.5。
	for (const cls of Object.keys(SIZE)) {
		await page.evaluate((c) => {
			state.ratio = c;
			renderCover(state);
			document.getElementById("cover").style.transform = "none";
		}, cls);
		await page.waitForTimeout(120);
		const d = await compareWithNative(page);
		ok(`${cls} 导出图与原生渲染结构一致`, d.badPct < 1 && d.mean < 6, `mean=${d.mean} bad60Pct=${d.badPct} native=${d.native.join("×")} export=${d.exported.join("×")}`);
	}

	// 文案与两个 logo 都要真的进画布
	const t = await page.evaluate(() => {
		state.ratio = "r-169";
		state.qMain = "自检问句？";
		state.answer = "自检落点";
		renderCover(state);
		const c = document.getElementById("cover");
		return {
			q: c.querySelector("h1 .q").textContent,
			a: c.querySelector("h1 .a").textContent,
			tiles: c.querySelectorAll(".vs .rt").length,
			logos: c.querySelectorAll(".vs .rt__logo svg").length,
			ok: [...c.querySelectorAll(".rt__ok")].map((el) => el.textContent).join("/")
		};
	});
	ok("改问句/落点即时生效", t.q === "自检问句？" && t.a === "自检落点", JSON.stringify({ q: t.q, a: t.a }));
	ok("两张运行时卡 + 两个 logo 都在", t.tiles === 2 && t.logos === 2, JSON.stringify({ tiles: t.tiles, logos: t.logos }));

	// 导出路径的前提：只用系统字体、无外链图片（否则导出掉字/丢图）
	const src = fs.readFileSync(path.join(DIR, FILE), "utf8");
	ok("无 @font-face（导出不依赖网络字体）", !/@font-face/.test(src));
	ok("无外链图片引用", !/<img|url\(["']?https?:/.test(src));

	await browser.close();
	console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（${pass} 项）`);
	process.exit(fail === 0 ? 0 : 1);
})();
