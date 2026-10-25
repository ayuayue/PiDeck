import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const probe = loadTsCommonJs("src/main/config/providerUsageProbe.ts");

const ensureVersion = (url) => (url.includes("/v1") ? url : `${url.replace(/\/+$/, "")}/v1`);

/** 线上真实成功响应形状（general 桶 5h 窗剩 99%、周窗剩 99%，video 桶单独一行）。 */
const LIVE = {
	model_remains: [
		{
			start_time: 1785164400000,
			end_time: 1785182400000,
			remains_time: 1877492,
			current_interval_total_count: 0,
			current_interval_usage_count: 0,
			model_name: "general",
			current_weekly_total_count: 0,
			current_weekly_usage_count: 0,
			weekly_start_time: 1785110400000,
			weekly_end_time: 1785715200000,
			weekly_remains_time: 534677492,
			current_interval_status: 1,
			current_interval_remaining_percent: 99,
			current_weekly_status: 1,
			current_weekly_remaining_percent: 99,
		},
		{
			start_time: 1785110400000,
			end_time: 1785196800000,
			remains_time: 16277492,
			current_interval_total_count: 3,
			current_interval_usage_count: 0,
			model_name: "video",
			current_weekly_total_count: 21,
			current_weekly_usage_count: 0,
			weekly_start_time: 1785110400000,
			weekly_end_time: 1785715200000,
			weekly_remains_time: 534677492,
			current_interval_status: 1,
			current_interval_remaining_percent: 100,
			current_weekly_status: 1,
			current_weekly_remaining_percent: 100,
		},
	],
	base_resp: { status_code: 0, status_msg: "success" },
};

const parse = (body) => probe.parseUsageResponseBody(body, JSON.stringify(body), { kind: "custom", resolver: "minimax-plan" });

test("MiniMax：剩余百分比反转为已用（99% 剩余 → 1% 已用），并带重置时间", () => {
	const res = parse(LIVE);
	assert.equal(res.matched, true);
	assert.equal(res.kind, "periods");
	assert.equal(res.periods.rolling.percent, 1);
	assert.equal(res.periods.weekly.percent, 1);
	assert.equal(res.periods.rolling.resetsAt, new Date(1785182400000).toISOString());
	assert.equal(res.periods.weekly.resetsAt, new Date(1785715200000).toISOString());
});

test("MiniMax：只取 general 桶，video 桶不参与展示", () => {
	const res = parse(LIVE);
	assert.equal(res.periods.rolling.percent, 1, "video 桶是 100% 剩余（0% 已用），取错桶会得到 0");
	// 只有 video 行时不展示视频额度，判未命中（视频额度不是模型用量）
	const onlyVideo = { model_remains: [LIVE.model_remains[1]], base_resp: { status_code: 0 } };
	assert.equal(parse(onlyVideo).matched, false);
});

test("MiniMax：general 桶改名时退到第一个非 video 行", () => {
	const renamed = {
		model_remains: [{ ...LIVE.model_remains[0], model_name: "MiniMax-M2.1", current_interval_remaining_percent: 40 }],
		base_resp: { status_code: 0 },
	};
	const res = parse(renamed);
	assert.equal(res.matched, true);
	assert.equal(res.periods.rolling.percent, 60);
});

test("MiniMax：旧响应无 percent 时按 total - usage_count 换算（usage_count 是剩余）", () => {
	const legacy = {
		model_remains: [
			{
				model_name: "MiniMax-M2",
				current_interval_total_count: 1500,
				current_interval_usage_count: 1200,
				current_weekly_total_count: 0,
				current_weekly_usage_count: 0,
			},
		],
		base_resp: { status_code: 0 },
	};
	const res = parse(legacy);
	assert.equal(res.matched, true);
	assert.equal(res.periods.rolling.percent, 20, "1500 总额度剩 1200 → 已用 20%");
	// 周窗 total 为 0（该账号未上报），只缺这一档，不影响 rolling
	assert.equal(res.periods.weekly, undefined);
	assert.equal(res.periods.rolling.resetsAt, undefined);
});

test("MiniMax：百分比越界收窄到 0-100", () => {
	const over = { model_remains: [{ model_name: "general", current_interval_remaining_percent: 120 }], base_resp: { status_code: 0 } };
	assert.equal(parse(over).periods.rolling.percent, 0);
	const under = { model_remains: [{ model_name: "general", current_weekly_remaining_percent: -5 }], base_resp: { status_code: 0 } };
	assert.equal(parse(under).periods.weekly.percent, 100);
});

test("MiniMax：HTTP 200 携带的业务/鉴权错误（status_code 1004/2049）判未命中", () => {
	const noKey = { model_remains: LIVE.model_remains, base_resp: { status_code: 1004, status_msg: "no api key" } };
	assert.equal(parse(noKey).matched, false);
	const wrongDomain = { model_remains: LIVE.model_remains, base_resp: { status_code: 2049, status_msg: "invalid api key" } };
	assert.equal(parse(wrongDomain).matched, false);
});

test("MiniMax：无可用 model_remains 行 / 窗口全缺时判未命中", () => {
	assert.equal(parse({ base_resp: { status_code: 0 }, model_remains: [] }).matched, false);
	assert.equal(parse({ base_resp: { status_code: 0 } }).matched, false);
	// 行在但两档都没有任何额度字段
	assert.equal(parse({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general" }] }).matched, false);
	assert.equal(probe.parseUsageResponseBody(null, "RAW", { kind: "custom", resolver: "minimax-plan" }).matched, false);
});

test("MiniMax 候选：国内/海外两个域都命中，其它 host 不命中", () => {
	const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.templateId === "minimax-plan");
	assert.ok(cand, "候选表应包含 minimax 适配器");
	for (const baseUrl of ["https://api.minimaxi.com/anthropic", "https://api.minimaxi.com/v1", "https://api.minimax.io/anthropic", "https://www.minimaxi.com/v1"]) {
		assert.equal(probe.candidateApplies(cand, baseUrl, "anthropic-messages"), true, baseUrl);
		assert.equal(probe.candidateApplies(cand, baseUrl, "openai-completions"), true, baseUrl);
	}
	assert.equal(probe.candidateApplies(cand, "https://api.openai.com/v1", "openai-completions"), false);
});

test("MiniMax 候选：rootPath 只取 origin，不继承 baseUrl 的 /anthropic、/v1 路径段", () => {
	const candidates = probe.USAGE_PROBE_CANDIDATES.filter((c) => c.templateId === "minimax-plan");
	assert.equal(JSON.stringify(candidates.map((c) => probe.usageProbeUrls(c, "https://api.minimaxi.com/anthropic", ensureVersion))), JSON.stringify([["https://api.minimaxi.com/v1/token_plan/remains"], ["https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains"]]));
	// 海外域同一套路径
	assert.equal(JSON.stringify(probe.usageProbeUrls(candidates[0], "https://api.minimax.io/anthropic/v1", ensureVersion)), JSON.stringify(["https://api.minimax.io/v1/token_plan/remains"]));
});
