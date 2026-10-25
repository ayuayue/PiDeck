# pi 1.0 适配 + 原生资源管理 手工测试方案

> 状态：**已执行（2026-10-04）**。适用提交范围：`f9a1c070..HEAD`（22 个功能提交 + origin/dev 合并）。
> 目的：推送/发版前的最终人工验收。自动化已覆盖的部分（见附录 A）不必重复手测。
> 本轮结论见下方「执行记录」；未执行的项与理由已逐条登记，下次发版按需补做即可。

---

## 执行记录（2026-10-04）

环境：Debian 13 native（非 WSL）；pi 1.0.2（PATH `~/.nvm/.../bin/pi`）+ 0.99.2（managed）；被测对象 = `/opt/PiDeck` **打包版**（20:34 构建，对应 `d1105dd9`，比当时 HEAD 少一个 `ece46f40` 图标资源路径修复，与本次适配无关）。仓库 `dev` @ `ece46f40` 工作区干净。

### 已通过（机器判据，不是肉眼判定）

| 项 | 判据 | 证据 |
|---|---|---|
| T1 迁移 | `Global resource migration completed {applied:0, unresolved:2}`，状态入库 | `~/.config/PiDeck/logs/app-2026-10-04.log` 20:36:59 / 20:38:38；`~/.config/PiDeck/pi-native-resources.json` 的 `global:settings` + `project:b8b3720b…`。2 条 unresolved = 本机未安装的 `npm:@adrianapan/pikit`、`npm:pi-mcp-adapter`，旧记录按设计保留（没静默丢弃） |
| T2 启动形态 | 20:36 之后 spawn args 无白名单注入 | 同日志：`--mode rpc --no-themes --offline` + 14 个 PiDeck `-e`；对照 19:00:14 旧构建 args 里仍有 `--no-extensions …` |
| T3/T4 技能开关 | 关 → `skills:["-<SKILL.md 绝对路径>"]` 且 `skill:image-gen` 离开命令列表；开 → `+` 规则且命令恢复 | 探针输出 + 新会话 `/` 菜单实测一致 |
| T5 包停用/启用（附带做了） | 关 → `packages` 四类空过滤；开 → 恢复 `{"source":"npm:pi-tracker"}`（不是全部强开） | 日志 `Extension toggled` 20:51:23/26/30；探针里 `analytics`/`budget` 命令随状态同步出现 |
| T6 pi 内置扩展 | 关 mcp → `-builtin:mcp` 且 `mcp` 命令消失；开 → `+builtin:mcp` 且命令恢复；llama.cpp 同法 | 日志 `pi built-in extension toggled` 20:51:44/46、20:53:11 |
| T11 quietStartup 三态 | 「仅保留横幅」→ `"quietStartup": "header"`（string）；重开配置页仍显示「仅保留横幅」（不被静默覆盖成布尔）；切回完整输出写 `false` | 20:54:39 落盘 + 重开读回 |
| T9-1 检测连接 | 界面「已连接 · 4 个工具」= CLI 真值 | `pi mcp list --json` → `{name:"beui",state:"connected",tools:4}`，exit 0 |

### 未执行（含理由）

- **T7 项目作用域、T10 defaultTools**：单测已覆盖（`piResource*` 51 项 / `defaultTools` 22 项），本轮未走 UI
- **T8 MCP 校验、T9-2/4/5**：单测 + UI 门控，收益低
- **T9-3 真实 OAuth**：无可用供应商账号（同附录 B）
- **T12 第三方接管**：本机未安装 `pi-mcp-adapter`
- **T13 WSL**：本机 native，`wslEnabled=false`
- **T14 迁移失败路径**：迁移态已入库，重放需先重置状态；runner 失败分支有单测
- **T15 合并回归**：web 服务关闭、飞书未配置
- **T16 打包冒烟**：被测对象本身就是打包版，T1–T6/T9-1/T11 均在打包版里完成

### 本轮新增工具

