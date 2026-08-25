# PiDeck 云同步调研报告（服务商评估 + 本地导入导出）

> 状态：**调研完成**。本文回答两个问题：
> 1. 现有云同步服务商能否满足需求？有没有更适合小白/普通用户的方法？
> 2. 本地一键导入/导出（不依赖云服务器）能否实现？
>
> 配套文档：实现方案见 `docs/cloud-sync-plan.md`；本文是它的前置调研，结论可直接并入计划。

---

## 0. 结论摘要（TL;DR）

1. **现有 5 类服务商“能用，但都不适合小白”**：WebDAV/S3/Gist 有配置门槛（URL、bucket、token），Google Drive/OneDrive 卡在 OAuth 客户端凭据。它们服务技术用户没问题，但“普通用户开箱即用”这条路是缺的。

2. **强烈建议新增第 6 类 provider：本地文件夹适配器（Local Folder）**。
   - 原理：用户选一个**本地文件夹**（比如他已经在用的 OneDrive / 坚果云 / 百度网盘 / 阿里云盘桌面客户端的同步目录），PiDeck 把加密对象写进该文件夹，**云同步交给用户已有的网盘客户端**。
   - 零新账号、零新配置、零 OAuth；完全离线可用；实现成本约一个 100~200 行的适配器（复用现有 `PiDeckCloudObjectStorage` 接口，WebDAV 适配器的临时文件 + rename 逻辑可直接抄）。
   - **这是“普通人能用的云同步”的最优解**：不依赖任何新服务商，天然规避所有第三方 API 的单文件大小/频率/流量限制。

3. **OneDrive 原生 OAuth 值得优先实现**：PiDeck 注册一次 Azure AD 应用即可，用户走浏览器登录（微软账号普及、Windows 自带客户端、国内可访问），是“真云”里对小白最友好的选项。Google Drive 国内不可用，降级为海外用户选项。

4. **本地一键导入/导出：完全可行，且应当做**。它就是“云同步的离线快照版”，与云同步共用 90% 代码（扫描、payload、加密、路径重映射、合并）。没有云服务也能实现：跨设备迁移、U 盘/聊天工具传文件、定期归档备份。

5. **组合拳 = 无云也能“伪云同步”**：本地文件夹适配器 + 任意网盘客户端 = 全自动云同步；导入导出 = 离线兜底。两者都落地后，“有没有云服务器”不再是使用前提。

---

## 1. 现状盘点（代码侧）

| Provider | 状态 | 实现位置 |
|---|---|---|
| WebDAV | ✅ 已实现（basic/digest/token） | `src/main/cloudSync/adapters/WebDAVObjectStorage.ts` |
| S3 兼容 | ✅ 已实现（条件写 + ETag revision） | `src/main/cloudSync/adapters/S3ObjectStorage.ts` |
| GitHub Gist | ✅ 已实现（Device Flow + 1MB/文件上限） | `src/main/cloudSync/adapters/GithubGistObjectStorage.ts` |
| Google Drive | ❌ 未实现（需 OAuth 客户端凭据） | 工厂显式报错（`adapters/index.ts`） |
| OneDrive | ❌ 未实现（需 OAuth 客户端凭据） | 工厂显式报错（`adapters/index.ts`） |

架构核心（与本次调研直接相关）：

- `PiDeckCloudObjectStorage` 统一接口（`objectStorage.ts`）：`connect / readObject / writeObject / deleteObject / getCapabilities`，适配器只处理“加密字节的对象读写”，与业务无关 → **新增 provider 的成本极低**。
- 加密（`EncryptionService.ts`）：PBKDF2（60 万次）+ AES-256-GCM，主密码/派生 key 只存主进程。
- 索引/对象分离（`payload.ts`）：小索引（`pideck-index.json`）+ 大会话对象（`pideck-sessions/<id>.jsonl.enc`）。
- 三路合并 + 缩水保护（`merge.ts`、`CloudSyncManager.ts`）。

---

## 2. 现有服务商逐个评估

### 2.1 GitHub Gist

- **门槛**：需要 GitHub 账号 + token，或 Device Flow（clientId 仍要用户自备）。程序员日常，普通人没有 GitHub 账号。
- **限制**：单文件 1MB（现有 `getCapabilities` 已按此限制处理）、API 频率限制（认证用户 5000 次/小时）。
- **适合**：索引、配置声明、轻量数据、小会话；**不适合**大会话/大资源。
- **小白友好度**：★★☆
- **结论**：保留，定位“技术用户选项”；不指望它服务小白。

