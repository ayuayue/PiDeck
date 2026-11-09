import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { makeSeedProject, openFirstSession } from "./open-session";

/**
 * Ask 批量提问卡的「跳过」矩阵 E2E（mock pi 真实 RPC）。
 *
 * 背景：批量卡新增「跳过此题」后，用户不确定「多题里跳过单个」会不会有意外
 * （整卡被跳过？已答内容丢失？跳过后位置错乱？）。这里按
 * 5 种题型（select / multi_select / confirm / input / editor）
 * × 单题/多题 × 作答/跳过/返回改答/审阅/关闭 展开，
 * 断言真正回传给 pi 的序列化 payload（而不是只看界面），
 * payload 从 mock pi 的流式回复里取出（`你选择了「MARKER」，答案：<JSON>`）。
 */

const askBar = (window: Page) => window.locator(".ask-inline-bar");
const timeline = (window: Page) => window.locator(".message-timeline");

/** 从回复文本里截取第一个完整的 JSON 对象（字符串内的花括号/转义不参与计数） */
function sliceJson(text: string, from: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = from; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(from, index + 1);
		}
	}
	return null;
}

type AskPayload = { cancelled?: boolean; answers?: Array<{ id: string; type: string; value: unknown; label?: string; wasCustom?: boolean; skipped?: boolean }> };

/** 读答复里本次 marker 对应的 payload；还没到就返回 null（配合 poll） */
async function readPayload(window: Page, marker: string): Promise<AskPayload | null> {
	const text = await window.evaluate(() => document.querySelector(".message-timeline")?.textContent ?? "");
	const anchor = `你选择了「${marker}」`;
	const at = text.lastIndexOf(anchor);
	if (at < 0) return null;
	const jsonStart = text.indexOf("{", text.indexOf("答案：", at));
	if (jsonStart < 0) return null;
	const json = sliceJson(text, jsonStart);
	if (!json) return null;
	try {
		return JSON.parse(json) as AskPayload;
	} catch {
		return null;
	}
}

async function waitPayload(window: Page, marker: string): Promise<AskPayload> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const payload = await readPayload(window, marker);
		if (payload) return payload;
		await window.waitForTimeout(200);
	}
	throw new Error(`没有等到 ${marker} 的答复`);
}

/** 关掉卡片后：payload 必须已经回传，且卡片从时间线移除 */
async function expectSubmitted(window: Page, marker: string) {
	const payload = await waitPayload(window, marker);
	await expect(askBar(window)).toHaveCount(0, { timeout: 10_000 });
	return payload;
}

/** 断言还没提交（等待一小段时间确认卡片仍在、会话没有新答复） */
async function expectNotSubmitted(window: Page, marker: string) {
	await window.waitForTimeout(1200);
	expect(await readPayload(window, marker)).toBeNull();
	await expect(askBar(window)).toHaveCount(1);
}

async function openAsk(window: Page, marker: string) {
	const composer = await openFirstSession(window);
	await composer.click();
	await window.keyboard.type(marker);
	await window.keyboard.press("Enter");
	await expect(askBar(window)).toBeVisible({ timeout: 15_000 });
	return askBar(window);
}

const activeTab = (window: Page) => askBar(window).locator('.ask-batch-tab[aria-selected="true"]');
const skipButton = (window: Page) => askBar(window).locator(".ask-batch-skip");
const body = (window: Page) => askBar(window).locator(".ask-batch-question-body");
const navNext = (window: Page) =>
	askBar(window)
		.locator("button", { hasText: /^(下一题|去审阅)$/ })
		.last();
const navPrev = (window: Page) => askBar(window).getByRole("button", { name: "上一题" });
const submitAll = (window: Page) => askBar(window).getByRole("button", { name: "提交", exact: true }).last();

test.use({ seedProjects: [makeSeedProject("ask-skip")] });

