---
name: mcp-setup
description: 帮用户接入/配置 MCP（Model Context Protocol）服务。当用户说「帮我接 MCP」「连上某个服务的 MCP」「配置 Model Context Protocol」「加个工具服务器」「为什么 MCP 连不上」等时使用。按服务官方文档把配置写进 pi 的 mcp.json，并用 pi mcp list 验证连接，全程不破坏用户已有配置。
---

# MCP 配置助手（mcp-setup）

帮用户把 MCP 服务接进 pi。核心原则：**每一步以服务官方文档为准，只改 mcp.json 里属于该服务的条目，改完必须验证。**

## 工作流总览

1. 弄清用户想接什么服务、拿来做什么；
2. 查该服务**官方**的 MCP 接入文档（官网 docs / 官方 GitHub README；优先官方源，不用第三方目录的转述）；
3. 按下方 schema 生成配置，写入 `~/.pi/agent/mcp.json`（全局）或项目 `.pi/mcp.json`（仅当前项目）；
4. 运行 `pi mcp list` 验证；需要 OAuth 的引导用户去 PiDeck 界面点「登录」；
5. 向用户汇报：加了什么、写到哪、怎么验证、如何撤销。

## pi 的 mcp.json 结构（唯一权威 schema）

文件是一个 JSON 对象，键 `mcpServers`，值是「服务名 → 定义」映射：

```json
{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp" },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@brave/brave-search-mcp-server"],
      "env": { "BRAVE_API_KEY": "..." }
    }
  }
}
```

每个服务定义二选一传输：

- **远程 HTTP**：`url`（必填，http/https）、`headers`（可选，如 `{"Authorization": "Bearer <key>"}`）；
- **本地 stdio**：`command`（必填）、`args`、`env`、`cwd`（可选）。

通用可选：`enabled`（布尔，false 则不连接）、`description`、`timeout`（秒）、`exposure`/`toolExposure`（工具暴露方式，默认不用写）。

**不要手写的字段**：`oauth`（clientId/clientSecret 等七字段）只在服务商明确要求预注册客户端时才写；pi 的 MCP OAuth 默认零配置，动态客户端注册自动完成。`auth.provider` 是复用 pi 模型供应商凭据的高级能力，仅全局配置可用，除非用户明确要求否则不要写。

## 认证形态判定（按官方文档，不猜）

| 服务方文档说 | 写法 |
|---|---|
| OAuth / 浏览器登录 / 无需 token | 只写 `url`；连接后 `pi mcp list` 显示 needs-auth，引导用户在 PiDeck「配置 → MCP」对应服务行点「登录」 |
| API Key / PAT，放请求头 | `headers: {"Authorization": "Bearer <key>"}`（或文档指定的自定义头名） |
| API Key 放环境变量 | stdio：`env: {"<文档规定的变量名>": "<key>"}` |
| 无认证 | 只写传输字段 |
| 需要 Docker | `command: "docker"`，args 按文档；先确认用户有 Docker |

## 写文件规则（防止破坏用户配置）

1. **先读后写**：读整个 mcp.json，解析 JSON；解析失败立即停手，让用户先在 PiDeck「源文件」页修复，绝不猜着覆盖；
2. **合并而非覆盖**：只新增/替换本次服务的键，其余条目原样保留；
3. **保格式**：写回时 2 空格缩进、键序尽量维持原样；
4. **密钥安全**：密钥值直接写入文件（mcp.json 是明文，这是 pi 的存储方式）；但**不要**把密钥回显到对话或日志里；
5. 项目级 `.pi/mcp.json` 只放该项目需要的覆盖，同名条目会遮蔽全局定义。

## 验证与收尾

```bash
pi mcp list          # 人读形态：每个服务的连接状态/工具数
pi mcp list --json   # 程序化形态
```

- `connected`（带工具数）→ 成功；告诉用户工具经 tool_search 可发现，正常对话即可用；
- `needs-auth` → 指导用户打开 PiDeck「配置 → MCP」，该服务行会出现「登录」按钮（或用 `pi mcp login <服务名>`）；
- `error` → 读错误信息定位：URL 打错 / 密钥无效 / npx 包名错 / Node 缺失。stdio 服务首次连接会 npx 拉包，稍慢是正常的；
- 修改的是**正在运行会话**读不到的：新配置从下一个会话/下一轮对话生效。

最后汇报三件事：写入了什么（服务名 + 字段清单，密钥打码）、验证结果、撤销方法（删掉 mcpServers 里对应键）。

## 常见坑

- npx 包名带 `@latest` 的按文档原样保留，不要自作聪明去掉；
- Windows 下 stdio 服务若失败，优先怀疑路径空格与杀毒软件拦截 npx；
- 远程 URL 末尾斜杠按官方文档原样写（如 `https://api.githubcopilot.com/mcp/`）；
- 服务方同时提供「远程托管」和「本地 stdio」两种时，默认选远程托管（免维护、随官方更新）；用户明确要本地/自托管时才选 stdio。