### 2.2 WebDAV

- **门槛**：中等——“WebDAV 是什么、URL 填什么、应用密码怎么生成”对普通用户就是三道坎；需要用户先有一个 WebDAV 服务。
- **国内可用的 WebDAV 服务商**：

| 服务商 | 免费额度 | 单文件限制 | 国内可用 | 备注 |
|---|---|---|---|---|
| **坚果云** | 免费版空间小（约 1GB 量级）+ 每月上传/下载流量限制（历史口径 1GB 上传 / 3GB 下载，以官方最新政策为准） | WebDAV 单文件有大小上限（免费档更严，官方帮助中心有“流量不足/空间不足”说明） | ✅ 好 | 国内最常用的第三方同步通道（Zotero/Obsidian 生态标配），但**流量+单文件双限制不适合 PiDeck 的大会话对象** |
| **InfiniCloud（阿里云盘海外版）** | **免费 25GB 永久** | 宽松 | ✅ 好 | 设置里开 WebDAV + 独立密码即可，**目前性价比最高的 WebDAV 选择** |
| 123云盘 | WebDAV 是**会员功能** | 会员单文件 1GB | ✅ | 曾限制第三方 Alist 挂载，政策风险高，不建议官方推荐 |
| 天翼云盘 | — | — | ⚠️ | 无官方 WebDAV，第三方工具不稳定 |
| Koofr / pCloud / Icedrive（国外） | 各 10GB 免费 | 宽松 | ❌ 一般 | 海外用户可用 |

- **小白友好度**：★★★☆（坚果云生态熟、教程多，但仍要填配置）
- **结论**：保留，并重点优化配置引导（内置“坚果云 / InfiniCloud 一键配置模板”+ 官方教程链接）；大对象场景明确提示换 S3/本地文件夹。

### 2.3 S3 兼容对象存储

- **门槛**：**最高**——注册云厂商、实名认证、控制台建 bucket、生成 AccessKey/SecretKey。小白完全不行，技术用户也要折腾。
- **免费额度**：

| 服务商 | 免费额度 | 国内直连 |
|---|---|---|
| Cloudflare R2 | 10GB 存储 + 100 万次 A 类 / 1000 万次 B 类操作/月 + **免出口流量** | ⚠️ 不稳 |
| Backblaze B2 | 10GB 存储 | ⚠️ 一般 |
| 腾讯云 COS | 新用户免费额度（约 50GB 标准存储 + 10GB 流量，期限与细则以官方为准） | ✅ 好 |
| 七牛云 Kodo | 免费额度（约 10GB 存储 + 每月流量，需个人实名认证） | ✅ 好 |
| 阿里云 OSS | 以按量付费为主 | ✅ 好 |

- **适合**：技术用户自建、公司内网 MinIO、R2/B2 当“免费对象存储”。
- **小白友好度**：★☆
- **结论**：保留（技术用户 + 自托管），不进小白路径。

### 2.4 Google Drive

- **门槛**：需要注册 Google Cloud 项目 + OAuth consent（未验证应用会弹“unverified app”警告）；**国内不可用**。
- **结论**：保留为“海外用户”选项，实现优先级最低。

### 2.5 OneDrive

- **门槛**：PiDeck 注册一次 Azure AD 应用（个人版账号、免费 5GB 可用），之后用户只做**浏览器登录**。
- **国内可用性**：✅ 好（onedrive.live.com 可访问，Windows 自带客户端普及率高）。
- **小白友好度**：★★★★（微软账号 + 浏览器授权，最接近“普通人的云同步”）。
- **结论**：**建议优先实现**，是对小白最友好的“真云”选项。

---

## 3. 针对小白用户的更好方案

### 3.1 方案 A（强烈推荐）：本地文件夹适配器（Local Folder Provider）

> 状态：**已实现**（2026-08 随统一 provider 模型落地）：`"local"` 已并入 `BUILTIN_CLOUD_PROVIDERS`，适配器见 `src/main/cloudSync/adapters/LocalFolderObjectStorage.ts`，设置页提供「本地同步文件夹」卡片（文件夹选择器复用 `dialog:pick-files`）。

**原理**：用户选择一个本地文件夹（任何路径，推荐选其网盘客户端的同步目录），PiDeck 把 `pideck-index.json` 与 `pideck-sessions/*.enc` 作为普通文件写进该文件夹；**上云这件事交给用户已有的网盘客户端**（OneDrive / 坚果云 / 百度网盘 / 阿里云盘 / iCloud…）。