// ── A. 单题批次 × 5 题型：正常作答即提交 ────────────────────────────────
const ANSWER_CASES = [
	{
		name: "select",
		marker: "ASK_BATCH_ONE_SELECT",
		act: async (window: Page) => {
			await askBar(window).locator(".ask-inline-bar-option", { hasText: "甲" }).click();
		},
		expect: { id: "o1", type: "select", value: "甲", label: "甲", wasCustom: false },
	},
	{
		name: "multi_select",
		marker: "ASK_BATCH_ONE_MULTI",
		act: async (window: Page) => {
			await askBar(window).locator(".ask-inline-bar-option", { hasText: "A" }).click();
			await askBar(window).locator(".ask-inline-bar-option", { hasText: "C" }).click();
			await submitAll(window).click();
		},
		expect: { id: "o2", type: "multi_select", value: ["A", "C"], label: "A、C", wasCustom: false },
	},
	{
		name: "confirm",
		marker: "ASK_BATCH_ONE_CONFIRM",
		act: async (window: Page) => {
			await askBar(window).locator(".ask-inline-bar-option-yes").click();
		},
		expect: { id: "o3", type: "confirm", value: true, label: "是", wasCustom: false },
	},
	{
		name: "input",
		marker: "ASK_BATCH_ONE_INPUT",
		act: async (window: Page) => {
			await body(window).locator("input").fill("单题输入");
			await body(window).locator("input").press("Enter");
		},
		expect: { id: "o4", type: "input", value: "单题输入", label: "单题输入", wasCustom: false },
	},
	{
		name: "editor",
		marker: "ASK_BATCH_ONE_EDITOR",
		act: async (window: Page) => {
			await body(window).locator("textarea").fill("第一行\n第二行");
			await body(window).locator("textarea").press("Control+Enter");
		},
		expect: { id: "o5", type: "editor", value: "第一行\n第二行", label: "第一行\n第二行", wasCustom: false },
	},
];

for (const item of ANSWER_CASES) {
	test(`单题批次 ${item.name}：作答后一步提交`, async ({ window }) => {
		test.setTimeout(120_000);
		await openAsk(window, item.marker);
		await item.act(window);
		const payload = await expectSubmitted(window, item.marker);
		expect(payload.answers).toHaveLength(1);
		expect(payload.answers?.[0]).toMatchObject(item.expect);
		expect(payload.answers?.[0]?.skipped).toBeUndefined();
	});
}

// ── B. 单题批次 × 5 题型：跳过即提交 ───────────────────────────────────
for (const item of ANSWER_CASES) {
	test(`单题批次 ${item.name}：跳过即提交，payload 只标 skipped`, async ({ window }) => {
		test.setTimeout(120_000);
		await openAsk(window, item.marker);
		await skipButton(window).click();
		const payload = await expectSubmitted(window, item.marker);
		expect(payload.answers).toHaveLength(1);
		// 跳过的题一律 value=null、label 为空、带 skipped 标记（扩展据此区分「主动跳过」与「没答」）
		expect(payload.answers?.[0]).toEqual({ id: item.expect.id, type: item.expect.type, value: null, label: "", wasCustom: false, skipped: true });
	});
}