`scripts/probe-pi-native-commands.mjs`：用**真实 HOME** 跑 `pi --mode rpc --no-session --offline --no-themes` 取 `get_commands`，支持 `--has/--missing` 断言。界面上的「已停用」只证明写盘成功，本脚本才证明 pi 真的没加载。注意：**只断言指定命令在不在，不要断言总数**（扩展注册有时序噪声，首跑可能少 `pi-tracker` 的命令）。

## 0. 环境准备（必做，5 分钟）

```bash
# 1) 备份真实配置——首次启动会触发真实迁移（旧禁用记录 → 原生规则）
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak-pre-migration
cp ~/AppData/Roaming/PiDeck-dev/settings.json ~/AppData/Roaming/PiDeck-dev/settings.json.bak 2>/dev/null # Windows dev；正式版路径为 ~/AppData/Roaming/PiDeck/
# Linux 对照：userData 为 ~/.config/pi-desktop-dev（dev）与 ~/.config/PiDeck（打包版）；日志在 <userData>/logs/app-<日期>.log
# 迁移状态另有 <userData>/pi-native-resources.json（重放迁移需删掉其中 migrations.<key> 条目）

# 2) 记录迁移前的旧禁用记录（用于 T1 验证迁移结果）
node -e "const s=require(process.env.HOME+'/.pi/agent/settings.json');console.log('disabledExtensions:',JSON.stringify(s.disabledExtensions??[]));console.log('disabledSkills:',JSON.stringify(s.disabledSkills??[]));console.log('disabledPrompts:',JSON.stringify(s.disabledPrompts??[]))"

# 3) 启动方式：npm run dev（开发）或打包版。测试全程用你日常的 pi（0.99.2 官方安装或 1.0.0 nvm 均可，两者已验证兼容）
```

回滚：关闭应用 → `cp ~/.pi/agent/settings.json.bak-pre-migration ~/.pi/agent/settings.json` → 重启。

---

## P0 冒烟（启动链路，~15 分钟）

### T1 首次启动迁移
| 步骤 | 预期 |
|---|---|
| 1. 启动应用，打开任意一个有旧禁用记录的项目会话 | 会话正常启动，无报错 |
| 2. 查看日志中 `migration` 关键字（问题反馈页导出或 userData/logs） | 出现 `Global resource migration completed` 或 `skipped`（无旧记录时），**不应**出现 `failed` |
| 3. `cat ~/.pi/agent/settings.json` | 旧 `disabledExtensions/disabledSkills/disabledPrompts` 若迁移成功则被清空/删除；`extensions/skills/prompts` 数组出现对应 `-<路径>` 条目 |
| 4. 对比步骤 0 记录的旧列表 | 每条旧禁用项都对应一条原生规则（或出现在迁移警告里，不能凭空消失） |

### T2 白名单移除后的启动形态
| 步骤 | 预期 |
|---|---|
| 1. 启动任一会话，观察日志 `spawn等效命令` | **没有** `--no-extensions`/`--no-skills`/`--no-prompt-templates` + 逐条路径的注入；只有 `--mode rpc --no-session --offline --no-themes` + PiDeck 自带扩展的少量 `-e` |
| 2. 会话内输入 `/` 查看命令列表 | 之前禁用的技能/扩展命令**不再出现**（原生规则生效）；未禁用的全部正常 |
| 3. 开发设置打开 `piRpcNoExtensions` 重启会话 | 扩展一个都不加载（诊断语义保留），关闭后恢复 |

### T3 迁移后禁用仍生效（最重要的回归）
| 步骤 | 预期 |
|---|---|
| 1. 若 T1 迁移了某个禁用技能：新会话里让模型调用或 `/技能名` | 该技能**不可用**（迁移等价于原来的白名单禁用，不是静默放行） |
| 2. 若无旧记录：手动禁用一个技能（见 T4），重启会话验证 | 同样生效 |

---

## P1 资源启停（原生配置，~20 分钟）

### T4 技能/提示词开关写原生规则
| 步骤 | 预期 |
|---|---|
| 1. 配置页 → 技能 → 关闭任意技能 | 列表立即显示停用 |
| 2. `cat ~/.pi/agent/settings.json` | `skills` 数组多了 `-<技能SKILL.md绝对路径>`（**不是**写 PiDeck 私有字段） |
| 3. 重启该会话 → `/技能名` | 命令消失 |
| 4. 重新打开该技能 | `-` 条目换成 `+` 条目；重启后命令恢复 |
| 5. 提示词页重复 1-4 | `prompts` 数组同样变化，`/模板名` 行为一致 |

