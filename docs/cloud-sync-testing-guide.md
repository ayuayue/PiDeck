# PiDeck 云同步全链路测试指南

> 覆盖三大入口：**增加云服务**（6 类 provider）、**同步内容**（扫描/选择/同步/冲突/自动同步）、**导入导出**（备份与恢复）。
> 先跑自动化层（105 项测试）确认代码绿，再按本指南做真实手工链路。

---

## 0. 自动化层（先确认代码状态）

```bash
npm run typecheck
node --test tests/cloudSync*.test.mjs tests/rendererProductCopyI18n.test.mjs
```

覆盖（`tests/` 下）：

| 测试文件 | 覆盖 |
|---|---|
| `cloudSyncEncryption.test.mjs` + `cloudSyncIndexValidation.test.mjs` | 主密码 PBKDF2/AES-256-GCM、索引 schema 校验 |
| `cloudSyncAdapters.test.mjs` | WebDAV/S3 适配器（条件写、可续传） |
| `cloudSyncGithubGist.test.mjs` | Gist Device Flow |
| `cloudSyncLocalFolder.test.mjs` | 本地文件夹适配器 + manager 端到端 |
| `cloudSyncOneDrive.test.mjs` | OneDrive 适配器 + **真实回环 OAuth 端到端** |
| `cloudSyncGoogleDrive.test.mjs` | Google Drive 适配器 + 真实回环 OAuth |
| `cloudSyncExportImport.test.mjs` | `.pideckbackup` 容器/往返/三种导入模式 |
| `cloudSyncDshSessions.test.mjs` | DSH 会话扫描 + zstd 往返 + 备份恢复 |
| `cloudSyncManager.test.mjs` / `cloudSyncMerge.test.mjs` / `cloudSyncScanner.test.mjs` / `cloudSyncProviders.test.mjs` / `cloudSyncMounts.test.mjs` | 编排/合并/扫描/边界/挂载 |

---

## 1. 准备：双实例模拟"两台设备"

单实例锁按 `userData/instance-locks/<version>.lock` 隔离 → **不同 `--user-data-dir` 的实例可并行**（dev 模式官方支持该参数）。

```bash
# 终端 A = 设备 A
npm run dev
# 终端 B = 设备 B（全新空数据目录 = 一台新机器）
npm run dev -- --user-data-dir=C:\PiDeckDeviceB
```

> 正式环境设备 A/B 就是两台真实机器或两个系统账号；本地模拟用上面的参数即可。

---

## 2. 增加云服务（全部 6 类）

打开 **设置 → 云同步**。首次使用先设**主密码**（≥8 位，牢记——忘记无法找回云端数据，零知识设计）。

| Provider | 真实配置步骤 | 小白友好度 |
|---|---|---|
| **本地同步文件夹** ⭐推荐先测 | 卡内「选择文件夹…」→ 选任意目录（如 `D:\PiDeckSync`，可先建空目录）→ 保存并连接。**无需任何账号** | ★★★★★ |
| **WebDAV（坚果云）** | 坚果云网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 生成**应用密码**；卡内点「坚果云」模板自动填 endpoint `https://dav.jianguoyun.com/dav/`，用户名=邮箱、密码=应用密码 | ★★★★ |
| **WebDAV（InfiniCloud）** | infini-cloud.net My Page 开启 Apps connection 生成 Apps Password，WebDAV 地址见 My Page（`https://<子域名>.teracloud.jp/dav/`） | ★★★☆ |
| **GitHub Gist** | 点「通过设备码连接」→ 浏览器打开链接输入设备码授权（Device Flow 浏览器验证）。**注入 `VITE_SYNC_GITHUB_CLIENT_ID` 后隐藏 Client ID 输入、直接连接（零配置，对齐 Netcatty）**；未注入时填自建 OAuth App 的 Client ID。单文件 1MB 上限，只适合索引/小数据 | ★★★☆ |
| **OneDrive** | 卡内指引注册 Azure「移动和桌面应用程序」→ 重定向 `http://localhost` → 填 Client ID → 通过浏览器连接（PKCE 授权）。**若构建期注入了 `VITE_SYNC_ONEDRIVE_CLIENT_ID`，输入框自动隐藏，直接点连接（对齐 Netcatty 零配置）** | ★★★☆ |
| **Google Drive** | Google Cloud Console 创建「桌面应用」OAuth 客户端 → 填 Client ID（+可选 Secret）→ 通过浏览器连接（需海外网络）。**注入 `VITE_SYNC_GOOGLE_CLIENT_ID` / `_SECRET` 后同样零配置** | ★★☆ |
| **S3** | 真实 bucket（R2/B2/腾讯 COS/MinIO）或本地 MinIO；技术用户选项 | ★☆ |

> **内置凭据怎么注入**（可选，模拟 Netcatty 零配置）：dev 启动前设置环境变量即可，
> 例如 PowerShell：`$env:VITE_SYNC_ONEDRIVE_CLIENT_ID="<你的 Azure Client ID>"; npm run dev`。
> 注入后 OneDrive/Google 卡片不再显示凭据输入框；不注入时保持「用户自备」模式。

**验证点**：卡片状态点变绿 + 显示「已连接」；主进程日志无报错。

---

## 3. 同步内容（全链路）

