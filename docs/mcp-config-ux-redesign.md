# MCP 配置体验重设计（提案 → 已确认方向）

> 状态：**已完成并验收（2026-10-04）**。追加：MCP 页布局简化为两栏（左=服务列表带状态/登录入口，右=配置详情），独立「连接状态」面板移除（状态融入列表行，保存/打开自动检测）。来源：用户对 MCP 页的三点反馈
> （字段不清晰 / 登录藏在检测后面 / 界面繁杂）+ Claude、VS Code、Cursor 三家调研。
> 实施时逐片回填状态；全部合并后收口（结论并回 project-resource-ui-improvements.md）。

## 0. 用户心智模型（一切设计的基准）

接一个 MCP 只有三种输入，其余全是噪音：

1. **粘贴 URL**（远程服务，90% 场景）→ 可能要点一次「登录」→ 完
2. **粘贴命令行**（本地 stdio，如 `npx -y @example/mcp`）→ 可能要在 env 里放个 Key → 完
3. **粘贴 JSON**（从服务器文档复制）→ 完

## 1. pi 的字段面（速查，来源：mcpConfig.ts 校验逐条核实）

**传输二选一**：
- 远程 HTTP（streamable）：`url` 必填；`headers` 可选
- 本地 stdio：`command` 必填；`args`、`env`、`cwd` 可选

**通用可选**：`enabled`、`description`、`timeout`、`exposure`/`toolExposure`

**认证四选一**（仅远程 HTTP）：
| 方式 | 配什么 | 场景 |
|---|---|---|
| 无 | —— | 公共服务（beui 等） |
| OAuth 自动 | 点「登录」；高级七字段（clientId/clientSecret/clientName/callbackUrl/callbackPort/scope/authServerMetadataUrl/clientRegistration）仅预注册客户端才需要 | Linear/Notion/Sentry |
| API Key | `headers.Authorization: Bearer <key>`（或服务器指定头） | 私有部署/网关 |
| 供应商登录 | `auth.provider`（全局 only，https/环回 only） | 服务器接受 pi 供应商凭据 |

## 2. 三家调研结论

| 产品 | 添加 | 认证 | 高级字段 |
|---|---|---|---|
| Claude connectors | 粘 URL → **自动连接并检测认证方式** → 用户确认 → OAuth 内联 | 检测驱动，UI 明示「检测到的认证方式」 | 不进 UI（审核制） |
| VS Code | `MCP: Add Server` 向导：类型 → URL/命令 → 名字 | 启动时**该登录就弹登录**；列表有状态指示 | mcp.json + IntelliSense |
| Cursor | 列表页 + 选类型添加，远程只填 URL | OAuth 远程全自动；静态密钥 `${env:}` | JSON 手配 |

**共同答案**：① 先选类型再出表单，默认只露 1-2 个字段；② 认证是**检测出来的不是配置出来的**，需要登录就直接给登录按钮；③ 高级字段进 JSON/折叠。行业另有「粘贴 JSON」惯例（文档给 JSON、用户复制）。

## 3. 已确认的设计决策

1. **智能添加**：一个粘贴框认三种输入——URL / 命令行（整行拆 command+args）/ JSON 片段（单条或整块）；名称自动生成（域名/包名）。
2. **状态卡常驻编辑器顶部**：保存后自动检测；`✅ 已连接·N 工具` / `🔑 需要登录→[登录]` / `⚠️ 失败→详情+重试` / `⚫ 已登录→[登出]`（复用 oauthCredentialNames / mcpListStatus / mcpLogin / mcpLogout）。登录不再藏在「检测连接」后面。
3. **编辑区四层**：名称+开关 → 状态卡 → 传输（按类型只露对应字段）→ 认证四选卡片（无/OAuth/API Key/供应商登录）。
4. **字段分层（按使用频率）**：`env`（stdio 放 Key，高频）留主表单可选区；`headers` 并入认证卡「API Key」项；`timeout`/`exposure`/`toolExposure`/OAuth 高级/`cwd` 进「高级」折叠。
6. **供应商清单零维护**：认证页由 pi-auth-host import 用户安装的 pi 本体枚举供应商；MCP 页下拉读 auth.json 键名（已登录供应商）。pi 新增供应商零改动同步。
5. **不做自维护 MCP 目录**：登录能力由服务器侧 401 声明、客户端自动响应，新服务零成本支持；协议面跟随 pi（升级后跑 smoke-pi-native-resources + diff `pi mcp --help`）。若未来 pi 提供官方目录再接。
6. **供应商登录的供应商清单零维护**：认证页由 pi-auth-host 直接 `import` 用户安装的 pi 本体（ModelRuntime）枚举；MCP 页下拉读 auth.json 键名（=已登录供应商）。pi 新增供应商自动出现，PiDeck 不持有清单；唯一耦合是 auth.json 结构约定（变更时下拉变空，可见失败）。

## 4. 分片实施

- **A 智能添加 ✅（2026-10-04）**：`parseSmartAddInput`/`suggestNameFrom*`/`uniqueServerName` 纯函数进 mcpForm（18 断言）；新增 `McpSmartAdd` 组件作为未选中时的默认编辑区内容；「添加并保存」走统一乐观锁保存并自动跑检测连接。
- **B 状态卡 → 按用户反馈回退**：不在编辑器顶部加卡；登录入口回到全量状态面板行内——保存后自动检测，needs-auth 行直接出现「登录」按钮（体验等价：保存即见登录入口）。状态行抽为 McpStatusRow 组件（面板复用）。
- **C 认证简化 ✅（形变落地）**：按用户决策「OAuth 写回是自动的，用户不该填」——OAuth 七字段表单整体移除（数据层照常保留：粘贴/导入的 oauth 字段保存不丢，预设时显示一行只读提示）；认证区=供应商登录开关卡片 + 两行说明（自动登录 / API Key 走 headers）。原计划的「四选卡片」不再需要。
- **D 高级抽屉 → 缩减**：最大的简化（OAuth 字段移除）已随 C 落地；timeout/exposure/toolExposure 暂留主表单（用户未再抱怨），后续如需再收。

## 5. 验收口径

- 新增 beui：粘 URL → 保存 → 状态卡 ✅，全程不滚动、不见高级字段；
- 新增 linear（有账号时）：粘 URL → 保存 → 状态卡 🔑 → 点登录 → 浏览器授权 → ✅；
- 粘 `npx -y @example/mcp`：自动拆 command/args，env 区可加 Key；
- 粘 JSON：整块导入多 server，名称取键名；
- API Key 服务器：认证卡选 API Key → 填 key → 保存后 headers 正确落盘；
- 高级抽屉默认全收起；回归：保存/冲突/未信任提示不受影响。
