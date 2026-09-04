/**
 * Provider 用量展示纯函数：usageTone 档位（cc-switch utilizationColor 语义）、
 * usagePercent 推导、徽标主值文本、余额格式化与相对时间。三处消费
 * （圆球/模型卡片/选择器行）共用，视觉阈值（≥90 红 / ≥70 橙 / 其余绿；剩余 <10% 橙、≤0 红）在此锁定。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const display = loadTsCommonJs("src/renderer/src/utils/providerUsageDisplay.ts");

function balanceResult(value, currency) {
  return { success: true, kind: "balance", balance: { value, currency } };
}

function periodsResult(percents) {
  const periods = {};
  if (percents.rolling != null) periods.rolling = { percent: percents.rolling };
  if (percents.weekly != null) periods.weekly = { percent: percents.weekly };
  if (percents.monthly != null) periods.monthly = { percent: percents.monthly };
  return { success: true, kind: "periods", periods };
}

function creditsResult(credits) {
  return { success: true, kind: "credits", credits };
}

test("usageTone：百分比档位对齐 cc-switch utilizationColor（≥90 红 / ≥70 橙 / 其余绿）", () => {
  assert.equal(display.usageTone(periodsResult({ rolling: 30, weekly: 80, monthly: 10 })), "low");
  assert.equal(display.usageTone(periodsResult({ rolling: 95 })), "empty");
  assert.equal(display.usageTone(periodsResult({ rolling: 69.4 })), "ok");
  // 70 与 90 属于高档位起点
  assert.equal(display.usageTone(periodsResult({ rolling: 70 })), "low");
  assert.equal(display.usageTone(periodsResult({ rolling: 90 })), "empty");
});

test("usageTone：credits 优先 windows 最高窗；余额 ≤0 红", () => {
  assert.equal(
    display.usageTone(
      creditsResult({ windows: [{ key: "fiveHour", total: 100, used: 92 }, { key: "weekly", total: 100, used: 10 }] }),
    ),
    "empty",
  );
  // remaining 反推 used：total 200 remaining 60 → 70% → low
  assert.equal(display.usageTone(creditsResult({ total: 200, remaining: 60 })), "low");
  assert.equal(display.usageTone(balanceResult(86.3, "CNY")), "ok");
  assert.equal(display.usageTone(balanceResult(0, "CNY")), "empty");
  // total 1000 remaining 50 → 已用 95% → empty（百分比档优先于剩余比例档）
  assert.equal(display.usageTone(creditsResult({ total: 1000, remaining: 50 })), "empty");
  // total 1000 remaining 0 → 已用 100% → empty
  assert.equal(display.usageTone(creditsResult({ total: 1000, remaining: 0 })), "empty");
  // 只有剩余量（无总额）→ ok（无上限概念不判橙红）
  assert.equal(display.usageTone(creditsResult({ remaining: 5 })), "ok");
  // 只有已用量（无总额）→ 中性灰
  assert.equal(display.usageTone(creditsResult({ used: 42 })), "neutral");
});

test("usageTone：失败结果返回 neutral（inline 层会先按失败不渲染）", () => {
  assert.equal(display.usageTone({ success: false, error: "x" }), "neutral");
});

test("usageToneForPercent：Details 逐窗口行与 usageTone 同阈值", () => {
  assert.equal(display.usageToneForPercent(null), "neutral");
  assert.equal(display.usageToneForPercent(69.9), "ok");
  assert.equal(display.usageToneForPercent(70), "low");
  assert.equal(display.usageToneForPercent(90), "empty");
});

test("tone → 样式类映射（绿/橙/红含 dark 变体，进度条与文字分列）", () => {
  assert.match(display.USAGE_TONE_TEXT_CLASS.ok, /green-600/);
  assert.match(display.USAGE_TONE_TEXT_CLASS.low, /orange-500/);
  assert.match(display.USAGE_TONE_TEXT_CLASS.empty, /red-500/);
  assert.match(display.USAGE_TONE_BAR_CLASS.empty, /bg-red-500/);
  assert.match(display.USAGE_TONE_BAR_CLASS.low, /bg-orange-500/);
  assert.match(display.USAGE_TONE_BAR_CLASS.ok, /bg-green-500/);
});

test("usagePercent：periods 封顶 100；credits remaining 可反推 used", () => {
  assert.equal(display.usagePercent(periodsResult({ rolling: 130, weekly: 5 })), 100);
  assert.equal(
    display.usagePercent(creditsResult({ total: 200, remaining: 60 })),
    70,
    "used = total - remaining = 140 → 70%",
  );
  // total<=0 不产生百分比（避免除零误报 danger）
  assert.equal(display.usagePercent(creditsResult({ total: 0, used: 10 })), null);
  assert.equal(display.usagePercent(balanceResult(10, "USD")), null);
});

test("formatUsageBadgeText：periods/credits-windows 出百分比，balance 出余额，credits 出剩余", () => {
  assert.equal(display.formatUsageBadgeText(periodsResult({ rolling: 12.4 })), "12%");
  assert.equal(display.formatUsageBadgeText(balanceResult(86.3, "CNY")), "¥86.3");
  assert.equal(display.formatUsageBadgeText(creditsResult({ remaining: 120.5 })), "120.5");
  assert.equal(
    display.formatUsageBadgeText(creditsResult({ windows: [{ key: "fiveHour", total: 100, used: 45 }] })),
    "45%",
  );
  // 无可展示数值 → null（调用方不渲染）
  assert.equal(display.formatUsageBadgeText({ success: false, error: "x" }), null);
  assert.equal(display.formatUsageBadgeText({ success: true }), null);
});

test("formatBalance：已知币种符号前缀、未知代码后缀、无币种纯数字", () => {
  assert.equal(display.formatBalance({ value: 110, currency: "USD" }), "$110");
  assert.equal(display.formatBalance({ value: 110, currency: "CNY" }), "¥110");
  assert.equal(display.formatBalance({ value: 3.5, currency: "XYZ" }), "3.5 XYZ");
  assert.equal(display.formatBalance({ value: 42 }), "42");
  assert.equal(display.formatAmount(3.14159), "3.14", "最多两位小数四舍五入");
  assert.equal(display.formatAmount(42), "42", "整数不出现小数点");
  assert.equal(display.currencySymbol("rmb"), "¥", "币种代码大小写不敏感");
});

test("usageBadgeSegments：periods 三档逐段出「标签+百分比」，档位逐段独立", () => {
  const t = (key) => `#${key}`;
  const json = (value) => JSON.stringify(value);
  assert.equal(
    json(display.usageBadgeSegments(periodsResult({ rolling: 32.6, weekly: 86, monthly: 95 }), t)),
    json([
      { labelKey: "sessionContext.usageRolling", text: "33%", tone: "ok" },
      { labelKey: "sessionContext.usageWeekly", text: "86%", tone: "low" },
      { labelKey: "sessionContext.usageMonthly", text: "95%", tone: "empty" },
    ]),
  );
  // 百分比缺省的档位跳过；全部缺省 → null（调用方不渲染）
  assert.equal(display.usageBadgeSegments(periodsResult({}), t), null);
});

test("usageBadgeSegments：balance 出「余额+金额」；credits 出「剩+剩余」或「已用+已用」", () => {
  const t = (key) => `#${key}`;
  const json = (value) => JSON.stringify(value);
  assert.equal(
    json(display.usageBadgeSegments(balanceResult(6.58, "CNY"), t)),
    json([{ labelKey: "config.usage.balanceShort", text: "¥6.58", tone: "ok" }]),
  );
  assert.equal(
    json(display.usageBadgeSegments(creditsResult({ remaining: 120.5 }), t)),
    json([{ labelKey: "config.usage.remainingShort", text: "120.5", tone: "ok" }]),
  );
  // 只有已用量：已用标签 + 中性灰
  assert.equal(
    json(display.usageBadgeSegments(creditsResult({ used: 42 }), t)),
    json([{ labelKey: "config.usage.usedShort", text: "42", tone: "neutral" }]),
  );
  // total-used 反推剩余
  assert.equal(
    json(display.usageBadgeSegments(creditsResult({ total: 200, used: 50 }), t)),
    json([{ labelKey: "config.usage.remainingShort", text: "150", tone: "ok" }]),
  );
});

test("usageBadgeSegments：credits windows 逐窗出「窗口名+百分比」，剩余可反推已用", () => {
  const t = (key) => `#${key}`;
  const json = (value) => JSON.stringify(value);
  assert.equal(
    json(display.usageBadgeSegments(
      creditsResult({
        windows: [
          { key: "fiveHour", total: 100, used: 45 },
          { key: "weekly", total: 100, remaining: 90 },
          { key: "customGateway", remaining: 3.5 },
          { key: "emptyWindow" },
        ],
      }),
      t,
    )),
    json([
      { labelKey: "sessionContext.usageWindowFiveHour", text: "45%", tone: "ok" },
      { labelKey: "sessionContext.usageWindowWeekly", text: "10%", tone: "ok" },
      // 未知窗口 key 原样做标签；无总额 → 退化为剩余数值（灰），不臆造百分比
      { labelText: "customGateway", text: "3.5", tone: "neutral" },
      // 百分比与剩余都算不出的窗口直接跳过（「窗口名 —」是噪音）
    ]),
  );
  // 窗口全部不可展示时落到主值分支，而不是整行消失
  assert.equal(
    json(display.usageBadgeSegments(
      creditsResult({ windows: [{ key: "emptyWindow" }], remaining: 12 }),
      t,
    )),
    json([{ labelKey: "config.usage.remainingShort", text: "12", tone: "ok" }]),
  );
});

test("usageBadgePrimarySegment：多档取档位最严重的一段（选择器行单值位示警）", () => {
  const t = (key) => `#${key}`;
  const worst = display.usageBadgePrimarySegment(periodsResult({ rolling: 32, weekly: 95 }), t);
  assert.equal(worst.text, "95%");
  assert.equal(worst.tone, "empty");
  // balance 单段原样返回
  assert.equal(display.usageBadgePrimarySegment(balanceResult(6.58, "CNY"), t).text, "¥6.58");
  // 无可展示数值 → null
  assert.equal(display.usageBadgePrimarySegment({ success: false, error: "x" }, t), null);
});

test("usageWindowLabel：内置 key 走 i18n，未知 key 原样文本", () => {
  assert.equal(display.usageWindowLabel("mcpMonthly").key, "sessionContext.usageWindowMcpMonthly");
  // Command Code 月度窗口复用 periods 的「本月/Monthly」叫法（i18n 两语言已有）。
  assert.equal(display.usageWindowLabel("monthly").key, "sessionContext.usageMonthly");
  const custom = display.usageWindowLabel("myGateway");
  assert.equal("text" in custom ? custom.text : undefined, "myGateway");
});

test("Command Code 三窗口段：5小时/周/本月独立百分比，月度带剩余可推导", () => {
  // 与 providerUsageProbe 的 commandcode-credits 解析输出对齐（GOAT 套餐实测数值）。
  const res = creditsResult({
    remaining: 63.451494087,
    windows: [
      { key: "fiveHour", total: 14, used: 0.0604245041 },
      { key: "weekly", total: 35, used: 6.548505913 },
      { key: "monthly", total: 70, used: 6.548505913, remaining: 63.451494087 },
    ],
  });
  const t = (key) => `[${key}]`;
  const segments = display.usageBadgeSegments(res, t);
  assert.equal(segments.length, 3);
  assert.equal("labelKey" in segments[0] ? segments[0].labelKey : "", "sessionContext.usageWindowFiveHour");
  assert.equal(segments[0].text, "0%");
  assert.equal("labelKey" in segments[1] ? segments[1].labelKey : "", "sessionContext.usageWindowWeekly");
  assert.equal(segments[1].text, "19%");
  assert.equal("labelKey" in segments[2] ? segments[2].labelKey : "", "sessionContext.usageMonthly");
  assert.equal(segments[2].text, "9%");
  assert.equal(display.usageTone(res), "ok");
  // 月度不可信（无 total）→ 退化「窗口名 + 剩余」灰字，不臆造百分比
  const degraded = creditsResult({
    remaining: 63.45,
    windows: [
      { key: "fiveHour", total: 14, used: 0.06 },
      { key: "weekly", total: 35, used: 6.55 },
      { key: "monthly", remaining: 63.45 },
    ],
  });
  const degradedSegments = display.usageBadgeSegments(degraded, t);
  assert.equal(degradedSegments.length, 3);
  assert.equal(degradedSegments[2].text, "63.45");
  assert.equal(degradedSegments[2].tone, "neutral");
});

test("relativeTimeParts：刚刚/分钟/小时/天/过期 五档（cc-switch Clock 行语义）", () => {
  const now = 1_000_000_000_000;
  const json = (value) => JSON.stringify(value);
  assert.equal(display.relativeTimeParts(now - 5_000, now).key, "config.usage.timeJustNow");
  assert.equal(
    json(display.relativeTimeParts(now - 3 * 60_000, now)),
    json({ key: "config.usage.timeMinutesAgo", params: { n: 3 } }),
  );
  assert.equal(
    json(display.relativeTimeParts(now - 2 * 3_600_000, now)),
    json({ key: "config.usage.timeHoursAgo", params: { n: 2 } }),
  );
  assert.equal(
    json(display.relativeTimeParts(now - 5 * 86_400_000, now)),
    json({ key: "config.usage.timeDaysAgo", params: { n: 5 } }),
  );
  // 超过 30 天 → stale（避免「9999 天前」这类荒谬值）
  assert.equal(display.relativeTimeParts(now - 31 * 86_400_000, now).key, "config.usage.timeStale");
  // 时钟倒挂（未来时间戳）按刚刚处理
  assert.equal(display.relativeTimeParts(now + 60_000, now).key, "config.usage.timeJustNow");
});
