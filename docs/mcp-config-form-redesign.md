# MCP 配置表单、服务目录与 AI 代配

> 状态：内置服务目录（25 个：24 个外部服务 + PiDeck 本机服务）+ 认证驱动表单 + AI 配置助手技能已实现。目录条目的接入方式逐项按服务官方文档核实；「已按官方文档核实」不等于「已在 PiDeck 真实环境逐项连接验证」。

## 调研结论（2026-10，业界客户端）

| 产品 | 新增路径 | 认证 | 目录 |
|---|---|---|---|
| VS Code | `MCP: Add Server` 向导 + `.mcpb` 一键安装 + mcp.json IntelliSense | 启动时该登录就弹登录 | `MCP: Browse MCP Servers` gallery |
| Cursor | 概览列表 + Marketplace 官方插件一键装 | OAuth 全自动；`${env:}` 引用密钥 | cursor.directory「Add to Cursor」深链 |
| Claude | Connectors（远程审核制）+ `.mcpb`（本地一键装） | OAuth 内联 | 官方连接器目录 |
| **PiDeck 取法** | 目录条目（推荐）+ 粘贴识别（智能添加）+ 手动高级表单 | 认证由条目声明：none 直接用 / OAuth 点登录 / 密钥写声明位置 | 内置 25 个精选目录，按分类分组 |

共同答案：① 目录/向导优先，字段最少化；② 认证是声明/检测出来的，不是让用户猜的；③ 高级字段进折叠或 JSON。AI 辅助配置的业界形态是 **Agent Skills**（Claude Code / Cursor / VS Code / pi 共用同一 SKILL.md 规范）——PiDeck 据此内置 `mcp-setup` 技能。

## 第一部分：新增服务交互（三条入口）

1. **目录推荐（默认）**：左栏下方按「开发 / 协作 / 商业数据 / 出行 / 搜索 / 设计」分组列出 25 个服务；已配置（与默认名同名）打 ✓。点选后右栏出现该服务的专属表单，字段由条目的认证声明驱动：
   - `none`：只有名称，直接「添加并保存」；
   - `oauth`：只有名称 + 「保存后在状态区点登录」提示（Linear/Notion/Sentry/Supabase/Figma）；
   - `header-key` / `env-key`（必填）：名称 + 遮罩密钥框，提示密钥落点（`Authorization: Bearer <key>` / 原样写入的指定头 / 指定环境变量）与明文存储（GitHub/Brave/腾讯文档/Exa/企查查/百度网盘）；
   - `credentialOptional`（Context7/Firecrawl/Exa）：密钥框可留空，提示 keyless 有额度限制。
2. **智能添加**：粘贴 URL / 命令行 / JSON 片段自动识别（原有能力保留）。
3. **AI 代配**：智能添加面板底部「让 AI 帮你配」——一键安装内置 `mcp-setup` 技能到 `~/.pi/agent/skills/`，之后在任意会话说「帮我接 Notion 的 MCP」或 `/skill:mcp-setup`，AI 按技能指引查官方文档、写配置、验证连接。

模板只创建新条目，不覆盖同名服务；名称冲突自动追加序号。添加后写入当前作用域的 Pi 原生 `mcp.json` 并刷新连接状态。

## 第二部分：外部服务目录（24 个，接入方式按官方文档核实）

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

### 搜索、文档与商业数据批次（2026-10 第二批）