**为什么这是“普通人能用”的最优解**：

1. **零新增成本**：不注册任何新账号、不填任何 URL/bucket/token，用户只做一件会做的事——“选个文件夹”。
2. **天然规避第三方限制**：单文件大小、API 频率、流量限额全部由网盘客户端处理，PiDeck 无需关心。大会话（512MB 上限）直接写文件即可。
3. **完全离线可用**：本地文件夹同步本身就是“伪云”，断网也能跨目录/跨盘迁移。
4. **实现成本极低**：新增 `LocalFolderObjectStorage` 适配器实现现有 `PiDeckCloudObjectStorage` 接口即可；revision 用文件 mtime+size，条件写用“临时文件 + rename”（WebDAV 适配器已有同款逻辑）；约 100~200 行。
5. **与导入导出天然衔接**：同一个适配器稍作扩展就是“导出到文件夹”，天然支持“定时快照备份”。

**代价**：同步延迟取决于网盘客户端；多设备并发仍走现有三路合并（已具备）；用户必须已有/愿意装一个网盘客户端——但这是“普通人”本来就有的东西。

**小白友好度**：★★★★★

#### 3.1.1 哪些网盘的“同步文件夹”真的能用（已查证）

判断标准只有一条：**这个文件夹是不是“本地真实存在 + 自动双向同步”**。用户可自测：在文件夹里新建文件 → 打开网盘网页版看是否自动出现 → 另一台设备是否自动出现。

| 服务商 | 同步文件夹 | 容量 | 关键限制（已查证） | 适合 PiDeck？ |
|---|---|---|---|---|
| **OneDrive**（Windows 自带） | ✅ 真实本地文件夹，自动双向同步 | 免费 5GB | 无（“文件按需”只是可选优化） | ✅ 首选 |
| **坚果云** | ✅ 同步文件夹就是本职 | 免费 1GB 空间 + 每月上传/下载流量 | 流量/单文件限制严格 | ⚠️ 只适合小对象 |
| **百度网盘“同步空间”** | ✅ 本地文件夹自动同步 | **共享网盘总容量**（免费通常 1TB+） | **免费用户每月仅 1GB 同步流量**（当月有效不结转，SVIP 无限） | ⚠️ 容量够，**流量是硬限制**，不适合大会话 |
| **WPS“同步文件夹”** | ✅ 有 | 免费一般 1TB | **单文件 ≤ 2GB**、**同步文件总数 ≤ 20,000**（大会员同样受限，官方社区实测确认）；会员相关功能 | ✅ 够用（2GB > 512MB 会话上限） |
| **天翼云盘“同步盘”** | ✅ 有 | 以官方为准 | 以官方为准 | 待确认 |
| **Google Drive 桌面版** | ⚠️ 仅**镜像模式**是真实本地文件夹；**在线访问模式是虚拟盘**（占位符按需下载）不适合 | 免费 15GB | 国内网络不可访问 | ❌ 国内不可用，仅海外 |
| Dropbox（海外） | ✅ 真实本地文件夹 | 免费 2GB | 无 | ✅ 海外用户 |

**明确不行的**：只有“网盘目录 + 手动上传/下载”的服务（如百度网盘主存储、阿里云盘官方客户端的单向“备份”）——因为 PiDeck 需要的是一个**会自动同步的本地文件夹**，不是网页网盘。

#### 3.1.2 澄清：Google / OneDrive 的“两条路”（API 直连 vs 本地文件夹）

调研中容易混淆的一点：Google/OneDrive 有**两种完全不同的接入方式**，两者互补而非互斥：

| | 路径 A：API 直连（计划文档的 OAuth 适配器） | 路径 B：本地文件夹适配器（本文方案） |
|---|---|---|
| PiDeck 怎么连云 | PiDeck 自己调 Google Drive API / Microsoft Graph API | PiDeck 不调 API，只读写用户本地文件夹 |
| 用户需要 | 浏览器 OAuth 登录一次 | 已装官方桌面客户端 |
| 本质 | 远程（PiDeck 直接连云） | 本地（上云由桌面客户端完成） |
| OneDrive | ✅ 可行（需注册 Azure 应用） | ✅ 最典型：Windows 自带客户端维护真实本地文件夹 |
| Google Drive | ❌ 未实现（卡 OAuth 凭据）；国内不可用 | ⚠️ 仅镜像模式可行；国内不可用，仅海外 |

