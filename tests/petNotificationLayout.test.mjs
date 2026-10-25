import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadLayout() {
	const source = readFileSync("src/shared/petNotificationLayout.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const module = { exports: {} };
	vm.runInNewContext(
		outputText,
		{ module, exports: module.exports },
		{
			filename: "petNotificationLayout.ts",
		},
	);
	return module.exports;
}

const L = loadLayout();

test("effectiveUIFontSize falls back to global fontSize when uiFontSize is null", () => {
	assert.equal(L.effectiveUIFontSize(null, "large"), "large");
	assert.equal(L.effectiveUIFontSize("compact", "large"), "compact");
	assert.equal(L.effectiveUIFontSize(undefined, "medium"), "medium");
});

test("font size mapping matches foundation --font-size-control presets", () => {
	assert.equal(JSON.stringify(L.NOTIFICATION_FONT_SIZE_PX), JSON.stringify({ compact: 12, medium: 14, large: 15, xlarge: 16 }));
});

test("notification font size is independent of petScale", () => {
	const small = L.petLayout({ scale: 0.3, fontMode: "medium", notificationVisible: true });
	const large = L.petLayout({ scale: 2, fontMode: "medium", notificationVisible: true });
	assert.equal(small.fontSizePx, 14);
	assert.equal(large.fontSizePx, 14);
	// 精灵尺寸随 scale 变化
	assert.equal(small.spriteW, Math.round(192 * 0.3));
	assert.equal(large.spriteW, 384);
	assert.equal(large.spriteH, 416);
});

test("window grows when notification is visible and shrinks back when not", () => {
	const idle = L.petLayout({ scale: 1, fontMode: "medium", notificationVisible: false });
	const notif = L.petLayout({ scale: 1, fontMode: "medium", notificationVisible: true });
	assert.equal(idle.windowW, 192);
	assert.equal(idle.windowH, 208);
	assert.ok(notif.windowW > idle.windowW);
	assert.ok(notif.windowH > idle.windowH);
	// 气泡槽位：两行 21px + 上下 padding 16 + 描边 3
	assert.equal(notif.notificationSlotH, 21 * 2 + 16 + 3);
});

test("notification slot height follows the font mode", () => {
	const compact = L.petLayout({ scale: 1, fontMode: "compact", notificationVisible: true });
	const xlarge = L.petLayout({ scale: 1, fontMode: "xlarge", notificationVisible: true });
	assert.ok(xlarge.notificationSlotH > compact.notificationSlotH);
});

test("keepFeetCenter preserves the sprite feet center across layout changes", () => {
	// 普通布局：窗口 192x208 位于 (100, 800)，脚底中心 = (196, 1008)
	const from = { x: 100, y: 800, width: 192, height: 208 };
	const to = L.petLayout({ scale: 1, fontMode: "large", notificationVisible: true });
	const next = L.keepFeetCenter(from, { width: to.windowW, height: to.windowH });
	// 窗口尺寸为整数像素，脚底中心允许 ±1px 取整误差
	assert.ok(Math.abs(next.x + to.windowW / 2 - 196) <= 1, `feet x drift: ${next.x + to.windowW / 2}`);
	assert.ok(Math.abs(next.y + to.windowH - 1008) <= 1, `feet y drift: ${next.y + to.windowH}`);
});

test("toNormalLayoutPosition converts any layout position back to normal layout", () => {
	const notif = L.petLayout({ scale: 0.8, fontMode: "medium", notificationVisible: true });
	const normal = L.petLayout({ scale: 0.8, fontMode: "medium", notificationVisible: false });
	// 通知布局左上 (50, 300)，脚底中心 = (50 + notif.windowW/2, 300 + notif.windowH)
	const converted = L.toNormalLayoutPosition({ x: 50, y: 300 }, { width: notif.windowW, height: notif.windowH }, { width: normal.windowW, height: normal.windowH });
	// 换算后的普通布局脚底中心必须相同（允许 ±1px 取整误差）
	assert.ok(Math.abs(converted.x + normal.windowW / 2 - (50 + notif.windowW / 2)) <= 1, `feet x drift: ${converted.x + normal.windowW / 2}`);
	assert.ok(Math.abs(converted.y + normal.windowH - (300 + notif.windowH)) <= 1, `feet y drift: ${converted.y + normal.windowH}`);
});

test("clampToWorkArea keeps the whole window inside the work area", () => {
	const wa = { x: 0, y: 0, width: 1920, height: 1080 };
	// 越出右侧/底部
	const right = L.clampToWorkArea({ x: 1900, y: 1000, width: 300, height: 300 }, wa);
	assert.equal(right.x, 1920 - 300);
	assert.equal(right.y, 1080 - 300);
	// 越出左侧/顶部
	const left = L.clampToWorkArea({ x: -50, y: -30, width: 300, height: 300 }, wa);
	assert.equal(left.x, 0);
	assert.equal(left.y, 0);
	// 屏幕内位置不变
	const inside = L.clampToWorkArea({ x: 100, y: 100, width: 300, height: 300 }, wa);
	assert.equal(inside.x, 100);
	assert.equal(inside.y, 100);
});

test("scale is sanitized to a positive finite number", () => {
	const layout = L.petLayout({ scale: 0, fontMode: "medium", notificationVisible: false });
	assert.equal(layout.scale, 0.1);
	assert.ok(layout.spriteW >= 16);
});

// ═══ 气泡字体与分段排版 ═══

/** mock measure：每个字符宽 10px */
const measure = (t) => t.length * 10;

const zhStatus = (title, status) => L.layoutNotificationSegments(measure, title, status, 200, 2);

const kinds = (rows) => JSON.stringify(rows.map((row) => row.map((s) => s.kind).join("|")));
const texts = (rows) => JSON.stringify(rows.map((row) => row.map((s) => s.text).join("")));

test("petFontStack resolves PiDeck font presets", () => {
	assert.match(L.petFontStack("system", ""), /^-apple-system/);
	assert.match(L.petFontStack("sans", ""), /^"Inter"/);
	assert.match(L.petFontStack("serif", ""), /^Georgia/);
	// custom 使用用户字体，并追加 CJK 回退；空值回退默认栈
	const custom = L.petFontStack("custom", "MyFont, sans-serif");
	assert.match(custom, /^MyFont, sans-serif, "Microsoft YaHei UI"/);
	assert.match(custom, /"Noto Sans CJK SC", sans-serif$/);
	assert.match(L.petFontStack("custom", "  "), /^-apple-system/);
});

test("segments keep the status word on the same line with a leading gap", () => {
	const rows = zhStatus("会话一", "已完成");
	assert.equal(rows.length, 1);
	assert.equal(kinds(rows), JSON.stringify(["title|status"]));
	assert.equal(texts(rows), JSON.stringify(["会话一  已完成"]));
});

test("long titles wrap and the status word follows the last line", () => {
	const rows = zhStatus("这是一个非常长的会话标题用于测试换行行为", "已完成");
	assert.equal(rows.length, 2);
	assert.equal(kinds(rows), JSON.stringify(["title", "title|status"]));
	assert.equal(JSON.parse(texts(rows))[1].endsWith("已完成"), true);
});

test("overlong titles are clipped with an ellipsis within max lines", () => {
	// 40 字符：两行放不下（15+15+10），第二行截断加省略号
	const rows = zhStatus("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十", "已完成");
	assert.equal(rows.length, 2);
	const last = rows[1];
	assert.equal(last[0].text.endsWith("…"), true);
});

test("a status word wider than the bubble gets its own line", () => {
	const rows = zhStatus("会话一", "encountered a problem");
	assert.equal(rows.length, 2);
	assert.equal(kinds(rows), JSON.stringify(["title", "status"]));
});

test("empty title renders the status alone", () => {
	const rows = zhStatus("", "等待操作");
	assert.equal(rows.length, 1);
	assert.equal(kinds(rows), JSON.stringify(["status"]));
});

test("quoted titles keep the status word following on the same line", () => {
	const rows = zhStatus("“会话一”", "已完成");
	assert.equal(rows.length, 1);
	assert.equal(kinds(rows), JSON.stringify(["title|status"]));
	assert.equal(texts(rows), JSON.stringify(["“会话一”  已完成"]));
});
