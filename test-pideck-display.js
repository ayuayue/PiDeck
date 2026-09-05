// 测试 PiDeck 用量查询的实际显示逻辑
import { loadTsCommonJs } from "./tests/helpers/loadTsCommonJs.mjs";

const providerUsageProbe = loadTsCommonJs("src/main/config/providerUsageProbe.ts");

console.log('=== 测试 PiDeck 用量查询显示 ===\n');

// 当前配置的两种探针
const ai88Probes = [
  {
    name: "ai88 (88api.ai) - 显示限额",
    match: { baseUrlContains: ["88api.ai"] },
    request: {
      path: "/dashboard/billing/subscription",
      method: "GET"
    },
    parse: {
      kind: "balance",
      valuePath: "hard_limit_usd",
      currencyPath: "USD"
    }
  },
  {
    name: "ai88 (88api.ai) - 显示已用量",
    match: { baseUrlContains: ["88api.ai"] },
    request: {
      path: "/dashboard/billing/usage",
      method: "GET"
    },
    parse: {
      kind: "balance",
      valuePath: "total_usage",
      currencyPath: "USD"
    }
  }
];

// 测试实际显示效果
console.log('测试场景 1: 仅限额信息');
const subscriptionData = {
  object: "billing_subscription",
  has_payment_method: true,
  soft_limit_usd: 500.633406,
  hard_limit_usd: 500.633406,
  system_hard_limit_usd: 500.633406,
  access_until: 0
};

const subscriptionResponse = providerUsageProbe.parseUsageResponseBody(
  subscriptionData,
  JSON.stringify(subscriptionData),
  ai88Probes[0].parse
);

console.log('探针类型: balance');
console.log('响应源: /dashboard/billing/subscription');
console.log('匹配: ' + subscriptionResponse.matched);
if (subscriptionResponse.matched) {
  console.log('余额: ' + subscriptionResponse.balance?.value);
  console.log('货币: ' + subscriptionResponse.balance?.currency);
  console.log('显示格式: ' + subscriptionResponse.displayString);
}

console.log('\n' + '='.repeat(60) + '\n');

console.log('测试场景 2: 仅已用量信息');
const usageData = {
  object: "list", 
  total_usage: 479.7638
};

const usageResponse = providerUsageProbe.parseUsageResponseBody(
  usageData,
  JSON.stringify(usageData),
  ai88Probes[1].parse
);

console.log('探针类型: balance');
console.log('响应源: /dashboard/billing/usage');
console.log('匹配: ' + usageResponse.matched);
if (usageResponse.matched) {
  console.log('用量: ' + usageResponse.balance?.value);
  console.log('货币: ' + usageResponse.balance?.currency);
  console.log('显示格式: ' + usageResponse.displayString);
}

console.log('\n' + '='.repeat(60) + '\n');

// 尝试创建 credits 类型，但需要两个字段
console.log('测试场景 3: 尝试 credits 类型（不可行）');
const creditsProbe = {
  kind: "credits",
  totalPath: "hard_limit_usd",
  usedPath: "total_usage"
};

console.log('注: credits 类型需要两个字段在同一响应中');
console.log('但 88api.ai 分在两个端点，无法实现');

console.log('\n' + '='.repeat(60) + '\n');

// 查看系统如何处理多个匹配的探针
console.log('问题: 当两个探针都匹配时，系统显示哪个？');

// 测试选择逻辑
const providers = [
  { 
    id: "ai88",
    baseUrl: "https://api.88api.ai/v1",
    name: "AI88 (GPT-like)"
  },
  {
    id: "ai88-gpt", 
    baseUrl: "https://api.88api.ai/v1",
    name: "AI88 GPT"
  }
];

console.log('\n当前方案分析:');
console.log('1. 探针1: 显示限额（500.63 USD）');
console.log('2. 探针2: 显示已用量（479.76 USD）');
console.log('3. 系统会按照探针数组顺序，第一个匹配成功即停止');
console.log('4. 因此用户可能只能看到限额信息');

console.log('\n建议: 可以调整探针顺序，让已用量优先显示');
console.log('或考虑其他解决方案：');
console.log('- 自定义解析器');
console.log('- 前端合成两个数据源');

// 测试调整顺序后的效果
console.log('\n' + '='.repeat(60) + '\n');
console.log('调整顺序测试 (已用量优先):');

const reorderedProbes = [ai88Probes[1], ai88Probes[0]];

console.log('先尝试已用量探针: ' + usageResponse.matched);
console.log('如果失败再尝试限额探针: ' + subscriptionResponse.matched);
console.log('\n实际效果：用户会看到已用量信息');

console.log('\n' + '='.repeat(60));
console.log('最终建议配置:');
console.log('- 探针1 (优先): 显示已用量');
console.log('- 探针2 (备选): 显示限额');
console.log('- 这样用户可以至少看到实际已用量');