**结论**：对国内小白，OneDrive 两条路都值得做（路径 B 成本更低，路径 A 免装客户端）；Google Drive 两条路都只服务海外用户，优先级最低。

### 3.2 方案 B：内置 OneDrive OAuth（优先做）

实现一次 Azure 应用注册，用户浏览器登录即用；对微软生态用户（Windows 11 自带）最顺。适合作为“真云”首选。

### 3.3 方案 C：一键导入/导出（见第 5 节）

离线兜底，任何用户任何环境可用。

### 3.4 不建议的方向

| 方向 | 原因 |
|---|---|
| Google Drive | 国内不可用；仅海外用户 |
| Syncthing 集成 | P2P 需两台设备同时在线 + 中继配置，普通用户门槛高；用户可自行使用，PiDeck 不必内置 |
| Telegram 当存储后端 | 违反 ToS 风险、不稳定、hack 味道重 |
| 百度网盘/微云开放 API | 需企业认证/应用审核，周期长且政策多变 |
| 阿里云盘开放平台 API | 需开发者认证 + 频率限制，不如直接走 InfiniCloud WebDAV |

---

## 4. 服务商对比总表

| Provider | 小白友好度 | 免费额度 | 单文件限制 | 国内可用 | 实现成本 | 建议优先级 |
|---|---|---|---|---|---|---|
| **本地文件夹（新增）** | ★★★★★ | 无（用用户自己的） | 无 | ✅ | 极低（1 个适配器） | **P0** |
| **导入/导出（新增）** | ★★★★★ | 无 | 无 | ✅ | 中（容器模块 + UI） | **P0** |
| OneDrive（原生 OAuth） | ★★★★ | 5GB 起 | 宽松 | ✅ | 中（注册一次 Azure app） | **P1** |
| WebDAV（坚果云/InfiniCloud） | ★★★☆ | InfiniCloud 25GB / 坚果云 1GB+流量 | 坚果云严格 | ✅ | 已实现 | P1（优化引导） |
| GitHub Gist | ★★☆ | 无 | 1MB | ✅ | 已实现 | P2（保持） |
| S3（R2/B2/COS/七牛/MinIO） | ★☆ | 各 10GB 起 | 宽松 | 分厂商 | 已实现 | P2（保持） |
| Google Drive | ★☆ | 15GB | 宽松 | ❌ | 中 | P3（海外） |

---

## 5. 本地一键导入/导出（第二部分）

> 状态：**已实现**（2026-08 落地）。格式 `.pideckbackup` 单文件容器，实现见 `src/main/cloudSync/exportImport.ts`，设置页「备份与恢复」Tab 提供导出/导入入口；三种导入模式（智能合并/覆盖/仅恢复缺失），路径重映射与待映射区与云端 pull 完全一致。详见 `cloud-sync-plan.md` §6.5。

### 5.1 可行性结论

**完全可行，且应当做。** 它本质是“云同步的离线快照版”：把“推送到云端对象存储”换成“写入一个本地文件包”，把“从云端拉取”换成“从文件包恢复”。与云同步共用扫描、payload 构建、加密、路径重映射、合并逻辑，**不是新功能域，而是同一管线的离线出口**。

### 5.2 文件格式建议

**单文件 `.pideckbackup`（版本化容器）**，理由：小白心智里“一个文件 = 一份备份”，比文件夹更不易漏拷。

```
PIDECKBACKUP 容器
├── 文件头：magic "PIDECKBACKUP" + formatVersion + 创建时间 + 创建设备
├── 加密清单（header）：复用现有 SyncedFile 加密格式（PBKDF2 + AES-256-GCM）
│     → 内含 PiDeckSyncIndexV1（设置/pi/项目树/会话引用）+ 各对象元数据（key/hash/size）
└── 加密对象区：pideck-sessions/<id>.jsonl.enc 等，逐个加密条目（或 gzip 后加密）
```

- **完全复用现有加密原语**（`EncryptionService.encryptPayload / decryptPayload`、`SyncedFile` 格式），不引入新加密栈。
- 对象条目按 key 索引，**支持增量/局部恢复**（比如只恢复某个项目）；也便于以后做“增量导出”。
- 可选更简单的替代：加密 ZIP（对象名用内容哈希，避免泄漏文件名）；但自研容器对“单文件流式写入/读取”更可控，且已有 `SyncedFile` 格式可直接用，**建议自研容器，不引 zip 依赖**。

### 5.3 导出流程