以**本地文件夹 provider**（无需账号）为例，可完整走通：

1. **扫描**：「同步内容」tab → 点「扫描会话」→ 出现选择树：
   - 全局节点（`~/.pi/agent/sessions` 会话 + prompts/skills/配置）
   - 项目节点（每个项目下的 `.pi/sessions` 与资源）
   - **DSH 会话**节点（若 `$DSH_HOME` 有会话）
2. **勾选**：一键全选 / 逐个勾选 → 「保存选择」。
3. **立即同步**：状态区应显示版本号变化（本地 v1 → 云端 v1…）、「有待同步变更」消失。
4. **数据落盘验证**（本地文件夹 provider 时直接看同步目录）：
   ```
   D:\PiDeckSync\
   ├── pideck-index.json          # 加密索引（含全部勾选内容元数据）
   ├── pideck-sessions/*.enc      # 每个选中会话一个加密对象
   ├── pideck-dsh-sessions/*.enc  # DSH 会话对象（如勾选）
   └── pideck-files/*.enc         # 大资源文件对象
   ```
   所有文件内容应为**密文**（不含明文 JSON）。
5. **双设备同步**（关键链路）：
   - 设备 B（第二个实例）→ 配**同一个**同步后端（本地文件夹指向同一目录，或同一 WebDAV/网盘）
   - 点「立即同步」→ 自动**拉取**（远端有、本地空 → 恢复云端）
   - 验证：B 的 `~/.pi/agent/sessions` 出现 A 同步的会话；DSH 会话出现在 B 的 `$DSH_HOME/sessions`（.zstd 重新压缩，内容一致）
   - 幂等：再同步一次，文件不应变化（版本号不变）
6. **冲突测试**：A、B 都改同一个会话（如各加一条消息）→ 双方各同步一次 → 第二次同步进入「有冲突待解决」→ 逐项选本地/云端 → 应用选择并同步。
7. **自动同步**：开「自动同步」→ 修改本地会话 → 等待间隔后状态区应自动变「已同步」（无需手动点）。

---

## 4. 导入导出（备份与恢复，无云兜底）

**导出**（设备 A）：
1. 「备份与恢复」tab → 「导出备份…」→ 选择保存位置 → 生成 `PiDeck 备份 <时间>.pideckbackup` 单文件。
2. 验证：文件存在、大小合理；toast 显示「备份已导出：（N 个会话，M 个资源）」。

**导入**（设备 B / 全新机器）：
1. 新实例（NO_KEY 状态）→ 「选择备份文件…」→ 输入**导出时的主密码** → 选导入方式：
   - **智能合并**（默认）：本地已有且不同则保留本地
   - **覆盖恢复**：以备份为准
   - **仅恢复缺失**：不覆盖已有文件
2. 点「开始导入」→ 会话/资源按路径重映射写回目标位置。
3. 验证点：
   - 全局会话 → B 的 `~/.pi/agent/sessions/...`
   - 项目会话 → B 有同名项目则落项目目录；没有则落 `userData/cloud-sync-pending/<projectId>/`（结果提示「N 个项目待映射」）
   - DSH 会话 → B 的 `$DSH_HOME/sessions/...`（zstd 会话自动重新压缩）
   - 导入密码成为新机主密码（后续云同步沿用同一密码）

**错误路径**（可选验证）：错误密码 → 报「密码错误或文件损坏」；损坏文件 → 报「Not a PiDeck backup」。

---

## 5. 无外部账号的 15 分钟全链路脚本

```text
1. npm run dev（设备 A）
2. 设置主密码 → 云服务 → 本地同步文件夹 → 选 D:\PiDeckSync（新建）
3. 同步内容 → 扫描 → 全选几个会话 → 保存 → 立即同步
4. 检查 D:\PiDeckSync 出现加密对象（pideck-index.json + *.enc）
5. 备份与恢复 → 导出备份 → 存 D:\backup.pideckbackup
6. 关 A → 开 B：npm run dev -- --user-data-dir=C:\PiDeckDeviceB
7. B 设置主密码（同密码）→ 备份与恢复 → 导入 D:\backup.pideckbackup（智能合并）
8. 验证 B 的 ~/.pi/agent/sessions 出现会话 → 打开一个会话确认内容完整
9. 可选：B 也配本地文件夹指向 D:\PiDeckSync → 立即同步 → 之后 A/B 双向改动验证合并/冲突
```

---

## 6. 常见问题排查

| 现象 | 原因/排查 |
|---|---|
| 「Connect a cloud provider first」 | 卡片仍是「已配置」未「已连接」→ 点卡片内「连接」按钮重试 |
| 同步报 401/授权失效 | 重新走浏览器授权（token 过期，自动刷新失败时需重连） |
| 坚果云同步报错 | 确认用的是**应用密码**而非登录密码；免费版有单文件/流量限制 |
| Gist 报 1MB 上限 | 大会话不要勾选 Gist；换 WebDAV/S3/本地文件夹 |
| 导入报「密码与主密码不一致」 | 该机已设过主密码且与备份密码不同；用本机主密码导入或换新机 |
| 「扫描失败」且是 DSH 节点 | 空 `$DSH_HOME` 会显示 0 会话（正常）；确认路径无权限问题 |
