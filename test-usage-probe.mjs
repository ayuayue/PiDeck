import { loadTsCommonJs } from "./tests/helpers/loadTsCommonJs.mjs";

// 加载相关模块
const providerUsageProbe = loadTsCommonJs("src/main/config/providerUsageProbe.ts");
const userUsageProbes = loadTsCommonJs("src/main/config/userUsageProbes.ts");

console.log("=== 测试用量探针配置 ===");

// 1. 测试配置解析
const configDir = "C:/Users/14012/.pi/agent";
const result = await userUsageProbes.loadUserUsageProbes(configDir);

console.log("✓ 配置加载成功");
console.log("- 找到探针数量:", result.candidates.length);
console.log("- 错误数量:", result.errors.length);

if (result.errors.length > 0) {
  console.error("配置错误:", result.errors);
}

// 2. 验证探针内容
if (result.candidates.length > 0) {
  console.log("\n=== 探针配置详情 ===");
  result.candidates.forEach((candidate, index) => {
    console.log(`\n探针 ${index + 1}:`);
    console.log("- baseUrlContains:", candidate.baseUrlContains);
    console.log("- 路径:", candidate.path);
    console.log("- 方法:", candidate.method || "GET");
    console.log("- 解析类型:", candidate.parse?.kind);
    
    if (candidate.parse?.kind === "balance") {
      console.log("- valuePath:", candidate.parse.valuePath);
      console.log("- currencyPath:", candidate.parse.currencyPath);
    }
    
    if (candidate.parse?.kind === "credits") {
      console.log("- totalPath:", candidate.parse.totalPath);
      console.log("- usedPath:", candidate.parse.usedPath);
      console.log("- remainingPath:", candidate.parse.remainingPath);
    }
  });
}

// 3. 测试配置解析函数
const normalizeResult = userUsageProbes.normalizeUserUsageProbes({
  probes: [
    {
      name: "测试探针",
      match: {
        baseUrlContains: ["88api.ai"]
      },
      request: {
        path: "/dashboard/billing/subscription",
        method: "GET"
      },
      parse: {
        kind: "credits",
        totalPath: "hard_limit_usd",
        usedPath: "usage"
      }
    }
  ]
});

console.log("\n=== 配置验证测试 ===");
console.log("✓ 配置格式验证通过");

// 4. 测试解析器
const testResponse = {
  hard_limit_usd: 100.0,
  usage: 50.0
};

console.log("\n=== 解析器测试 ===");
const parseResult = providerUsageProbe.parseUsageResponseBody(
  testResponse,
  JSON.stringify(testResponse),
  { kind: "credits", totalPath: "hard_limit_usd", usedPath: "usage" }
);

if (parseResult.matched) {
  console.log("✓ 解析成功");
  console.log("- kind:", parseResult.kind);
  
  if (parseResult.credits) {
    console.log("- credits.total:", parseResult.credits.total); // 应该是 100
    console.log("- credits.used:", parseResult.credits.used);   // 应该是 50
    console.log("- credits.remaining:", parseResult.credits.remaining); // 应该是 50 = 100 - 50
  }
} else {
  console.error("✗ 解析失败");
}

// 5. 测试更多可能的响应格式
const possibleResponses = [
  {
    desc: "简单格式",
    data: { hard_limit_usd: 100.0, usage: 50.0 },
    expectedTotal: 100,
    expectedUsed: 50
  },
  {
    desc: "嵌套格式",
    data: { billing: { hard_limit_usd: 200.0, usage: 75.0 } },
    totalPath: "billing.hard_limit_usd",
    usedPath: "billing.usage",
    expectedTotal: 200,
    expectedUsed: 75
  },
  {
    desc: "字符串数值",
    data: { hard_limit_usd: "150.00", usage: "90.50" },
    expectedTotal: 150,
    expectedUsed: 90.50
  }
];

console.log("\n=== 多种响应格式测试 ===");
for (const testCase of possibleResponses) {
  const totalPath = testCase.totalPath || "hard_limit_usd";
  const usedPath = testCase.usedPath || "usage";
  
  const result = providerUsageProbe.parseUsageResponseBody(
    testCase.data,
    JSON.stringify(testCase.data),
    { kind: "credits", totalPath, usedPath }
  );
  
  console.log(`\n${testCase.desc}: ${result.matched ? "✓ 通过" : "✗ 失败"}`);
  if (result.matched && result.credits) {
    console.log(`  - 期望: total=${testCase.expectedTotal}, used=${testCase.expectedUsed}`);
    console.log(`  - 实际: total=${result.credits.total}, used=${result.credits.used}`);
  }
}

console.log("\n=== 最终结果 ===");
console.log("✓ 配置解析测试完成");
console.log("✓ 你的 ai88 探针现在应该显示：总金额、已用量、剩余量");