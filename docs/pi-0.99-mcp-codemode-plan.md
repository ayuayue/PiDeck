# pi 原生资源管理与 MCP / Codemode 收尾执行计划

> 状态：**计划已整理，业务实现待执行**。这是本任务唯一执行计划；文件名保留，内容已按最新讨论完整重写。
> 目标：以 **pi 0.99.2** 为本轮适配与验收基线，普通扩展包、独立扩展、skills、prompts 改用 pi 原生配置控制；完成全局与项目管理，并修正上一轮未收尾的 MCP / codemode 适配。
> 本轮仅修改计划与兼容账本，没有执行用户配置迁移、修改业务代码、安装依赖或重启应用。

## 0. 给执行模型的起步说明

### 0.1 已确定的产品决定

1. **日常启停采用 pi 原生配置**。最终正常会话不再通过 `--no-extensions/--no-skills/--no-prompt-templates` 加全量路径白名单控制普通资源。
2. **全局页面只管理当前 pi 环境的全局配置；项目右键资源管理固定管理所选项目**。项目操作不得偷偷写全局，也不增加来回切作用域的下拉。
3. **扩展包总开关表示整包启停**：包声明的 extensions、skills、prompts、themes 一起停用；重新启用恢复停用前的资源过滤。独立文件扩展没有“附带技能”的推断关系，不按名称猜关联。
4. **PiDeck 自带扩展仅供 PiDeck**：继续随桌面会话附加，不安装到 pi 用户资源目录、不创建 TUI 共享包、不把应用资源路径持久化到 pi 的全局 `packages/extensions`。
5. **pi 原生内置扩展必须有图形开关**：mcp、codemode、tool-search、llama.cpp；全局和项目均支持，按原生 `builtin:` 规则保存。此项是必做，不再标“可选”。
6. **MCP 全局和项目都可管理**。项目 MCP 写 `.pi/mcp.json`，不是 `.pi/settings.json`。这取代旧计划“只做全局 MCP”的范围。
7. **MCP OAuth、登出、连接检测统一调用 `pi mcp` CLI**，不通过 RPC 发 `/mcp login`，不另建 SDK 桥。授权链接只在登录区域内显示，不能为链接弹 toast，也不能自动再开一次浏览器。0.99.2 新增的 `auth.provider` 使用供应商既有登录凭据，属于另一种认证模式；其操作边界与该版 CLI 缺口见 7.4。
8. **工具设置继续是一项 `defaultTools` 多选字段 + codemode 子字段**，不改成每个工具一行开关。项目资源页复用这一小块，不开放整套项目模型/认证设置。
9. **第三方 MCP adapter 不再作为支持路线**：删除安装引导；检测已安装者，给卸载命令和真实导航；直接开始聊天的用户也能收到准确提醒。不自动卸载用户扩展。
10. 设置变更默认作用于**下一次启动/重启的会话**；不擅自重启正在工作的 Agent。MCP OAuth 成功后的凭据更新遵循 pi 原生下一轮读取行为。

普通资源改为原生配置后，使用同一 pi 环境、配置目录和项目的 TUI 也会遵循这些选择。这是产品行为，页面说明一次即可；PiDeck 自带扩展仍仅在桌面运行。

### 0.2 工作区基线与保护

- 制定计划时：仓库 `/home/zhadainian/PiDeck`，分支 `dev`，HEAD `46441bb2`（pi 命令来源/安装器改动）；应用 `0.7.8-beta`。
- 上一轮 MCP/codemode 改动还在工作区，包含多个 tracked 修改和新文件。**现有代码是半成品，不能整体丢掉，也不能当作已验收实现。**
- 开始时先 `git status --short`、`git diff --stat`、读相关 diff；确认 HEAD 是否又前进。保留安装器与其他并行改动，不做全工作区 stash/pop、reset、clean 或切分支来跑基线。
- 当前没有 stash 条目。历史会话用过多次 stash，这不构成继续使用的理由。
- 在当前开发分支执行。不要顺手改 DSH、CUA 业务、GUI 桥协议、安装器策略和其他无关功能。
- 用户下一次让快模型“按本计划执行”即是执行计划内代码与测试的任务指令。不要再次询问已确定的技术方案；真实外部登录、部署、发布仍按实际授权处理。
- 不把“完成一个阶段”理解成自动获准暂存/提交整个工作区；提交遵循用户当次指令和项目规则，绝不带入并行改动。

### 0.3 当前半成品：哪些可以复用，哪些仍有问题

| 范围 | 当前事实 | 执行要求 |
|---|---|---|
| 扩展/skills/prompts 启停 | 全局写 PiDeck `disabled*`；项目写 `.pi/settings.json` 的私有 `disabled*` / `pideckDisabledGlobal*`；运行时仍算白名单 | 迁移为原生规则后退出白名单，不只是换字段名 |
| PiProcess 内置恢复 | 白名单下无条件补回四个 `builtin:` | 最终删除这条补回路径；正常发现由 pi 尊重原生开关，诊断总关不得补回 |
| pi 内置扩展 UI | 尚未做 | 全局与项目都补齐 |
| MCP 配置 | 已收敛两层与 stdio/http；仍浅合并同名 server，接受无传输的 `enabled` 覆盖；校验前会丢掉部分非法值 | 修成 pi 原生语义，保留原文及未知数据 |
| MCP 导入 | `mcpTransportOf` 去掉了 socket 返回，但转换器还接受 socket、会写 `disabled` | 完整修复转换与测试 |
| MCP 表单 | 有 OAuth/toolExposure 初版；没有 callbackUrl/clientName；按可编辑名称作 key；错误显示、登出确认、去扩展页未闭环 | 见 M1–M3 |
| MCP CLI | `piMcpCli.ts` 初版没有作用域/cwd 对齐、操作 ID、取消；URL 可被分块重复/截断；JSON 开头即可压过退出错误 | 见 M2 |
| 会话提醒 | 仅看安装列表，异步诊断可能错过首轮 flush；缺 runtime 身份复核/可用导航，文案过度断言 | 以当前会话命令来源确认，见 M3 |
| defaultTools | 已有多选与纯函数；`toggleTool([], "codemode", true)` 误写成 modifier-only，恢复默认工具；子字段只认 `+codemode` | 修编码与状态显示，见 T1 |
| codemode 对象 | 编辑已知字段时重建对象，丢未知嵌套字段 | 仅 patch 当前键 |
| 备份 | 已加入 `pi/mcp-auth.json` 文件 key | 补凭据脱敏/恢复测试，不据此宣布备份验收完成 |
| 兼容账本 | 原来全部标“已完成”，包含与实现不符的说法 | 本轮已改为真实状态，交付时再逐项更新 |

## 1. 已核对的原生契约（禁止按旧计划猜）

核对目标为正式 tag **`v0.99.2`**（2026-09-30 发布，`005af57d88ee23b33778f343a9595b32e67ff788`）；本次读取本机包 `package.json` 也已确认 `0.99.2`。前轮把部分随本地包更新获得的 0.99.2 特性写在了 0.99.1 基线下，现以 tag 差异校正：`description`、`oauth.clientName`、`auth.provider`、exposure 别名合并与 namespace 规范化归属 0.99.2，不宣称 0.99.1 支持。

来源与复核方式：