| 服务 | 分类 | 传输 | 认证 | 凭据落点 | 官方参考 |
|---|---|---|---|---|---|
| 百智云 Agent 工具包 | 搜索 | `https://agent-toolkit.app.baizhi.cloud/mcp` | API Key 必填 | `Authorization: Bearer` | [百智云接入指南](https://agent-toolkit.app.baizhi.cloud/access-guide) |
| Tavily Search | 搜索 | `https://mcp.tavily.com/mcp/?tavilyApiKey=<KEY>` | API Key 必填 | query `tavilyApiKey` | [Tavily MCP](https://docs.tavily.com/documentation/mcp) |
| Exa Search | 搜索 | `https://mcp.exa.ai/mcp` | `x-api-key` 头（可留空，keyless 限速） | `x-api-key`（**原值**） | [Exa MCP](https://docs.exa.ai/reference/exa-mcp) |
| 腾讯文档 | 协作 | `https://docs.qq.com/openapi/mcp` | MCP Token 必填 | `Authorization`（**原值，加 Bearer 会被判 400006**） | [腾讯文档开放平台 · 获取 MCP token](https://docs.qq.com/open/document/mcp/get-token) |
| 百度网盘 | 协作 | `npx -y mcp-remote@latest https://mcp-pan.baidu.com/sse`（桥接） | OAuth Access Token 必填 | env `BAIDU_NETDISK_ACCESS_TOKEN`（args 里 `${...}` 引用） | [baidu-netdisk/mcp](https://github.com/baidu-netdisk/mcp) |
| 企查查（工商信息） | 商业数据 | `https://agent.qcc.com/mcp/company/stream` | API Key 必填 | `Authorization: Bearer` | [企查查智能体数据平台](https://agent.qcc.com/guide) |

**百智云接入说明**：官方接入指南以工具包站点 origin + `/mcp` 生成远程地址，要求 `Authorization: Bearer <API Key>`（2026-10-12 核对）。在目录「搜索」分类选中条目，输入原始 Key，再点击「添加并保存」；需要百智云账号和服务积分，工具调用会发送输入并可能扣减积分。密钥沿用下述当前作用域明文存储方式。官方端点的真实服务连接、工具调用及计费未在本次离线验证中验收。

![百智云目录与认证表单](images/baizhi-mcp-catalog.png)

截图来自上述真实目录和表单组件的隔离浏览器验证，使用合成密钥与保存回调；不是完整 Electron 桌面端或真实百智服务验收。

**第二批调研备注**：企业微信官方 MCP 配置由客户端按权限逐条生成（工作台 → 智能机器人 → 编辑 → 可使用权限 → 复制 MCP url / JSON），没有固定端点，只能走「智能添加」粘贴官方复制出来的配置；携程问道与东方财富妙想官方只有 Skill / API Key 形态（`WENDAO_API_KEY`、`EASTMONEY_APIKEY`），不提供 MCP 端点，均未收入目录。百度网盘官方远程端点只有 SSE（`/sse` + `/message` 是旧传输），pi 只支持 streamable HTTP，所以条目用 `mcp-remote` 桥接（先试 streamable HTTP，405 回退 SSE，`Authorization` 由 `--header` 同时交给两条路）；上传本地文件仍需按官方文档另部署 Python stdio 服务。企查查按模块提供 10 个 streamable 端点（company/risk/ipr/operation/history/executive/regulation/case/tender/document），目录只收工商信息一条，其余复制条目改地址后缀即可。

**目录维护规则**：新增/修改条目必须先核对服务官方文档（接入端点、认证形态、凭据写入位置），在 `tests/mcpServiceCatalog.test.mjs` 同步登记 id 与声明；服务方变更接入方式时更新条目并注明来源。选择标准：官方维护、无需用户自建服务、覆盖桌面工作台高频场景（文档/浏览器/代码/协作/搜索/设计）。

**品牌图标**：优先取官方图形——官方站点/CDN 导出的 SVG（Tavily mark）、simple-icons（CC0，经 iconify API 获取）、官方品牌图集 logos（Exa）；钉钉用阿里 Ant Design 官方品牌图形（1024 网格）、飞书用官方 CDN 彩色四色 logo（16 网格，multiPaths 多段 fill）；均内联在 `mcpServiceBrandIcons.tsx`（零新依赖、离线可用）。非 24 网格/非正方形画板用条目自带的 `viewBox` 声明（Tavily 55×55、Exa 256×256），列表行内按 meet 等比缩放；PiDeck 自己的 π 标归一到 24 网格，与其它图标同为 14px 满格。腾讯文档/企查查/百度网盘官方只发位图（站点 logo / app 图标），条目的 `png` 字段内联官方图标的 data URI（≤96px、约 1KB，按官方圆角遮罩去白底）。github/notion/sentry/tavily/piDeck 原色过暗，改用主题文字色随明暗自适应；拿不到任何官方图形源的服务（context7/firecrawl/高德/腾讯地图/12306，高德官方 SVG 为横条全字 logo 不适合小尺寸）回退 lucide 通用图标，新增服务时在守卫测试登记归属。

## 通用配置边界（不变项）

- 自定义入口继续接受 HTTP(S) URL、命令行和 JSON 配置片段；完整 Pi MCP 能力可通过 JSON 或源文件编辑。
- `auth.provider` 只在全局 HTTP 服务的高级区域可设置，复用 Pi 模型供应商凭据；项目配置不能指定它。
- OAuth 客户端参数（`clientId`、`clientSecret` 等）不进入普通表单。通过 JSON 或源文件导入时保留原值。例外是 `oauth.clientName`：授权服务器对动态注册做客户端白名单校验的服务（目前只有 Figma，见下节）由目录条目自动写入，模板表单只读展示实际值。

## 动态客户端注册白名单（Figma）

Figma 的注册端点 `https://api.figma.com/v1/oauth/mcp/register` 对 `client_name` 做白名单校验，未收录的客户端直接回裸文本 `Forbidden`（连 JSON 错误都不是），pi 侧表现为 `OAuth dynamic client registration failed with status 403: Forbidden`。2026-10 实测：`pi` / `Cursor` / `VS Code` / 随机名 → 403；`Claude Code` / `Codex` / `Claude Desktop` / `JetBrains Junie` → 200。

- 登记点：`mcpServiceCatalog.ts` 的 `MCP_DCR_CLIENT_NAME_OVERRIDES`（`figma: "Claude Code"`），由 `buildCatalogBase` 注入 `oauth.clientName`，`buildCatalogDefinition` 与模板保存共用同一条路径。
- 表单**不展示**任何提示文案（用户看这些只会烦）：覆盖值静默生效，排查入口在本文与代码注释。
- 已保存过的 figma 条目不会自动改：`pi mcp logout figma` 后删掉条目重加（或手改 `mcp.json` 加 `oauth.clientName`）再登录。
- 其余 OAuth 目录条目（Sentry / Supabase / Linear / Notion / Context7 / Exa）实测 `client_name: pi` 均放行（201/200），**不要**顺手加 clientName 覆盖；新增条目登录报 403 且正文是裸文本时，按同一方法换名试注册确认后再登记。
- 独立 `pi mcp list` 状态不等同于正在运行会话的实时状态。

## 密钥存储说明（对用户如实告知）

目录密钥输入框使用遮罩；模板输入、URL、headers、env、手动 JSON 或源文件中的凭据都会以明文保存到当前作用域的 Pi 原生 `mcp.json`。遮罩只影响模板输入框的屏幕显示，PiDeck 不会将这些值存入系统密钥库。

## 验证

- `npm run typecheck`
- `node --test tests/mcpServiceCatalog.test.mjs tests/mcpConfigUi.test.mjs tests/mcpForm.test.mjs`
- `npm run check:format`
- `node scripts/generate-content-manifests.mjs --domain skills`（新增 mcp-setup 技能后重新生成清单；缺 `--domain` 会直接报错）
