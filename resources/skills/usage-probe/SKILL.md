---
name: usage-probe
description: 为 PiDeck 的「用量查询」功能排查/扩展供应商支持。当用户想显示某个供应商的用量、余额或额度点数时，先判断是否已内置支持（内置无需配置）；不在内置时引导用户使用「用量查询」弹窗里的通用 / New API / Cookie / 火山方舟 AK-SK 模板；四种模板都覆盖不了的接口，帮用户写出 usage-probes.json 的旧版探针数组。
---

# 用量查询辅助（usage-probe）

## 这是什么

供应商的用量/余额显示在「设置 → 配置管理 → 模型/认证」的 **供应商卡片底部**
（学 cc-switch：所有卡片同一位置、右对齐：相对时间 + 彩色数值 + 刷新按钮）。
支持分三层：

1. **内置模板（零配置）**：命中内置候选的供应商开箱即用，弹窗里已识别、无需配置。
   当前内置：
   - 官方余额：DeepSeek（`/user/balance`）、OpenRouter（`/api/v1/key` per-key 额度）、
     Moonshot 官方余额（`/users/me/balance`）；
   - 套餐额度：Kimi For Coding（`/usages`，含 Boost 点数）、智谱 GLM Coding Plan
     （5h 滚动窗 / 周窗 / MCP 月度窗）、OpenCode Go（`/usage` 三档百分比）；
   - 官方订阅（登录态 OAuth，凭据来自 auth.json）：Codex/ChatGPT（`/wham/usage`）、
     xAI Grok（billing 预检链）；
   - 通用 OpenAI 兼容网关兜底：实现了官方 `/v1/usage`（`{ balance, unit }`）的中转站自动显示余额。
2. **声明式模板（弹窗内可选）**：不在内置列表时，弹窗提供四个模板——
   - **通用模板**：请求 `/usage`（OpenAI 兼容），API Key / 请求地址可覆盖（留空用供应商的）；
   - **New API**：New API / OneAPI 中转站，填 访问令牌 + 用户 ID（积分自动换算）；
   - **Cookie**：自研网关的网页后台接口（需要登录态 Cookie，不能用 API Key）；
   - **火山方舟 AK/SK**：方舟（ark）的 Agent Plan / Coding Plan 额度，填控制台生成的
     Access Key ID + Secret Access Key，Region 自动从推理 base_url 推断；同一个账号
     只订阅哪一种套餐都能识别（两个 Action 依次探测，未订阅的那个返回全 0 自动跳过）。
3. **旧版探针数组（AI 兜底）**：上面都覆盖不了的接口（如自建网关的自定义余额端点），
   由 AI 写 `~/.pi/agent/usage-probes.json` 的 `probes` 数组（见下文），运行时按
   baseUrl 关键字匹配合入探测。

配置文件位置（和 models.json 同一个目录）：

```
~/.pi/agent/usage-probes.json
```

改完立刻生效（无需重启）。顶层 `providers` 映射由弹窗维护，**AI 不要手改**；
`probes` 数组才是开放给 AI 写的部分。

改完立刻生效（无需重启），下次打开供应商卡片就能读到新配置。

## 你（AI）的工作流程

当用户说「帮我让 XX 供应商显示用量」时，按下面顺序做：

1. **先判断是否已内置**：读 `~/.pi/agent/models.json` 找到该 provider 的 `baseUrl`，
   对照上面的内置清单。命中就直接告诉用户「已内置，无需配置，卡片底部会自动显示」，
   不需要写任何文件。apiKey 的位置不用读出来，也不要把 key 贴到任何地方。
2. **没内置 → 引导弹窗模板**：让用户在供应商卡片点「用量查询」打开弹窗：
   - OpenAI 兼容站点（有 `/usage` 端点）→ 选「通用模板」，必要时填请求地址（留空用供应商的）；
   - New API / OneAPI 中转站 → 选「New API」，填访问令牌和用户 ID；
   - 火山方舟（ark，含 Coding Plan / Agent Plan）→ 选「火山方舟 AK/SK」，让用户到火山引擎
     控制台「访问控制 → 密钥管理」创建 AK/SK 填进去（**不是**方舟的推理 API Key：那个是
     Bearer 鉴权，控制面 OpenAPI 只认 AK/SK 签名）；
   - 两个模板都覆盖不了 → 继续第 3 步。
3. **写旧版 probes 数组**：确认该供应商的「余额 / usage / balance / credits」接口
   （拿不到文档时让用户 F12 抓包，把 URL 路径和返回 JSON 发给你；记得提醒用户
   抹掉 key/token），确定「剩余额度」字段后按下面结构生成 `probes` 数组。
