import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const probe = loadTsCommonJs("src/main/config/providerUsageProbe.ts");

const ensureVersion = (url) => {
  // 与 baseUrlPath.ensureOpenAiVersionPath 相同的语义：根路径补 /v1、已含 /v1 不动。
  if (url.includes("/v1")) return url;
  return `${url.replace(/\/+$/, "")}/v1`;
};

test("candidateApplies 命中 opencode zen 网关", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains && c.baseUrlContains.some((n) => n.includes("opencode")));
  assert.ok(cand, "候选表应包含 opencode 适配器");
  assert.equal(probe.candidateApplies(cand, "https://opencode.ai/zen/go/v1/", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.openai.com/v1", "openai-completions"), false);
});

test("usageProbeUrls 生成版本化与原样两条去重路径", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES[0];
  const urls = probe.usageProbeUrls(cand, "https://opencode.ai/zen/go/v1/", ensureVersion);
  // 两条尝试：版本化后 /usage，原样 /usage。版本化已是 /v1 → 两者一致去重。
  assert.ok(urls.length >= 1 && urls.length <= 2);
  assert.ok(urls.some((u) => u.endsWith("/usage")));
  // 含 /v1 版本化前缀
  assert.ok(urls.some((u) => u.includes("/v1/usage")));
});

test("parseUsageResponseBody 解析 rolling/weekly/monthly 三档百分比", () => {
  const body = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-01-01T00:00:00Z" },
      weekly: { percent: 18 },
      monthly: { percent: 68 },
      ignored: { foo: 1 },
    },
  };
  const res = probe.parseUsageResponseBody(body, "{}");
  assert.equal(res.matched, true);
  assert.equal(res.periods.rolling.percent, 0);
  assert.equal(res.periods.rolling.status, "ok");
  assert.equal(res.periods.weekly.percent, 18);
  assert.equal(res.periods.monthly.percent, 68);
  assert.equal(res.periods.ignored, undefined);});

test("parseUsageResponseBody 无 usage 字段时不匹配并保留 raw", () => {
  const res = probe.parseUsageResponseBody({ foo: 1 }, "RAW_TEXT");
  assert.equal(res.matched, false);
  assert.equal(res.raw, "RAW_TEXT");
});

test("parseUsageResponseBody 非对象/空体不命中", () => {
  assert.equal(probe.parseUsageResponseBody(null, "x").matched, false);
  assert.equal(probe.parseUsageResponseBody("str", "x").matched, false);
  assert.equal(probe.parseUsageResponseBody([], "x").matched, false);
});

test("parseUsageResponseBody percent 非数字时退化 raw", () => {
  const res = probe.parseUsageResponseBody(
    { usage: { monthly: { percent: "68%" } } },
    "RAW",
  );
  assert.equal(res.matched, false);
  assert.equal(res.raw, "RAW");
});
test("真实 opencode-go /v1/usage 响应形状可解析出三档", () => {
  const real = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2025-06-01T00:00:00.000Z" },
      weekly: { percent: 18, status: "ok" },
      monthly: { percent: 68, resetsAt: "2025-07-01T00:00:00.000Z" },
    },
  };
  const parsed = probe.parseUsageResponseBody(real, JSON.stringify(real));
  assert.equal(parsed.matched, true);
  assert.equal(parsed.periods.rolling.percent, 0);
  assert.equal(parsed.periods.rolling.status, "ok");
  assert.equal(parsed.periods.weekly.percent, 18);
  assert.equal(parsed.periods.monthly.percent, 68);
  assert.equal(parsed.periods.monthly.resetsAt, "2025-07-01T00:00:00.000Z");
});

test("候选表首个条目的 URL 生成命中 /usage", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES[0];
  const urls = probe.usageProbeUrls(cand, "https://opencode.ai/zen/go/v1/", ensureVersion);
  assert.ok(urls.some((u) => u.endsWith("/usage")));
});

test("getByPath 支持点号/下标混合路径", () => {
  const body = { data: { balance: 12.5 }, balance_infos: [{ currency: "CNY", total_balance: "110.00" }] };
  assert.equal(probe.getByPath(body, "data.balance"), 12.5);
  assert.equal(probe.getByPath(body, "balance_infos[0].total_balance"), "110.00");
  assert.equal(probe.getByPath(body, "balance_infos[0].currency"), "CNY");
  assert.equal(probe.getByPath(body, "data.missing"), undefined);
  assert.equal(probe.getByPath(body, "balance_infos[5].x"), undefined);
  assert.equal(probe.getByPath(null, "a.b"), undefined);
  assert.equal(probe.getByPath(body, ""), undefined);
});

test("toNumber 兼容数字与数字字符串", () => {
  assert.equal(probe.toNumber(110), 110);
  assert.equal(probe.toNumber("110.00"), 110);
  assert.equal(probe.toNumber(" 12.5 "), 12.5);
  assert.equal(probe.toNumber("abc"), undefined);
  assert.equal(probe.toNumber(""), undefined);
  assert.equal(probe.toNumber(null), undefined);
  assert.equal(probe.toNumber(Number.NaN), undefined);
});