1. 复用 `CloudSyncScanner` 扫描（与云同步完全相同的选择树：全局/项目/会话/资源）；
2. 复用 `payload.ts` 构建 `PiDeckSyncIndexV1`；
3. 用户选择导出位置（默认 `文档/PiDeck 备份/`）；
4. 所有选中会话/资源加密为对象条目，连同加密清单写入容器（流式，避免内存爆掉 512MB 会话）；
5. 完成提示：文件路径 + 大小 + “请牢记主密码，丢失无法恢复”。

### 5.4 导入流程

1. 用户选择 `.pideckbackup` 文件；
2. 输入主密码，校验（复用 `verifyPassword`）；
3. 选择导入模式：
   - **智能合并（默认）**：复用 `merge.ts` 三路合并，冲突时复用现有冲突 UI；
   - **覆盖恢复**：以包内容为准（需二次确认，类似现有缩水保护确认）；
   - **仅恢复缺失**：本机已有文件不动；
4. **路径重映射**：完全复用 pull 的逻辑——全局会话 → `~/.pi/agent/sessions/<relativePath>`；项目会话 → 本机匹配项目 → 否则落入 `cloud-sync-pending` 待映射区（等用户建项目后落位）；路径穿越/symlink 逃逸检查复用现有守卫；
5. 包扩展声明 → 复用现有 `pi install` 自动安装 + `missingExtensions` 重试机制；
6. 导入完成摘要：恢复 X 个会话 / Y 个资源 / 跳过 Z 个冲突。

### 5.5 无云场景的完整用法

| 场景 | 做法 |
|---|---|
| 换新电脑、无网络 | 旧机导出 → U 盘/微信文件传输助手/网盘 → 新机导入（智能合并） |
| 不想用任何云 | 本地文件夹适配器 + 任意网盘客户端 = “伪云同步”；或纯手动导出/导入 |
| 定期归档 | 导出即快照备份，可配合定时任务自动导出 |
| 云同步的补充 | 大版本升级前导出一次，作为回滚保险 |

### 5.6 边界与风险

- **大文件**：沿用现有 512MB 会话上限；导出/导入显示进度；流式写入避免整包进内存。
- **密码丢失**：零知识设计下不可恢复，导出完成页强提醒（与云同步一致）。
- **版本兼容**：`formatVersion` 字段 + 旧版本读取兼容（沿用“兼容旧数据”项目惯例）。
- **安全**：容器内相对路径只允许安全段（复用 `assertSafeCloudObjectKey` 类守卫），禁止 `..` / 绝对路径 / 盘符；恢复侧 symlink 逃逸检查复用现有逻辑。
- **误导入**：导入前展示“将影响本机哪些数据”的预估摘要 + 二次确认。

### 5.7 与现有代码的复用清单

| 现有模块 | 复用点 |
|---|---|
| `CloudSyncScanner.ts` | 导出时扫描选择树（原样复用） |
| `payload.ts` | 索引构建、路径安全过滤（原样复用） |
| `EncryptionService.ts` | 加密/解密/主密码校验（原样复用） |
| `merge.ts` | 导入智能合并、冲突收集（原样复用） |
| `CloudSyncManager.ts` 的 pull 恢复路径 | 落盘 + 扩展安装 + 待映射区（抽出为可复用函数） |
| **新增** `main/cloudSync/exportImport.ts` | 容器读写（magic/版本/流式条目） |
| **新增** `shared/types/cloudSync.ts` 扩展 | 导出选项/导入结果类型 |
| **新增** IPC + 设置页 UI | `cloud-sync:export*` / `cloud-sync:import*` + “备份与恢复”入口 |

---

## 6. 建议实施优先级（并入 cloud-sync-plan.md）

| 优先级 | 事项 | 说明 |
|---|---|---|
| **P0** | 本地文件夹适配器（Local Folder Provider） | 小白首选，实现成本最低，复用 WebDAV 适配器模式 |
| **P0** | 一键导入/导出（`.pideckbackup`） | 无云兜底，复用现有管线 90% |
| **P1** | OneDrive 原生 OAuth | 注册一次 Azure app，浏览器登录，小白最友好的“真云” |
| **P1** | WebDAV 配置引导优化 | 内置坚果云/InfiniCloud 一键模板 + 教程链接 |
| **P2** | 分块上传 | 配合大会话对象与受限服务商（坚果云单文件限制） |
| **P2** | Google Drive | 海外用户选项 |
| **P3** | DSH 会话/飞书数据同步 | 按原计划后续补齐 |

---

## 7. 参考资料

**WebDAV 服务商：**

