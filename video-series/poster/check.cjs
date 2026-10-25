// 验证：面板改价生效、导出 PNG 与原生渲染逐像素一致
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = "file:///" + path.join(DIR, "poster.html").replace(/\\/g, "/");
let fails = 0;
const ok = (cond, label, extra) => {
	console.log((cond ? "  PASS " : "  FAIL ") + label + (extra ? "  " + extra : ""));
	if (!cond) fails++;
};

(async () => {
	const browser = await chromium.launch(fs.existsSync(EDGE) ? { executablePath: EDGE } : { channel: "msedge" });
	const ctx = await browser.newContext({ viewport: { width: 1300, height: 2100 }, deviceScaleFactor: 1 });
	const page = await ctx.newPage();
	const errs = [];
	page.on("pageerror", (e) => errs.push(e.message));
	await page.goto(URL);
	await page.waitForTimeout(300);

	// 预览区自适应：缩放（transform）要加在海报自己身上——加在 .stage 上会被 stage 的 overflow:hidden
	// 先在「未缩放的本坐标系」里裁掉超出部分，用户看到的就是海报的左上一角（2027-02 实测事故）
	const geo = await page.evaluate(() => {
		const r = (id) => {
			const b = document.getElementById(id).getBoundingClientRect();
			return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
		};
		return { preview: r("preview"), stage: r("stage"), poster: r("poster") };
	});
	const inside =
		geo.poster.x >= geo.preview.x - 1 &&
		geo.poster.y >= geo.preview.y - 1 &&
		geo.poster.x + geo.poster.w <= geo.preview.x + geo.preview.w + 1 &&
		geo.poster.y + geo.poster.h <= geo.preview.y + geo.preview.h + 1;
	// stage 是 overflow:hidden 的裁切盒，海报的可视矩形必须落在它视觉矩形内（否则看到的是被裁剩的左上一角）
	const notClipped =
		geo.poster.x >= geo.stage.x - 1 &&
		geo.poster.y >= geo.stage.y - 1 &&
		geo.poster.x + geo.poster.w <= geo.stage.x + geo.stage.w + 1 &&
		geo.poster.y + geo.poster.h <= geo.stage.y + geo.stage.h + 1;
	ok(inside && notClipped && geo.poster.w < 1200, "预览里海报完整可见（缩放后未被 overflow 裁掉）", JSON.stringify(geo));

	// 换几种真实窗口尺寸再验一遍：任何尺寸下都必须「完整可见 + 不被裁 + 不至于小到看不清」
	const measure = () =>
		page.evaluate(() => {
			const b = (id) => document.getElementById(id).getBoundingClientRect();
			const pv = b("preview"), st = b("stage"), po = b("poster");
			const inBox = (a, c) => a.x >= c.x - 1 && a.y >= c.y - 1 && a.right <= c.right + 1 && a.bottom <= c.bottom + 1;
			return { pw: Math.round(po.width), ph: Math.round(po.height), inside: inBox(po, pv), notClipped: inBox(po, st), panel: Math.round(b("panel").width) };
		});
	for (const [vw, vh] of [[1024, 700], [1440, 860], [1600, 1000]]) {
		await page.setViewportSize({ width: vw, height: vh });
		await page.waitForTimeout(120);
		const m = await measure();
		ok(m.inside && m.notClipped && m.pw >= 400 && m.panel >= 300, `窗口 ${vw}x${vh} 预览完整可见且可读`, JSON.stringify(m));
	}
	await page.setViewportSize({ width: 1300, height: 2100 });
	await page.waitForTimeout(120);

	// 冻住预览缩放（fit 之后关掉）：预览里 #poster 带 scale，量尺寸/截图/导出都得先清掉
	const freeze = () =>
		page.evaluate(() => {
			window.removeEventListener("resize", window.fit);
			window.fit = () => {};
			const st = document.getElementById("stage");
			st.style.transform = "none";
			st.style.width = "auto";
			st.style.height = "auto";
			document.getElementById("poster").style.transform = "none";
		});

	await freeze();
	ok(errs.length === 0, "页面无 JS 报错", errs.join("|"));
	ok((await page.locator("#poster").boundingBox()).width === 1200, "海报宽度 1200px");
	ok((await page.locator(".footnote").innerText()).includes("发票"), "底部发票小字渲染出来了");

	// 0) 源码里不许再出现成本 / 毛利字段（售价海报，公开仓库也不能带成本）
	const src = fs.readFileSync(path.join(DIR, "poster.html"), "utf8");
	ok(!/cost|毛利|拿货|profit/i.test(src), "poster.html 无成本/毛利字段");

	// 1) 改主价 → 海报跟着变；面板里不再有成本输入
	await page.fill('[data-path="hero.price"]', "158");
	await page.waitForTimeout(80);
	ok((await page.locator(".hero-price .num").innerText()).trim() === "158", "改主价 → 海报同步");
	const panelText = await page.locator("#panel").innerText();
	ok(!/拿货|成本|毛利/.test(panelText), "面板无拿货价/毛利输入");

	// 2) 清空价格 → 显示“询价”
	await page.fill('[data-path="hero.price"]', "");
	await page.waitForTimeout(80);
	ok((await page.locator(".hero-price .num").innerText()).trim() === "询价", "清空价格 → 显示询价");

	// 3) 四位数自动缩小字号
	await page.fill('[data-path="hero.price"]', "1388");
	await page.waitForTimeout(80);
	ok(await page.locator(".hero-price .num").evaluate((el) => el.classList.contains("d4")), "四位数自动套 d4 字号");

	// 4) 条目增删
	await page.reload();
	await page.waitForTimeout(250);
	await freeze();
	await page.click('button[data-act="addItem"]');
	await page.waitForTimeout(80);
	ok((await page.locator(".items li").count()) === 3, "加一行 → 海报 3 行");
	await page.click('button[data-act="delItem"][data-i="0"]');
	await page.waitForTimeout(80);
	ok((await page.locator(".items li").count()) === 2, "删一行 → 海报 2 行");
	ok(!(await page.locator(".items").innerText()).includes("Claude"), "删掉的是 Claude 那行");

	// 5) 长文本不溢出（把最长的条目名加长后再量卡片是否横向溢出）
	await page.fill('[data-path="items.0.name"]', "Claude pro成品号（超稳）（超长测试超长测试超长测试超长测试）");
	await page.waitForTimeout(80);
	const overflow = await page.evaluate(() => {
		const p = document.getElementById("poster");
		return { pw: p.scrollWidth, cw: p.clientWidth, ph: p.offsetHeight };
	});
	ok(overflow.pw <= overflow.cw + 1, "长文案不横向溢出", JSON.stringify(overflow));

	// 6) 导出图 vs 原生渲染逐像素比对（1 倍图，省内存）
	await page.reload();
	await page.waitForTimeout(250);
	await freeze();
	await page.evaluate(() => {
		document.querySelector(".panel").style.display = "none";
	});
	const native = path.join(DIR, "_native.png");
	await page.locator("#poster").screenshot({ path: native });
	const exportUrl = await page.evaluate(() => window.__buildPng(1));
	const exportPath = path.join(DIR, "_export.png");
	fs.writeFileSync(exportPath, Buffer.from(exportUrl.split(",")[1], "base64"));
	const diff = await page.evaluate(
		async ([a, b]) => {
			const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
			const [ia, ib] = await Promise.all([load(a), load(b)]);
			if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: [ia.width, ia.height, ib.width, ib.height] };
			const data = (img, w, h) => { const cv = document.createElement("canvas"); cv.width = w || img.width; cv.height = h || img.height; const g = cv.getContext("2d"); g.drawImage(img, 0, 0, cv.width, cv.height); return g.getImageData(0, 0, cv.width, cv.height).data; };
			// 缩略必须按比例缩（曾把高度写死 → 海报一改高就纵向拉伸，出现假阳性差异），并用高质量重采样让边缘抗锯齿平均掉
			const thumb = (img) => { const w = Math.round(img.width / 8); const h = Math.round(img.height / 8); const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
			const stat = (da, db) => { let sum = 0, max = 0, bad = 0, n = 0; for (let i = 0; i < da.length; i += 4) for (let k = 0; k < 3; k++) { const d = Math.abs(da[i + k] - db[i + k]); sum += d; if (d > max) max = d; if (d > 60) bad++; n++; } return { mean: +(sum / n).toFixed(3), max, bad60Pct: +((bad / n) * 100).toFixed(4) }; };
			// 全尺寸：只剩文字边缘抗锯齿差异（屏幕用次像素抗锯齿、SVG 导出用灰度）→ mean 应极小
			const full = stat(data(ia), data(ib));
			// 1/8 缩略：抗锯齿被平均掉，任何「元素丢失 / 错位」都会现形
			const small = stat(thumb(ia), thumb(ib));
			return { full, small };
		},
		["data:image/png;base64," + fs.readFileSync(native).toString("base64"), exportUrl]
	);
	console.log("  diff:", JSON.stringify(diff));
	ok(!diff.sizeMismatch, "导出图尺寸与原生一致");
	// 阈值依据（_probe 实测，2026-xx 校准）：同一状态只有文字边缘抗锯齿差异 → full mean 0.47 / bad 0.16%，small mean 0.25 / bad 0%；
	// 真结构性差异：导出漏一行成品号 → small 0.61 / 0.31%，价格未跟上面板 → small 1.14 / 0.58%。阈值卡在两者之间。
	ok(!diff.sizeMismatch && diff.full.mean < 1 && diff.full.bad60Pct < 0.3, "导出图与原生渲染像素级一致", JSON.stringify(diff.full));
	ok(diff.small && diff.small.mean < 0.5 && diff.small.bad60Pct < 0.25, "缩略图结构完全一致（无元素丢失/错位）", JSON.stringify(diff.small));

	const big = await page.evaluate(() => window.__buildPng(2));
	const dims = await page.evaluate(
		(u) => new Promise((r) => { const i = new Image(); i.onload = () => r([i.width, i.height]); i.src = u; }),
		big
	);
	const box2 = await page.locator("#poster").boundingBox();
	ok(dims[0] === box2.width * 2 && Math.abs(dims[1] - box2.height * 2) <= 2, "2 倍图 = 逻辑尺寸 ×2", `${dims.join("x")} vs ${box2.width * 2}x${box2.height * 2}`);

	await browser.close();
	fs.unlinkSync(native); fs.unlinkSync(exportPath);
	console.log(fails === 0 ? "\n全部通过" : `\n${fails} 项失败`);
	process.exit(fails === 0 ? 0 : 1);
})();
