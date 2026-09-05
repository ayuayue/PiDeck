// 尝试调用实际的 88api.ai 计费端点
import fetch from 'node-fetch';

// 从 models.json 读取 apiKey
const fs = await import('fs');
const models = JSON.parse(fs.readFileSync('C:/Users/14012/.pi/agent/models.json', 'utf8'));

const ai88Config = models.providers.ai88;
const ai88GptConfig = models.providers['ai88-gpt'];

console.log('=== 测试真实 API 响应 ===');

async function testEndpoint(baseUrl, apiKey, name) {
  try {
    console.log(`\n测试 ${name}:`);
    console.log(`- baseUrl: ${baseUrl}`);
    console.log(`- apiKey: ${apiKey.substring(0, 15)}...`);
    
    // 构建计费端点 URL
    const url = new URL('/dashboard/billing/subscription', baseUrl);
    
    console.log(`- 请求: GET ${url.toString()}`);
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    const status = response.status;
    const contentType = response.headers.get('content-type') || '';
    
    console.log(`- 响应状态: ${status}`);
    console.log(`- Content-Type: ${contentType}`);
    
    if (response.ok) {
      const text = await response.text();
      try {
        const data = JSON.parse(text);
        
        console.log('- 响应结构:');
        console.log(JSON.stringify(data, null, 2));
        
        // 分析关键字段
        console.log('\n- 字段分析:');
        
        function findFields(obj, path = '') {
          const fields = {};
          for (const key in obj) {
            const fullPath = path ? `${path}.${key}` : key;
            const value = obj[key];
            
            if (typeof value === 'number' || 
                (typeof value === 'string' && !isNaN(parseFloat(value)))) {
              // 可能是金额或用量
              if (key.toLowerCase().includes('limit') || 
                  key.toLowerCase().includes('hard') ||
                  key.toLowerCase().includes('total') ||
                  key.toLowerCase().includes('balance')) {
                console.log(`  ${fullPath}: ${value} (可能是总额)`);
              } else if (key.toLowerCase().includes('usage') || 
                         key.toLowerCase().includes('used')) {
                console.log(`  ${fullPath}: ${value} (可能是已用量)`);
              } else {
                console.log(`  ${fullPath}: ${value} (数字)`);
              }
            } else if (value && typeof value === 'object') {
              // 递归查找
              findFields(value, fullPath);
            }
          }
        }
        
        findFields(data);
        
        return { success: true, data };
      } catch (e) {
        console.log('- 响应内容 (非 JSON):');
        console.log(text.substring(0, 500));
        return { success: false, error: '非 JSON 响应' };
      }
    } else {
      console.log('- 错误响应:');
      const text = await response.text();
      console.log(text.substring(0, 500));
      return { success: false, error: `HTTP ${status}` };
    }
  } catch (error) {
    console.log(`- 请求失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// 测试多个可能的端点
async function testAllEndpoints() {
  // 1. 测试 /dashboard/billing/subscription
  console.log('\n' + '='.repeat(50));
  console.log('测试 /dashboard/billing/subscription');
  console.log('='.repeat(50));
  
  await testEndpoint(ai88Config.baseUrl.replace('/v1', ''), ai88Config.apiKey, 'ai88');
  
  // 2. 测试 /usage 端点（通用模板）
  console.log('\n' + '='.repeat(50));
  console.log('测试 /usage 端点（通用模板）');
  console.log('='.repeat(50));
  
  try {
    const url = new URL('/usage', ai88Config.baseUrl.replace('/v1', ''));
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ai88Config.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log(`- 状态: ${response.status}`);
    if (response.ok) {
      const data = await response.json();
      console.log('- 响应:');
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log('- 端点不存在或错误');
    }
  } catch (error) {
    console.log(`- 请求失败: ${error.message}`);
  }
  
  // 3. 测试 /v1/dashboard/billing/subscription
  console.log('\n' + '='.repeat(50));
  console.log('测试 /v1/dashboard/billing/subscription');
  console.log('='.repeat(50));
  
  try {
    const url = new URL('/v1/dashboard/billing/subscription', ai88Config.baseUrl.replace('/v1', ''));
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ai88Config.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log(`- 状态: ${response.status}`);
    if (response.ok) {
      const data = await response.json();
      console.log('- 响应:');
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log('- 端点不存在或错误');
    }
  } catch (error) {
    console.log(`- 请求失败: ${error.message}`);
  }
}

// 运行测试
if (ai88Config && ai88Config.apiKey) {
  await testAllEndpoints();
} else {
  console.error('未找到 ai88 配置或 apiKey');
}