4. **验证**：让用户打开供应商卡片看底部用量行。不显示就继续对齐字段路径。
> 重要安全边界：`probes` 数组里**不要**写 apiKey。鉴权统一走 `Authorization: Bearer <key>`，
> 主进程自动从 auth.json/models.json 取 key；只有个别接口用非标准鉴权头时才用
> `"headers": { "X-API-Key": "{{apiKey}}" }` 占位。
> 例外：火山方舟模板的 AK/SK 由弹窗写进顶层 `providers` 映射（不走 probes 数组），
> 只用于本地派生请求签名，不进日志与遥测。

## 配置文件结构

顶层 `providers` 映射由弹窗维护（开关/模板/超时/间隔），**AI 不要手改**。
下面这个 `probes` 数组是开放给 AI 写的兜底部分，每条是一个供应商。字段含义：

```jsonc
{
  "probes": [
    {
      // （可选）只是给自己看的名字，不影响功能
      "name": "我的中转站",

      // 匹配条件：你的供应商 baseUrl 里包含的任意关键字（小写匹配）
      "match": {
        "baseUrlContains": ["api.myprovider.com"]
      },

      // 发什么请求
      "request": {
        "path": "/user/balance",   // 相对 baseUrl 的路径，必须以 / 开头
        "method": "GET",            // 可选，GET 或 POST，缺省 GET
        // "body": { ... },         // 可选，POST 时的请求体
        // "headers": { "X-API-Key": "{{apiKey}}" }  // 可选，非标准鉴权头
      },

      // 怎么从响应里取数（三种形态选一种）
      "parse": {
        "kind": "balance",
        "valuePath": "balance_infos[0].total_balance",   // 剩余额度的字段路径
        "currencyPath": "balance_infos[0].currency"      // 可选，币种
      }
    }
  ]
}
```

### 三种 parse 形态

**1. balance（剩余额度，一个数字 + 可选币种）**

```jsonc
"parse": {
  "kind": "balance",
  "valuePath": "data.available_balance",
  "currencyPath": "data.currency"
}
```

**2. credits（额度点数，总额 / 已用 / 剩余，至少给一个）**

```jsonc
"parse": {
  "kind": "credits",
  "totalPath": "data.total_credits",     // 可选
  "usedPath": "data.total_usage",        // 可选
  "remainingPath": "data.remaining"      // 可选；不给时会用 total-used 自动算
}
```

**3. periods（三档百分比：滚动 / 周 / 月）**

```jsonc
"parse": { "kind": "periods" }
```

periods 形态不需要写字段路径：解析器会自动找响应里的
`usage.rolling / usage.weekly / usage.monthly`，每档取 `percent` / `resetsAt` / `status`。
只要你的供应商接口返回类似 `{ "usage": { "weekly": { "percent": 68 } } }` 的结构，
直接用 periods 即可，不用写路径。

### 字段路径怎么写

用「点号 + 方括号」从响应根一层层往下指：

- `data.balance` → `{ "data": { "balance": 110 } }` 里的 110
- `balance_infos[0].total_balance` → 数组第一项的 total_balance
- `data.credits.total` → 嵌套对象

数字可以是 number，也可以是能转成数字的字符串（很多网关余额字段是 `"110.00"` 这种字符串）。

## 完整示例

### 示例一：某 OpenAI 兼容网关返回 `{ data: { balance: 12.5, currency: "USD" } }`

```json
{
  "probes": [
    {
      "name": "我的网关",
      "match": { "baseUrlContains": ["gateway.example.com"] },
      "request": { "path": "/v1/balance" },
      "parse": {
        "kind": "balance",
        "valuePath": "data.balance",
        "currencyPath": "data.currency"
      }
    }
  ]
}
```

### 示例二：OpenRouter（额度点数）

```json
{
  "probes": [
    {
      "name": "OpenRouter",
      "match": { "baseUrlContains": ["openrouter.ai"] },
      "request": { "path": "/credits" },
      "parse": {
        "kind": "credits",
        "remainingPath": "data.total_credits",
        "usedPath": "data.total_usage"
      }
    }
  ]
}
```

> 提示：不同网关字段名可能不同，以上示例里的字段名请以官方文档或实际抓包为准。

## 排查清单

- 供应商卡片底部用量行完全没显示：先看弹窗是否命中「已内置」；未命中就看模板选对没有；
- 显示「用量暂时不可用」：接口字段路径没对上，把脱敏后的响应 JSON 发给 AI 帮你对齐；
- 显示「用量查询未开启」：弹窗里的启用开关没开（或之前显式关闭过），打开即可；
- 显示「当前 provider 暂不支持用量查询」：说明没有匹配到任何探针。检查
  `match.baseUrlContains` 里的关键字，是不是和 `models.json` 里那个 provider 的
  `baseUrl` 完全不一致（注意大小写、是否带 `/v1`）。
- 配置写错了 JSON：主进程会忽略整条非法探针并在日志里提示，不会影响内置探针。
- 余额显示成「0」：可能字段取错了位置，或接口返回的字段本身是「已用」而不是「剩余」。
