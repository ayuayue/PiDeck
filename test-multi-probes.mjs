import { loadTsCommonJs } from "./tests/helpers/loadTsCommonJs.mjs";

const userUsageProbes = loadTsCommonJs("src/main/config/userUsageProbes.ts");

console.log("=== 测试多探针配置 ===");

// 测试配置解析
const testConfig = {
  probes: [
    {
      name: "ai88 (88api.ai) - 主探针",
      match: { baseUrlContains: ["88api.ai"] },
      request: { path: "/dashboard/billing/subscription", method: "GET" },
      parse: { kind: "credits", totalPath: "hard_limit_usd", usedPath: "usage" }
    },
    {
      name: "ai88 (88api.ai) - 备用探针1",
      match: { baseUrlContains: ["88api.ai"] },
      request: { path: "/dashboard/billing/subscription", method: "GET" },
      parse: { kind: "credits", totalPath: "subscription.hard_limit_usd", usedPath: "subscription.usage" }
    },
    {
      name: "ai88 (88api.ai) - 备用探针2",
      match: { baseUrlContains: ["88api.ai"] },
      request: { path: "/dashboard/billing/subscription", method: "GET" },
      parse: { kind: "credits", totalPath: "data.hard_limit_usd", usedPath: "data.usage" }
    }
  ]
};

const result = userUsageProbes.normalizeUserUsageProbes(testConfig);

console.log(`✓ 解析成功：${result.probes.length} 个探针，${result.errors.length} 个错误`);
if (result.errors.length > 0) {
  console.error("错误:", result.errors);
}

// 测试不同响应结构
console.log("\n=== 不同路径匹配测试 ===");

const testCases = [
  {
    desc: "简单结构",
    data: { hard_limit_usd: 100, usage: 50 },
    probes: [
      { path: "hard_limit_usd", desc: "主探针" },
      { path: "subscription.hard_limit_usd", desc: "备用1" },
      { path: "data.hard_limit_usd", desc: "备用2" }
    ]
  },
  {
    desc: "嵌套结构1",
    data: { subscription: { hard_limit_usd: 200, usage: 75 } },
    probes: [
      { path: "hard_limit_usd", desc: "主探针", shouldFail: true },
      { path: "subscription.hard_limit_usd", desc: "备用1" },
      { path: "data.hard_limit_usd", desc: "备用2", shouldFail: true }
    ]
  },
  {
    desc: "嵌套结构2",
    data: { data: { hard_limit_usd: 300, usage: 120 } },
    probes: [
      { path: "hard_limit_usd", desc: "主探针", shouldFail: true },
      { path: "subscription.hard_limit_usd", desc: "备用1", shouldFail: true },
      { path: "data.hard_limit_usd", desc: "备用2" }
    ]
  }
];

const providerUsageProbe = loadTsCommonJs("src/main/config/providerUsageProbe.ts");

for (const testCase of testCases) {
  console.log(`\n${testCase.desc}:`);
  
  for (const probe of testCase.probes) {
    const totalPath = probe.path;
    const usedPath = probe.path === "hard_limit_usd" ? "usage" :
                    probe.path === "subscription.hard_limit_usd" ? "subscription.usage" :
                    "data.usage";
    
    const parseResult = providerUsageProbe.parseUsageResponseBody(
      testCase.data,
      JSON.stringify(testCase.data),
      { kind: "credits", totalPath, usedPath }
    );
    
    const status = parseResult.matched ? "✓ 匹配" : "✗ 不匹配";
    const expected = probe.shouldFail ? "应该不匹配" : "应该匹配";
    console.log(`  ${probe.desc}: ${status} (${expected})`);
    
    if (parseResult.matched && !probe.shouldFail) {
      console.log(`    余额: ${parseResult.credits?.total}, 已用: ${parseResult.credits?.used}, 剩余: ${parseResult.credits?.remaining}`);
    }
  }
}

console.log("\n=== 配置生效说明 ===");
console.log("1. 系统会按顺序尝试每个探针");
console.log("2. 第一个成功匹配的探针被使用");
console.log("3. 现在配置包含了三种可能的响应结构");
console.log("4. 这样应该能覆盖大多数情况");
console.log("\n下一步：打开 PiDeck 查看 ai88 和 ai88-gpt 的用量显示");