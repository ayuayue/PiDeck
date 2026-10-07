# MCP 配置表单、服务目录与 AI 代配

> 状态：内置服务目录（11 个）+ 认证驱动表单 + AI 配置助手技能已实现。目录条目的接入方式逐项按服务官方文档核实；「已按官方文档核实」不等于「已在 PiDeck 真实环境逐项连接验证」。

## 调研结论（2026-10，业界客户端）

| 产品 | 新增路径 | 认证 | 目录 |
|---|---|---|---|
| VS Code | `MCP: Add Server` 向导 + `.mcpb` 一键安装 + mcp.json IntelliSense | 启动时该登录就弹登录 | `MCP: Browse MCP Servers` gallery |
| Cursor | 概览列表 + Marketplace 官方插件一键装 | OAuth 全自动；`${env:}` 引用密钥 | cursor.directory「Add to Cursor」深链 |
| Claude | Connectors（远程审核制）+ `.mcpb`（本地一键装） | OAuth 内联 | 官方连接器目录 |
| **PiDeck 取法** | 目录条目（推荐）+ 粘贴识别（智能添加）+ 手动高级表单 | 认证由条目声明：none 直接用 / OAuth 点登录 / 密钥写声明位置 | 内置 11 个精选目录，按分类分组 |

共同答案：① 目录/向导优先，字段最少化；② 认证是声明/检测出来的，不是让用户猜的；③ 高级字段进折叠或 JSON。AI 辅助配置的业界形态是 **Agent Skills**（Claude Code / Cursor / VS Code / pi 共用同一 SKILL.md 规范）——PiDeck 据此内置 `mcp-setup` 技能。

## 第一部分：新增服务交互（三条入口）

1. **目录推荐（默认）**：左栏下方按「开发 / 协作 / 搜索 / 设计」分组列出 11 个服务；已配置（与默认名同名）打 ✓。点选后右栏出现该服务的专属表单，字段由条目的认证声明驱动：
   - `none`：只有名称，直接「添加并保存」；
   - `oauth`：只有名称 + 「保存后在状态区点登录」提示（Linear/Notion/Sentry/Supabase/Figma）；
   - `header-key` / `env-key`（必填）：名称 + 遮罩密钥框，提示密钥落点（`Authorization: Bearer <key>` 请求头或指定环境变量）与明文存储（GitHub/Brave）；
   - `credentialOptional`（Context7/Firecrawl）：密钥框可留空，提示 keyless 有额度限制。
2. **智能添加**：粘贴 URL / 命令行 / JSON 片段自动识别（原有能力保留）。
3. **AI 代配**：智能添加面板底部「让 AI 帮你配」——一键安装内置 `mcp-setup` 技能到 `~/.pi/agent/skills/`，之后在任意会话说「帮我接 Notion 的 MCP」或 `/skill:mcp-setup`，AI 按技能指引查官方文档、写配置、验证连接。

模板只创建新条目，不覆盖同名服务；名称冲突自动追加序号。添加后写入当前作用域的 Pi 原生 `mcp.json` 并刷新连接状态。

## 第二部分：内置服务目录（18 个，接入方式按官方文档核实）

### 国际服务（首批）