test("buildProbeHeaders 缺省补 Bearer，自定义 Authorization 覆盖，{{apiKey}} 替换", () => {
  const j = (v) => JSON.stringify(v);
  assert.equal(j(probe.buildProbeHeaders(undefined, "sk-1")), j({ Authorization: "Bearer sk-1" }));
  assert.equal(j(probe.buildProbeHeaders({}, "sk-1")), j({ Authorization: "Bearer sk-1" }));
  assert.equal(j(probe.buildProbeHeaders({ Authorization: "Bearer {{apiKey}}" }, "sk-2")), j({ Authorization: "Bearer sk-2" }));
  assert.equal(j(probe.buildProbeHeaders({ "X-API-Key": "{{apiKey}}" }, "sk-3")), j({ Authorization: "Bearer sk-3", "X-API-Key": "sk-3" }));
  // 空 key 时缺省 Bearer 不生成（上层会快速失败），但显式占位仍替换成空串
  assert.equal(j(probe.buildProbeHeaders(undefined, "")), j({}));
});

test("buildProbeHeaders noBearer 时不自动补 Bearer，显式 Authorization 仍保留", () => {
  const j = (v) => JSON.stringify(v);
  // 用户探针 skipBearer（如 Cookie 登录态接口，自动补 Bearer 会触发双凭证冲突）
  assert.equal(j(probe.buildProbeHeaders({ Cookie: "sid=1; tok=2" }, "sk-1", { noBearer: true })),
    j({ Cookie: "sid=1; tok=2" }));
  // noBearer 不影响显式 Authorization（调用方显式声明时以显式为准）
  assert.equal(j(probe.buildProbeHeaders({ Authorization: "Bearer custom" }, "sk-1", { noBearer: true })),
    j({ Authorization: "Bearer custom" }));
  // 不带 noBearer 保持历史行为（无 Authorization 时仍补）
  const withBearer = probe.buildProbeHeaders({ Cookie: "sid=1" }, "sk-1");
  assert.equal(withBearer.Cookie, "sid=1");
  assert.equal(withBearer.Authorization, "Bearer sk-1");
});

test("parseUsageResponseBody 解析 balance 形态", () => {
  const res = probe.parseUsageResponseBody(
    { balance_infos: [{ currency: "CNY", total_balance: "110.00" }] },
    "{}",
    { kind: "balance", valuePath: "balance_infos[0].total_balance", currencyPath: "balance_infos[0].currency" },
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "balance");
  assert.equal(res.balance.value, 110);
  assert.equal(res.balance.currency, "CNY");
});

test("parseUsageResponseBody balance 取不到数值时退化 raw", () => {
  const res = probe.parseUsageResponseBody(
    { balance_infos: [] },
    "RAW",
    { kind: "balance", valuePath: "balance_infos[0].total_balance" },
  );
  assert.equal(res.matched, false);
  assert.equal(res.raw, "RAW");
});

test("parseUsageResponseBody 解析 credits 形态，remaining 自动 total-used 反推", () => {
  const res = probe.parseUsageResponseBody(
    { data: { total_credits: 100, total_usage: 42.5 } },
    "{}",
    { kind: "credits", totalPath: "data.total_credits", usedPath: "data.total_usage" },
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  assert.equal(res.credits.total, 100);
  assert.equal(res.credits.used, 42.5);
  assert.equal(res.credits.remaining, 57.5);
});

test("parseUsageResponseBody credits 显式 remainingPath 优先", () => {
  const res = probe.parseUsageResponseBody(
    { data: { total: 100, used: 42.5, remaining: 60 } },
    "{}",
    { kind: "credits", totalPath: "data.total", usedPath: "data.used", remainingPath: "data.remaining" },
  );
  assert.equal(res.credits.remaining, 60);
});

test("内置候选包含 DeepSeek balance 与 opencode periods", () => {
  const opencode = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("opencode.ai/zen"));
  const deepseek = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.deepseek.com"));
  assert.ok(opencode);
  assert.ok(deepseek);
  assert.equal(deepseek.parse.kind, "balance");
});

test("内置候选包含 OpenRouter、Kimi For Coding 与 Moonshot balance", () => {
  const openrouter = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("openrouter.ai"));
  const moonshot = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.moonshot.ai"));
  const kimi = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.kimi.com"));
  assert.ok(openrouter);
  assert.ok(moonshot);
  assert.ok(kimi, "候选表应包含 Kimi For Coding 适配器");
  assert.equal(openrouter.parse.kind, "credits");
  assert.equal(openrouter.path, "/key");
  assert.equal(moonshot.parse.kind, "balance");
  assert.equal(kimi.parse.kind, "credits");
});

test("OpenRouter 候选：普通 inference key 走 /api/v1/key 而非 /credits", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("openrouter.ai"));
  // /credits 需要 Management key，已改用 /key（普通 key 即可用）
  assert.notEqual(cand.path, "/credits");
  assert.equal(cand.parse.totalPath, "data.limit");
  assert.equal(cand.parse.usedPath, "data.usage");
  assert.equal(cand.parse.remainingPath, "data.limit_remaining");
});

