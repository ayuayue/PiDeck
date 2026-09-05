import fs from 'fs';

console.log('=== 最终配置检查 ===\n');

// 读取最终配置
const configPath = 'C:/Users/14012/.pi/agent/usage-probes.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log('配置结构:');
console.log(`- 有 ${config.providers?.length || 0} 个 providers`);
console.log(`- 有 ${config.probes?.length || 0} 个 probes`);
console.log('');

// 显示所有探针
console.log('探针列表:');
config.probes.forEach((probe, i) => {
  console.log(`\n探针 ${i + 1}: ${probe.name}`);
  console.log(`  匹配: baseUrl 包含 ${probe.match.baseUrlContains?.join(', ') || 'none'}`);
  console.log(`  请求: ${probe.request.method} ${probe.request.path}`);
  console.log(`  解析: ${probe.parse.kind}`);
  
  if (probe.parse.kind === 'balance') {
    console.log(`  字段: ${probe.parse.valuePath}`);
    console.log(`  货币: ${probe.parse.currencyPath}`);
  } else if (probe.parse.kind === 'credits') {
    console.log(`  总额: ${probe.parse.totalPath}`);
    console.log(`  已用: ${probe.parse.usedPath}`);
  }
});

console.log('\n' + '='.repeat(60));
console.log('配置说明:');
console.log('');
console.log('1. 探针优先级:');
console.log('   - 第一探针: 显示已用量（优先用户关心的信息）');
console.log('   - 第二探针: 显示限额（备选，如果用量端点失效）');
console.log('');
console.log('2. 工作原理:');
console.log('   - PiDeck 会按探针顺序尝试');
console.log('   - 第一个能成功匹配并使用端点的探针会被使用');
console.log('   - 由于两个端点都会成功，用户会看到「已用量优先」');
console.log('');
console.log('3. 对 ai88 和 ai88-gpt 的影响:');
console.log('   - 两者都使用 api.88api.ai/v1 域名');
console.log('   - 因此两个 provider 都会显示 $479.76 USD（已用量）');
console.log('   - 如果需要区分，需要不同的配置');
console.log('');
console.log('4. bailu 的配置:');
console.log('   - bailu 不使用 88api.ai 域名');
console.log('   - 会使用 「通用模板」（如果配置了 enabled: true）');
console.log('   - 或需要自定义探针');

console.log('\n' + '='.repeat(60));
console.log('建议在 PiDeck 中测试:');
console.log('1. 打开 PiDeck 设置页面');
console.log('2. 点击「用量查询」');
console.log('3. 应该能看到 ai88 显示: 已用量 $479.76 USD');
console.log('4. 这是比只看到总限额更有用的信息');