# DSH 0.2.0 直接升级对照

状态：代码适配与本机隔离验证完成，发布前跨平台与人工 smoke 待补齐（0.1.5-rc.1 → 0.2.0-rc.2；不经过中间安装版本）。

## 边界与验收

本次只升级 PiDeck 的 DSH 运行时集成，不复刻 DSH 的执行器或存储迁移器。开发验证使用临时 HOME/profile，不读取凭据、不启动真实会话、不重启应用、不发布线上 runtime。

| 能力 | 新版变化 | 适配与验收 |
| --- | --- | --- |
| 运行时 | code-runtime 停发，PTC 后端替代 worker-thread | 精确锁版本、更新本地插件 peer 范围；归档闭包与 boot 门禁 |
| 预设 | registry + 声明式 preset bundle | 加载官方 standard/ptc/minimal/cordis，服务按预设隔离；不凭旧注释创建 code→ptc 别名 |
| 默认与配置 | settings 写入 profile patch | PiDeck 独立 profile + 官方 PluginPackages；旧配置保留并兼容导入，重启仍有效 |
| 用户预设 | 不再扫描 .agent-presets | 保留原目录、ID 与相对资源基准，转换已知停发模块，失败明确报错 |
| 预设删除 | deletePreset 端点删除 | 移除 UI/preload/IPC/host/remote 入口，不代写文件删除 |
| 模型选择 | host 目录不再携带会话当前选择 | 验证官方目录形状，从会话投影冷读 next/lastUsed；仅未配置会话回退到 host 默认 |
| 子代理 | subagents/list 端点删除 | 从 session/projections + session/list 读取目录/状态；保留 continuable 模式，排除 reference 和非直接 child 的历史访问 |
| fork | atSeq 精确包含式截断 | 排除将要回填的用户消息，校验安全整数及首条消息边界；clone 保持完成前缀 |
| 事件投影 | V4 toolCallId/isError、reasoning.text、顶层 usage、system/message | 保留旧历史读取；成功/失败、未知 callId/乱序并发、用量与系统提示清空回归 |
| 会话格式 | V3 → V4 | 上游负责；测试只读不落盘、写租约后原子发布、V3 原文件保留及最高代扫描 |
| 插件 | profile bundles 与配置重载 | 组合可重复加载，不引入 webserver/UI；每次重载读取当前共享 HOME 补丁，不冻结启动快照，不把 bundle 当作可随意删除的文件 |
| 隐私 | 新增遥测与授权插件 | 遥测硬关闭层最后生效；授权保留，不启动登录 |

## 升级与回退

新版只读会话时在内存转换，取得写租约后才生成独立 V4 文件，不覆盖 V3。旧 runtime 会选最高代并拒绝 V4，不能仅降 npm 版本实现回退；V4 新写入不会回填 V3。共享 DSH_HOME 的 CLI 同样受影响。回退前必须停止所有 writer，备份/核验数据；保留 V4 新增内容，禁止静默删除高代文件。

## 验证门禁

- `npm run typecheck`。
- `node --test tests/dsh*.test.mjs` 及触达的 IPC/UI 契约测试。
- `npm run check:dsh-wire`：真实新版描述符校验。
- DSH 本地插件单包构建；仅构建需要的 DSH 入口，不跑全仓构建。
- `runtime:pack` 输出到本次隔离目录，`runtime:check` + `runtime:check:boot`（真实归档、独立 HOME/profile，检查预设健康、配置持久化、服务隔离）。
- `node scripts/check-dsh-migration.mjs <runtime.tgz>`：真实 host/RPC 的 V3→V4、fork、只读/写租约及损坏输入门禁。
- 分平台归档只验证归档完整性；非本机平台真实运行需对应 runner，不把交叉打包称为跨平台运行通过。

## 交付记录