// ── C. 五题型混合：全部作答 ────────────────────────────────────────────
test("五题混合：全部作答后按题型回传", async ({ window }) => {
	test.setTimeout(120_000);
	await openAsk(window, "ASK_BATCH_MIX5");
	await expect(askBar(window).locator(".ask-batch-tab")).toHaveCount(5);

	await askBar(window).locator(".ask-inline-bar-option", { hasText: "React" }).click();
	await expect(activeTab(window)).toContainText("选择要启用的特性");
	await askBar(window).locator(".ask-inline-bar-option", { hasText: "日志" }).click();
	await askBar(window).locator(".ask-inline-bar-option", { hasText: "缓存" }).click();
	await navNext(window).click();
	await expect(activeTab(window)).toContainText("使用 TypeScript");
	await askBar(window).locator(".ask-inline-bar-option-yes").click();
	await expect(activeTab(window)).toContainText("项目名");
	await body(window).locator("input").fill("my-app");
	await body(window).locator("input").press("Enter");
	await expect(activeTab(window)).toContainText("备注");
	await body(window).locator("textarea").fill("说明文本");
	await body(window).locator("textarea").press("Control+Enter");

	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.cancelled).toBeUndefined();
	expect(payload.answers).toEqual([
		{ id: "m1", type: "select", value: "React", label: "React", wasCustom: false },
		{ id: "m2", type: "multi_select", value: ["日志", "缓存"], label: "日志、缓存", wasCustom: false },
		{ id: "m3", type: "confirm", value: true, label: "是", wasCustom: false },
		{ id: "m4", type: "input", value: "my-app", label: "my-app", wasCustom: false },
		{ id: "m5", type: "editor", value: "说明文本", label: "说明文本", wasCustom: false },
	]);
});

// ── D. 五题混合：跳过中间一题 ──────────────────────────────────────────
test("五题混合：跳过第 2 题，只有该题标 skipped，其余答案与顺序不变", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_MIX5");
	await bar.locator(".ask-inline-bar-option", { hasText: "React" }).click();
	// 第 2 题不答，直接跳过 → 自动进入第 3 题
	await skipButton(window).click();
	await expect(activeTab(window)).toContainText("使用 TypeScript");
	await expect(bar.locator(".ask-batch-tab.skipped")).toHaveCount(1);
	await expect(bar).toContainText("已完成 2/5");
	await bar.locator(".ask-inline-bar-option-yes").click();
	await body(window).locator("input").fill("my-app");
	await body(window).locator("input").press("Enter");
	await body(window).locator("textarea").fill("说明文本");
	await body(window).locator("textarea").press("Control+Enter");

	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.answers?.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
	expect(payload.answers?.[0]).toMatchObject({ value: "React" });
	expect(payload.answers?.[1]).toEqual({ id: "m2", type: "multi_select", value: null, label: "", wasCustom: false, skipped: true });
	expect(payload.answers?.[2]).toMatchObject({ value: true });
	expect(payload.answers?.[3]).toMatchObject({ value: "my-app" });
	expect(payload.answers?.[4]).toMatchObject({ value: "说明文本" });
});

// ── E. 跳过后返回改答：skipped 被清除 ──────────────────────────────────
test("五题混合：跳过第 1 题后回上一题作答，skipped 清除", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_MIX5");
	await skipButton(window).click();
	await expect(activeTab(window)).toContainText("选择要启用的特性");
	await navPrev(window).click();
	await expect(activeTab(window)).toContainText("选择框架");
	// 回到已跳过的题：跳过按钮呈「已跳过」按下态
	await expect(skipButton(window)).toHaveText("已跳过");
	await expect(skipButton(window)).toHaveAttribute("aria-pressed", "true");
	await bar.locator(".ask-inline-bar-option", { hasText: "Vue" }).click();
	await expect(bar.locator(".ask-batch-tab.skipped")).toHaveCount(0);

	await bar.locator(".ask-inline-bar-option", { hasText: "测试" }).click();
	await navNext(window).click();
	await bar.locator(".ask-inline-bar-option-no").click();
	await body(window).locator("input").fill("revisit");
	await body(window).locator("input").press("Enter");
	await body(window).locator("textarea").fill("改主意了");
	await body(window).locator("textarea").press("Control+Enter");

	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.answers?.some((item) => item.skipped)).toBe(false);
	expect(payload.answers?.[0]).toMatchObject({ id: "m1", value: "Vue" });
	expect(payload.answers?.[1]).toMatchObject({ value: ["测试"] });
	expect(payload.answers?.[2]).toMatchObject({ value: false, label: "否" });
});

