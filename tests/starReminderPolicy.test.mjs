/**
 * GitHub Star 提醒（utils/starReminderPolicy.ts + hooks/useStarReminder.ts）。
 *
 * 守护的是「克制」本身：这条提示是营销性质，一旦条件松动就会退化成每天开工先被要一次
 * Star 的骚扰。所以把「用满一天」「本次运行满 15 分钟」「一天最多一次」「不再提醒永久生效」
 * 逐条钉成单测，行为侧再用源码断言守住装配与按钮语义。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

// 纯判定模块无运行时 import（只用类型），vm 沙箱直接加载
function loadPolicy() {
	const sandbox = { exports: {} };
	vm.runInNewContext(transpile("src/renderer/src/utils/starReminderPolicy.ts"), sandbox, {
		filename: "starReminderPolicy.ts",
	});
	return sandbox.exports;
}

const policy = loadPolicy();
const NOW = 1_800_000_000_000; // 固定「现在」，避免测试依赖真实时钟
const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;

/** 满足全部唤醒条件的上下文（各用例只改动一个维度）。 */
function readyContext(overrides = {}) {
	return {
		state: { dismissed: false, firstSeenAt: NOW - 3 * DAY, lastShownAt: 0 },
		now: NOW,
		uptimeMs: 30 * MINUTE,
		blocked: false,
		...overrides,
	};
}

// vm 沙箱产出的对象属于另一个 realm，deepStrictEqual 会因原型不同而失败，统一先摊平成宿主对象
const parse = (raw) => ({ ...policy.parseStarReminderState(raw, NOW) });
const FRESH = { dismissed: false, firstSeenAt: NOW, lastShownAt: 0 };

test("parse：首次读取用 now 作为 firstSeenAt，lastShownAt 记 0（从未弹过）", () => {
	assert.deepEqual(parse(null), FRESH);
});

test("parse：坏 JSON / 非对象一律回落默认，不抛错（localStorage 里的残留脏数据）", () => {
	assert.deepEqual(parse("{not json"), FRESH);
	assert.deepEqual(parse('"text"'), FRESH);
	assert.deepEqual(parse("null"), FRESH);
});

test("parse：脏字段逐项回落（dismissed 只认 true，时间戳只认有限正数）", () => {
	const parsed = parse(JSON.stringify({ dismissed: "yes", firstSeenAt: -5, lastShownAt: Number.NaN }));
	assert.deepEqual(parsed, FRESH);
	assert.equal(policy.parseStarReminderState(JSON.stringify({ dismissed: true }), NOW).dismissed, true);
	assert.equal(policy.parseStarReminderState(JSON.stringify({ lastShownAt: "yesterday" }), NOW).lastShownAt, 0);
});

test("parse：未来时间戳（时钟回拨/手动改表）封顶到 now，否则会永久不再提醒", () => {
	const parsed = policy.parseStarReminderState(JSON.stringify({ firstSeenAt: NOW + 10 * DAY, lastShownAt: NOW + 10 * DAY }), NOW);
	assert.equal(parsed.firstSeenAt, NOW);
	assert.equal(parsed.lastShownAt, NOW);
});

test("shouldPrompt：条件齐备才提醒", () => {
	assert.equal(policy.shouldPromptStarReminder(readyContext()), true);
});

test("shouldPrompt：点过「不再提醒」/「去点 Star」后永久静默", () => {
	const state = { dismissed: true, firstSeenAt: NOW - 10 * DAY, lastShownAt: 0 };
	assert.equal(policy.shouldPromptStarReminder(readyContext({ state })), false);
});

test("shouldPrompt：首次使用不满一天不提醒（新用户当天安装当天不被打扰）", () => {
	const state = { dismissed: false, firstSeenAt: NOW - DAY + MINUTE, lastShownAt: 0 };
	assert.equal(policy.shouldPromptStarReminder(readyContext({ state })), false);
	// 刚好满一天就允许
	assert.equal(policy.shouldPromptStarReminder(readyContext({ state: { ...state, firstSeenAt: NOW - DAY } })), true);
});

test("shouldPrompt：本次运行不满 15 分钟不提醒（不在启动期抢注意力）", () => {
	assert.equal(policy.shouldPromptStarReminder(readyContext({ uptimeMs: 14 * MINUTE })), false);
	assert.equal(policy.shouldPromptStarReminder(readyContext({ uptimeMs: 15 * MINUTE })), true);
});

test("shouldPrompt：一天最多一次——24 小时内弹过就跳过，满 24 小时才允许再弹", () => {
	const state = { dismissed: false, firstSeenAt: NOW - 10 * DAY, lastShownAt: NOW - DAY + MINUTE };
	assert.equal(policy.shouldPromptStarReminder(readyContext({ state })), false);
	assert.equal(policy.shouldPromptStarReminder(readyContext({ state: { ...state, lastShownAt: NOW - DAY } })), true);
});

