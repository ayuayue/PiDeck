console.log("=== 验证探针匹配逻辑 ===");

const providerBaseUrls = {
  bailu: "https://bailucode.com/openapi/v1",
  ai88: "https://88api.ai/v1", 
  ai88GPT: "https://88api.ai/v1"
};

const probeKeywords = ["88api.ai"];

console.log("\n1. 原始配置验证:");
console.log("ai88 baseUrl:", providerBaseUrls.ai88);
console.log("ai88 小写:", providerBaseUrls.ai88.toLowerCase());
console.log("包含 '88api.ai'？", providerBaseUrls.ai88.toLowerCase().includes("88api.ai"));

console.log("\n2. 所有 provider 匹配测试:");
for (const [name, baseUrl] of Object.entries(providerBaseUrls)) {
  const lower = baseUrl.toLowerCase();
  const matches = probeKeywords.some(keyword => lower.includes(keyword));
  console.log(`${name}: baseUrl="${baseUrl}" → 匹配 ${probeKeywords.join(",")}: ${matches}`);
  
  if (!matches) {
    console.log(`  警告: ${name} 没有匹配的探针！`);
  }
}

console.log("\n3. 测试 'general' 模板的使用:");
console.log("bailu 使用了 'general' 模板，它会尝试哪些端点？");
console.log("1) 首先看是否被探针匹配 (baseUrlContains)");
console.log("2) 如果没有，使用 'general' 模板的 /usage 端点");
console.log("3) 这个端点对于 OpenAI 兼容网关应该返回 { balance, unit } 格式");

console.log("\n4. 当前配置的分析:");
console.log("✓ ai88: 匹配探针，会调用 /dashboard/billing/subscription");
console.log("✓ ai88-gpt: 同样匹配探针，会调用 /dashboard/billing/subscription");
console.log("✓ bailu: 使用 'general' 模板，会调用 /usage");
console.log("\n注意: ai88 和 ai88-gpt 使用相同 API key / 余额吗？");
console.log("如果它们使用不同的 API key，可能会有独立的余额。");