- [坚果云第三方应用授权 WebDAV 开启方法](https://help.jianguoyun.com/?p=2064)
- [坚果云帮助中心：流量不足，空间不足](https://help.jianguoyun.com/?tag=%e6%b5%81%e9%87%8f%e4%b8%8d%e8%b6%b3%ef%bc%8c%e7%a9%ba%e9%97%b4%e4%b8%8d%e8%b6%b3)
- [快速实现 25G 永久存储！InfiniCloud 网盘 + Webdav 搭建详解（CSDN）](https://blog.csdn.net/lxx309707872/article/details/158580631)
- [123 云盘会员 WebDAV 上传文件大小限制改为 1GB（V2EX）](https://global.v2ex.co/t/1163374#reply5)
- [123 云盘暂停第三方软件 Alist 挂载（LINUX DO）](https://linux.do/t/topic/719403/10)
- [国内外主流网盘/支持 WebDAV 的网盘对比列表参考（Appinn）](https://meta.appinn.net/t/topic/75126#1#1)
- [国内外支持 WebDAV 的网盘汇总（Bilibili）](https://m.bilibili.com/opus/1145120761691766808#1)
- [10 Best Microsoft OneDrive Alternatives（Cloudwards，pCloud 等免费额度参考）](https://www.cloudwards.net/onedrive-alternatives/)

**S3/对象存储：**

- [Cloudflare R2 Pricing](https://cloudflare-docs.cloudflare-docs.workers.dev/r2/pricing/#1)
- [腾讯云 COS 免费额度](https://cloud.tencent.com.cn/document/product/436/6240#1)
- [七牛云 免费额度及查看方法](https://developer.qiniu.io/af/12968/freequota)
- [2025 年对象存储免费申请：腾讯云 COS 50GB+10GB 流量（腾讯云社区）](https://cloud.tencent.cn/developer/article/2567369)
- [Backblaze B2 Setup（10GB 免费存储参考）](https://deepwiki.com/twilligon/git-lfs-s3-proxy/4.3-backblaze-b2-setup#1)

**OAuth / 生态参考：**

- [Python 快速入门 | Google Drive API（OAuth 门槛参考）](https://developers.google.com/drive/api/quickstart/python?authuser=7&hl=zh-cn)
- [How do I create a free app with a OneDrive API？（Microsoft Q&A）](https://learn.microsoft.com/en-ie/answers/questions/5421338/how-do-i-create-a-free-and-open-source-app-with-a#1)

**导入导出 / 本地同步参考：**

- [Cherry Studio 数据设置：WebDAV 备份（同类型 Electron AI 桌面应用）](https://docs.cherryai.com.cn/pre-basic/settings/data-settings/webdav)
- [Obsidian 免费同步怎么选：Nutstore Sync（segmentfault）](https://segmentfault.com/a/1190000047902948)
- [Obsidian 七种主流多端同步方式（少数派）](https://sspai.com/post/104619#1)
- [Syncthing：开源文件同步神器（P2P 方案参考）](https://osp.io/archives/10111)
- [rclone：云存储备份和迁移的瑞士军刀（provider 生态参考）](https://cloud.tencent.cn/developer/article/2486544)

**同步文件夹实测数据（百度网盘 / WPS / Google / OneDrive）：**

- [Google Drive 桌面版：在线访问（Stream）与镜像（Mirror）模式官方说明](https://support.google.com/drive/answer/13401938?hl=zh-CN)
- [OneDrive Files On-Demand 说明（微软）](https://learn.microsoft.com/en-in/archive/blogs/nzedu/onedrive-files-on-demand-perfect-for-byod)
- [百度网盘“工作空间”上线报道：免费用户每月 1GB 同步流量，容量共享网盘总容量（站长之家/快科技，2021-05）](https://www.chinaz.com/2021/0519/1252250.shtml)
- [百度网盘“同步空间”实测（今日头条，2024-12，确认功能现行）](https://m.toutiao.com/article/7444175098375897615/?upstream_biz=toutiao_pc)
- [WPS 官方社区：同步文件夹限制文件总数与单个文件大小（大会员：<20,000 个文件、单文件 ≤2GB）](http://bbs.wps.cn/topic/37967)
- [WPS 官方社区：同步文件夹是否有文件数量限制（2024-12）](http://bbs.wps.cn/topic/45996)
- [WPS 会员特权：同步文件夹文件数权益页](https://vip.wps.cn/privilege_page/privilege_detail?id=filenum_in_sync_folder)