// ── F. 跳过最后一题但前面还有未答：不提交，跳回未答题 ──────────────────
test("五题混合：跳过末题时前面有未答，卡片不提交并跳回第一道未答题", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_MIX5");
	await skipButton(window).click(); // 1 已跳过
	await navNext(window).click(); // 2 不答直接翻页
	await skipButton(window).click(); // 3 跳过
	await skipButton(window).click(); // 4 跳过
	await skipButton(window).click(); // 5 跳过（末题）→ 校验发现第 2 题未答

	// 不提交、卡片留在原地，并跳回第一道未答的第 2 题
	await expectNotSubmitted(window, "ASK_BATCH_MIX5");
	await expect(activeTab(window)).toContainText("选择要启用的特性");
	await expect(bar).toContainText("已完成 4/5");
	await expect(bar.locator(".ask-batch-tab.skipped")).toHaveCount(4);

	// 补答第 2 题后再跳到末题提交（第 2 题是多选，不会自动前进）
	await bar.locator(".ask-inline-bar-option", { hasText: "缓存" }).click();
	await bar.locator(".ask-batch-tab").last().click();
	await submitAll(window).click();
	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.answers).toHaveLength(5);
	expect(payload.answers?.[1]).toMatchObject({ id: "m2", value: ["缓存"] });
	expect(payload.answers?.filter((item) => item.skipped)).toHaveLength(4);
});

// ── G. 全部跳过 ────────────────────────────────────────────────────────
test("五题混合：逐题全部跳过仍可提交，payload 全为 skipped", async ({ window }) => {
	test.setTimeout(120_000);
	await openAsk(window, "ASK_BATCH_MIX5");
	for (let index = 0; index < 5; index += 1) await skipButton(window).click();

	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.answers?.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
	expect(payload.answers?.every((item) => item.skipped === true && item.value === null && item.label === "")).toBe(true);
});

// ── H. 跳过的题：输入框里留着的文字不算答案 ────────────────────────────
test("五题混合：输入框有未提交文字时点跳过，回传 skipped 而不是那段文字", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_MIX5");
	await bar.locator(".ask-inline-bar-option", { hasText: "React" }).click();
	await bar.locator(".ask-inline-bar-option", { hasText: "日志" }).click();
	await navNext(window).click();
	await bar.locator(".ask-inline-bar-option-yes").click();
	await body(window).locator("input").fill("typed-but-skipped");
	await skipButton(window).click();
	await body(window).locator("textarea").fill("末题");
	await body(window).locator("textarea").press("Control+Enter");

	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.answers?.[3]).toEqual({ id: "m4", type: "input", value: null, label: "", wasCustom: false, skipped: true });
	expect(JSON.stringify(payload)).not.toContain("typed-but-skipped");
});

// ── I. 多选回车不推进 ──────────────────────────────────────────────────
test("五题混合：多选勾选后按回车不提交也不前进，焦点在选项上回车只会切换勾选", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_MIX5");
	await bar.locator(".ask-inline-bar-option", { hasText: "React" }).click();
	await bar.locator(".ask-inline-bar-option", { hasText: "日志" }).click();
	await bar.locator(".ask-inline-bar-option", { hasText: "缓存" }).click();
	// 焦点还在「缓存」上：回车走按钮原生 click（取消勾选），绝不把「勾了一个」当成答完而跳题
	await window.keyboard.press("Enter");
	await expect(activeTab(window)).toContainText("选择要启用的特性");
	await expect(bar.locator(".ask-inline-bar-option.selected", { hasText: "日志" })).toHaveCount(1);
	await expect(bar.locator(".ask-inline-bar-option.selected", { hasText: "缓存" })).toHaveCount(0);
	await expectNotSubmitted(window, "ASK_BATCH_MIX5");

	// 重新勾上再继续
	await bar.locator(".ask-inline-bar-option", { hasText: "缓存" }).click();
	await navNext(window).click();
	await bar.locator(".ask-inline-bar-option-yes").click();
	await body(window).locator("input").fill("enter-guard");
	await body(window).locator("input").press("Enter");
	await body(window).locator("textarea").fill("ok");
	await body(window).locator("textarea").press("Control+Enter");
	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.answers?.[1]).toMatchObject({ value: ["日志", "缓存"] });
});

