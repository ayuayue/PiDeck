# PiDeck 数据迁移登记

本文是持久数据迁移的统一索引，供升级验收、故障回顾和兼容代码退役使用。登记基线为命名统一提交 `6e67c8c56` 之后的 `dev` 工作区；条目按现有代码核对。**代码存在、状态文件存在、真实用户升级成功是三个不同结论**，各条目的验收状态要分别记录。

这里登记 PiDeck 自己的数据转换、用户主动导入，以及上游拥有的格式迁移。纯 UI/模块重构不属于本台账。各领域继续维护自己的执行器与状态文件，本文提供统一入口。

## 维护方式

- 新增、调整或退役持久数据迁移时，在同一次改动中更新本台账：保留稳定 ID，写清旧输入、新输出、触发条件、完成判据、失败/冲突行为、代码入口、验证入口与退役条件。
- 当前多数迁移按文件或字段特征触发，没有可靠的最低历史版本登记。不能据当前应用版本猜测支持范围；核实首次引入版本、最低支持数据格式后补到对应条目。
- “已完成”只能表示该作用域内需要的转换成功。未解析条目、清理失败和目录冲突须单独说明，不能用一个总开关掩盖。
- 迁移与旧数据清理分开验收。删除迁移入口前，先明确支持的升级范围、跨版本直升路径及回退限制；需要删用户历史数据时另行备份、核验并取得确认。
- 表中的测试是复查入口。除文末明确列出的本次验证外，登记不表示这些测试已在本次重新运行。

## 自动迁移与兼容修复索引

下列 ID 是文档登记号；现有代码的状态键仍按各模块自己的契约使用。

