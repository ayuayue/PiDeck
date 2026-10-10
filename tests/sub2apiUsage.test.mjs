import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const custom = loadTsCommonJs("src/main/config/providerUsageCustom.ts");

/** resolveCustomUsage 的便捷入口：sub2api-usage 解析器按响应结构分流。 */
function parse(body) {
	return custom.resolveCustomUsage("sub2api-usage", body, JSON.stringify(body));
}

test("sub2api 钱包形态：顶层 balance 输出余额（含币种）", () => {
	const res = parse({ mode: "wallet", isValid: true, balance: 12.34, remaining: 12.34, unit: "USD" });
	assert.ok(res && res.matched, "应命中");
	assert.equal(res.kind, "balance");
	assert.equal(res.balance.value, 12.34);
	assert.equal(res.balance.currency, "USD");
});

test("sub2api 订阅形态（新版字段）：限额档出窗口、remaining 取最小剩余", () => {
	const res = parse({
		mode: "subscription",
		isValid: true,
		remaining: 2.5,
		unit: "USD",
		subscription: { daily_limit_usd: 5, daily_usage_usd: 2.5, weekly_limit_usd: null, weekly_usage_usd: 8, monthly_limit_usd: 100, monthly_usage_usd: 40 },
		usage: { total: { actual_cost: 42.5 } },
	});
	assert.ok(res && res.matched, "应命中");
	assert.equal(res.kind, "credits");
	assert.equal(res.credits.remaining, 2.5);
	assert.equal(res.credits.used, 42.5);
	// vm 沙箱跨 realm 的数组原型不同，deepEqual 会假失败，逐项断言。
	assert.equal(res.credits.windows.length, 2);
	assert.equal(res.credits.windows[0].key, "daily");
	assert.equal(res.credits.windows[0].total, 5);
	assert.equal(res.credits.windows[0].used, 2.5);
	assert.equal(res.credits.windows[1].key, "monthly");
	assert.equal(res.credits.windows[1].total, 100);
	assert.equal(res.credits.windows[1].used, 40);
});

test("sub2api 无限额订阅（zuiapi 实测形态）：remaining -1 不展示，只剩已用", () => {
	const res = parse({
		daily_usage: [],
		isValid: true,
		mode: "unrestricted",
		planName: "DeepSeek公益5B",
		remaining: -1,
		subscription: { daily_limit_usd: null, daily_usage_usd: 0.550914, monthly_limit_usd: null, monthly_usage_usd: 5.79544156, weekly_limit_usd: null, weekly_usage_usd: 5.79544156 },
		unit: "USD",
		usage: { total: { actual_cost: 5.8013008 } },
	});
	assert.ok(res && res.matched, "应命中");
	assert.equal(res.kind, "credits");
	assert.equal(res.credits.used, 5.8013008);
	assert.equal(res.credits.remaining, undefined, "-1 是不限额哨兵，不能当剩余展示");
	assert.equal(res.credits.windows, undefined, "三档限额全 null，不应有窗口");
});

test("sub2api 旧版部署别名：used_quota/total_quota 作月档窗口兜底", () => {
	const res = parse({
		mode: "subscription",
		isValid: true,
		remaining: -1,
		unit: "USD",
		subscription: { used_quota: 35.87, total_quota: 500, expire_time: "2026-11-08T00:00:00Z" },
		usage: { total: { actual_cost: 35.87 } },
	});
	assert.ok(res && res.matched, "应命中");
	assert.equal(res.kind, "credits");
	assert.equal(res.credits.windows.length, 1);
	assert.equal(res.credits.windows[0].key, "monthly");
	assert.equal(res.credits.windows[0].total, 500);
	assert.equal(res.credits.windows[0].used, 35.87);
});