// ── J. 审阅模式：跳过的题在审阅页显示「已跳过」 ────────────────────────
test("审阅模式：跳过末题进入审阅页，显示已跳过并可一次提交", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_REVIEW");
	await expect(bar.locator(".ask-batch-tab--review")).toHaveCount(1);
	await bar.locator(".ask-inline-bar-option", { hasText: "甲" }).click();
	await bar.locator(".ask-inline-bar-option", { hasText: "A" }).click();
	await navNext(window).click();
	await skipButton(window).click();

	// 末题跳过 → 审阅页（不是直接提交）
	await expect(bar.locator(".ask-batch-tab--review")).toHaveAttribute("aria-selected", "true");
	await expect(bar).toContainText("确认全部回答");
	await expect(bar).toContainText("已跳过");
	await expect(submitAll(window)).toBeEnabled();
	await submitAll(window).click();

	const payload = await expectSubmitted(window, "ASK_BATCH_REVIEW");
	expect(payload.answers).toEqual([
		{ id: "r1", type: "select", value: "甲", label: "甲", wasCustom: false },
		{ id: "r2", type: "multi_select", value: ["A"], label: "A", wasCustom: false },
		{ id: "r3", type: "editor", value: null, label: "", wasCustom: false, skipped: true },
	]);
});

// ── K. 审阅模式：跳过不等于「全答完」────────────────────────────────────
test("审阅模式：跳过一题但另一题未答时，审阅页提交禁用并提示未答", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_REVIEW");
	await skipButton(window).click(); // r1 跳过
	await navNext(window).click(); // r2 不答翻页
	await skipButton(window).click(); // r3 跳过 → 审阅页

	await expect(bar).toContainText("还有题目未回答");
	await expect(submitAll(window)).toBeDisabled();
	await expectNotSubmitted(window, "ASK_BATCH_REVIEW");

	// 回到 r2 补答；从题目页直接点「提交审阅」回到审阅页（不是「下一题」）
	await bar.locator(".ask-batch-tab", { hasText: "审阅多选" }).click();
	await bar.locator(".ask-inline-bar-option", { hasText: "B" }).click();
	await bar.locator(".ask-batch-tab--review").click();
	await expect(submitAll(window)).toBeEnabled();
	await submitAll(window).click();
	const payload = await expectSubmitted(window, "ASK_BATCH_REVIEW");
	expect(payload.answers?.[0]).toMatchObject({ skipped: true });
	expect(payload.answers?.[1]).toMatchObject({ value: ["B"] });
});

// ── L. 跳过 + 关闭：取消包里保留 skipped 标记 ──────────────────────────
test("五题混合：跳过后关闭卡片，取消包同时保留 skipped 与已答内容", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_MIX5");
	await skipButton(window).click();
	// 第 2 题是多选（不会自动前进），答完再「下一题」到第 3 题 confirm
	await bar.locator(".ask-inline-bar-option", { hasText: "日志" }).click();
	await navNext(window).click();
	await bar.locator(".ask-inline-bar-option-yes").click();
	await bar.getByRole("button", { name: "关闭" }).click();

	const payload = await expectSubmitted(window, "ASK_BATCH_MIX5");
	expect(payload.cancelled).toBe(true);
	expect(payload.answers).toHaveLength(5);
	expect(payload.answers?.[0]).toMatchObject({ id: "m1", skipped: true, value: null });
	expect(payload.answers?.[1]).toMatchObject({ id: "m2", value: ["日志"] });
	expect(payload.answers?.[2]).toMatchObject({ id: "m3", value: true });
	// 没答的题保持 null 且不带 skipped
	expect(payload.answers?.[3]).toMatchObject({ id: "m4", value: null });
	expect(payload.answers?.[3]?.skipped).toBeUndefined();
});