### T5 扩展开关（包安装 vs 本地文件）
| 步骤 | 预期 |
|---|---|
| 1. 扩展页关闭一个 **npm 安装**的扩展 | `settings.json` 的 `packages` 里该包变成四类空过滤（`extensions:[] skills:[] prompts:[] themes:[]`），整包停用 |
| 2. 重新启用 | 恢复停用前的过滤（不是全部强开） |
| 3. 关闭一个**本地文件**扩展（~/.pi/agent/extensions 下的 .ts） | `extensions` 数组多了 `-<绝对路径>` |
| 4. 重启会话验证两种停用都生效 | 扩展贡献的命令/工具消失 |

### T6 pi 内置扩展开关面板
| 步骤 | 预期 |
|---|---|
| 1. 扩展页顶部「pi 内置扩展」区 | mcp / llama.cpp / codemode / tool-search 四行，默认全启用 |
| 2. 关闭 mcp | `settings.json` 出现 `-builtin:mcp`；重启会话后 MCP 页配的服务器不加载 |
| 3. 重新打开 | 出现 `+builtin:mcp`；恢复 |
| 4. （若用 1.0.0）在 TUI 里 `pi config` 关一个内置扩展，回 PiDeck 打开面板 | PiDeck 面板**显示已停用**（读取同一份原生配置，不覆盖 TUI 的选择） |

### T7 项目作用域
| 步骤 | 预期 |
|---|---|
| 1. 项目右键 → 资源管理 → 技能 | 只显示该项目 `.pi/skills`/`.agents/skills` + 继承的全局；作用域标识固定为该项目 |
| 2. 在项目里停用一个**项目自有**技能 | 该项目 `.pi/settings.json` 出现 `-<路径>`；**全局** settings.json 不变 |
| 3. 在项目里停用一个**继承的全局**技能（若有该入口） | 项目层写「绝对路径 + `-路径`」；全局不变；其他项目不受影响 |
| 4. MCP 页从项目资源管理进入 | 标题/路径显示项目 `.pi/mcp.json`；新增/编辑只写项目文件；「恢复继承」可用 |

---

## P1 MCP（~15 分钟）

### T8 MCP 配置与校验
| 步骤 | 预期 |
|---|---|
| 1. 新建 HTTP server，URL 填 `ftp://x` | 保存被拒，提示 http(s) |
| 2. 同名 `dev-radius` 与 `dev_radius` 并存 | 保存被拒，提示命名空间冲突 |
| 3. 写 `exposure: codemode-deferred` 的旧配置文件 | 能读，列表正常（别名归一显示 codemode）；不改文件不重写 |
| 4. 项目 `.pi/mcp.json` 里放含 `auth` 的条目 | 校验报「auth 只允许全局」 |

### T9 连接检测与 OAuth
| 步骤 | 预期 |
|---|---|
| 1. MCP 页「检测连接」 | `pi mcp list --json` 真实连接；每行显示 state/tools；exit 1（有未连接项）不当作失败 |
| 2. 有未保存草稿时点检测 | 被阻止并提示先保存（CLI 读磁盘） |
| 3. 对需要 OAuth 的 server 登录（如有账号） | pi 自动开浏览器；授权 URL 同时内嵌显示（不弹 toast）；登录结果**无论成败都显示** |
| 4. 登出 | 弹确认框，文案说明 pi 1.0 起凭据按「名称+URL」存储 |
| 5. `auth.provider` 模式的 server | 不显示 MCP 登录/登出按钮，显示「使用供应商登录」 |

---

## P1 设置与工具（~10 分钟）

### T10 defaultTools 与 codemode
| 步骤 | 预期 |
|---|---|
| 1. 设置页「工具与 Codemode」 | 单个多选框（chips） |
| 2. 清空全部工具 → 只勾 codemode → 保存 | `settings.json` 的 `defaultTools` 解析后**只含 codemode**（不能带回 read/bash/edit/write） |
| 3. codemode 子字段（mode/budget） | 任何时候可编辑（不因未勾 codemode 而禁用）；0 预算可保存；未知嵌套字段不丢 |
| 4. 「重置为默认」 | `defaultTools` 键删除 |

