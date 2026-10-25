/**
 * Ask 选择框「点击被吞」反馈循环驱动（diagnosing-bugs Phase 1）。
 * 运行：node_modules/.bin/electron tests/fixtures/ask-click-driver.cjs
 *
 * 通过 sendInputEvent 走真实 Chromium 输入管线（非合成 Selection API），
 * 在 ask-click-fixture.html 上测量各交互序列下 hasTextSelection() 守卫
 * 是否吞掉点击。退出码：0 = 未复现（绿），1 = 复现点击被吞（红）。
 */
"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	await app.whenReady();
	const win = new BrowserWindow({
		width: 900,
		height: 700,
		show: true, // 真实渲染管线；offscreen 可能影响 selection 语义真实性
		webPreferences: { zoomFactor: 1 },
	});
	await win.loadFile(path.join(__dirname, "ask-click-fixture.html"));
	const wc = win.webContents;
	wc.focus();
	await sleep(300);

	const q = (expr) => wc.executeJavaScript(`window.__query(${JSON.stringify(expr)})`);
	const dump = () => wc.executeJavaScript("window.__dump()");
	const evl = (code) => wc.executeJavaScript(code);
	const selection = () => wc.executeJavaScript("window.getSelection().toString()");

	/** 真实输入：down [+move 拖动] + up。clickCount 传 2 模拟双击。 */
	async function click(x, y, opts = {}) {
		const { clickCount = 1, dragDx = 0, dragDy = 0 } = opts;
		await wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount });
		if (dragDx || dragDy) {
			const steps = 4;
			for (let i = 1; i <= steps; i++) {
				await wc.sendInputEvent({
					type: "mouseMove",
					x: x + Math.round((dragDx * i) / steps),
					y: y + Math.round((dragDy * i) / steps),
				});
				await sleep(20);
			}
		}
		await wc.sendInputEvent({
			type: "mouseUp",
			x: x + dragDx,
			y: y + dragDy,
			button: "left",
			clickCount,
		});
		await sleep(100);
	}

	async function clickEl(sel, opts = {}) {
		const pos = await q(sel);
		if (!pos) throw new Error(`selector not found: ${sel}`);
		await click(pos.x, pos.y, opts);
		return pos;
	}

	const reset = () =>
		evl(`window.__state.checked["opt-0"]=false; window.__state.toggled["opt-0"]=0;
         window.__state.swallowed["opt-0"]=0; window.__state.swallowed["opt-1"]=0;
         document.getElementById("opt-0").classList.remove("selected");
         window.getSelection().removeAllRanges(); true;`);

	/** 场景前快照：verdict 用增量而不是绝对值，避免跨场景计数累积误报 */
	const snap = async () => {
		const d = await dump();
		return { sw: d.swallowed["opt-0"] + d.swallowed["opt-1"], tg: d.toggled["opt-0"] };
	};

	const R = {};

	// S0: user-select 计算值审计（验证复刻保真度 + 找出选区来源）
	R.S0_userSelect = await evl(`(() => ({
    button: getComputedStyle(document.getElementById("opt-0")).userSelect,
    labelSpan: getComputedStyle(document.getElementById("opt-0-label")).userSelect,
    title: getComputedStyle(document.getElementById("question-title")).userSelect,
  }))()`);

	// S1 基线：干净状态精确单击 → 期望 toggled=1（环境健全性）
	let before = await snap();
	await clickEl("#opt-0");
	R.S1_baseline = await dump();
	R.S1_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	await reset();

	// S2 按钮上微拖单击（模拟手抖 4px）：选区是否产生？点击是否被吞？
	before = await snap();
	await clickEl("#opt-0", { dragDx: 4, dragDy: 0 });
	R.S2_microDrag = await dump();
	R.S2_selectionAfter = await selection();
	R.S2_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	// S3 残留选区下再精确单击：守卫是否持续吞点击（症状核心）
	before = await snap();
	await clickEl("#opt-0");
	R.S3_steadyState = await dump();
	R.S3_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	// S4 用户 workaround：点空白处再精确单击 → 是否恢复
	before = await snap();
	await click(30, 30); // stage padding 空白区
	R.S4_selectionAfterEmptyClick = await selection();
	await clickEl("#opt-0");
	R.S4_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	await reset();

	// S5 修复验证：旧选区残留后精确按压选项 → 必须放行（旧守卫在此误吞 = 用户 bug）
	before = await snap();
	const title = await q("#question-title");
	await click(title.left + 5, title.y, { dragDx: title.w - 10, dragDy: 0 });
	R.S5_selectionAfterTitleDrag = await selection();
	await clickEl("#opt-0");
	R.S5_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	await reset();

	// S6 双击标题选词 → 单击选项：日常「双击选词」后选项必须可点（旧守卫误吞）
	before = await snap();
	const tpos = await q("#question-title");
	await click(tpos.x, tpos.y, { clickCount: 2 });
	R.S6_selectionAfterDblClick = await selection();
	await clickEl("#opt-0");
	R.S6_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	// S6b 双击选项按钮本身：急躁连点是否产生选区并让后续点击失灵
	before = await snap();
	await clickEl("#opt-0", { clickCount: 2 });
	R.S6b_selectionAfterDblClickOnOption = await selection();
	await clickEl("#opt-0");
	R.S6b_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	// S9 守卫本职：从标题拖选、mouseup 落在选项按钮上（冒充 click）→ 必须仍被吞
	before = await snap();
	const t2 = await q("#question-title");
	const o2 = await q("#opt-0");
	// 分段拖动：起点标题，途经空白，终点按钮中心（mouseup 在按钮上）
	await wc.sendInputEvent({ type: "mouseDown", x: t2.left + 5, y: t2.y, button: "left", clickCount: 1 });
	for (let i = 1; i <= 6; i++) {
		await wc.sendInputEvent({
			type: "mouseMove",
			x: Math.round(t2.left + 5 + ((o2.x - t2.left - 5) * i) / 6),
			y: Math.round(t2.y + ((o2.y - t2.y) * i) / 6),
		});
		await sleep(20);
	}
	await wc.sendInputEvent({ type: "mouseUp", x: o2.x, y: o2.y, button: "left", clickCount: 1 });
	await sleep(120);
	R.S9_selectionAfterDragToOption = await selection();
	R.S9_delta = { tg: (await snap()).tg - before.tg, sw: (await snap()).sw - before.sw };

	// S7 失焦/回焦对选区的影响（用户 workaround 的另一种解释）
	await reset();
	await evl(`(() => { const t = document.getElementById("question-title");
    const r = t.getBoundingClientRect();
    window.__titleRect = r; return true; })()`);
	const tr = { x: Math.round((await q("#question-title")).left + 5), y: (await q("#question-title")).y };
	await click(tr.x, tr.y, { dragDx: 100, dragDy: 0 });
	const beforeBlur = await selection();
	win.blur();
	await sleep(150);
	win.focus();
	await sleep(150);
	const afterBlurFocus = await selection();
	R.S7_blurRefocus = { beforeBlur, afterBlurFocus };

	// 汇总判定（修复后）：
	// - S5/S6 旧选区路径必须放行（修复点）；S1 基线必须健康
	// - S9 冒充 click 观察：Chromium click 派发语义下拖选 mouseup 落在按钮上不会
	//   给按钮发 click（mousedown/mouseup 共同祖先才发 click），实测 tg=0/sw=0；
	//   若未来 click 意外触发且守卫未吞（tg>0 && sw==0）才是真回归
	R.VERDICT = {
		S1_baseline_ok: R.S1_baseline_ok ?? (R.S1_delta.tg === 1 && R.S1_delta.sw === 0),
		S5_staleSelection_stillSwallowed_BUG: R.S5_delta.sw > 0,
		S6_dblClickWord_stillSwallowed_BUG: R.S6_delta.sw > 0,
		S9_impersonatedClick_clickFired: R.S9_delta.tg > 0,
		S9_impersonatedClick_leaked: R.S9_delta.tg > 0 && R.S9_delta.sw === 0,
	};
	R.VERDICT.RED_bugReproduced = R.VERDICT.S5_staleSelection_stillSwallowed_BUG || R.VERDICT.S6_dblClickWord_stillSwallowed_BUG || R.VERDICT.S9_impersonatedClick_leaked || !R.VERDICT.S1_baseline_ok;

	console.log("=== ASK-CLICK FEEDBACK LOOP RESULT ===");
	console.log(JSON.stringify(R, null, 2));
	app.exit(R.VERDICT.RED_bugReproduced ? 1 : 0);
}

main().catch((err) => {
	console.error("driver failed:", err);
	app.exit(2);
});