test("OpenRouter 候选解析真实 /api/v1/key 响应，remaining 直接用 API 给的值", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("openrouter.ai"));
  assert.equal(probe.candidateApplies(cand, "https://openrouter.ai/api/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.deepseek.com", "openai-completions"), false);
  const res = probe.parseUsageResponseBody(
    { data: { limit: 100, usage: 25.5, limit_remaining: 74.5, limit_reset: "monthly" } },
    "{}",
    cand.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  assert.equal(res.credits.total, 100);
  assert.equal(res.credits.used, 25.5);
  // remaining 采信 API 返回的 limit_remaining，不反推
  assert.equal(res.credits.remaining, 74.5);
});

test("OpenRouter 免费层 limit/limit_remaining 为 null 时仍命中（仅 used）", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("openrouter.ai"));
  const res = probe.parseUsageResponseBody(
    { data: { limit: null, usage: 3.2, limit_remaining: null } },
    "{}",
    cand.parse,
  );
  // total/remaining 都取不到，但 used 有值 → 仍命中小数余额展示，不整体退化 raw
  assert.equal(res.matched, true);
  assert.equal(res.credits.total, undefined);
  assert.equal(res.credits.used, 3.2);
  assert.equal(res.credits.remaining, undefined);
});

test("Kimi For Coding 候选：命中 api.kimi.com，解析真实 /usages 响应", () => {
  const kimi = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.kimi.com"));
  assert.equal(kimi.path, "/usages");
  assert.equal(probe.candidateApplies(kimi, "https://api.kimi.com/coding/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(kimi, "https://api.moonshot.ai/v1", "openai-completions"), false);
  const res = probe.parseUsageResponseBody(
    { usage: { limit: "2048", used: "214", remaining: "1834", resetTime: "2026-01-09T15:23:13Z" } },
    "{}",
    kimi.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  assert.equal(res.credits.total, 2048);
  assert.equal(res.credits.used, 214);
  // remainingPath 命中 → 直接用 usage.remaining（字符串数字也会被 toNumber 收窄）
  assert.equal(res.credits.remaining, 1834);
});

test("Kimi For Coding：字段漂移下只给 limit+remaining 或 limit+used 都能解析", () => {
  const kimi = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.kimi.com"));
  // 漂移形态 A：没有 used，只有 remaining
  const onlyRemaining = probe.parseUsageResponseBody(
    { usage: { limit: "100", remaining: "74" } },
    "{}",
    kimi.parse,
  );
  assert.equal(onlyRemaining.matched, true);
  assert.equal(onlyRemaining.credits.total, 100);
  assert.equal(onlyRemaining.credits.used, undefined);
  assert.equal(onlyRemaining.credits.remaining, 74);
  // 漂移形态 B：只有 used，remaining 由 total-used 反推
  const onlyUsed = probe.parseUsageResponseBody(
    { usage: { limit: "100", used: "40" } },
    "{}",
    kimi.parse,
  );
  assert.equal(onlyUsed.matched, true);
  assert.equal(onlyUsed.credits.total, 100);
  assert.equal(onlyUsed.credits.used, 40);
  assert.equal(onlyUsed.credits.remaining, 60);
});

test("Kimi For Coding：boosterWallet 带独立货币字段不干扰主额度解析", () => {
  const kimi = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.kimi.com"));
  // boosterWallet 是独立 Boost 点数货币，主额度 usage 之外；确认解析只取 usage.*
  const res = probe.parseUsageResponseBody(
    {
      usage: { limit: "1000", used: "100", resetTime: "2026-02-01T00:00:00Z" },
      boosterWallet: { balance: { type: "BOOSTER", amount: "5000000", amountLeft: "1000000" } },
    },
    "{}",
    kimi.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.credits.total, 1000);
  assert.equal(res.credits.used, 100);
  assert.equal(res.credits.remaining, 900);
});

test("Moonshot 候选国内/国际 baseUrl 都命中，解析真实 balance 响应（无币种）", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.moonshot.ai"));
  assert.equal(probe.candidateApplies(cand, "https://api.moonshot.ai/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.moonshot.cn/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.openai.com/v1", "openai-completions"), false);
  const res = probe.parseUsageResponseBody(
    { code: 0, data: { available_balance: 12.34, voucher_balance: 2.0, cash_balance: 10.34 } },
    "{}",
    cand.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "balance");
  assert.equal(res.balance.value, 12.34);
  assert.equal(res.balance.currency, undefined);
});

test("内置候选包含通用 OpenAI /usage 兑底候选（不限 baseUrl，仅限 OpenAI 协议）", () => {
  const generic = probe.USAGE_PROBE_CANDIDATES.find((c) => c.path === "/usage" && c.apiTypes);
  assert.ok(generic, "候选表应包含通用 OpenAI /usage 候选");
  assert.equal(generic.baseUrlContains, undefined);
  assert.ok(generic.apiTypes.includes("openai-completions"));
  assert.ok(generic.apiTypes.includes("openai-responses"));
  assert.ok(generic.apiTypes.includes("openai-codex-responses"));
  assert.equal(generic.parse.kind, "balance");
  assert.equal(generic.parse.valuePath, "balance");
  assert.equal(generic.parse.currencyPath, "unit");
});

test("通用 OpenAI /usage 候选：任意 OpenAI 协议 baseUrl 命中，非 OpenAI 协议不命中", () => {
  const generic = probe.USAGE_PROBE_CANDIDATES.find((c) => c.path === "/usage" && c.apiTypes);
  assert.equal(probe.candidateApplies(generic, "https://open.mwy.asia/v1", "openai-responses"), true);
  assert.equal(probe.candidateApplies(generic, "https://any-gateway.example.com/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(generic, "https://api.anthropic.com", "anthropic-messages"), false);
  assert.equal(probe.candidateApplies(generic, "https://generativelanguage.googleapis.com", "google-generative-ai"), false);
});

test("通用 OpenAI /usage 候选解析真实 /usage 响应（balance+unit）", () => {
  const generic = probe.USAGE_PROBE_CANDIDATES.find((c) => c.path === "/usage" && c.apiTypes);
  const res = probe.parseUsageResponseBody(
    { balance: 1.69525969, unit: "USD", planName: "钱包余额", remaining: 1.69525969 },
    "{}",
    generic.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "balance");
  assert.equal(res.balance.value, 1.69525969);
  assert.equal(res.balance.currency, "USD");
});

test("智谱 GLM 候选：rootPath 挂 host 根、在通用 OpenAI 候选之前", () => {
  const zhipu = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("open.bigmodel.cn"));
  assert.ok(zhipu, "候选表应包含智谱适配器");
  assert.equal(zhipu.path, "/api/monitor/usage/quota/limit");
  assert.equal(zhipu.rootPath, true);
  // 认证是裸 apiKey（不带 Bearer 前缀，智谱监控 API 要求）
  assert.equal(zhipu.headers.Authorization, "{{apiKey}}");
  assert.equal(zhipu.parse.kind, "credits");
  assert.equal(zhipu.parse.totalPath, "data.limits[0].usage");
  assert.equal(zhipu.parse.usedPath, "data.limits[0].currentValue");
  // 必须排在通用 OpenAI /usage 候选之前，避免被兜底候选半路劫走
  const zhipuIdx = probe.USAGE_PROBE_CANDIDATES.indexOf(zhipu);
  const genericIdx = probe.USAGE_PROBE_CANDIDATES.findIndex((c) => c.path === "/usage" && c.apiTypes);
  assert.ok(zhipuIdx >= 0 && genericIdx > zhipuIdx, "智谱候选应先于通用 OpenAI 候选");
});

test("智谱候选命中 open.bigmodel.cn 的 OpenAI/Anthropic 两种 base，不误伤其它域名", () => {
  const zhipu = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("open.bigmodel.cn"));
  assert.equal(probe.candidateApplies(zhipu, "https://open.bigmodel.cn/api/paas/v4/", "openai-completions"), true);
  assert.equal(probe.candidateApplies(zhipu, "https://open.bigmodel.cn/api/anthropic", "anthropic-messages"), true);
  assert.equal(probe.candidateApplies(zhipu, "https://api.deepseek.com", "openai-completions"), false);
  assert.equal(probe.candidateApplies(zhipu, "https://openrouter.ai/api/v1", "openai-completions"), false);
});

test("智谱候选追加 api.z.ai 国际版 origin，同样命中根路径监控端点", () => {
  const zhipu = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("open.bigmodel.cn"));
  // api.z.ai 是 GLM Coding Plan 国际版 origin，与 open.bigmodel.cn 同一监控 API
  assert.ok(zhipu.baseUrlContains.includes("api.z.ai"), "候选 baseUrlContains 应包含 api.z.ai");
  assert.equal(probe.candidateApplies(zhipu, "https://api.z.ai/api/paas/v4/", "openai-completions"), true);
  // rootPath 只取 origin，拼接出 api.z.ai 的监控端点而非 /api/paas/v4 兼容路径
  const urls = probe.usageProbeUrls(zhipu, "https://api.z.ai/api/paas/v4/", ensureVersion);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "https://api.z.ai/api/monitor/usage/quota/limit");
});

