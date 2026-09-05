// 测试更多可能的计费/用量端点
import fetch from 'node-fetch';
import fs from 'fs';

const models = JSON.parse(fs.readFileSync('C:/Users/14012/.pi/agent/models.json', 'utf8'));
const ai88Config = models.providers.ai88;

console.log('=== 测试更多 88api.ai 端点 ===\n');

async function testEndpoint(path, description) {
  try {
    const base = ai88Config.baseUrl.replace('/v1', '');
    const url = new URL(path, base);
    
    console.log(`测试: ${description}`);
    console.log(`路径: ${path}`);
    console.log(`完整 URL: ${url.toString()}`);
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ai88Config.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log(`状态: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log('响应结构:');
      console.log(JSON.stringify(data, null, 2));
      
      // 搜索可能的用量相关字段
      console.log('\n可能的用量字段:');
      searchForUsageFields(data);
    } else {
      const text = await response.text();
      console.log('响应:');
      console.log(text.length > 300 ? text.substring(0, 300) + '...' : text);
    }
    
    console.log('\n' + '-'.repeat(60) + '\n');
    
  } catch (error) {
    console.log(`错误: ${error.message}\n`);
    console.log('-'.repeat(60) + '\n');
  }
}

function searchForUsageFields(obj, path = '') {
  for (const key in obj) {
    const fullPath = path ? `${path}.${key}` : key;
    const value = obj[key];
    
    if (value && typeof value === 'object') {
      searchForUsageFields(value, fullPath);
    } else {
      const keyLower = key.toLowerCase();
      const isUsageField = keyLower.includes('usage') || 
                          keyLower.includes('used') || 
                          keyLower.includes('total') ||
                          keyLower.includes('limit') ||
                          keyLower.includes('balance') ||
                          keyLower.includes('credit') ||
                          keyLower.includes('remaining') ||
                          keyLower.includes('available');
      
      if (isUsageField) {
        let type = '未知';
        if (keyLower.includes('usage') || keyLower.includes('used')) type = '已用量';
        if (keyLower.includes('limit')) type = '限额';
        if (keyLower.includes('balance')) type = '余额';
        if (keyLower.includes('credit')) type = '点数';
        if (keyLower.includes('remaining')) type = '剩余';
        if (keyLower.includes('available')) type = '可用';
        if (keyLower.includes('total')) type = '总计';
        
        console.log(`  ${fullPath}: ${JSON.stringify(value)} (${type})`);
      }
    }
  }
}

// 测试各种可能的端点
const endpoints = [
  // OpenAI 官方端点
  '/v1/usage',
  '/usage',
  '/dashboard/billing/usage',
  '/billing/usage',
  '/v1/dashboard/billing/usage',
  
  // 其他可能的端点
  '/dashboard/billing/credit_grants',
  '/dashboard/billing/credit_summary',
  '/v1/billing/credit_summary',
  
  // OpenRouter 端点（88api.ai 可能是 OpenRouter 中转）
  '/api/v1/key',
  '/api/v1/credits',
  '/credits',
  
  // 通用计费端点
  '/dashboard/billing',
  '/billing',
  '/v1/billing'
];

// 同时测试这些端点
for (const path of endpoints) {
  await testEndpoint(path, `测试 ${path}`);
}

console.log('=== 端点测试完成 ===');