### T11 quietStartup 三态（pi 1.0）
| 步骤 | 预期 |
|---|---|
| 1. 设置页 quietStartup | 下拉三选：完整输出 / 全部隐藏 / 仅保留横幅（**不再是开关**） |
| 2. 手动在 settings.json 写 `"quietStartup": "header"` 后刷新设置页 | 显示「仅保留横幅」，再切其它值时 **"header" 不被静默覆盖成布尔**（这是本轮修的数据丢失缺陷） |

### T12 第三方接管提醒
| 步骤 | 预期 |
|---|---|
| 1. 安装 `pi-mcp-adapter`（或用已有），启动会话 | 时间线出现系统诊断「已安装 pi-mcp-adapter…」+ 全局 toast，toast 带「去 MCP 设置」按钮且**能跳转** |
| 2. 卸载后重启会话 | 提醒不再出现 |
| 3. 若你手动在 settings.json 写了 `-builtin:mcp` | 不出现「当前被接管」的误报（运行时确认来源） |

---

## P2 边界与合并回归（~15 分钟）

### T13 WSL（若你用 WSL 项目）
| 步骤 | 预期 |
|---|---|
| 1. WSL 项目启动会话 | 技能/扩展按 distro 内 `~/.pi/agent` 解析；启动正常 |
| 2. WSL 项目里开关资源 | 写入的是 distro 侧路径格式的规则（由宿主转换），重启后生效 |

### T14 迁移失败路径
| 步骤 | 预期 |
|---|---|
| 1. `chmod 444 ~/.pi/agent/settings.json` 后启动（迁移写入会失败） | 日志出现迁移失败警告；**旧禁用记录不被删除**；会话仍能启动（但该次禁用可能不生效——有明确日志，不静默） |
| 2. 恢复权限重启 | 迁移重试成功（幂等） |

### T15 合并进来的远端功能抽查（与本次适配无直接关系，合并可能影响）
| 步骤 | 预期 |
|---|---|
| 1. Web 模式时间线 | 回合聚合/折叠正常 |
| 2. 抽屉面板自定义 | 面板增删/固定正常 |
| 3. 飞书（若配置） | 连接状态/消息推送正常 |
| 4. RPC 日志面板 | 开日志即开面板 |

### T16 打包版冒烟（发版前）
| 步骤 | 预期 |
|---|---|
| 1. `npm run pack` → 运行打包版 | T1-T5 关键路径全部通过（特别是原生规则写入与迁移） |

---

## 附录 A：自动化已验证、无需手测的部分

| 层 | 证据 |
|---|---|
| 单元/契约测试 | 全量 7496 tests / 7471 pass / 24 fail（24 个全部为合并前基线或 origin/dev 自带失败，对照 worktree 确认无新增） |
| 类型/格式 | `typecheck` 0 error；`check:format` 通过 |
| main+preload 打包 | `build:main` 通过；产物抽查无白名单注入残留 |
| 真实 pi 冒烟 | `scripts/smoke-pi-native-resources.mjs` 对 0.99.2 与 1.0.0 各 **19/19**：原生 `+/-` 真实生效、`-builtin:mcp` 生效、项目覆盖与信任边界生效、迁移端到端 pi 真的不加载 |
| 本轮新增针对性测试 | defaultTools 22 / mcpConfig 21 / mcpForm 5 / mcpConfigUi 6 / mcpThirdParty* 9 / piResource* 51 / piMcpCli 7 / agentManagerMcpThirdPartyNotice 6 / settingsQuietStartup 1 全绿 |

## 附录 B：已知未验证项

- **真实 OAuth 全流程**（需可用 MCP 供应商账号；T9-3 是唯一覆盖点）
- **E2E**（`e2e/config-tabs.spec.ts` 及新增 native-resource/mcp specs，需构建 renderer 后跑 playwright）
- **打包版完整安装包**（T16 只要求 --dir 冒烟）
