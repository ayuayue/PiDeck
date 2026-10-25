/**
 * PiDeck EP01 v4 · 逐帧探针。
 * 从公开 DOM 断言「影片真的在讲 v4 的事」：pi-tui 像素 logo、真实会话=Tab、
 * 真实分屏、真实浮动球，以及三张知识卡。所有采样时刻都落在元素的可见窗口内。
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = "file:///" + path.join(here, "film.html").replace(/\\/g, "/");
const shotDir = path.join(here, "verify");
fs.rmSync(shotDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

/** 断言：[t, 描述, fn] */
const PROBES = [
	[1.6, "像素 logo 10 个彩色格已落位", () => {
		const lit = [...document.querySelectorAll("#pixgrid .pc")]
			.filter((e) => +e.style.opacity > 0.5 && e.style.background).length;
		return lit === 10 ? "" : `彩色格 ${lit}，应为 10`;
	}],
	[4.0, "冷开场第二句已换词", () => +document.querySelector("#oh2").style.opacity > 0.5 ? "" : "oh2 不在场"],
	[7.0, "像素网格已展开成窗口四乘四栅格", () => {
		const c = document.querySelector("#pixgrid .pc");
		/* 值里逗号后有空格，正则必须空白容忍 */
		const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+),\s*([\d.]+)\)/.exec(c.style.transform);
		if (!m) return "没有 transform: " + JSON.stringify(c.style.transform);
		if (+m[3] < 2) return `格子还没展开 (scaleX=${m[3]})`;
		return "";
	}],
	[9.0, "窗口 UI 已在场、像素网格已让位", () => {
		if (+document.querySelector("#tabbar").style.opacity < 0.8) return "tabbar 不在场";
		if (+document.querySelector("#pixgrid .pc").style.opacity > 0.2) return "像素格还压在窗口上";
		return "";
	}],
	[12.0, "侧栏 5 条会话都在场", () => {
		const n = [...document.querySelectorAll(".sess")].filter((e) => +e.style.opacity > 0.7).length;
		return n === 5 ? "" : `只有 ${n} 条`;
	}],
	[12.5, "ComposerStatsLine 在 composer 下方（真实标签）", () => {
		const s = document.querySelector("#stats");
		if (+s.style.opacity < 0.7) return "stats 不在场";
		if (!/First token 28\.0s/.test(s.textContent)) return "stats 文案不是真实的 ComposerStatsLine 标签";
		return "";
	}],
	[13.0, "字幕 C1 在场", () => +document.querySelector("#cap0").style.opacity > 0.6 ? "" : "C1 不在场"],
	[17.0, "第 1 个 Tab 已开（点侧栏会话）", () => {
		const tb = document.querySelector("#tb1");
		if (+tb.style.opacity < 0.8) return "tb1 不在场";
		return +document.querySelector("#tb2").style.opacity < 0.5 ? "" : "tb2 应该还没开";
	}],
	[18.0, "正在打字", () => /把这期宣传片/.test(document.querySelector("#ctext").textContent) ? "" : "输入框是空的"],
	[19.9, "发送后 Tab 1 的 spinner 还在（后台继续跑）", () =>
		+document.querySelector("#tb1 .trun").style.opacity > 0.6 ? "" : "Tab 1 停了"],
	[22.2, "5 个 Tab 全部打开且各自在转（后端下拉已收）", () => {
		if (+document.querySelector("#bkmenu").style.opacity > 0.2) return "后端下拉还开着，会盖住 Tab 栏";
		const tb = [...document.querySelectorAll(".tab")];
		if (tb.filter((e) => +e.style.opacity > 0.8).length !== 5) return "不是 5 个 Tab 在场";
		if (tb.filter((e) => +e.querySelector(".trun").style.opacity > 0.6).length !== 5) return "不是 5 个 spinner 在转";
		const rots = tb.map((e) => e.querySelector(".trun").style.transform);
		if (new Set(rots).size !== 5) return "5 个 spinner 角度相同 = 同步闪，不真实";
		return "";
	}],
	[22.4, "侧栏 5 个状态点都是琥珀色（bg-warning）", () => {
		const d = [...document.querySelectorAll(".sess .dot")];
		if (d.filter((e) => e.style.background === "rgb(251, 191, 36)").length !== 5) return "状态点颜色不对";
		return "";
	}],
	[22.5, "字幕 C3 在场", () => +document.querySelector("#cap2").style.opacity > 0.6 ? "" : "C3 不在场"],
	[23.6, "相机推到标签栏（特写距离）", () => {
		const z = +/scale\(([\d.]+)\)/.exec(document.querySelector("#world").style.transform)[1];
		return z > 1.8 ? "" : `z=${z.toFixed(2)}，没推近`;
	}],
	[25.6, "项目行出现 bg-warning 点 + 原生 tooltip", () => {
		if (+document.querySelector("#pdot").style.opacity < 0.5) return "项目行没有运行点";
		const tp = document.querySelector("#projtip");
		if (+tp.style.opacity < 0.6) return "tooltip 不在场";
		if (tp.textContent.trim() !== "此工作区有会话在运行") return "tooltip 文案不对";
		return "";
	}],
	[28.2, "拖拽落点预览 + 被拖的 Tab 跟着光标（真实分屏放置提示）", () => {
		const g = document.querySelector("#dropghost");
		if (g.style.display !== "flex") return "拖拽中但没有落点预览";
		if (+g.style.opacity < 0.5) return "落点预览不可见";
		const dt = document.querySelector("#dragtab");
		if (dt.style.display !== "flex") return "没有跟着光标的被拖 Tab";
		if (+dt.style.opacity < 0.5) return "被拖 Tab 不可见";
		return "";
	}],
	[29.6, "分屏成立：左右两栏各有独立的运行 spinner", () => {
		if (+document.querySelector("#split").style.opacity < 0.85) return "分屏没出现";
		if (+document.querySelector("#timeline").style.opacity > 0.2) return "单会话视图还没让位";
		const sd = [...document.querySelectorAll(".sphead .sd")];
		if (sd.length !== 2) return "不是两栏";
		const rots = sd.map((e) => e.style.transform);
		if (rots[0] === rots[1]) return "两栏 spinner 同角度 = 不独立";
		return "";
	}],
	[31.6, "拖动分隔条改变了 pane 宽度", () => {
		const w = parseFloat(document.querySelector("#spL").style.width);
		return w > 560 ? "" : `spL 宽度 ${w}，分隔条没生效`;
	}],
	[34.5, "浮动球计数在爬", () => {
		const n = +document.querySelector("#fcount").textContent;
		return n >= 1 && n <= 5 ? "" : `计数值 ${n}`;
	}],
	[37.0, "浮动球计到 5 且 Running 5", () => {
		const n = +document.querySelector("#fcount").textContent;
		if (n !== 5) return `计数停在 ${n}`;
		if (document.querySelector("#flabel").textContent.trim() !== "Running 5") return "标签文案不对";
		return "";
	}],
	[40.0, "终端滑入 + 真实 git 输出开始流入", () => {
		if (+document.querySelector("#term").style.opacity < 0.9) return "终端没进来";
		if (!/git status/.test(document.querySelector("#termbody").textContent)) return "没有命令";
		if (document.querySelectorAll("#termbody .tout").length < 1) return "输出没流入";
		return "";
	}],
	[41.0, "右侧真实改动文件在级联", () => {
		const n = [...document.querySelectorAll("#ftree .frow")].filter((e) => +e.style.opacity > 0.7).length;
		return n >= 5 ? "" : `只显示了 ${n} 行`;
	}],
	[42.8, "提交按钮已按下并回写", () => {
		if (document.querySelector("#commitbtn span").textContent !== "已暂存") return "提交没有生效";
		return "";
	}],
	[43.0, "字幕 C6 在场", () => +document.querySelector("#cap5").style.opacity > 0.6 ? "" : "C6 不在场"],
	[47.6, "知识卡 1：Pi vs DSH 两张卡都在场", () => {
		if (+document.querySelector("#card1").style.opacity < 0.85) return "card1 不在场";
		if (+document.querySelector("#piCard").style.opacity < 0.8) return "Pi 卡不在场";
		if (+document.querySelector("#dshCard").style.opacity < 0.8) return "DSH 卡不在场";
		return "";
	}],
	[49.5, "知识卡 1：真实事实（pi --mode rpc / utilityProcess）", () => {
		const txt = document.querySelector("#card1").textContent;
		if (!/pi --mode rpc/.test(txt)) return "缺 Pi 的运行方式";
		if (!/utilityProcess/.test(txt)) return "缺 DSH 的运行方式";
		if (!/\$DSH_HOME/.test(txt)) return "缺 DSH 的会话存储";
		return "";
	}],
	[50.0, "知识卡 1：逐行对滑高亮", () => document.querySelectorAll(".row2.hi").length >= 1 ? "" : "没有高亮行"],
	[56.0, "知识卡 2：裸终端堆 + 对照文案", () => {
		if (+document.querySelector("#card2").style.opacity < 0.85) return "card2 不在场";
		const st = [...document.querySelectorAll("#rawstack .termstack")];
		if (st.filter((e) => +e.style.opacity > 0.3).length < 4) return "终端窗口没堆起来";
		if (+document.querySelector("#decklbl").style.opacity < 0.5) return "PiDeck 侧文案不在场";
		return "";
	}],
	[62.0, "无像素 logo（v3 的假总览页已删除）", () =>
		document.querySelectorAll("#pixgrid .gp, #grid5").length === 0 ? "" : "还留着五格总览页"],
	[64.0, "知识卡 3：11 个导入来源都在场", () => {
		const n = [...document.querySelectorAll("#chipwrap .chip")].filter((e) => +e.style.opacity > 0.7).length;
		return n === 11 ? "" : `只显示了 ${n} 个`;
	}],
	[66.5, "导入来源逐个变成已导入态", () => {
		const n = document.querySelectorAll("#chipwrap .chip.done").length;
		return n >= 6 ? "" : `只有 ${n} 个转为已导入`;
	}],
	[70.5, "数字卡：1714 / 42 / 11 / 1", () => {
		if (+document.querySelector("#card4").style.opacity < 0.85) return "card4 不在场";
		if (document.querySelector("#n1v").textContent !== "1,714") return "模型条目不是 1,714";
		if (document.querySelector("#n2v").textContent !== "42") return "provider 不是 42";
		if (document.querySelector("#n3v").textContent !== "11") return "导入来源不是 11";
		if (document.querySelector("#n4v").textContent !== "1") return "进程数不是 1";
		return "";
	}],
	[74.0, "收束：6 个能力 chip 都在场", () => {
		const n = [...document.querySelectorAll("#card5 .rc")].filter((e) => +e.style.opacity > 0.7).length;
		return n === 6 ? "" : `只有 ${n} 个 chip`;
	}],
	[77.0, "窗口已塌回像素 tile", () => {
		const s = document.querySelector("#shape");
		if (parseFloat(s.style.width) > 320) return `宽度还是 ${s.style.width}`;
		if (+document.querySelector("#tile").style.opacity < 0.5) return "tile 不在场";
		return "";
	}],
	[78.4, "尾板：wordmark + 像素 logo 回来了 + 双仓库链接", () => {
		if (+document.querySelector("#word").style.opacity < 0.8) return "wordmark 不在场";
		const lit = [...document.querySelectorAll("#pixgrid .pc")].filter((e) => +e.style.opacity > 0.5 && e.style.background).length;
		if (lit !== 10) return `尾板只有 ${lit} 个彩色格（栅格淡回没生效）`;
		if (!/atomgit/.test(document.querySelector("#links").textContent)) return "缺仓库链接";
		return "";
	}],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(file);