### 已通过

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（不生成应用构建产物） |
| `node --test --test-concurrency=4 --test-reporter=spec "tests/dsh*.test.mjs" tests/providerMigration.test.mjs` | 738 项通过，0 失败/跳过 |
| `node --test --test-concurrency=4 --test-reporter=spec tests/configUnsavedChangesSummary.test.mjs tests/providerOrder.test.mjs tests/ipcDeadChannelConstants.test.mjs tests/extractedIpcRegistration.test.mjs tests/storeSuggestionChipContrast.test.mjs` | 关联 IPC/UI/配置契约 25 项通过 |
| `npm run check:dsh-wire` | 30 个静态调用点形状匹配；事件网关及动态端点由实际 boot/迁移门禁和针对性测试覆盖 |
| `npm run build --prefix packages/dsh-tool-pwsh-persistent` | 本地 DSH 插件单包构建通过 |
| `node scripts/pack-dsh-runtime.mjs --out "$TEMP/pideck-dsh-020rc2-final" --lite` | win32-x64 归档成功 |
| `node scripts/check-dsh-asar.mjs "$TEMP/pideck-dsh-020rc2-final/dsh-runtime-win32-x64.tgz"` | 38,141 entries；19 基线包 + 9 入口包、606 package dirs 的入口与关键文件通过 |
| `node scripts/check-dsh-boot.mjs "$TEMP/pideck-dsh-020rc2-final/dsh-runtime-win32-x64.tgz"` | 真实 hostEntry 与 RPC 启动、官方/旧预设健康、相对资源、配置保存/重启及隐私隔离通过 |
| `node scripts/check-dsh-migration.mjs "$TEMP/pideck-dsh-020rc2-final/dsh-runtime-win32-x64.tgz"` | V3 冷读不落盘、写入生成 V4、V3 字节保留、V4 重启、损坏输入拒绝发布、最高代扫描、follow/control/fork 通过 |
| `node --test --test-reporter=spec tests/dshProfileSettings.test.mjs` | 最终格式化后复跑 6 项通过，含共享 HOME 补丁重载回归 |
| `npm exec -- biome format $(git diff --name-only -- src tests scripts) $(git ls-files --others --exclude-standard -- src tests scripts)` + `git diff --check` | 44 个触达源码/测试/脚本格式检查及差异空白检查通过 |

`check-dsh-boot` / `check-dsh-migration` 使用 `scripts/dsh-boot-harness.mjs` 只构建 DSH 入口，通过 Node 子进程承载实际 hostEntry，模拟 Electron parentPort；不是在运行中的 Electron 应用内重启 host。所有会话、配置、旧预设 fixture 都在临时 HOME，结束时清理，不读取真实凭据或调用模型。

### 保留的验证产物

本次 win32-x64 产物位于 `C:/Users/14012/AppData/Local/Temp/pideck-dsh-020rc2-final/`：

- `dsh-runtime-win32-x64.tgz`：真实归档门禁验证对象，159,785,811 bytes（152.4 MiB）；runtime `0.2.0-rc.2`，最低应用版本 `0.7.8-beta`。
- `dsh-runtime-win32-x64-releases.json`：下载索引与完整性校验元数据。
- 归档 SHA-256：`1b0f93c627ebb838c66ac9181f57f9b71b8443f3bd16bb6d642820f05731db2a`。

体积高于升级前调研中的 30–56 MB 估计；以上是实际打包结果。未为压缩体积删减未知运行时依赖。本次没有执行全仓构建、发布、应用重启或真实用户数据迁移。

### 未验证及发布前要求

- 其他五个目标平台的归档完整性与真实启动不在本次已通过范围；需各自对应 runner 补齐。
- 未验证安装包内的 Electron utilityProcess、真实供应商请求/工具执行及人工 UI smoke；无凭据环境的 RPC/存储验证不能替代这些项目。
- 未上传 runtime sidecar 或发布应用/公告。在线 Release 仍需同时提供新版各平台 tgz 与索引，否则新版本门控会拒绝旧 runtime。
- 发版时通过 `announcements-md` → `npm run build:announcements` 发布重新下载及 V4 回退边界提醒；安装包/sidecar 和中英文发布说明按项目发版流程处理。