| ID | 迁移对象 | 触发与完成判据 | 失败/冲突与当前记录方式 | 代码及复查入口 |
| --- | --- | --- | --- | --- |
| UD-001 | `pi-desktop` → `PiDeck`；源码开发根、分支开发根及 Dev 独立根同步更名 | `ready/setPath` 前；整根、持久化路径、encoded 会话目录及适用的 `header.cwd` 全部处理成功 | 本次补齐专用原子完成记录；失败不发布新记录、下次重试；根/会话冲突保留两边 | [userDataNameMigration.ts](../src/main/projects/userDataNameMigration.ts)、[devUserDataMigration.ts](../src/main/projects/devUserDataMigration.ts)；`tests/userDataMigrationState.test.mjs`、`tests/userDataNameMigration.test.mjs`、`tests/userDataSessionHeaderMigration.test.mjs`、`tests/devUserDataMigration.test.mjs` |
| FE-001 | `<userData>/pi-desktop/` → `feishu/` | 飞书配置首次实际读写时解析目录；成功整目录 rename | 失败继续旧目录并重试；两目录并存用新目录、保留旧目录；没有专用完成记录 | [FeishuConfig.ts](../src/main/feishu/FeishuConfig.ts) 的 `getConfigDir`；`tests/feishuConfigDirectory.test.mjs` |
| FE-002 | 飞书单 Bot `version:1` → 多 Bot `version:2` | 读取 `feishu.json` 时转换为 `bots[]`，后续正常保存写 v2 | 属读取兼容；读到 v2 即无需转换，没有一次性完成记录；v1 无 ID 时读取会生成 ID | [FeishuConfig.ts](../src/main/feishu/FeishuConfig.ts) 的 `readConfig`；持久 Bot ID 的跨重启验收待补 |
| FE-003 | 飞书 runtime 身份 → 稳定 Session 绑定 | 读取 Bot 分配时把 `agentId` 键换成 `sessionId`；恢复绑定时经 runtime gateway 校验，唯一路径匹配可复用旧群 | 无总标记；保留无主绑定，身份校验失败不猜测改主；保存后的键/绑定形态作为进度 | [feishuIpc.ts](../src/main/ipc/feishuIpc.ts)、[FeishuBridge.ts](../src/main/feishu/FeishuBridge.ts)；`tests/feishuSessionRuntimeBinding.test.mjs` |
| RS-001 | PiDeck/项目私有禁用列表 → pi 原生资源过滤 | 全局启动期、项目资源页或 Agent spawn 前；写原生 `extensions/skills/prompts/packages` 规则 | 有 `pi-native-resources.json` 作用域记录；当前记录包含 `unresolved`，且先记完成再清理旧字段，详见后文待核查项 | [piResourceMigration.ts](../src/main/config/piResourceMigration.ts)、[piResourceMigrationRunner.ts](../src/main/config/piResourceMigrationRunner.ts)、[PiResourceStateStore.ts](../src/main/config/PiResourceStateStore.ts)；`tests/piResourceMigration.test.mjs`、`tests/piResourceMigrationRunner.test.mjs` |
| RS-002 | 历史错误的顶层 `extensions: -<包安装目录>` 规则清理 | 资源迁移门禁内，扫描已安装包并删精确匹配的错误规则；无残留不写 | 幂等扫描，没有持久完成记录；读目录失败视为空，写失败报告 `failed` | [piPackageRootRuleRepair.ts](../src/main/config/piPackageRootRuleRepair.ts)；`tests/piPackageRootRuleRepair.test.mjs` |
| ST-001 | 更新源 `github` → `atomgit`（代码注明 v0.7.5） | 持久化旧源为 github 且无标记；写新值和 `updateSourceAtomgitMigrated:true` | 后续用户改回 github 受尊重；保存失败忽略，本次内存已生效，下次仍可重试 | [SettingsStore.ts](../src/main/settings/SettingsStore.ts) 的 `migrateUpdateSourceToAtomgit`；`tests/updateSourceMigration.test.mjs` |
| ST-002 | `contentMaxWidth` 像素 → `chatContentWidthPct` 百分比 | 新字段没有合法数值时按旧值映射 60–100%；新字段为完成判据 | 保存失败下次重试；新字段已有值不覆盖；旧字段不是清理标记 | [SettingsStore.ts](../src/main/settings/SettingsStore.ts) 的 `migrateContentWidth`；`tests/settingsContentWidthMigration.test.mjs` |
| ST-003 | 旧设置字段/枚举兼容 | 加载时删除 `providerUsageAutoQueryEnabled`、`collapsePrevRunsOnNewTurn`；`commit-mono` 回落 `system-mono` | 前两项删除后排队保存，失败可重试；字体属于读取归一化、后续保存持久化；无总标记 | [SettingsStore.ts](../src/main/settings/SettingsStore.ts) 的两个 `migrateRemoved*` 与字体兼容分支 |
| QM-001 | `settings.quickMessages` → `quick-messages.json` | 首读文件缺失或内容无效时，用历史清单作种子；合法新文件（包括空清单）优先 | 原子发布新文件；坏文件尝试备份 `.bak`；读取失败不覆盖；种子写失败告警并可重试 | [QuickMessageStore.ts](../src/main/quickmessages/QuickMessageStore.ts)；`tests/quickMessages.test.mjs` |
| SC-001 | catalog 时间戳标题、标题锁及标题来源补齐 | `SessionCatalog.load` 按旧字段特征修复；写 `titleLocked/titleOrigin`，防止历史确认标题被自动覆盖 | 无全局标记；快照写失败保留内存结果、下次重试；legacy 标题还可按指纹修复 | [SessionCatalog.ts](../src/main/sessions/SessionCatalog.ts)；`tests/sessionCatalog.test.mjs`、`tests/sessionCatalogTitleOrigin.test.mjs`、`tests/sessionCatalogManualTitleSurvivesRestart.test.mjs` |
| SC-002 | catalog 相对 `filePath` → 绝对路径及重算 `originKey` | catalog 加载时由注入的 resolver 解析项目路径 | 新路径形态为判据；写失败下次重试；不是改写 pi 历史正文 | [SessionCatalog.ts](../src/main/sessions/SessionCatalog.ts) 的 `repairRelativeFilePaths`；`tests/sessionCatalogLegacyPathHeal.test.mjs` |
| SC-003 | DSH/ACP catalog 被 pi 字段污染的身份修复 | 加载时先给 DSH 补 `dshSessionId`，再清除 DSH/ACP 的 `filePath/piSessionId/originKey` | 字段形态为判据；写失败下次重试；会话原文件由对应后端拥有 | [SessionCatalog.ts](../src/main/sessions/SessionCatalog.ts)；`tests/sessionCatalog.test.mjs` |
| DS-001 | DSH_HOME 根的 PiDeck 私有文件 → `.pideck/` | DSH host 初始化前：`.pideck-archive/`、`usage-probes.json`、`.pideck-host.lock` 各自搬到新布局 | 目标存在则跳过并保留源；异常静默、无完成记录；代码称旧布局仅开发/试用存在，退役证据待确认 | [pideckDshHome.ts](../src/main/dsh/pideckDshHome.ts)、[DshHost.ts](../src/main/dsh/DshHost.ts)；`tests/pideckDshHome.test.mjs` |
| DS-002 | 共享 `settings.yaml` → PiDeck 私有 profile patch | 首次初始化 `.pideck/profile/cordis.patch.yml`；只导入用户配置并转换旧 namespace/default 字段 | 原 settings 永远保留；同目录临时文件原子发布；已有 profile 为判据，错误不发布半截文件 | [dshProfileSettings.ts](../src/main/dsh/dshProfileSettings.ts)；`tests/dshProfileSettings.test.mjs`；[DSH 升级对照](dsh-0.2.0-migration.md) |
| IM-001 | 生图 JSONL 内联 base64 → `blobs/<ref>` + 消息引用 | 每个会话首次读/追加时有界探测，流式转换；与追加共用文件锁 | 无完成 ledger；按格式继续探测。转换失败的图片行原样保留；原子替换并受历史预算限制，损坏行尽量保留 | [ImageSessionStore.ts](../src/main/imagegen/ImageSessionStore.ts)；`tests/imageGenLegacyMigrationNoLoss.test.mjs`、`tests/imageGenMigrationAppendRace.test.mjs`；[生图存储细则](maintenance-domains.md#生图会话存储userdataimagegensessions-索引--blobs-图片) |
| DR-001 | 单文件 `scratch-pad.md` → `drafts/<旧mtime>.md` | 首次访问草稿接口；非空旧文件复制，之后删除旧文件 | 以旧文件消失为判据；异常静默；目标同名时现有 `copyFile` 可覆盖，专属迁移回归/冲突验收待补 | [scratchPadIpc.ts](../src/main/ipc/scratchPadIpc.ts) 的 `ensureDraftsDir`；`tests/scratchPadIpcBoundary.test.mjs` 为相邻接口校验入口 |
| EX-001 | 用户扩展目录历史内置副本/已下线文件清理 | 启动时按内置扩展名单和两个历史文件名删除 `~/.pi/agent/extensions/` 副本，含已配置 WSL home | 无完成记录；逐文件失败吞掉、下次再试；按名称删除，无内容指纹确认，备份/用户修改保护待核查 | [index.ts](../src/main/index.ts) 的 `migrateLegacyBuiltInExtensions/removeStalePiDeckExtension`；扩展打包/加载测试不能替代删除安全验收 |
| VC-001 | 旧语音配置缺 `enabled` 时保留已开启体验 | 读取 `voice-transcription.json`：缺 enabled 且有旧 protectedApiKey → enabled=true | 读取兼容，后续正常保存持久化；不改写/输出密钥，无专用完成记录 | [VoiceTranscriptionConfigStore.ts](../src/main/voice/VoiceTranscriptionConfigStore.ts)；`tests/voiceTranscriptionConfig.test.mjs` |

## UD-001：本次补齐的完成状态

### 范围与记录

- 正式安装根 `pi-desktop → PiDeck`；源码开发根 `pi-desktop-dev[-分支] → PiDeck-dev[-分支]`；Dev 安装独立根 `pi-desktop-channel-dev → PiDeck-channel-dev`。每个新根分别记录，不共享总标记。
- 完成文件：`<新userData>/user-data-name-migration.json`，实现为 [userDataMigrationState.ts](../src/main/projects/userDataMigrationState.ts)。当前 `schemaVersion:1`、`migrationVersion:1`、`status:"completed"`，绑定 `oldRoot/newRoot/sessionsRoot/platform`，含 `completedAt`。迁移版本与应用版本独立。
- 完成判据覆盖本迁移列出的设置/自动化/项目/目录记录/catalog 及备份/缓存、适用的草稿和飞书 JSON 路径，以及候选 encoded 会话目录与适用的 `header.cwd`。配置改写使用同目录临时文件 + flush + rename，写入/发布失败保留完整原文件；需要改写的配置若是符号链接则保留链接并报告未完成。会话正文按字节保留。
- 两代目录并存时不得改名/合并旧根数据（那份数据可能仍被旧版本使用），但仍要比对新根自己的目录与 header：只修「旧路径已消失、新路径存在」的会话，旧路径仍存在时保留原样。
- 会话候选来自根本身、一层实际子目录和 `chat-path.json` 登记路径，**不是所有磁盘数据的完整审计**。未涉及本根的自定义项目路径不处理。
- FE-001 子目录更名、Bot 格式、凭据解密和其它表项各自有独立边界；UD-001 的完成文件不证明它们已验收。

### 成功、失败与快速跳过

1. 显式数据目录/便携版跳过；新旧根都不存在视为新安装，迁移器不为此创建根或完成记录。
2. 新旧根同时存在时视为「降级后并存」：不改名、不合并、不删旧根，也不写完成记录；但仍跑幂等补修（仅针对新根自己的配置与已改到新名下的会话目录，旧路径仍存在时不改写 header）。这覆盖 beta 只改了目录名、header 仍指向已消失旧路径的存量用户。
3. 记录与本次上下文及迁移版本匹配时，只读小状态文件，跳过配置/JSONL 扫描和写盘。记录读取硬上界 16 KiB（另读 1 字节判定溢出）；损坏、超限、版本/路径/平台不符回到幂等核验。
4. 根 rename 失败返回旧根；根已改名但后续读写、扫描、会话冲突、header 损坏/目标缺失或并行追加导致发布放弃时，返回 `failed` 并继续使用新根。下次启动补修，不重新创建已消失的旧根。
5. 所有适用步骤成功后，独占创建同目录临时文件、flush，再 rename 发布完成记录；写入失败清理临时文件，不发布新完成记录。原有无效记录不作为成功依据。

失败原因在启动日志 `migration` 域补记，带实际 `userDataPath`。本记录保存成功结果，不持久化各失败步骤的完整历史。旧版本已改根但没有记录的用户会补核验；未来本迁移增加步骤或改变判据时，需要更新迁移版本及测试。

### 验收状态与回退

状态：实现与临时目录单测通过，三平台真实安装/升级及密钥环验收待完成。先在独立测试用户或 VM 中从仅有旧根的版本直升：核对实际数据根、设置/项目/会话可读并能续聊、飞书群绑定和密文、Dev 环境选择、第二次启动。详见 [命名维护细则](maintenance-domains.md#应用命名与历史数据目录迁移)。

完成记录不是备份，也没有自动反向迁移。旧版本仍可能使用旧根、重新建立第二份数据；回退须在停止 writer 后用事先备份核验。相同路径还原旧内容时要让完成记录与还原的数据一起处理，不能把后来生成的记录当作旧快照完成的证据。退役条件：明确最低支持的历史目录/数据格式、验证跨版本直升，或提供独立转换入口；目前保留兼容入口，不清旧数据。

## 上游拥有的迁移

| ID | 对象与 owner | PiDeck 责任及验收 |
| --- | --- | --- |
| UP-001 | DSH 0.1.5-rc.1 → 0.2.0-rc.2；会话 V3 → V4 由 DSH runtime 负责 | PiDeck 做 RPC/配置/投影适配及真实 runtime 隔离验收。只读时内存转换，写租约后发布独立 V4、保留 V3；不能只降 npm 版本回退，V4 新消息不会回填 V3。owner、验证证据与各平台未验收项统一见 [DSH 0.2.0 升级对照](dsh-0.2.0-migration.md) |
| UP-002 | DSH 0.2.0-rc.2 → 0.2.1-rc.2（经 0.2.1-rc.1）；会话格式不变，仍由 DSH runtime 负责 V3/V4 | PiDeck 适配依赖布局、PeerScope 必填、wire 描述符与预设变化，并显式声明过去靠 hoist 出现在顶层的 profile 插件包；rc.1 → rc.2 为补丁级（新增 web-deepseek-api provider 行、`WebRuntimeConfig` 字段改 Volatile），不改会话/RPC 契约，回退边界同 UP-001。验证证据与未验收项见 [DSH 0.2.1 升级对照](dsh-0.2.1-migration.md) |
| UP-003 | pi 自身会话格式、认证存储及 MCP 凭据迁移由 pi 负责 | PiDeck 保持 stdio RPC/既有认证边界；升级 pi 时验证会话恢复、读写及已有凭据可用，不另外实现 pi 存储迁移器 |

## 用户主动导入与复制

这些是可重复操作；操作结果与目标内容是完成依据，不应套用“升级后永远跳过”的标记。

| ID | 操作与入口 | 当前完成/失败边界 |
| --- | --- | --- |
| OP-001 | pi ↔ DSH 单供应商复制；[providerMigrationService.ts](../src/main/config/providerMigrationService.ts)、[providerMigration.ts](../src/main/config/providerMigration.ts)；`tests/providerMigration.test.mjs` | 先预览、同名覆盖由 UI 确认。只复制 API Key，OAuth 拒绝；DSH 已就绪用官方 API，否则合并 profile/credentials。多文件写入不是整体事务，出错可能已写部分，需检查目标后重试；不删源供应商 |
| OP-002 | 正式共用数据 → Dev 独立数据导入；[channelDataImport.ts](../src/main/dataEnv/channelDataImport.ts)、[dataEnvMarker.ts](../src/main/dataEnv/dataEnvMarker.ts)；`tests/channelDataImport.test.mjs` | 按白名单复制、排除可重建运行时/锁/日志等；重复导入可覆盖目标。取消/失败保留已复制部分，`phase:done` 表示该批结束；`pideck-env.json` 是环境选择指针，不是所有数据完成迁移的证明 |
| OP-003 | 旧用量 probes 数组 → 声明式 provider 配置；[ConfigManager.ts](../src/main/config/ConfigManager.ts)、[userUsageProbes.ts](../src/main/config/userUsageProbes.ts)；`tests/userUsageProbes.test.mjs` | 读取旧探针给弹窗回显/预填，用户保存新配置才写盘；仍保留旧探针兼容。没有启动期批量转换/总完成标记；检查 `saveUsageProbeForProvider` 结果及目标 provider 配置 |
| OP-004 | 外部 MCP 配置导入的字段转换；[mcpImport.ts](../src/main/resourceImport/mcpImport.ts) | 用户选择导入时转换旧 `disabled` 等字段，冲突/不保留字段给 warnings；配置写入属于用户确认的导入，不自动执行整仓迁移 |

## 持续兼容项

这些入口仍在每次读取或保存时工作，不能仅因某次迁移完成而删除。

| 对象 | 现有规则与入口 | 退役前证据 |
| --- | --- | --- |
| 飞书 legacy base64 / `v2:` safeStorage 密文 | [FeishuConfig.ts](../src/main/feishu/FeishuConfig.ts) 按前缀解密，新写入按 safeStorage 可用性处理；旧数据不会首读批量重加密 | 旧格式支持范围与真实 OS 密钥环验收；`tests/feishuSecretStorage.test.mjs` 仅证明模拟存储行为 |
| 应用安装/加密/浏览器存储身份 | [appBrand.ts](../src/main/utils/appBrand.ts) 保留 Electron 初始化时的历史名；bundle ID、AUMID 和历史 `pi-desktop:*` localStorage key 保持兼容 | 名称统一不等于身份更换；必须证明确有安全转换路径，不能全局字符串替换 |
| 模型 API 历史别名 | [ConfigManager.ts](../src/main/config/ConfigManager.ts) 保存时把 `anthropic`、`openai-chat-completions` 转成官方名，未知 API ID 保留 | 用户仍可导入旧配置；移除前明确支持的配置格式，不能用网络探测兜底改写保存值 |
| DSH 凭据旧扁平布局 / v1 `refs` 布局 | [dshCredentials.ts](../src/main/dsh/dshCredentials.ts) 先读 refs、再兼容扁平值；供应商复制沿用官方写格式 | 核实旧布局使用范围及转换成功证据；读兼容本身不证明磁盘已完成格式改写 |
| 技能重命名后的禁用列表同步 | [SkillManager.ts](../src/main/skills/SkillManager.ts)、[ProjectResourceManager.ts](../src/main/projects/ProjectResourceManager.ts) 在用户重命名时替换旧 name | 属资源操作的数据维护；不能用启动迁移记录跳过后续重命名 |

## 待回顾处理的事项

以下为本次代码核对发现，尚未据此修改其它迁移实现。

| 优先级 | 对应 ID | 后续工作与判定目标 |
| --- | --- | --- |
| 高 | UD-001 / FE-001 | 补 Linux 真实升级，再补 Windows/macOS；验收正常升级、两根冲突、重试及密钥环可用性。完成文件不能代替安装包验收 |
| 高 | RS-001 | 复现并测试“原生写成功、清理旧记录失败”与 unresolved 后资源再次可解析：当前记录先于 cleanup，后续因已记完成而跳过。明确“写入完成/清理待重试/未解析待处理”的区别，再决定实现 |
| 高 | UD-001 | 并行/降级场景的真实验收：本机已见「旧根只剩 Chromium 壳、新根完整、beta 已改目录名但 header 未补」的形态；并存分支现在仍补修 header，需在真实安装上复验 |
| 高 | DR-001 / EX-001 | 验收旧便签同名目标的保护、复制后删除的失败窗口，以及扩展文件由用户编辑后的备份/内容识别。当前按文件名删除/覆盖的事实应留在记录中，不能表述为普遍保守迁移 |
| 中 | FE-002 | 为 v1 缺 Bot ID 的配置补跨次读取/重启验收，确认生成 ID 与绑定文件不会漂移；读到 v2 之前不宣称磁盘迁移完成 |
| 中 | DS-001 | 核实“只存在开发/试用旧布局”的实际版本范围，并验收 rename 失败后读取旧配置/归档的可用性；路径函数返回新布局，不能只凭注释认定有完整旧位置兜底 |
| 中 | RS-002 / 各字段兼容 | 核实最低支持的历史版本/格式，再判断哪些需要专门完成记录、哪些保留廉价幂等探测；没有证据时不按“过了几个版本”删入口 |

## 本次验证记录

UD-001 完成状态改动已验证：

```bash
node --test tests/userDataMigrationState.test.mjs tests/userDataNameMigration.test.mjs tests/userDataSessionHeaderMigration.test.mjs tests/devUserDataMigration.test.mjs tests/portableUserData.test.mjs
```

86 项通过。覆盖首次迁移、已改根补修、快速跳过、完成记录损坏/版本/路径/平台不符/超限与读取竞态、读写/扫描/发布失败后重试、配置中断写入保留完整原文件、符号链接保护、根/会话目录冲突、并存时的保守补修（旧路径已消失才改 header）、header 损坏/目标缺失和并行追加保留。

真实机器验收（2026-10-12，Linux 安装版）：`pideck 0.9.0` 安装包内已含本迁移代码；`~/.config/PiDeck-dev` 完成记录已生成（`pi-desktop-dev` 已改名），dev 会话 header 全部指向新路径；`~/.config/PiDeck` 与仅剩 Chromium 壳的 `~/.config/pi-desktop` 并存，启动日志出现 collision 告警，当时未补修 9 个仍指向 `/home/zhadainian/.config/pi-desktop/chat-workspace` 的 header（旧路径已不存在），因此更正为并存也跑补修；会话文件与环境配置未被改动。
重新打包启动后复验（同日 20:45，安装包已含修复）：15 个会话的 header 全部指向新路径（原 9 条旧路径归零），恰好只改写那 9 个文件，正文逐字节保留；项目会话（29+3）未被误改；`~/.config/pi-desktop` 未被碰；catalog 139 条 `filePath` 全部存在。
经用户确认，仅含 `Local State`（57 B，sha256 前缀 b56ef05d）、`Crashpad/client_id`（36 B，b6b9c373）和一个空目录的空壳旧根已用 `gio trash` 移入回收站（`~/.local/share/Trash/files/pi-desktop`，可还原）；根目录内 2 个 `session-catalog.json.*.tmp`（2026-09-26 旧残留）按用户选择保留。旧根已不存在，下次启动会重跑一次全链路并写入完成记录，之后走快速跳过。

TypeScript 使用 `tsconfig.main.json` 选项，仅以四个迁移模块为根进行 noEmit 定向检查，通过；启动装配文件语法检查通过。触达源码/测试的 Biome 格式检查及自身改动的差异空白检查通过。未执行全仓构建、完整应用类型检查、打包、真实用户数据迁移或系统密钥环 smoke。其它条目的测试本次未重新运行。