test("sub2api Key 额度形态：quota 三件套为主值、rate_limits 映射 5h/1d/7d 窗口", () => {
	const res = parse({
		mode: "quota_limited",
		isValid: true,
		unit: "USD",
		quota: { limit: 50, used: 10, remaining: 40 },
		rate_limits: [
			{ window: "5h", limit: 100, used: 20 },
			{ window: "1d", limit: 200, used: 80 },
			{ window: "7d", limit: 1000, used: 300 },
		],
		usage: { total: { actual_cost: 10 } },
	});
	assert.ok(res && res.matched, "应命中");
	assert.equal(res.kind, "credits");
	assert.equal(res.credits.total, 50);
	assert.equal(res.credits.used, 10, "quota 形态主值已用取 quota.used（与总额同口径）");
	assert.equal(res.credits.remaining, 40);
	// vm 沙箱跨 realm 的数组原型不同，deepEqual 会假失败（同文件既有测试同坑），逐项断言。
	assert.equal(res.credits.windows.length, 3);
	assert.equal(res.credits.windows[0].key, "fiveHour");
	assert.equal(res.credits.windows[1].key, "daily");
	assert.equal(res.credits.windows[2].key, "weekly");
	assert.equal(res.credits.windows[0].total, 100);
	assert.equal(res.credits.windows[2].used, 300);
});

test("sub2api 不认识的窗口名与空 rate_limits 条目被跳过", () => {
	const res = parse({
		mode: "quota_limited",
		isValid: true,
		unit: "USD",
		quota: { limit: 50, used: 10, remaining: 40 },
		rate_limits: [{ window: "30d", limit: 1, used: 1 }, "garbage", { window: "1d" }],
	});
	assert.ok(res && res.matched, "应命中");
	// "30d" 无对应窗口 key；"garbage" 非对象；"1d" 无 limit/used 数值——全部跳过。
	assert.equal(res.credits.windows, undefined);
});

test("sub2api 无任何可用数值时不命中（回退其他候选/原始展示）", () => {
	assert.equal(parse({}).matched, false);
	assert.equal(parse({ mode: "wallet", isValid: true }).matched, false);
	assert.equal(parse("nope").matched, false);
});

/** parseSub2ApiPanelBalance 的便捷入口：/api/v1/auth/me 响应 → 余额段。 */
function parsePanel(body) {
	return custom.parseSub2ApiPanelBalance(body, JSON.stringify(body));
}

test("sub2api 面板余额解析：data.balance 输出余额（USD，冻结额不扣减）", () => {
	const res = parsePanel({ code: 0, message: "success", data: { id: 1, email: "a@b.c", balance: 12.34, frozen_balance: 1.5, total_recharged: 100 } });
	assert.ok(res && res.matched, "应命中");
	assert.equal(res.kind, "balance");
	// 与网页面板同口径：余额取 balance 原值，冻结额不扣减。
	assert.equal(res.balance.value, 12.34);
	assert.equal(res.balance.currency, "USD");
});

test("sub2api 面板余额解析：JWT 失效（非 2xx 在请求层已被挡）与结构变更静默不命中", () => {
	// 上游包一层 { code, message, data }；无 data（如错误响应）不命中。
	assert.equal(parsePanel({ code: "unauthorized", message: "无效令牌" }).matched, false);
	// data.balance 缺失（上游结构变更）不命中。
	assert.equal(parsePanel({ code: 0, data: { id: 1 } }).matched, false);
	assert.equal(parsePanel(null).matched, false);
});

test("面板 JWT 失败不再纯静默：合并层带 panelBalanceError，401 归因为过期", () => {
	// 源码扫描契约（空白容忍）：主结果成功但面板余额追加失败时必须带原因字段，
	// UI 才能显示「JWT 已过期」而不是余额段无感消失（2026-10 实测踩坑：用户贴的
	// JWT 已到期，静默降级看起来像功能坏了）。
	const source = readFileSync("src/main/config/ConfigManager.ts", "utf8");
	assert.match(source, /else\s+result\.panelBalanceError\s*=\s*merged\.reason/);
	assert.match(source, /result\.status\s*===\s*401/);
	assert.match(source, /reason:\s*unauthorized\s*\?\s*"unauthorized"\s*:\s*"failed"/);
});