- [0.99.2 发布说明](https://github.com/earendil-works/pi/releases/tag/v0.99.2)；[0.99.1 → 0.99.2 完整差异](https://github.com/earendil-works/pi/compare/v0.99.1...v0.99.2)。已核对 compare 的完整文件清单，资源 `package-manager/settings-manager` 与 RPC 命令定义未改，不能把 `/reload` 的变化当成新增 `reload_config` RPC。

- `@earendil-works/pi-coding-agent/docs/{configuration,settings,packages,skills,prompt-templates,security,cli,mcp}.md`。
- `dist/core/{package-manager,settings-manager,mcp-servers}.js`。
- `dist/modes/interactive/components/config-selector.js`（`pi config` 如何保存开关）。
- `dist/extensions/mcp/{config,cli}.js`。
- [0.99.2 MCP 文档](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/mcp.md) 与 [工具设置文档](https://github.com/earendil-works/pi/blob/v0.99.2/packages/coding-agent/docs/settings.md) 固定 tag 引用；本机包根：`/home/zhadainian/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent/`。执行环境不同则先定位实际包并读取版本；不要把此绝对路径写入生产代码/常规测试。

### 1.1 资源配置

- 默认 agent 目录为 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 改变。项目目录为运行 cwd 下的 `.pi`。
- `extensions/skills/prompts/themes` 支持 `!pattern` 排除、`+path` 精确包含、`-path` 精确排除。全局这三类覆盖的优先级不是“任意最后一条赢”：排除 → 精确包含 → 精确排除。
- `packages` 条目可以是 source 字符串，也可以是 `{source, extensions?, skills?, prompts?, themes?, autoload?}`。普通包：某类字段省略表示沿用包声明，`[]` 表示不加载该类。
- 项目同身份包一般替换全局包；`autoload:false` 表示对全局包作项目差量覆盖，**此时 `[]` 是没有覆盖，不是禁用全部**。
- 包身份：npm 按包名（版本不构成另一身份），git 按仓库（ref 不构成另一身份），本地包按解析后的绝对路径。不要按展示名称或当前安装目录版本生成身份。
- 对继承的全局独立文件作项目覆盖：`pi config` 会在项目列表中放入该文件的显式路径及对应 `+/-` 条目；只写相对项目的 `-文件名` 通常匹配不到全局资源。
- pi 内置扩展默认加载；`-builtin:mcp` 等可停用。项目 `+/-/!` 匹配可覆盖全局。`-e builtin:...` 是显式加载，会越过普通发现的关闭结果，因此不要再无条件传入。
- skills 的 `disable-model-invocation` 表示只允许用户显式调用，与“完全不加载”分开；普通开关表示后者。
- 项目信任未通过时，项目配置与资源不应参与执行。安装/连接不是单纯查看，必须复用现有信任门禁。

### 1.2 MCP

- 全局 `<agentDir>/mcp.json` + 已信任项目 `<cwd>/.pi/mcp.json`；**项目同名定义整体替换全局定义，不浅合并**。
- `enabled:false` 也必须包含有效传输；单独 `{enabled:false}` 是非法条目，不能拿来覆盖全局 server。
- `type:sse` 不支持，socket 不支持。HTTP 可用 `type:http|streamable-http`，stdio 可用 `type:stdio`，type 可省略。
- 名称原生正则为 `^[A-Za-z0-9_-]+$`，允许下划线/短横线开头；名称中 `-` 与 `_` 归一后命名空间碰撞要报告。不能保留当前无依据的“字母数字开头、最多 64 字符”规则。
- `codemode-deferred` 是 `codemode` 的兼容别名。新表单提供四个 canonical 值；旧值能读，不能因打开页面就重写文件。
- `toolExposure` 精确名称优先；通配模式只有 `*`，多模式按原始顺序首个命中。不得排序这个对象来“格式化”。
- **不是所有 `auth` 都是 adapter 遗留字段**：0.99.2 支持 HTTP `auth:{provider}`，配置文件里只允许全局层；项目层含它会被跳过。要求 HTTPS，仅 `localhost/127.0.0.1/[::1]` 允许 HTTP。不要把它随 legacy 清理删除。OAuth 另支持 `clientId/clientSecret/callbackPort/callbackUrl/scope/clientName`。
- 0.99.2 将 MCP namespace/tool name 中不属于 `[A-Za-z0-9_]` 的字符替换为 `_`，碰撞工具都加 hash 后缀；配置 server 名仍保持用户原名。`toolExposure` 的键始终匹配 server 原始工具名，不是规范化的 RPC 工具名。
- 默认 codemode 不再把 MCP 工具/指令塞进工具描述。MCP 摘要由 pi 放在 `mcp_servers` 系统提示词段，`description` 参与摘要和搜索排序；scripts 用 `searchTools/describeTool/describeNamespace/ALL_TOOLS` 发现。PiDeck 不自行生成这段提示词。
- 原生校验对同时出现 command/url 的对象按 type/有效分支判定，type 省略时可优先接受 HTTP；当前 UI 新建只生成选中的一种传输，但读取/原文保存不能谎称 pi 一定拒绝这种历史对象。
- `pi mcp add/remove` 才支持 `-l`。**`list/login/logout` 不接受 `-l`**，由 cwd、agentDir 和已保存项目信任决定读取范围。
- `pi mcp` 命令的项目判定直接读 `ProjectTrustStore`，不能假定会话的一次性 `--approve` 能代替这条 CLI 的已保存信任。
- list 退出 1 且有完整合法报告，表示存在配置/连接问题；超时、信号退出、spawn 错误不能被一段 JSON 覆盖为成功。
- CLI 连接报告不是运行中 Agent 的连接状态。CLI 不加载扩展，也不证明第三方 `/mcp` 替换是否在会话内发生。
- OAuth 凭据由 pi 保存在 agentDir 的 `mcp-auth.json`；按服务器 URL 关联，可能被同 URL 的多个名称/项目共享。登出不能宣传为“仅清除这个项目凭据”。

### 1.3 defaultTools / codemode 的精确边界

- 无 `defaultTools`：沿用默认 `read/bash/edit/write`。全局 `[]`：空的默认工具选择；并不等于停用所有扩展注册的工具，也不禁止 MCP 稍后自动激活 codemode。
- 有裸名称：裸名称构成初始集合，然后依序应用 `+/-`。例如 `["read","-bash","+grep"]` 的结果是 `["read","grep"]`，绝不是旧计划写的 read/edit/write/grep。
- codemode 与 tool_search 由扩展注册为初始不活跃的工具。MCP 有实际需要且对应扩展可用时自动激活；`autoEnableCodemode:false` 仅关闭 MCP 自动激活 codemode，不会取消用户显式启用，也不关闭 deferred 所需的 tool_search。
- codemode 暴露的 MCP 工具也可被 tool_search 找到，不能写“只有 codemode 才能调用”。
- **跨层空列表语义已用 0.99.2 的 InMemorySettingsStorage 重新实测**；以下四例结果与前轮记录相同：

| 全局 defaultTools | 项目 defaultTools | 0.99.2 实际解析 |
|---|---|---|
| 未设置 | 未设置 | 沿用默认 |
| `[]` | 未设置 | `[]` |
| `["read"]` | `[]` | `["read"]` |
| `[]` | `["+codemode"]` | `["read","bash","edit","write","codemode"]` |

项目空数组在 base 已是数组时被当作空 modifier 列表叠加。不要只照文档直觉改 `mergeDefaultTools`；UI 保存必须用解析回验保证“清空/只选择一个”确实得到用户选择，见 T1。

### 1.4 0.99.2 增量适配清单

| 上游变化 | 本轮动作 | 所属阶段 |
|---|---|---|
| 默认 codemode MCP 后台连接，不再阻塞首轮；只有含 direct exposure 的服务器参与首轮等待（最多 10 秒，含 toolExposure 的 direct 覆盖） | PiDeck 不在 prompt 之前主动跑 `mcp list`/等待所有连接，不因工具描述暂时无 MCP 条目而报配置失效；连接状态显示与请求发送解耦 | A5/M2/M3/V1 |
| `mcp_servers` 摘要、`description`、`describeNamespace()`；codemode-deferred 合并为别名 | 补 description 编辑/保留/导入，改中英文 exposure 文案，只给四个 canonical 选项；模型请求日志展示 pi 真实请求，不自行重写 prompt/tool description | M1/M3/T1 |
| namespace 中 `-` → `_`、碰撞工具都加 hash；server 名碰撞被拒绝 | 校验配置冲突；运行时名称按 RPC 原样消费，不自算 hash、不改历史消息。`toolKind.ts` 现有 `mcp__` 前缀判断可兼容；补旧名/新名/带 hash 名测试 | M1/M2/V1 |
| `oauth.clientName`；provider token 认证 | 补有效值与操作模式，clientName 改名需登出再注册；HTTPS/全局限制；provider-auth 不显示 MCP OAuth 登录/登出。CLI 回调缺口见 7.4 | M1/M2/M3 |
| `/reload` 激活新加到 defaultTools 的工具，但不关闭被移除工具、不重开会话内已关闭且未新加的工具；CLI tools flags 仍优先 | 保留桌面“新建/重启后完整生效”策略，不新增自动 `/reload` 或不存在的 RPC；说明配置预计状态与运行态可以不同 | T1/V1 |
| Anthropic workload identity federation | 核对现有环境透传并补测试，认证交换/文件读取/刷新均交给 pi；不增加 PiDeck 联邦凭据存储或新认证桥，见 3.2 | A1/A5/V1 |
| `/mcp` TUI 授权链接改成终端超链接；TUI 长单行结果按视觉行折叠 | 这不是 CLI/RPC wire 改动。独立 `pi mcp login` 仍输出明文 URL；M2 按 CLI 分块/CRLF 测试，不把 OSC 超链接带到 GUI，不移植 TUI renderer | M2/V1 |
| Windows 独立包 codemode worker、非法 codemode image、model lookup、扩展 provider 默认模型、strict schema、Retry-After、Z.AI CN overflow 等修复 | 由实际 pi 0.99.2 runtime 获得。做相关现有启动/事件/显示回归，不在 PiDeck 重写 worker、图像校验、模型选择或供应商重试 | A5/V1 |

本次 compare 没有模型 catalog 源数据变更。PiDeck 构建期 `pi-ai@0.99.1` 只生成静态 catalog，DSH 又有自己的运行时依赖；**不为对齐外部 CLI 版本而顺手 bump 这两条依赖或重新生成 catalog**。以后出现实际模型数据变化再独立更新。

## 2. 总体模块边界

### 2.1 配置归属

| 对象 | 全局页面写入 | 项目右键页面写入 | 执行读取者 |
|---|---|---|---|
| 普通包、独立扩展、skills、prompts 的选择 | `<agentDir>/settings.json` | `<project>/.pi/settings.json` | pi |
| pi 原生内置扩展开关 | 同上 `extensions` | 同上 `extensions` | pi |
| 默认工具/codemode 子设置 | 同上 | 同上，仅这块工具设置 | pi |
| MCP server / 自动 codemode | `<agentDir>/mcp.json` | `<project>/.pi/mcp.json` | pi |
| 技能/模板正文 | 当前全局资源目录 | `.pi/skills`、`.pi/prompts`；用户明确选择时 `.agents/skills` | pi |
| OAuth tokens | 不由 PiDeck 编辑；pi CLI 写 agentDir | 不放项目目录 | pi |
| PiDeck 自带扩展全局开关 | PiDeck `removedBuiltInExtensions` | 不适用 | PiDeck 选择本次附加扩展 |
| PiDeck 自带扩展的项目覆盖 | 不适用 | `.pi/settings.json` 下 `pideck.extensions`（见 4.4） | 仅 PiDeck |
| 迁移记录/操作恢复快照 | PiDeck userData 的单一状态文件 | 同一文件按环境与项目键分区 | 仅用于迁移、包过滤恢复及识别 PiDeck 创建的继承覆盖；不能决定运行时加载 |

默认路径只是展示默认值，不能在新代码里绕开实际 agentDir、WSL HOME、自定义 pi 命令。

### 2.2 建议的小模块（新文件名可保持，已有等价模块则复用）

| 文件 | 职责 |
|---|---|
| `src/shared/types/piResources.ts`（新） | 作用域、资源身份、来源、覆盖状态、patch 请求/结果；纯契约 |
| `src/main/config/piResourceEnvironment.ts`（新） | 统一实际 pi 环境、host/runtime 路径、agentDir、projectId 对应 cwd |
| `src/main/config/piConfigFileStore.ts`（新） | 有边界校验的读取、revision、锁、最新文件上的 patch、原子写 |
| `src/main/config/piResourceRules.ts`（新） | 原生文件/builtin/package 规则修改的纯函数，及生效态投影 |
| `src/main/config/PiResourceConfigService.ts`（新） | 调用上两层处理资源开关与作用域，不管理 pi 运行时 |
| `src/main/config/PiResourceStateStore.ts`（新） | 迁移状态与整包停用前的恢复快照；不保存第二份 enabled 真值 |
| `src/main/config/piResourceMigration.ts`（新） | 旧禁用记录映射、备份、提交/恢复、未解析项 |
| `src/main/pi/mcpThirdPartyNotice.ts`（新） | 接管提醒的纯决策/文案参数，AgentManager 只调用 |
| renderer `hooks/useMcpController.ts` / `config/PiBuiltInExtensionsPanel.tsx` 等（按需新建） | 域状态与窄视图；不再给 ConfigModal/AgentManager 堆长业务块 |

读侧保留并修正现成 `resourceDiscovery.ts`、`packageResourceResolver.ts`、`resourceWhitelist.ts` 的通用解析能力，供列表展示和迁移使用；**不要因为停止 argv 白名单就把仍有调用者的纯函数全删掉**。不为文件名好看做全仓迁名。

`main/index.ts` 只装配。IPC 修改共享通道、主进程 handler、preload、previewApi 四处同步；订阅必须可退订。生产代码不得直接 import 用户安装的 pi SDK/私有模块来解析配置，禁止新增通用 pi API 桥。

### 2.3 作用域与身份

- 写请求使用 `{scope:"global"}` 或 `{scope:"project",projectId}`；不接受渲染层任意 configPath/cwd/agentDir。
- 资源身份包含：当前环境标识、kind、来源类型、所属配置层、包身份（如有）、包内相对路径/独立文件规范路径。不能继续只用 skill 名、模板名或 extension basename 作为跨来源唯一身份。
- 区分 `ownerScope`（声明在哪层）、`physicalScope`（物理安装在哪层）、`effectiveScope`（哪层覆盖当前结果）。项目 delta 不等于项目拥有全局安装文件。
- 列表必须包含被禁用的资源，否则用户无法重新打开。无安装文件、无资源、解析失败不应统统显示成“已禁用”。
- 至少区分 enabled / disabled / partial / unavailable，项目再显示 inherit / explicit-enabled / explicit-disabled / custom。partial 用于包只启用部分资源。
- 同名资源、同一文件被多个来源引用、npm 版本变更、git ref 变化、项目与全局同包等，按原生身份/优先级展示，不通过重复行或虚假 enabled 掩盖。

## 3. 配置写入、环境与生效时机

### 3.1 读改写必须保留用户配置

1. 新开关发送“改哪个资源/哪项字段”的窄 patch。主进程加锁后重读最新配置，再修改目标条目；不把页面缓存的整份 JSON 覆盖回去。
2. 原文编辑器/现有 SettingsTab 仍可能整文件保存：加 `expectedRevision`，变化后拒绝覆盖并提示刷新/保留草稿。不能让旧 SettingsTab 草稿冲掉刚做的资源开关。
3. 仅修改目标键，保留其他字段、未知嵌套字段、包 source/ref、显式路径、用户 glob 和 toolExposure 顺序。文件格式尽量保留缩进/换行。
4. JSON 读取与 pi 一样兼容 UTF-8 BOM。JSON 损坏、顶层类型错误、已知字段类型不合法时不按 `{}` 写回。显示错误并保留原文，关闭可视化保存；不要先归一化丢掉非法字段再宣称合法。
5. 单文件写 tmp → rename；project 写入复用 `projectFileAccess` 的 canonical 边界与临写前再校验，拒绝路径逃逸/junction。读取外部引用是展示能力，不等于可以写/删它。
6. pi 的 settings 写入使用 `proper-lockfile`，锁目标为同一路径且 `realpath:false`。仓库 lockfile 已有该依赖但仅为传递依赖；实现时将它声明为直接依赖（用途：与 pi 协调配置写入，不另造锁协议），使用异步锁，锁内重读。不得在 UI 主线程照抄 pi 的忙等循环。
7. PiDeck 所有触达同文件的写入入口共享服务：资源开关、设置页、相关 raw 保存、MCP 编辑/导入及迁移。CLI 安装/卸载等操作不在外层持有同一锁时执行，以免 pi 自己取锁死锁。
8. 原文编辑器及不合作的外部编辑器仍可能竞争：revision 检测能避免已观察到的陈旧覆盖，不能宣称任意外部写入都受锁保护。遇到冲突报告，不循环覆盖。

### 3.2 当前环境必须同源

- 复用 `PiLocator.resolveCommand/createInvocation/createProcessEnv`、`ConfigManager.getConfigDir`、现有 WSL 环境解析与 UNC↔Linux 转换。新服务不能自己猜另一个 HOME。
- Win/mac/Linux、WSL 自定义发行版/用户、路径带空格和中文均要覆盖；WSL 调用前走已有 warmWslCommand。
- agentDir 自定义时，页面读写、pi 会话 spawn、MCP CLI、备份与恢复必须指向同一个目录；必要时补齐既有环境透传，不重写安装器。
- 旧 skill 白名单有 Windows/WSL 两个 home 的并集兼容（issue #203）。切换时必须单列核对：**不再隐式合并两套环境**；已依赖跨环境来源的记录列入迁移待处理，用户可显式把该目录加入当前 pi 的原生 `skills` 来源。没有明确来源映射时不能宣称无损迁移、不能静默丢掉来源或转成启动 argv 白名单。
- 项目配置中的本地路径按运行 pi 的路径格式保存；UNC 是宿主文件访问路径，不直接写成 Linux pi 的资源路径。
- 0.99.2 Anthropic federation：保留 `ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID`、`ANTHROPIC_IDENTITY_TOKEN_FILE`，可选 `ANTHROPIC_SERVICE_ACCOUNT_ID/ANTHROPIC_WORKSPACE_ID`。现有 `PiLocator.sanitizePiChildEnv` 不会删除它们；用假值补环境契约测试，不读取 token 文件、不输出变量真实值。认证选择与刷新归 pi，不能为了选 federation 清除已有 API key/token。
- WSL 的 federation 使用发行版实际环境与 Linux token 文件路径；不能自动把宿主 Windows token 路径/凭据转传到发行版，不能宣称 host env 保留就等于 WSL 实测通过。本次不新增云认证 UI或跨环境凭据复制。

### 3.3 保存与运行分开

- 单项资源开关/包开关：即时保存，保存成功才刷新生效态；失败恢复 UI，不先显示永久成功。
- MCP 表单、工具设置：沿用草稿 + 保存；作用域切换/关闭沿用 dirty 保护。项目工具“恢复继承”删除该项目字段，不复制当前全局值。
- 保存后提示“新会话或重启后生效”，已有会话允许继续使用启动时配置；不擅自重启，也不使用不存在的 `reload_config` RPC。
- 资源列表/草稿命令补全读“配置预计状态”；运行中命令用现有 `get_commands` 数据。不能把预期状态冒充当前 Agent 已加载状态。
- 文件在 TUI/编辑器外部被修改后，页面刷新重新读取，不用 PiDeck enabled 缓存反向覆盖。包操作成功后失效所有关联的扩展/技能/提示词列表。

## 4. 原生资源开关的具体规则

### 4.1 独立文件与 pi 内置扩展

- 自动发现的全局独立文件：修改全局对应资源数组的精确 `+/-` 规则；项目本地文件则修改项目数组。
- 启用时移除该资源等价的精确负项，再按需写精确 `+`，以覆盖用户更宽的 `!glob`；停用写精确 `-`。不删其他资源或广域 glob。
- `+/-` 只是过滤，**不是任意新增来源的路径声明**。settings 显式来源必须保留 plain 路径；否则“停用再启用”可能永远发现不到原文件。特别警惕照抄 config-selector 时移除 plain 条目的情况。
- 项目覆盖继承全局文件：项目数组增加运行时绝对文件路径 plain + 对应精确覆盖；恢复继承仅移除本次创建的覆盖/声明。用户原有显式引用不得被一并删除。
- builtin 使用 `builtin:mcp` 等原生标识，不加普通文件 plain 声明。项目覆盖优先；恢复继承移除目标覆盖并重算全局结果。
- 核心用例：global `!builtin:*` 后项目 `+builtin:mcp`；全局精确负项；路径别名；关闭显式路径后仍可启用；拒绝 trust 时忽略项目覆盖。

### 4.2 安装包总开关

**普通的全局包/项目自有包**：

- 停用：保留 source、未知属性与安装，四种资源过滤写为 `extensions:[] / skills:[] / prompts:[] / themes:[]`。
- 先保存原包条目的资源过滤快照，再原子提交关闭状态。再次停用幂等，不能覆盖原始快照。
- 启用：若当前条目仍等于上次停用的结果，恢复原过滤（原来字符串就恢复字符串；原来部分资源关闭仍维持关闭）。
- 快照缺失或停用后被外部修改：不能伪装成“恢复原设置”。保留现状，给出明确的“启用包默认资源”动作或让用户查看自定义过滤；不得未经说明删光过滤。

**项目中覆盖全局安装包**：

- 不复制/卸载全局安装，不建立项目第二份安装。使用同包身份的项目 `{source,autoload:false,...}` delta。
- 整包停用：delta 四类写 `["!*", "!.*"]`；整包强制启用：四类写 `["*", ".*"]`。前者排除所有文件名（含隐藏文件），后者是 delta 中的原生匹配包含；不是对普通包“精确 +”的替代。
- 此模式已对本机 package-manager 的 `applyPackageDeltaFilter` 做纯内存探针：普通/隐藏文件与隐藏目录下文件都能被覆盖；空数组确实不产生覆盖。实现必须永久保留相应回归样例。
- 禁止把 delta 的四个空数组当成整包停用，也不要枚举当前每个文件再写一串精确负项（包升级新资源会漏掉）。
- 若已有项目 delta，快照保留其原过滤；恢复继承/恢复先前设置不能删除用户既有其他 delta。显式“强制全部启用”和“恢复先前选择”是不同动作，文案区分。
- 包更新增加新资源后，整包停用仍覆盖它们；包身份不随版本目录变化。

**恢复快照仅是操作辅助**：建议落到 `<userData>/pi-native-resources/<environmentKey>.json`，键含配置文件身份 + 包身份；保存 before 过滤、after 指纹及迁移记录。启动路径永远不能读此快照决定包是否加载；当前原生配置才是真值。外部修改导致指纹不一致就停止自动恢复。

### 4.3 安装、卸载、更新、单资源操作

- 安装/卸载统一交给 pi CLI：全局 `pi install/remove <source>`；项目加 `-l` 且 cwd 必须是已校验的所选项目。所有入口传显式 scope/projectId，禁止只有 `scope:"project"` 却没有 cwd。
- 当前 `ExtensionManager.uninstall` 只有 scope，`updateExtension` 没有项目参数，storeIpc 相同：这些不是 UI 改好就自动正确，必须同步修复。
- pi 当前 `update <source>` 会考虑多个作用域，没有等价 `update -l`。**不要发明参数或给项目按钮做“只更新本项目”的假承诺**。本轮项目页不提供模糊的单项目更新；全局“更新包”明确可能更新该身份在多个作用域的安装，沿用原生行为。
- 继承全局行提供本项目覆盖/恢复继承，不显示全局卸载、删除文件、重命名或直接编辑源正文；项目自有包卸载后可能重新继承同身份全局包，UI 重新解析并说明。
- 包内单项技能/模板开关可保留为细粒度配置：修改对应包过滤，不修改包内文件。包总开关关闭期间子项标为“整包已停用”，不让子项切换意外部分复活。
- 独立技能/模板可编辑、重命名、删除，保留现有边界与回收站机制。重命名时同步本次资源的原生精确规则，不清除同名其他来源的规则。
- 安装技能/模板写正文文件，启停写配置；安装/删除不应留幽灵禁用记录。新包默认按其 manifest 加载，安装与“手工额外开启每个文件”不绑定。

### 4.4 PiDeck 自带扩展

- 全局继续用 `removedBuiltInExtensions` 选择随包/热更新覆盖层中的入口，再通过 `-e` 附加；这不是用户资源的全量白名单。
- 项目覆盖采用 `.pi/settings.json` 中 `pideck.extensions: {"pi-deck-todo.ts": false}` 这样的明确命名空间：缺键继承，true/false 本项目启用/停用。只接受 `BUILT_IN_EXTENSIONS` 已知入口名，未知字段保留但不执行。
- 仅项目信任放行时读取项目覆盖；旧 `pideckDisabledGlobalExtensions` 中 PiDeck 自带项迁到这个命名空间，普通项迁到原生配置。
- `INTERNAL_BUILT_IN_EXTENSIONS` 不变成用户可关闭资源；正常模式始终保留内部 shell-proxy，诊断无扩展模式遵循现有总关语义。
- 保持 GUI 桥入口顺序、热更新完整快照/依赖校验以及供应目录解析；不改扩展本体来“适配 TUI”。
- 现有第三方 todo/plan/ask 冲突处理不扩大；所需的 enabled 判定改为原生有效状态，避免仅看旧私有字段误禁用自带扩展。列表读取不得新增文件删除副作用。

## 5. 旧数据迁移与退出白名单

### 5.1 必须覆盖的旧数据

- PiDeck settings：`disabledExtensions`（scope/source）、`disabledSkills`、`disabledPrompts`、`disableExtensionWhitelist`。
- 项目 `.pi/settings.json`：`disabledExtensions`、`disabledSkills`、`disabledPrompts`、`pideckDisabledGlobalExtensions/Skills/Prompts`。
- 旧版本/手工遗留在 pi 全局 settings 中的同类禁用字段：识别并列入迁移，不当成原生生效字段。
- PiDeck 自带项：保留全局 `removedBuiltInExtensions`，项目项迁到 4.4；内部适配器不接受遗留禁用记录。

### 5.2 迁移顺序与失败处理

1. **先做只读计划**：解析当前环境、原生配置、旧记录、资源来源，计算准确修改和未解析项。普通资源按来源/路径映射，不能用同名猜包。
2. 原旧记录确实按名称影响多个资源时，列出旧解析器实际匹配的同作用域集合并逐项迁移；没有来源或 `scope:unknown` 且无法确定时列 unresolved，不随意扩到所有项目。
3. 写任何配置前为相关原文保存保护备份；迁移备份覆盖本次项目 settings，而不只有 ConfigBackupManager 的全局文件。备份放 userData，不在项目里散落包含私人配置的备份。
4. 锁内校验 revision → 先写原生配置 → 读回并验证预期规则 → 再清理**已成功迁移**的旧记录、登记版本。任一步失败不能先删除旧禁用数据。
5. 崩溃重试按 before/after 指纹幂等恢复；跨原生配置与 PiDeck settings 不是单次文件 rename，必须有状态记录。回滚只在目标仍等于本次 after 时还原，不能覆盖用户后续编辑。
6. 按环境/项目惰性迁移：全局首次使用时处理，已信任项目在打开管理页或新建运行时前处理；不扫描和改写所有磁盘项目，不为迁移自动信任项目。
7. 活跃旧禁用项 unresolved/写入失败时，对受影响环境或项目返回明确的迁移错误，**不能删除白名单后仍继续启动并悄悄加载已禁用资源**。其他无关项目可继续。
8. 旧 `disableExtensionWhitelist:true` 下普通扩展禁用列表当时是不生效的：归档为待处理，不自动变成一批新的原生禁用；保持原有效状态并提示用户可重新应用这些选择。
9. 历史包级 `disabledExtensions` 命中已安装包时，按用户最新决定迁成整包停用，附带技能/模板也停用；迁移摘要明确此行为，不能假称原先就是整包停用。
10. 不把旧私有字段作为永久运行时兜底；迁移完后读取/开关全部用原生值。保留迁移读取一个兼容周期即可，不能每次启动从旧字段反向覆盖用户在 TUI 的修改。

### 5.3 版本策略

- 本轮原生资源管理与 MCP/codemode 管理统一以 **pi >= 0.99.2** 为支持基线，替换旧计划的 0.99.1 门槛；这样新增字段与 exposure 语义不需要并存两套解释。比较完整 semver（含未来 1.x），不只截 minor。
- 更旧/版本无法验证：资源可只读展示，禁用原生管理写入/迁移并提示升级；已有其他旧版会话能力不在本任务全面删除。
- 旧版且仍依赖活跃旧禁用记录的会话，不默默忽略记录启动。报告所需版本与未迁移原因；不再投入维护第二条永久白名单实现。
- 若要放宽到更早版本，必须补上该版本的原生行为证据和契约测试后调整门槛，不能仅因字段名字相同就认为兼容。

### 5.4 PiProcess 与调用者收口

- 移除正常启动的三类 `resolveEnabled*Paths` 注入、全量参数预算降级，以及 `appendBuiltInExtensionSpecifierArgs` 无条件带回逻辑。
- 保留诊断用 `piRpcNoExtensions/piRpcNoSkills`、已有 startup fallback、trust flags、代理/安全环境、PiDeck 自带附加扩展。拒绝 trust 用原生 `--no-approve`，不需要额外全局白名单；版本无法保证 trust 隔离则维持 fail-closed。
- `AgentManager` 新建/重启/恢复、`PiModelCapabilityCache` 及其他 PiProcess 构造点须一起核对，不能模型列表与会话使用两套资源选择。
- 去掉用户可见“禁用 -e 参数/白名单总开关”和失效白名单超限提醒。尚供只读发现/迁移使用的模块保留；无调用者的启动白名单代码及专属 IPC 才删除。
- 现有 RPC 不兼容扩展处置、启动失败快退、WSL 参数转换均需回归；不顺手扩大自动搬文件/禁用范围。

## 6. MCP 数据层与项目管理（M1）

### 6.1 schema 与保留语义

- 修改 `src/shared/types/mcp.ts`、`src/main/config/mcpConfig.ts`、`systemIpc.ts` 守卫与表单 helper。
- 原始配置读取保留所有未知字段，包括 oauth 内部未知字段；字段校验在归一化之前进行。非法列表/数值不能静默变 undefined 然后保存丢失。
- 传输识别/校验遵循 1.2；已知字符串数组、字符串 map、布尔、timeout、description、OAuth 类型都测。新建表单只输出选择的传输，不因读取历史双字段对象就删另一字段。
- 加 `description`、`oauth.callbackUrl/clientName` 和全局原生 `auth.provider` 的类型与保留/校验。高级字段可放折叠区域；不自实现 provider 认证，不读取凭据内容。
- `description` 允许空字符串，空时由 pi 使用服务器指令首行；`oauth.clientName` 如提供必须是非空且非纯空白字符串，说明仅动态注册时发送，改名后要先登出再注册；不自动替用户登出。`auth.provider` 校验非空 provider 名与 HTTPS/loopback 条件，禁止写进项目配置。
- `isMcpServerDisabled` 只根据 `enabled === false` 展示原生状态。旧 `disabled:true` 显示“旧字段不生效”的迁移提示，不装作 server 已停用。
- 新编辑启用时删除 `enabled` 键，停用写 false；未知字段保留。不能在同名项目覆盖里把删字段解释成继承那个全局字段。
- 同名有效 project 定义整体替换 global；无效项目项应报告，依 pi 行为保留其他有效项，不把无效部分浅合并成看似合法项。
- toolExposure 编辑用带稳定 `rowId` 的草稿行，名称与 exposure 分开编辑，保存时才构建有序对象；不能用可编辑名称作 React key，不能每个字符输入都删除/重建原 map。空模式、重名、非法值在提交前报错，编辑过程保留原行与焦点；允许删除全部规则后恢复默认 exposure。

### 6.2 项目 MCP 页面与覆盖

- `McpTab` 接收固定 scope/projectId；全局入口不借用当前聚焦会话的项目；项目入口带项目名/路径，不跳回全局。
- snapshot 区分原始 global/project、可写层、本地定义、继承定义、有效定义及错误；不要继续用“首次出现传输的层”判断归属。
- 项目自己新增/编辑/删除/导入 server 只写 `.pi/mcp.json`，不改全局；只查看不创建文件。
- 继承全局 server：提供“在本项目停用”“创建项目覆盖”“恢复继承”，不提供全局删除。
- **在本项目停用继承 server**：写有效的最小停用定义，例如 `{url:<继承URL>,enabled:false}` 或 `{command:<继承command>,enabled:false}`，必要时保留对应 type；不能只写 enabled。停用定义不复制全局 headers/env/oauth/auth。URL 的 userinfo/query 也可能含凭据，不能一面复制这类 URL 一面声称“不复制凭据”；检测到敏感形态时停在项目定义编辑器，明确展示待写内容与所需传输，不自动改写目标或复制敏感值。
- PiDeck 创建的这种停用定义，在辅助状态里保存 after 指纹与用途；匹配时 UI 主动作是“恢复继承”（删除该项目定义）。不能简单移除 enabled 导致一个丢失 args/headers 的半截定义开始运行。外部改过该条后按普通项目覆盖处理，不自动删除。
- “创建项目覆盖”进入完整编辑器：从有效配置提取非敏感字段，明确需要本项目提供的 env/headers/auth 方式；不能自动复制全局明文凭据。**全局 `auth.provider` 禁止直接复制进项目**；可在项目停用或恢复继承，但不能伪造一个 pi 不支持的 provider-auth 项目覆盖。
- 删除项目同名覆盖后，重新显示继承全局的状态（可能仍为 disabled）；界面不能把“删除覆盖”误报为“服务器已从全部配置删除”。
- `autoEnableCodemode`：全局未设置/开/关；项目继承/开/关，恢复继承删项目键。默认 true；说明它仅控制自动启用工具。
- 项目未信任时可以展示来源与原文，但安装/配置变更/连接操作沿用现有项目信任门禁；不得新增自动 `ensureTrustedDirectory`。信任变更与配置变更是不同操作。

### 6.3 导入与备份

- `mcpImport.ts` 完整拒绝 socket 与 legacy SSE，支持原生 streamable-http；Codex `enabled:false` 和明确的旧来源 `disabled:true` 转为 `enabled:false`，冲突时报告，不再产生 disabled。
- 支持原生 exposure/toolExposure/description/oauth 的可表达字段，未知源字段给具体 warning；保留外部原文件，不“帮用户清理”源文件。
- 全局导入只检查全局目标冲突；项目导入只检查项目目标，遇到同名全局提示会覆盖。导入 target 与来源扫描 projectId 分开，禁止把“扫描此项目来源”误当写入目标。
- 轻量 probe 只验证静态命令/HTTP 可达性，界面不得称其“已经成功连接 MCP”。真实连接用 M2。
- `ConfigBackupManager` 的 `mcp-auth.json` 增量补齐测试：缺文件旧备份兼容、恢复前保护备份、查看内容脱敏。测试覆盖 access_token/refresh_token/client_secret 与 camelCase 形式、Authorization 和 oauth.clientSecret；不能把 token 带进 renderer/log。
- 项目迁移备份由第 5 节负责，不把项目文件误混进全局 restore。

## 7. MCP CLI 与 OAuth 生命周期（M2；仅命令路线）

### 7.1 执行作用域

- `PiMcpCli` 注入统一环境解析与进程执行器，接受 scope/projectId，而非任意 cwd。
- 全局：使用当前 agentDir + PiDeck 控制的无项目配置工作目录，确保 list/login/logout 不读恰好位于应用 cwd 的 `.pi/mcp.json`。说明全局检测中的相对 command/cwd 是该检测环境的结果，不等于每个项目都能连接。
- 项目：cwd 为所选项目 runtime 路径，验证 pi 的已保存 trust；有效列表包含继承 global + project 整体覆盖。未信任时不声称“项目检测成功”，也不偷偷持久化 trust。
- 不给 list/login/logout 加 `-l` 或无效的 `--no-approve/--approve` 参数。不能通过复制 credentials 到临时 agentDir 来模拟 scope。
- `PiLocator` 最新命令来源/安装器改动必须复用，WSL warm-up/转换、env 透传和自定义 pi 路径一起覆盖。

### 7.2 进程、结果与事件

- 请求/事件统一带 `operationId + scope/environment/projectId + server`，并绑定发起的 webContents。不能仅用同名 server 把全局与项目 OAuth 链接串起来。
- list：默认 30s，显式 maxBuffer；退出 0/1 且报告形状完整才解析；报告有 errors/未连接不能显示全绿。spawn/信号/超时明确返回失败。
- login：pi timeout 秒数校验为有限正数并设置合理上限；宿主额外宽限有限；输出用有上限尾部缓冲。支持取消，关闭页面/窗口时取消并清理订阅、timer、进程。
- stdout 用逐行增量解析器，不对累积半截内容反复跑 URL 正则。完整 URL 才推送，去重，只允许 http/https；stdout/stderr 各自处理，stderr 尾部错误要可见。按 0.99.2 CLI 的明文 `Sign in to MCP server ... in your browser:` + 下一行 URL 验证，覆盖分块、CRLF 和 EOF；本版超链接修复在 `/mcp` TUI，不要把 CLI 解析器误改成必须有 OSC 8。
- 原生 pi 已经开浏览器，PiDeck 不自动再开。仅在当前登录区域展示可点击授权链接，点击走现成受控 openExternal；链接不进 toast、常规日志或模型上下文。
- 同一 server/同一环境避免并行 login/logout/list 状态互相覆盖；旧 operation 的迟到结果不能更新新作用域或已关闭的页面。
- 终止使用项目已有跨平台进程收尾手段；不能只 resolve UI promise 却留下 CLI/stdio MCP 子进程。异常/取消/close 只能 settle 一次。
- CLI 输出可能含第三方错误/URL：复用脱敏工具，日志只保留必要元信息，授权 URL、token/headers 不落日志。

### 7.3 UI

- 有未保存 MCP 草稿时，检测/登录明确要求先保存或使用“已保存配置”；不能显示用户草稿已被检测。本轮采用：阻止运行操作，提示先保存。
- 每台 server 独立显示操作结果，无论它是否已在 status 列表里；修正当前常见失败被隐藏的问题。
- logout 使用现有确认弹框，说明同一 URL 的其他会话/项目可能共用凭据；不把删除服务器配置等同于登出。
- 登录成功后刷新 CLI 报告，提示运行中会话下一轮使用新凭据；不要主动发送模型消息来“验证”。登录后握手失败应显示“已授权但连接失败”，不能吞掉退出 1。
- 非 TTY CLI 无法接收手工粘贴重定向 URL时，失败/超时给出在对应环境、对应项目目录执行原生登录命令的引导；不发明新认证协议。

### 7.4 provider token 认证的单独处理（0.99.2 必须覆盖）

- `auth.provider` 是复用 pi 供应商登录 token，既不是 MCP OAuth，也不是让 PiDeck 读取 `auth.json` 再填 Authorization。MCP OAuth 登录/登出按钮仅在 HTTP 且无 Authorization header、无 auth.provider 时适用；header 名判断不区分大小写。
- provider 模式显示“使用供应商登录”，操作导航到现有供应商认证入口；WSL 沿用该入口的“不支持桌面认证，改用终端 `/login <provider>`”说明。不得替用户运行 `pi mcp login/logout`，也不在关闭/删除 MCP 时登出共享供应商。
- **已验证的上游 CLI 缺口**：0.99.2 `extensions/mcp/cli.ts:createConnection` 未向 `McpServerConnection` 传 `providerToken`；session 的连接路径有这个回调。纯内存探针确认，无回调时 token 为 undefined，提供模拟回调时才有值；未读取任何真实凭据或连接服务器。
- 因此该版本 `pi mcp list --json` 对 provider-auth 的报告不能验证会话中的 provider 认证。保留原始检测结果，但给这类行明确标注“CLI 尚不能验证此认证方式”，不能把 needs-auth 直接提示成“再次 MCP OAuth 登录”或断言供应商未登录。普通 OAuth/stdio/http 检测不受此限制。
- 不绕过缺口引入 SDK/HTTP 验证通道。该限制限定在已核对的 0.99.2，未来 pi 修复后重新核对并移除提示/测试门控，不永久禁止 provider-auth 检测。
- 新建表单明确区分自动 MCP OAuth、显式 Authorization、provider 登录三种模式；已有原文同时带多个字段时保留，按原生优先级解释，不因打开页面就删字段。模式切换导致字段删除必须是用户显式编辑结果。

## 8. 第三方 MCP 提醒与导航（M3）

- 配置页：按当前 scope 的有效资源配置识别已知 adapter；全局页不把别的项目安装包当成本环境正在启用。窄包身份规则，禁止 `/mcp/` 宽正则误伤。
- 有正常运行中的 Agent 时，用标准 RPC `get_commands` 中 `name:"mcp"` 的 `sourceInfo` 确认命令所有者；`sourceInfo.path/source` 可区分 `builtin:mcp` 与第三方来源。这是只读观察，OAuth 仍走 CLI。
- 会话启动提醒优先基于本 runtime 的这条事实；未知来源只说“当前 /mcp 来自第三方”，不能随便生成卸载包名。仅有安装列表时说“检测到可能接管的已启用扩展”，不冒充运行确认。
- 检查尊重项目 trust、诊断无扩展、启动回退、真实加载错误以及已配置停用状态；不把全局安装列表直接复用于所有项目。
- 文案：“当前 MCP 由 X 提供；建议使用 pi 内置实现并卸载 X。”不能再写“本页配的所有服务器一定不会工作”，第三方可能自己读取同一个 mcp.json。
- npm/git 包提供实际 source 的卸载命令；项目加 `-l` 并明确“在项目目录运行”。复制命令按对应平台正确引用参数；实际 UI 卸载仍走 argv 数组，不执行拼接 shell 字符串。本地文件给“去扩展页管理”，不生成危险删除命令。
- “去扩展页”通过现成组件回调/设置导航 action，并保留 scope/projectId；不要发明 `pideck://` URL，也不要把 extensions 塞进仅属于 config 区的 ConfigTab 联合类型。
- 聊天入口提醒：时间线每 runtime 最多一条；toast 按环境/来源/项目适当去重，带可工作的处理 action。国际化参数同时给 timeline/toast，不能丢 source/command。
- 异步检查若首个 run 已发生则直接按现成安全消息路径写入，不能永远留在 pendingStartupDiagnostics；promise 返回时核对 `sessionId + agentId + runtimeGeneration`，旧 runtime 丢弃结果。
- 新增行为测试 `agentManagerMcpThirdPartyNotice.test.mjs`：可信/不可信项目、global/project、原生/第三方/已停用、诊断回退、首轮前后、重启迟到、去重、导航参数。

## 9. 默认工具与 Codemode（T1）

- 复用 `src/shared/defaultTools.ts`、`DefaultToolsInput.tsx` 和已有 SettingsTab 单字段 UI；项目资源页只复用工具小面板，不复制整个 SettingsTab。
- UI 支持已知默认工具 + 未知/第三方工具名原样保留；不能因为工具不在十项固定目录就把它从配置中删掉。
- `toggleTool` 必须区分 undefined、显式空列表、裸名列表、modifier-only；不再以 `entries ?? []` 混同空选择和沿用默认。
- 定义“选择→编码→原生合并→解析”的回验：保存候选结果必须等于 UI 所选集合。显式空集合后只加 codemode，应写能表达仅 codemode 的列表，不能写 `+codemode` 导致四个默认工具回来。
- 项目未自定义时显示全局继承结果；编辑优先保留增量语义。遇到 1.3 中跨层空列表细节，使用能得到确切选择的表达：例如清空可以对继承/默认集合生成逐项负项，必要时非空选择用裸名列表。**不要把一个在当前 pi 中无效的项目 `[]` 当成完成“清空”**。
- “恢复默认”：全局删除 defaultTools；项目删除 defaultTools 恢复继承。普通移除一个 chip 不等于删除整个字段。
- “清空默认工具”文案说明仅控制初始选择，不能承诺所有扩展工具和 MCP 自动启用都被关掉；需要阻止 MCP 自动启用的用户使用 `autoEnableCodemode`，需要停用能力则关对应扩展。
- codemode 子字段始终允许预配置，不以是否恰好存在字符串 `+codemode` 来禁用。显示说明：扩展可用且工具被手动/MCP 激活后这些值生效；若对应扩展被配置关闭，可显示原因但不擅自打开。
- `mode` 只写 on/only，budget 为非负整数，0 必须保留；清空恢复该层默认/继承。修改一个键时保留 codemode 的未知字段，只有整个对象真的为空才删除。
- 不在 PiProcess 额外拼 `--tools` 覆盖原生配置。MCP 自动激活继续交给 pi。
- 0.99.2 的 `/reload` 是增量激活，不等于把运行中工具集重置成配置集合。即便用户在 TUI reload 后，移除的工具仍可能活跃；PiDeck 保存时仍提示新建/重启会话完成应用，不自动发送 `/reload` prompt、不新增 `reload_config` RPC。
- MCP/codemode 文案同步 1.4：default codemode 的 MCP 工具不再内联于工具描述，inlineBudget 不能保证列出 MCP 全部工具；四个 exposure 选项中不再单列 codemode-deferred。
- 保持现有安全门策略与默认工具不变。兼容账本已有的 powershell 受管范围缺口不因新增多选 UI 而自动解决；工具可以选择不代表已被 PiDeck 安全门覆盖，交付时不得作这种承诺。本轮不顺手重写命令安全策略。
- 补全测试：未知工具、重复操作、显式空后开一个、最后一个关闭、混合裸名/修饰符、项目覆盖、1.3 四条实测、嵌套未知字段保留、MCP 自动激活说明不被 UI 误判。

## 10. 页面、权限与 IPC 接线

- `ConfigModal.tsx` 继续按入口派生 scope；把 MCP 与工具小面板纳入项目 resourceOnly 导航。主配置页固定 global，项目弹窗固定 projectId；Chat 虚拟项目无项目资源入口。
- `ExtensionsTab` 分清普通安装包/独立扩展、pi 内置、PiDeck 内置；包行总开关说明影响附带资源，partial 有明确展示；不新增另一套资源管理页面。
- SkillsTab/PromptsTab/ExtensionsTab 统一从新的有效配置投影展示状态；项目页分本项目与继承全局。不能继续只看 disabledNames 或在列表中丢弃原生已禁用项。
- 修改 `storeIpc.ts`、`projectResourceIpc.ts`、`systemIpc.ts` 的输入边界：scope、projectId、resourceId、布尔/三态、operationId 都从 unknown 收窄；不能只用 string 类型注解当运行时验证。
- 包安装/卸载保留原生 CLI；来源切换、模型能力缓存、草稿命令补全 `useSessionComposerController` 必须失效/刷新。UI 刷新失败不能覆盖保存成功的文件，但要报告状态未刷新。
- i18n 中英成对；shadcn/Tailwind，沿用现有颜色 token。修改块需要拆分时按域抽 hook/component，不增加 App/ConfigModal 巨型业务回调。
- 文件资源编辑权限按物理所有权保留；从 package 或祖先目录发现的资源不能因出现在项目页就获得任意写删权限。

## 11. 执行阶段与文件清单

所有阶段都是本次交付必做，**包含第 1.4 节的 0.99.2 增量项和第 7.4 节的 CLI 已知限制**。按依赖执行；独立阶段可交错，但同文件不要多个执行者同时修改。下表状态仅在真实通过验证后改勾。

| ID | 状态 | 交付单元 | 主要触达文件 | 依赖 |
|---|---|---|---|---|
| A0 | [ ] | 确认 0.99.2 基线/版本，加入原生契约样例与红色回归 | `tests/defaultTools.test.mjs`、`tests/mcpConfig.test.mjs`、新的 native-resource 测试；1.4/7.4 回归清单 | 无 |
| A1 | [x] | 作用域/环境/资源身份/配置安全写入 | `shared/types/piResources.ts`、`piConfigFileStore.ts`、`types/proper-lockfile.d.ts`、依赖声明 | A0 | 提交 `42f6ffda` |
| A2 | [x] | 原生规则与整包停用/恢复 | `piResourceRules.ts`、`PiResourceConfigService.ts`、`PiResourceStateStore.ts` | A1 | 提交 `bed19aa1` |
| A3 | [x] | 旧记录迁移、备份、失败恢复 | `piResourceMigration.ts`、`piResourceMigrationRunner.ts`、`ProjectResourceManager` 读写、启动装配 | A2 | 提交 `aef62bfd`、`37b38180` |
| A4 | [x] | 管理入口切原生，三种扩展 UI、项目三态 | 原生内置扩展开关 + 面板；技能/提示词/扩展三页与项目侧开关全部改走原生过滤规则，列表状态按原生条目投影；项目继承覆盖写「绝对路径 plain + 精确规则」并可恢复继承 | A2/A3 | 提交 `99348296`、`00982a6b`、`7645e283`、`83c2aeb5`、`184b5e68`、`4fec5ccb` |
| A5 | [x] | 退出三类 argv 白名单 | 已删除：`--no-extensions/--no-skills/--no-prompt-templates` 注入分支、三类 resolveEnabled* 白名单解析（技能/提示词模块与测试一并删除）、白名单总开关（IPC/UI/设置字段/文案）、`whitelistSkipNotice` 与其诊断/时间线提示；扩展 resolver 保留为「会加载哪些扩展」的只读查询（压缩归属启发式用）。安全前提：迁移改为幂等 `ensureResourceMigration`，Agent spawn 前按作用域 await（全局在启动即开始，项目在 `createUnlocked` 前完成） | A3/A4 | 提交 `37b38180` + 本次清理 |
| M1 | [x] | MCP 原生 schema、项目 scope、导入/备份 | `mcpConfig.ts`、`types/mcp.ts`、`mcpImport.ts`、`ConfigManager`、system IPC、`ConfigBackupManager` | A1 | 提交 `23db0c91`、`d17a51bd` |
| M2 | [x] | CLI 环境、状态、OAuth 操作生命周期 | `piMcpCli.ts`、`systemIpc.ts`、共享通道/preload、`tests/piMcpCli.test.mjs` | A1/M1 | 提交 `af44d658` |
| M3 | [x] | MCP 编辑 UI 收尾、接管提醒/导航 | `McpTab.tsx`、`McpResourceViews.tsx`、`mcpForm.ts`、`AgentManager.resolveMcpCommandOwner`、`tests/agentManagerMcpThirdPartyNotice.test.mjs` | A4/A5/M1/M2 | 提交 `364b3594` |
| T1 | [x] | 全局工具单字段与 codemode 子设置 | `defaultTools.ts`、`DefaultToolsInput.tsx`、`SettingsTab.tsx` | A1/A4/M1 | 提交 `4a720b1d` |
| V1 | [~] | 行为回归、更新说明与交接 | 全量测试与 typecheck 已跑（见下）；E2E 未跑 | 全部 | 见 12.3 |

**A5 已完成（本轮清理）**：白名单注入分支、白名单总开关（IPC/UI/设置字段/文案）、
`whitelistSkipNotice` 与三类预算跳过提示已全部删除；`enabledExtensionResolver` 保留为
「会加载哪些扩展」的只读查询（`resolveLoadableExtensionPaths`，始终返回数组），供压缩归属
启发式使用；技能/提示词白名单解析模块与 `builtInExtensionToggles.ts`（仅服务于注入）一并删除。

迁移现在是硬前提：`AgentManager.createUnlocked` 在 spawn 前 `await` 该项目作用域的迁移
（幂等），迁移失败时旧记录保留并记日志——这种情况下旧禁用不会再由白名单兜底，错误已显式
记录而非静默。`disableExtensionWhitelist` 设置字段同步移除（历史值不再有语义）。

说明：`piProcessSkillResolvers.ts` 位于 skills 域，prompt 位于 prompts 域，extension 位于 extensions 域。文件是否删除由调用者检查决定，不按表格批量删除。新单模块控制在约 400 行，超过 600 行必须拆分。

## 12. 验证路径与完成标准

### 12.1 针对性测试组

现有 helper 使用 `tests/helpers/loadTsCommonJs.mjs` / `createTsSandbox.mjs`。跨 VM 数组/对象先复制/序列化再 deepStrictEqual，禁止为通过跨 realm 断言而改生产语义。

| 范围 | 已有测试（按触达面跑） | 应补测试 |
|---|---|---|
| 原生规则/配置写入 | `packageResourceResolver.test.mjs`、`resourceDiscovery.test.mjs` | `piResourceRules.test.mjs`、`piConfigFileStore.test.mjs`、`piResourceMigration.test.mjs` |
| 全局/项目管理 | `extensionManager.test.mjs`、`skillManager.test.mjs`、`promptManager.test.mjs`、`projectResourceManager.test.mjs`、`projectResourceIpc.test.mjs`、`resourceScopeManagement.test.mjs`、`extensionStoreIpc.test.mjs`、`storeIpcPromptValidation.test.mjs` | 包总开关/恢复、三态覆盖、继承行拒绝卸载全局、同名来源互不影响 |
| 启动/WSL/trust | `piProcessSecurityEnv.test.mjs`、`piProcessWsl.test.mjs`、`piProcessSpawnFailureFastFail.test.mjs`、`extensionStartupFallback.test.mjs`、`builtInExtensions.test.mjs`、`extensionBuiltInDisable.test.mjs`、`configTrustWsl.test.mjs`、`extensionManagerWsl.test.mjs` | 正常 argv 无三类白名单；诊断仍全关；拒绝 trust；自定义 agentDir 同源 |
| MCP 数据/UI | `mcpConfig.test.mjs`、`mcpForm.test.mjs`、`mcpConfigUi.test.mjs`、`mcpThirdParty.test.mjs`、`mcpThirdPartyGuide.test.mjs`、`configBackupManager.test.mjs` | `mcpImport.test.mjs`、`mcpScope.test.mjs`；字段保留/非法类型/整项替换/凭据脱敏 |
| CLI/提醒 | 当前缺相应行为测试 | `piMcpCli.test.mjs`、`agentManagerMcpThirdPartyNotice.test.mjs` |
| 工具/codemode | `defaultTools.test.mjs` | 空列表重开单工具、项目编码回验、未知字段和自动启用 UI |
| 0.99.2 接入面 | `toolKind.test.mjs`、`toolCategory.test.mjs`、`agentManagerPromptDisposition.test.mjs`、`piLocator.test.mjs`、`toolFullTextDelivery.test.mjs` | 新旧 MCP 工具名/碰撞后缀显示、首轮不受 CLI 检测阻塞、federation 变量保留、provider-auth 操作边界；其余归入 M1/M2 测试 |

旧 `enabledExtensionResolver/skillWhitelistResolver/promptWhitelistResolver` 测试里有值得保留的资源来源/信任/WSL 样例，应迁到新规则/发现/迁移测试。仅针对已移除 argv 机制的断言可替换；不能删掉真实行为覆盖来制造全绿。旧 `resourceScopeManagement` 明确断言 MCP 只全局、项目不能重开全局禁用项，需要按新产品规则改测试，而不是绕过新要求。

### 12.2 必须覆盖的行为矩阵

| 场景 | 通过判据 |
|---|---|
| 全局关包，包有 extension + skill + prompt + theme | 四类都被原生过滤，其他包不变；没有删除安装 |
| 包此前部分启用，关→开 | 恢复先前过滤，非全部强开 |
| 停用后外部改过滤 | 不用旧快照覆盖外部修改 |
| 全局关，项目 A 强开，项目 B 继承 | A 生效、B 仍关；未信任 A 不生效 |
| 项目关继承包后包升级增加资源 | 新资源仍在该项目被关 |
| 同名 skills 来自包/独立目录/另一个项目 | 只修改目标身份；旧名字迁移需准确列出匹配集合 |
| 显式 settings 路径停用→启用 | 来源仍可发现 |
| JSON 损坏/并发编辑/写入失败 | 不覆盖原文件、不清旧记录、不显示成功 |
| 迁移写 native 后进程崩溃 | 下次幂等完成/报告冲突，不重复叠加、不恢复已停用项 |
| TUI 修改原生规则后刷新 PiDeck | UI 反映文件；旧 disabled 缓存不反写 |
| 原生 builtin:mcp/codemode 任意关闭 | 正常启动不通过 -e 复活；PiDeck 其他扩展仍可用 |
| 项目 MCP 同名覆盖 | 整个定义来自项目；删除项目项恢复全局 |
| 项目停用继承 MCP | 写有效传输+false，不拷凭据；恢复继承不启用半截定义 |
| MCP 无效字段/旧 disabled/socket/SSE | 准确诊断，源数据不丢，不显示虚假的禁用/连接成功 |
| list 退出 1/超时/退出 2/半截 JSON | 仅完整的 0/1 报告可用，其他明确失败 |
| OAuth URL 跨 chunk/重复/迟到/页面关闭 | 一次完整链接，正确作用域，清理进程订阅，不弹链接 toast |
| 登录失败但 server 已在状态表 | 错误仍可见；logout 有确认 |
| 全局 CLI 与项目 CLI 有同名 server | 连接/登录目标是各自当前有效定义 |
| 第三方已装但本项目停用/诊断关扩展 | 不发“当前接管”假警告 |
| 提醒在首轮之后返回/旧 Agent 重启后返回 | 新消息及时出现；旧 runtime 消息丢弃 |
| defaultTools 清空后只选 codemode | 解析只含 codemode，不意外加回 read/bash/edit/write |
| MCP autoEnableCodemode=false + 手动 codemode | 手动选择保留；子设置可编辑；不把“不自动开”画成扩展关闭 |
| PiDeck 自带扩展关闭/项目覆盖 | 只影响桌面附加项；不向 pi 全局安装列表写入 PiDeck 包 |
| 0.99.2 默认 codemode 后台连接未完成 | 不因 CLI 检测未完成阻止发送首轮；不因 codemode 描述无 MCP 名称而提示服务不存在 |
| 0.99.2 description/clientName/alias | 保存与导入保留 description；空白 clientName 拒绝；只展示四种 exposure，旧 alias 可读 |
| `dev-radius` 与 `dev_radius`，`read-file` 与 `read_file` | server 命名空间冲突报错；原始 toolExposure 名称不改，RPC 带 hash 名不丢、不重算、不改历史消息 |
| 0.99.2 provider-auth 全局/项目、HTTPS/loopback | 非环回 HTTP 拒绝、项目拒绝；MCP OAuth 按钮隐藏或解释不可用；不把 CLI 缺口当作用户未登录 |
| `/reload` 与默认工具保存 | 不发虚构 RPC、不承诺移除工具立即关闭；新会话按新设置完整加载 |
| Anthropic federation 变量 | 假值通过 native 子进程 env 清洗，Electron 私有变量仍清掉；不读取 token 文件、不改 WSL 凭据边界 |

### 12.2b 本轮已执行的回归（2026-10-01）

- `npm test`：7393 tests / **7385 pass / 7 fail**。
- 基线对照：在 `f9a1c070`（本轮开工前的计划文档提交）的独立 worktree 跑同类目标，
  同样 7 项失败：WSL Git ×5（`gitWslInvocation`/`gitProcessRunGit`）、CUA MCP HTTP host ×1、
  旧会话目录迁移 ×1。**结论：这 7 项是改动前就存在的基线失败，不是本轮引入。**
- `npm run typecheck`：0 error（此前会话记录的 DSH 报错来自陈旧增量缓存，清掉 `node_modules/.tmp` 后消失）。
- `npm run check:format`：2297 files 通过。
- 本轮新增测试全部通过：`piResourceRules`(11) / `piConfigFileStore`(6) /
  `piResourceConfigService`(11) / `piResourceMigration`(9) / `piResourceMigrationRunner`(6) /
  `builtInExtensionToggles`(6) / `piMcpCli`(7) / `agentManagerMcpThirdPartyNotice`(6) / `defaultTools`(22)。
- **E2E 未执行**（需要构建产物）；真实 OAuth 与真实 pi 会话未验证，留给 V1 收尾。

### 12.3 命令和测试限制

- 每个业务阶段先红色复现测试，再实现，再跑对应文件；`npm run typecheck` 保留完整输出，不能过滤掉 DSH 报错后写“通过”。
- 格式化仅本次触达文件（Biome），避免全仓 `format --write` 改到并行代码；收尾 `npm run check:format`。
- 本次跨 IPC/运行时/资源配置，全部针对性测试通过后可在最终收口跑**一次** `npm test`，保留日志与准确失败集；不是每个阶段都跑。
- **禁止全量编译/打包**：不要跑 `npm run build`、`build:fast`、`test:e2e` 或 `verify` 来绕过范围限制，它们会生成无关 catalog/manifest、构建 DSH 包等。
- UI 验证使用隔离 profile。已有 `npm run build:main` 是 main+preload 目标；renderer 如需重建，使用仅包含现有 renderer 配置的临时验证配置，保留插件/alias，验证后清理。不得假造 `electron-vite build --rendererOnly`，该选项仅存在于 dev 命令。
- 然后运行 `npx playwright test e2e/config-tabs.spec.ts` 及新增 `e2e/native-resource-management.spec.ts`、`e2e/mcp-management.spec.ts`（名称为计划新增）。只使用本次更新过的产物；不能用旧 out/ 证明新代码。
- E2E 内容：全局/项目入口固定 scope，包开关四类联动、继承三态、MCP 覆盖/恢复、toolExposure 连续编辑不失焦、OAuth mock 错误/取消/链接内嵌。用现成 mock/隔离 fixture，不连真人供应商、不读真实用户配置。
- 真实 CLI smoke 使用隔离 agentDir/测试项目和假 MCP server；真实 OAuth 如无可用账号则明确未验证，不能以 mock 宣称真实授权成功。不要修改开发者真实 `~/.pi` 或登录第三方来完成测试。
- 上一轮历史 typecheck 曾有 3 条 DSH API 错误，全量测试曾有 12 条失败；本轮只做计划，没有重跑它们。执行时重新记录，不能把数量相同等同于同一失败集。

### 12.4 能力对照与最终交付

| 原能力/承诺 | 交付后要求 | 状态 |
|---|---|---|
| 全局扩展/技能/提示词启停 | 原生配置生效，可重开；TUI 同环境一致 | [ ] |
| 项目本地与继承全局管理 | 固定 projectId、三态、无全局误写删 | [ ] |
| 整包开关 | 附带资源一起关，恢复前态，更新后仍有效 | [ ] |
| PiDeck 自带/热更新/内部适配器 | 桌面独立加载，顺序/依赖/保护不回退 | [ ] |
| 原生四扩展开关 | 全局和项目均有 UI，不被启动参数覆盖 | [ ] |
| 启动恢复/trust/WSL/模型能力查询 | 同源、无全量白名单、诊断与拒绝信任保留 | [ ] |
| 历史禁用选择 | 备份、可恢复、未解析不静默失效 | [ ] |
| 全局与项目 MCP CRUD/导入 | 原生完整定义、真实来源、未知字段保留 | [ ] |
| MCP OAuth/状态检测 | CLI-only、作用域正确、可取消、错误可见 | [ ] |
| 第三方接管提醒 | 设置和聊天都可见，来源准确，导航/卸载引导可用 | [ ] |
| defaultTools/codemode | 单多选+子字段，空列表/继承/自动开启不混淆 | [ ] |
| 测试/文档 | 必要检查有证据，失败/未验证明确，账本不虚报完成 | [ ] |

交付说明列出：实际修改文件、迁移规则、测试命令与结果、尚未验证的真实环境、备份/回滚位置。本文阶段与对照表按事实勾选；`docs/pi-compatibility.md` 不得提前写全部完成。

## 13. 可直接发给执行模型的任务

> 请完整阅读 `docs/pi-0.99-mcp-codemode-plan.md`，从当前 dev 工作区接着实现 A0–V1，包含 1.4 节的 pi 0.99.2 增量与 7.4 节的 provider-auth CLI 限制。采用 pi 原生配置管理普通资源，支持固定全局/项目入口和整包启停；PiDeck 自带扩展仅供桌面；补齐 MCP/codemode 所有未完成项。先核对现有 diff 并保留并行工作，按阶段写针对性行为测试和执行验收，不用全量构建、不操作真实用户配置、不把历史失败过滤成通过。原生契约与本文有冲突时以当前实际 pi 行为和用户决定为准，先纠正受影响的计划/测试再继续，不用兼容补丁掩盖未知行为。完成后更新阶段状态、能力对照和兼容账本，报告通过项、失败项和未验证项。