test("usageProbeUrls rootPath：只取 baseUrl origin，不拼 /api/paas/v4 路径段", () => {
  const zhipu = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("open.bigmodel.cn"));
  const urls = probe.usageProbeUrls(zhipu, "https://open.bigmodel.cn/api/paas/v4/", ensureVersion);
  // loadTsCommonJs 经 vm.runInNewContext 执行，返回跨 realm 的 Array，deepStrictEqual
  // 会因原型不同误报 "same structure but not reference-equal"，故逐元素断言
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
});

test("智谱真实响应样例解析为 credits（usage=总配额、currentValue=已用、剩余反推、双窗口齐全）", () => {
  const zhipu = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("open.bigmodel.cn"));
  const res = probe.parseUsageResponseBody(
    {
      code: 200,
      msg: "success",
      success: true,
      data: {
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 10000000, currentValue: 500000, percentage: 5, nextResetTime: 1706200000000 },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 100000, currentValue: 20000, percentage: 20 },
        ],
      },
    },
    "{}",
    zhipu.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  // 主值 = limits[0]（5h 滚动窗）：usage=总配额、currentValue=已用、剩余反推
  assert.equal(res.credits.total, 10000000);
  assert.equal(res.credits.used, 500000);
  // remaining 由 total-used 反推，不采信 percentage（那只是展示百分比）
  assert.equal(res.credits.remaining, 9500000);
  // 双窗口并列：5h 窗 + 周窗各自独立解析（周窗 currentValue=20000 / usage=100000）；
  // loadTsCommonJs 经 vm 执行跨 realm，对象原型不同，deepEqual 会误报，故逐字段断言
  assert.equal(res.credits.windows.length, 2);
  assert.equal(res.credits.windows[0].key, "fiveHour");
  assert.equal(res.credits.windows[0].total, 10000000);
  assert.equal(res.credits.windows[0].used, 500000);
  assert.equal(res.credits.windows[0].remaining, 9500000);
  assert.equal(res.credits.windows[1].key, "weekly");
  assert.equal(res.credits.windows[1].total, 100000);
  assert.equal(res.credits.windows[1].used, 20000);
  assert.equal(res.credits.windows[1].remaining, 80000);
});