await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
await page.evaluate(() => { window.__seekRender = true; });

const asserts = [];
for (const [t, label, fn] of PROBES) {
	await page.evaluate((tt) => window.__seek(tt), t);
	const bad = await page.evaluate(fn);
	asserts.push({ t, label, bad });
	if (bad) console.log(`  FAIL ${t.toFixed(2)}s  ${label}\n        ${bad}`);
}

/** mean luma of a png via ffmpeg rawvideo gray — catches the "seek renders black" bug */
function grayOf(file) {
	const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
		maxBuffer: 1 << 28,
	});
	let sum = 0;
	for (let i = 0; i < raw.length; i++) sum += raw[i];
	return sum / raw.length;
}

/* 关键帧截图 + 灰度门禁（黑色帧会静默假绿） */
const SHOT_TIMES = [1.6, 6.4, 11.5, 17.9, 21.0, 23.6, 25.6, 28.4, 29.8, 34.5, 37.0, 40.6, 47.8, 50.0, 56.5, 64.0, 70.5, 74.0, 78.9];
let minGray = 999;
for (const t of SHOT_TIMES) {
	await page.evaluate((tt) => window.__seek(tt), t);
	const out = path.join(shotDir, "v4_" + String(t).replace(".", "_") + ".png");
	await page.screenshot({ path: out });
	const g = grayOf(out);
	if (g < minGray) minGray = g;
	console.log(`  shot t=${t.toFixed(2)}s  灰度 ${g.toFixed(2)}`);
}

const failed = asserts.filter((a) => a.bad);
console.log(`\n${asserts.length} 条断言，失败 ${failed.length}`);
if (errors.length) {
	console.log(`\npageerror ${errors.length} 条:`);
	for (const e of errors) console.log(`  ${e}`);
}
console.log(`截图最低灰度 ${minGray.toFixed(2)}（阈值 9）`);
if (failed.length || errors.length || minGray < 9) process.exit(1);
console.log("PASS");
process.exit(0);