| 服务 | 分类 | 传输 | 认证 | 凭据落点 | 官方参考 |
|---|---|---|---|---|---|
| Context7 | 开发 | `https://mcp.context7.com/mcp` | Bearer 头（可选提额） | `Authorization` | [upstash/context7](https://github.com/upstash/context7) |
| Playwright | 开发 | `npx @playwright/mcp@latest` | 无 | — | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) |
| Chrome DevTools | 开发 | `npx -y chrome-devtools-mcp@latest` | 无 | — | [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) |
| GitHub | 开发 | `https://api.githubcopilot.com/mcp/` | PAT 必填 | `Authorization: Bearer` | [github/github-mcp-server](https://github.com/github/github-mcp-server) |
| Sentry | 开发 | `https://mcp.sentry.dev/mcp` | OAuth | — | [getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp) |
| Supabase | 开发 | `https://mcp.supabase.com/mcp` | OAuth（动态注册） | — | [Supabase MCP 文档](https://supabase.com/docs/guides/ai-tools/mcp) |
| Linear | 协作 | `https://mcp.linear.app/mcp` | OAuth 2.1 | — | [Linear MCP 文档](https://linear.app/docs/mcp) |
| Notion | 协作 | `https://mcp.notion.com/mcp` | OAuth | — | [Notion Remote MCP](https://developers.notion.com/docs/mcp) |
| Brave Search | 搜索 | `npx -y @brave/brave-search-mcp-server --transport stdio` | API Key 必填 | `env.BRAVE_API_KEY` | [brave/brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server) |
| Firecrawl | 搜索 | `https://mcp.firecrawl.dev/mcp` | Bearer 头（可选提额） | `Authorization` | [Firecrawl MCP](https://docs.firecrawl.dev/mcp-server) |
| Figma | 设计 | `https://mcp.figma.com/mcp` | OAuth | — | [Figma Remote MCP](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation) |

### 国产服务（2026-10 批次，调研 WorkBuddy / 火山引擎 / 魔搭生态后接入）

| 服务 | 分类 | 传输 | 认证 | 凭据落点 | 官方参考 |
|---|---|---|---|---|---|
| 飞书 (Lark) | 协作 | `npx -y @larksuiteoapi/lark-mcp mcp` | 双凭据 | args `-a <AppID>` / `-s <AppSecret>` | [larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp) |
| 钉钉 | 协作 | `npx -y dingtalk-mcp@latest` | 双凭据 | env `DINGTALK_Client_ID` / `DINGTALK_Client_Secret` | [钉钉开放平台](https://open.dingtalk.com/document/ai-dev/second-level-node-1) |
| 支付宝开放平台 | 协作 | `npx -y @alipay/mcp-server-alipay` | 三凭据 | env `AP_APP_ID` / `AP_APP_KEY` / `AP_PUB_KEY` | [@alipay/mcp-server-alipay](https://www.npmjs.com/package/@alipay/mcp-server-alipay)（官方 npm scope；另有沙箱模式可编辑 mcp.json 启用） |
| 高德地图 | 出行 | `https://mcp.amap.com/mcp?key=<KEY>` | URL Key | query `key` | [高德 MCP](https://lbs.amap.com/api/mcp-server/gettingstarted) |
| 腾讯地图 | 出行 | `https://mcp.map.qq.com/mcp?key=<KEY>` | URL Key | query `key` | [腾讯位置服务 MCP](https://lbs.qq.com/service/MCPServer/MCPServerGuide/userGuide) |
| 12306 购票查询 | 出行 | `npx -y 12306-mcp` | 无 | — | [Joooook/12306-mcp](https://github.com/Joooook/12306-mcp)（社区，仅查询） |
| 魔搭 ModelScope | 开发 | `uvx modelscope-mcp-server` | Token | env `MODELSCOPE_API_TOKEN` | [modelscope-mcp-server](https://github.com/modelscope/modelscope-mcp-server)（依赖 Python uv） |

**国产批次调研备注**：WorkBuddy（腾讯）与豆包（火山）是 Agent 平台而非 MCP 提供方；火山引擎 MCP 为云运维向、豆包搜索需企业版 Key，暂不收入。支付宝官方重心已部分转向「支付集成 Skill」（魔搭 Skills 中心），MCP 版仍维护。

**目录维护规则**：新增/修改条目必须先核对服务官方文档（接入端点、认证形态、凭据写入位置），在 `tests/mcpServiceCatalog.test.mjs` 同步登记 id 与声明；服务方变更接入方式时更新条目并注明来源。选择标准：官方维护、无需用户自建服务、覆盖桌面工作台高频场景（文档/浏览器/代码/协作/搜索/设计）。

**品牌图标**：优先取官方图形——simple-icons（CC0，经 iconify API 获取）收录 12 个；钉钉用阿里 Ant Design 官方品牌图形（1024 网格）、飞书用官方 CDN 彩色四色 logo（16 网格，multiPaths 多段 fill）；均内联在 `mcpServiceBrandIcons.tsx`（零新依赖、离线可用）。github/notion/sentry 原色过暗，改用主题文字色随明暗自适应；simple-icons 未收录且无官方图形源的服务（context7/firecrawl/高德/腾讯地图/12306——高德官方 SVG 为横条全字 logo 不适合小尺寸）回退 lucide 通用图标，新增服务时在守卫测试登记归属。

## 通用配置边界（不变项）

- 自定义入口继续接受 HTTP(S) URL、命令行和 JSON 配置片段；完整 Pi MCP 能力可通过 JSON 或源文件编辑。
- `auth.provider` 只在全局 HTTP 服务的高级区域可设置，复用 Pi 模型供应商凭据；项目配置不能指定它。
- OAuth 客户端参数（`clientId`、`clientSecret` 等）不进入普通表单。通过 JSON 或源文件导入时保留原值。
- 独立 `pi mcp list` 状态不等同于正在运行会话的实时状态。

## 密钥存储说明（对用户如实告知）

目录密钥输入框使用遮罩；模板输入、URL、headers、env、手动 JSON 或源文件中的凭据都会以明文保存到当前作用域的 Pi 原生 `mcp.json`。遮罩只影响模板输入框的屏幕显示，PiDeck 不会将这些值存入系统密钥库。

## 验证

- `npm run typecheck`
- `node --test tests/mcpServiceCatalog.test.mjs tests/mcpConfigUi.test.mjs tests/mcpForm.test.mjs`
- `npm run check:format`
- `node scripts/generate-content-manifests.mjs`（新增 mcp-setup 技能后重新生成清单）