test("智谱响应缺周窗条目时 windows 只给 5h 一条，主值仍正常", () => {
  const zhipu = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("open.bigmodel.cn"));
  const res = probe.parseUsageResponseBody(
    { data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 1145 }] } },
    "{}",
    zhipu.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.credits.total, 2000);
  // 单窗：windows 只含 5h，周窗缺值被跳过而不是使整条解析失败
  assert.equal(res.credits.windows.length, 1);
  assert.equal(res.credits.windows[0].key, "fiveHour");
});

test("智谱 MCP 月度额度窗口：按 type=TIME_LIMIT 遍历匹配，与 5h/周窗并存", () => {
  const zhipu = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("open.bigmodel.cn"));
  const res = probe.parseUsageResponseBody(
    {
      data: {
        limits: [
          { type: "TIME_LIMIT", usage: 300, currentValue: 120, usageDetails: [{ modelCode: "glm-4.5", usage: 60 }] },
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 10000000, currentValue: 500000 },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 100000, currentValue: 20000 },
        ],
      },
    },
    "{}",
    zhipu.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.credits.windows.length, 3);
  const byKey = Object.fromEntries(res.credits.windows.map((w) => [w.key, w]));
  // MCP 月额度（TIME_LIMIT）：usage=总配额、currentValue=已用
  assert.equal(byKey.mcpMonthly.total, 300);
  assert.equal(byKey.mcpMonthly.used, 120);
  assert.equal(byKey.mcpMonthly.remaining, 180);
  // 5h 窗与周窗仍按 unit 匹配，不受 MCP 条目插队影响
  assert.equal(byKey.fiveHour.total, 10000000);
  assert.equal(byKey.weekly.total, 100000);
});

test("Kimi booster 独立货币解析：定点余额/分钱换算成元，unlimited 标记", () => {
  const kimi = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.kimi.com"));
  const res = probe.parseUsageResponseBody(
    {
      usage: { limit: "1000", used: "100", resetTime: "2026-02-01T00:00:00Z" },
      boosterWallet: {
        balance: { type: "BOOSTER", amount: "5000000", amountLeft: "1000000" },
        monthlyChargeLimit: { priceInCents: 2000, currency: "CNY" },
        monthlyUsed: { priceInCents: 450, currency: "CNY" },
        monthlyChargeLimitEnabled: true,
      },
    },
    "{}",
    kimi.parse,
  );
  assert.equal(res.matched, true);
  // 主额度不受影响
  assert.equal(res.credits.total, 1000);
  // booster：1,000,000 定点 = 1 分 → amountLeft 1000000 = 1 分 = 0.01 元；amount 5000000 = 0.05 元
  assert.ok(res.booster, "booster 应解析出来");
  assert.equal(res.booster.balance, 0.01);
  assert.equal(res.booster.total, 0.05);
  assert.equal(res.booster.currency, "CNY");
  assert.equal(res.booster.monthlyUsed, 4.5); // 450 分 = 4.5 元
  assert.equal(res.booster.monthlyChargeLimit, 20); // 2000 分 = 20 元
  assert.equal(res.booster.unlimitedMonthly, undefined);
});

test("Kimi booster 月限额未启用（monthlyChargeLimitEnabled=false）时标记 unlimited 且不给数值", () => {
  const kimi = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.kimi.com"));
  const res = probe.parseUsageResponseBody(
    {
      usage: { limit: "1000", used: "100" },
      boosterWallet: {
        balance: { type: "BOOSTER", amount: "5000000", amountLeft: "2000000" },
        monthlyChargeLimitEnabled: false,
      },
    },
    "{}",
    kimi.parse,
  );
  assert.equal(res.booster.unlimitedMonthly, true);
  assert.equal(res.booster.monthlyChargeLimit, undefined);
});