test("shouldPrompt：模态框打开 / 窗口不在前台时顺延（blocked），不丢提醒", () => {
	assert.equal(policy.shouldPromptStarReminder(readyContext({ blocked: true })), false);
});

test("nextStarReminderCheckDelayMs：最多睡 5 分钟就复查一次，且不会 0 延迟自旋", () => {
	const { STAR_REMINDER_POLL_INTERVAL_MS: poll, STAR_REMINDER_MIN_CHECK_MS: floor } = policy;
	assert.equal(policy.nextStarReminderCheckDelayMs(0), poll);
	assert.equal(policy.nextStarReminderCheckDelayMs(10 * MINUTE), poll);
	assert.equal(policy.nextStarReminderCheckDelayMs(30 * MINUTE), poll);
	assert.equal(policy.nextStarReminderCheckDelayMs(-10 * MINUTE), poll);
	// 距 15 分钟不足下限时按 floor 睡（避免性能时钟抖动算出 0）
	assert.equal(policy.nextStarReminderCheckDelayMs(15 * MINUTE - 100), floor);
});

// ── 行为侧（hook + 装配）：源码断言，模式与 agentLoadNotice / archMismatchNotice 契约测试一致 ──
test("useStarReminder 挂载在 App，且判定走纯函数（不把条件散落在 hook 里）", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const hook = readFileSync("src/renderer/src/hooks/useStarReminder.ts", "utf8");
	assert.match(app, /useStarReminder\(\)/);
	assert.match(hook, /shouldPromptStarReminder\(/);
	assert.match(hook, /parseStarReminderState\(/);
	// 记账先落盘再弹：同一天不会因为崩溃/退出重播
	const writeIndex = hook.indexOf("writeStarReminderState(state);");
	const showIndex = hook.indexOf("showNotice(");
	assert.ok(writeIndex > 0 && showIndex > writeIndex, "lastShownAt 必须在弹出之前落盘");
});

test("useStarReminder：toast 双按钮语义 = 去 Star（系统浏览器 + 永久静默）+ 不再提醒（永久静默）", () => {
	const hook = readFileSync("src/renderer/src/hooks/useStarReminder.ts", "utf8");
	assert.match(hook, /t\("starReminder\.title"\)/);
	assert.match(hook, /t\("starReminder\.desc"\)/);
	assert.match(hook, /label: t\("starReminder\.action"\)/);
	assert.match(hook, /label: t\("starReminder\.dismiss"\)/);
	// 主按钮必须走系统浏览器（用户在浏览器里已登录 GitHub，才能一键 Star）
	assert.match(hook, /openExternal\(STAR_REMINDER_URL, true\)/);
	// 两个按钮都把提醒关掉：点过 Star 就不再打扰，按钮文案之外没有别的判定
	assert.equal(hook.match(/state = \{ \.\.\.state, dismissed: true \};/g)?.length, 1);
	assert.match(hook, /markHandled\(\);/);
	// 粘性 toast（全局 toast 时长会被设置覆盖，只有 Infinity 表示常驻）+ 60s 自动收起
	assert.match(hook, /Number\.POSITIVE_INFINITY/);
	assert.match(hook, /dismissNotice\(noticeId\), STAR_REMINDER_AUTO_DISMISS_MS/);
});

test("Star 目标地址取 shared 的仓库坐标（改名不会指向旧仓库）", () => {
	// 运行时断言：直接调生产函数。旧版读源码正则，只能证明「字符串出现在文件里」，
	// 证明不了拼出来的地址是对的（协议、owner/repo 对调、多余斜杠都能骗过它）。
	const { gitHubReleasesBase } = loadTsCommonJs("src/shared/updateSources.ts");
	assert.equal(gitHubReleasesBase(), "https://github.com/ayuayue/PiDeck");
});

test("i18n：四个键在中英词典里都有、非空，且不是把 key 当译文（zh-TW 由生成器跟随）", () => {
	// 运行时断言：旧版正则只证明键名出现在源码里，值为空串、或直接把 key 抄成译文都能通过。
	const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const key of ["starReminder.title", "starReminder.desc", "starReminder.action", "starReminder.dismiss"]) {
		assert.ok(zhCN[key]?.trim(), `zh-CN 缺或空 ${key}`);
		assert.ok(enUS[key]?.trim(), `en-US 缺或空 ${key}`);
		assert.notEqual(zhCN[key], key, `zh-CN 把 key 当译文 ${key}`);
		assert.notEqual(enUS[key], key, `en-US 把 key 当译文 ${key}`);
	}
});