// ── M. 两题：跳过第一个再答第二个 ──────────────────────────────────────
test("两题批次：跳过第 1 题、作答第 2 题，顺序与标记都对", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_TWO");
	await skipButton(window).click();
	await expect(activeTab(window)).toContainText("再输入");
	// 用 placeholder 定位：切题有退场动画，直接 body input 可能命中上一题（select 的自定义输入框）
	const secondInput = body(window).locator('input[placeholder="文本"]');
	await secondInput.fill("后半段答案");
	// input 文字要按回车/点本题提交才算作答，底部「提交」在未答完时是禁用的
	await secondInput.press("Enter");
	const payload = await expectSubmitted(window, "ASK_BATCH_TWO");
	expect(payload.answers).toEqual([
		{ id: "t1", type: "select", value: null, label: "", wasCustom: false, skipped: true },
		{ id: "t2", type: "input", value: "后半段答案", label: "后半段答案", wasCustom: false },
	]);
});

// ── N. 单题 select 自定义输入：wasCustom 标记与自动提交 ────────────────
test("单题批次 select：自定义输入提交后带 wasCustom，且一步完成", async ({ window }) => {
	test.setTimeout(120_000);
	await openAsk(window, "ASK_BATCH_ONE_SELECT");
	await body(window).locator("input").fill("自定义值");
	await body(window).getByRole("button", { name: "提交" }).click();
	const payload = await expectSubmitted(window, "ASK_BATCH_ONE_SELECT");
	expect(payload.answers?.[0]).toEqual({ id: "o1", type: "select", value: "自定义值", label: "自定义值", wasCustom: true });
});

// ── O. select 自定义输入后跳过：跳过压过未提交文字 ────────────────────
test("单题批次 select：输入自定义内容后点跳过，回传 skipped 而不是自定义文本", async ({ window }) => {
	test.setTimeout(120_000);
	await openAsk(window, "ASK_BATCH_ONE_SELECT");
	await body(window).locator("input").fill("自定义但不提交");
	await skipButton(window).click();
	const payload = await expectSubmitted(window, "ASK_BATCH_ONE_SELECT");
	expect(payload.answers?.[0]).toEqual({ id: "o1", type: "select", value: null, label: "", wasCustom: false, skipped: true });
	expect(JSON.stringify(payload)).not.toContain("自定义但不提交");
});

// ── P. 预填题跳过：预填不能被当成答案交回 ────────────────────────────
test("预填批次：跳过带 prefill 的题，payload 不含预填文本", async ({ window }) => {
	test.setTimeout(120_000);
	const bar = await openAsk(window, "ASK_BATCH_PREFILL");
	// p2（editor，prefill）是末题：跳过它时 p1 还没答 → 不提交，跳回 p1
	await bar.locator(".ask-batch-tab", { hasText: "备注" }).click();
	await skipButton(window).click();
	await expect(activeTab(window)).toContainText("选择框架");
	await expectNotSubmitted(window, "ASK_BATCH_PREFILL");

	await bar.locator(".ask-inline-bar-option", { hasText: "Vue" }).click();
	// 答完 p1 会落到已跳过的末题（非审阅模式只在末题出现整卡提交）
	await expect(activeTab(window)).toContainText("备注");
	await submitAll(window).click();
	const payload = await expectSubmitted(window, "ASK_BATCH_PREFILL");
	expect(payload.answers).toEqual([
		{ id: "p1", type: "select", value: "Vue", label: "Vue", wasCustom: false },
		{ id: "p2", type: "editor", value: null, label: "", wasCustom: false, skipped: true },
	]);
	expect(JSON.stringify(payload)).not.toContain("预填的默认备注");
});