test("Kimi booster 缺 balance 时 booster 不输出（主额度仍正常）", () => {
  const kimi = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.kimi.com"));
  const res = probe.parseUsageResponseBody(
    { usage: { limit: "100", used: "10" } },
    "{}",
    kimi.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.booster, undefined);
});

test("xAI 候选：absoluteUrl 固定官方域、baseUrlContains api.x.ai、带 Grok 客户端头与 preflight", () => {
  const xai = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.x.ai"));
  assert.ok(xai, "候选表应包含 xAI 适配器");
  assert.equal(xai.absoluteUrl, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
  assert.equal(probe.candidateApplies(xai, "https://api.x.ai", "openai-completions"), true);
  assert.equal(probe.candidateApplies(xai, "https://api.deepseek.com", "openai-completions"), false);
  assert.equal(xai.headers["X-XAI-Token-Auth"], "xai-grok-cli");
  assert.ok(xai.preflight, "xAI 需要 identity 预检");
  assert.equal(xai.preflight.absoluteUrl, "https://cli-chat-proxy.grok.com/v1/user?include=subscription");
  // loadTsCommonJs 经 vm 执行，跨 realm 对象 deepEqual 会误报，故逐字段断言
  assert.equal(xai.preflight.capture.path, "userId");
  assert.equal(xai.preflight.capture.header, "x-userid");
  assert.equal(xai.parse.kind, "custom");
  assert.equal(xai.parse.resolver, "xai-billing");
  // absoluteUrl 生效：usageProbeUrls 只返回该官方 URL，不拼 baseUrl 也不走版本化
  const urls = probe.usageProbeUrls(xai, "https://api.x.ai", ensureVersion);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
});

test("xAI billing 专用解析：percent 优先，否则 cent-wrapper 美元桶，含按需用量", () => {
  const xai = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.x.ai"));
  // percent 形态：creditUsagePercent 直接是占用百分比
  const percentRes = probe.parseUsageResponseBody(
    {
      config: {
        creditUsagePercent: 25,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
        onDemandCap: { val: 10000 },
        onDemandUsed: { val: 1000 },
        prepaidBalance: { val: 5000 },
      },
    },
    "{}",
    xai.parse,
  );
  assert.equal(percentRes.matched, true);
  assert.equal(percentRes.kind, "credits");
  const byKey = Object.fromEntries(percentRes.credits.windows.map((w) => [w.key, w]));
  assert.equal(byKey.included.used, 25);
  assert.equal(byKey.included.total, 100);
  assert.equal(byKey.onDemand.used, 10); // 1000 分 = 10 元
  assert.equal(byKey.onDemand.total, 100); // 10000 分 = 100 元

  // 无 percent 时回退 monthlyLimit/used（cent wrapper → 美元）
  const usdRes = probe.parseUsageResponseBody(
    { config: { monthlyLimit: { val: 3000 }, used: { val: 750 } } },
    "{}",
    xai.parse,
  );
  assert.equal(usdRes.matched, true);
  const usdByKey = Object.fromEntries(usdRes.credits.windows.map((w) => [w.key, w]));
  assert.equal(usdByKey.included.used, 7.5);
  assert.equal(usdByKey.included.total, 30);

  // 既无 percent 也无美元字段 → 不匹配
  assert.equal(probe.parseUsageResponseBody({ config: {} }, "{}", xai.parse).matched, false);
});

test("Codex 候选：命中 chatgpt.com 的 codex 协议，走 wham/usage 相对路径", () => {
  const codex = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("chatgpt.com"));
  assert.ok(codex, "候选表应包含 OpenAI Codex 适配器");
  assert.equal(codex.path, "/wham/usage");
  assert.equal(probe.candidateApplies(codex, "https://chatgpt.com/backend-api", "openai-codex-responses"), true);
  assert.equal(probe.candidateApplies(codex, "https://chatgpt.com/backend-api", "openai-completions"), false);
  assert.equal(probe.candidateApplies(codex, "https://api.openai.com/v1", "openai-codex-responses"), false);
  // 相对 baseUrl 拼接（pi 的 openai-codex baseUrl 就是 chatgpt.com/backend-api）
  const urls = probe.usageProbeUrls(codex, "https://chatgpt.com/backend-api", ensureVersion);
  assert.ok(urls.some((u) => u === "https://chatgpt.com/backend-api/wham/usage"));
});

test("Codex 专用解析：primary/secondary percent 窗 + credits 余额", () => {
  const codex = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("chatgpt.com"));
  const res = probe.parseUsageResponseBody(
    {
      rate_limit: {
        primary_window: { used_percent: 62, limit_window_seconds: 3600, reset_at: 1706200000 },
        secondary_window: { used_percent: 15, limit_window_seconds: 86400, reset_at: 1706200000 },
      },
      credits: { has_credits: true, balance: 12 },
      rate_limit_reset_credits: { available_count: 2 },
      plan_type: "codex-pro",
    },
    "{}",
    codex.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  assert.equal(res.credits.remaining, 12); // credits.balance
  const byKey = Object.fromEntries(res.credits.windows.map((w) => [w.key, w]));
  assert.equal(byKey.primary.used, 62);
  assert.equal(byKey.primary.total, 100);
  assert.equal(byKey.secondary.used, 15);
  assert.equal(byKey.secondary.total, 100);
  // 全空响应不匹配
  assert.equal(probe.parseUsageResponseBody({}, "{}", codex.parse).matched, false);
});

test("preflight 子结构 URL 生成：absoluteUrl 优先、普通 path 走版本化拼接", () => {
  // xAI preflight 有 absoluteUrl → 只返回官方 URL
  const xai = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.x.ai"));
  const preflightUrls = probe.usageProbeUrls(
    { path: xai.preflight.path, absoluteUrl: xai.preflight.absoluteUrl, rootPath: false },
    "https://api.x.ai",
    ensureVersion,
  );
  assert.equal(preflightUrls.length, 1);
  assert.equal(preflightUrls[0], "https://cli-chat-proxy.grok.com/v1/user?include=subscription");
  // 普通 path（无 absoluteUrl）：版本化 + 原样两条
  const plain = probe.usageProbeUrls(
    { path: "/v1/user", rootPath: false },
    "https://api.x.ai",
    ensureVersion,
  );
  assert.ok(plain.length >= 1 && plain.length <= 2);
  assert.ok(plain.some((u) => u.includes("/v1/user")));
});

test("credits parse 的 scale 把原始积分换算成主单位（New API quota/500000）", () => {
  const body = { data: { quota: 2_500_000, used_quota: 500_000, success: true } };
  const res = probe.parseUsageResponseBody(body, "{}", {
    kind: "credits",
    remainingPath: "data.quota",
    usedPath: "data.used_quota",
    scale: 500_000,
  });
  assert.equal(res.matched, true);
  assert.equal(res.credits.remaining, 5, "2500000 / 500000 = 5 USD");
  assert.equal(res.credits.used, 1, "500000 / 500000 = 1 USD");
  assert.equal(res.credits.total, undefined);
});

test("credits parse 无 scale 或非法 scale 不缩放（行为不变）", () => {
  const body = { data: { limit: 100, usage: 30 } };
  const res = probe.parseUsageResponseBody(body, "{}", {
    kind: "credits",
    totalPath: "data.limit",
    usedPath: "data.usage",
    scale: 0,
  });
  assert.equal(res.matched, true);
  assert.equal(res.credits.total, 100);
  assert.equal(res.credits.used, 30);
  assert.equal(res.credits.remaining, 70);
});

test("usageProbeUrls noVersionPath 只尝试管理根单 URL（不补 /v1）", () => {
  const cand = { path: "/api/user/self", noVersionPath: true };
  const urls = probe.usageProbeUrls(cand, "https://88api.ai", ensureVersion);
  // vm realm 数组不能 deepStrictEqual，逐项断言
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "https://88api.ai/api/user/self");
});

test("usageProbeUrls noVersionPath 保留子路径前缀", () => {
  const cand = { path: "/api/user/self", noVersionPath: true };
  const urls = probe.usageProbeUrls(cand, "https://host.example/newapi", ensureVersion);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "https://host.example/newapi/api/user/self");
});

const TR = (k) => `[${k}]`;

test("buildProbeFailureDetail 全量 404 归纳「地址不对」提示并带响应摘要", () => {
  const attempts = [
    { url: "https://88api.ai/v1/api/user/self", method: "GET", status: 404 },
    { url: "https://88api.ai/api/user/self", method: "GET", status: 404, body: '{"error":{"message":"Invalid URL"}}' },
  ];
  const detail = probe.buildProbeFailureDetail(attempts, TR);
  assert.match(detail, /GET https:\/\/88api\.ai\/api\/user\/self → HTTP 404/);
  assert.match(detail, /Invalid URL/);
  assert.match(detail, /\[mainConfig\.providerUsageHintNotFound\]/);
});

test("buildProbeFailureDetail 全量 401/403 归纳「鉴权」提示", () => {
  const attempts = [
    { url: "https://88api.ai/api/user/self", method: "GET", status: 401, body: '{"code":"AUTH_UNAUTHORIZED"}' },
  ];
  const detail = probe.buildProbeFailureDetail(attempts, TR);
  assert.match(detail, /\[mainConfig\.providerUsageHintAuth\]/);
});

test("buildProbeFailureDetail 全部超时/网络错误归纳「超时/网络」提示", () => {
  const attempts = [
    { url: "https://88api.ai/api/user/self", method: "GET", error: "timeout" },
    { url: "https://88api.ai/api/user/self", method: "GET", error: "network" },
  ];
  const detail = probe.buildProbeFailureDetail(attempts, TR);
  assert.match(detail, /\[mainConfig\.providerUsageAttemptTimeout\]/);
  assert.match(detail, /\[mainConfig\.providerUsageAttemptNetwork\]/);
  assert.match(detail, /\[mainConfig\.providerUsageHintTimeout\]/);
});

test("buildProbeFailureDetail 200 结构不符归纳「接口变更」提示", () => {
  const attempts = [{ url: "https://host/api/user/self", method: "GET", kind: "shape" }];
  const detail = probe.buildProbeFailureDetail(attempts, TR);
  assert.match(detail, /响应结构与预期不符/);
  assert.match(detail, /\[mainConfig\.providerUsageHintShape\]/);
});

test("buildProbeFailureDetail 混合失败归纳「混合」提示，无尝试记录返回空串", () => {
  const detail = probe.buildProbeFailureDetail(
    [
      { url: "https://a.example/x", method: "GET", status: 404 },
      { url: "https://a.example/y", method: "GET", status: 401 },
    ],
    TR,
  );
  assert.match(detail, /\[mainConfig\.providerUsageHintMixed\]/);
  assert.equal(probe.buildProbeFailureDetail([], TR), "");
});

test("Command Code 候选：host 根 /alpha/billing/credits、专用解析器、模板登记", () => {
  const cc = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.commandcode.ai"));
  assert.ok(cc, "候选表应包含 Command Code 适配器");
  assert.equal(cc.path, "/alpha/billing/credits");
  assert.equal(cc.rootPath, true);
  assert.equal(cc.templateId, "commandcode-credits");
  assert.equal(cc.parse.kind, "custom");
  assert.equal(cc.parse.resolver, "commandcode-credits");
  assert.equal(probe.candidateApplies(cc, "https://api.commandcode.ai/provider/v1", ""), true);
  assert.equal(probe.candidateApplies(cc, "https://api.deepseek.com", ""), false);
  // rootPath 生效：只取 origin 拼接，不拼 /provider/v1 也不走版本化补齐
  const urls = probe.usageProbeUrls(cc, "https://api.commandcode.ai/provider/v1", ensureVersion);
  assert.equal(urls.length, 1);
  assert.equal(urls[0], "https://api.commandcode.ai/alpha/billing/credits");
});

test("Command Code 真实响应：5h/周/月三窗口同时展示，月度按套餐表校验", () => {
  const cc = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.commandcode.ai"));
  // 真实实测响应（GOAT 套餐）：weekly used 6.548505913 恰好等于 70 - 63.451494087
  const live = {
    credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 63.451494087, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: { used: 0.0604245041, cap: 14, exceeded: false, resetAt: 1788503106394 },
      weekly: { used: 6.548505913, cap: 35, exceeded: false, resetAt: 1788939961631 },
    },
  };
  const res = probe.parseUsageResponseBody(live, "{}", cc.parse);
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  assert.equal(res.credits.remaining, 63.451494087);
  const byKey = Object.fromEntries(res.credits.windows.map((w) => [w.key, w]));
  assert.equal(byKey.fiveHour.used, 0.0604245041);
  assert.equal(byKey.fiveHour.total, 14);
  assert.equal(byKey.weekly.used, 6.548505913);
  assert.equal(byKey.weekly.total, 35);
  // cap 14/35 恰好命中 GOAT（70/月）→ 月度百分比可得
  assert.equal(byKey.monthly.total, 70);
  assert.equal(byKey.monthly.used, 6.548505913);
  assert.equal(byKey.monthly.remaining, 63.451494087);
  assert.equal(res.credits.windows.length, 3);
});

test("Command Code 月度不可信：cap 对不上套餐表时降级只显剩余（不臆造百分比）", () => {
  const cc = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.commandcode.ai"));
  const body = {
    credits: { monthlyCredits: 63.45 },
    windowLimits: {
      fiveHour: { used: 0.06, cap: 999 },
      weekly: { used: 6.54, cap: 35 },
    },
  };
  const res = probe.parseUsageResponseBody(body, "{}", cc.parse);
  assert.equal(res.matched, true);
  const byKey = Object.fromEntries(res.credits.windows.map((w) => [w.key, w]));
  assert.equal(byKey.monthly.total, undefined);
  assert.equal(byKey.monthly.used, undefined);
  assert.equal(byKey.monthly.remaining, 63.45);
  assert.equal(byKey.fiveHour.total, 999); // 5h/周窗口照常展示（wire 值不经套餐表）
});

test("Command Code 形态兼容：snake_case 字段与 credits 内嵌 windowLimits 都能解析", () => {
  const cc = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.commandcode.ai"));
  const body = {
    credits: {
      monthly_credits: "10",
      window_limits: {
        five_hour: { used: 2, cap: 3 },
        weekly: { used: 4, cap: 6 },
      },
    },
  };
  const res = probe.parseUsageResponseBody(body, "{}", cc.parse);
  assert.equal(res.matched, true);
  const byKey = Object.fromEntries(res.credits.windows.map((w) => [w.key, w]));
  assert.equal(byKey.monthly.total, 10); // Go 套餐（3/6 cap 命中）
  assert.equal(byKey.monthly.used, 0);
  assert.equal(byKey.fiveHour.total, 3);
  assert.equal(byKey.weekly.used, 4);
});

test("Command Code 缺 monthlyCredits 时不匹配（关键字段缺失）", () => {
  const cc = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.commandcode.ai"));
  assert.equal(
    probe.parseUsageResponseBody({ windowLimits: { fiveHour: { used: 1, cap: 2 } } }, "{}", cc.parse).matched,
    false,
  );
});

