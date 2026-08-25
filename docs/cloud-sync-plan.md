# PiDeck 云同步计划（Cloud Sync Plan）

> 状态：**实现中**。M1-M4、M5/M6/M8（主体）、M2（WebDAV/S3/GitHub）已在 `feat/cloud-sync` 分支落地并配套单测；
> 剩余：Google Drive/OneDrive 适配器、自动同步 debounce 触发源、DSH 会话同步、飞书数据、分块上传。
> 参考实现：`F:\Netcatty`（Netcatty 的端到端加密云同步）。
> 目标：把 Netcatty 的云同步能力按 PiDeck 的架构规则搬到本仓库，并加入“用户选择同步哪些会话”的产品能力。

---

## 1. 结论摘要

PiDeck 的云同步采用与 Netcatty 相同的核心理念：

1. **零知识加密**：用户设置主密码，PBKDF2 派生 AES-256-GCM 密钥；云端只保存密文。
2. **统一云服务适配层**：GitHub Gist、Google Drive、OneDrive、WebDAV、S3 兼容存储都走同一个加密对象存储接口。
3. **三路合并 + 缩水保护**：以“上次成功同步的 base”做合并，防止本地数据异常清空后反向覆盖云端。
4. **自动同步 + 手动冲突处理**：设置页可连接多个 provider，支持自动同步、手动同步、冲突选择。
5. **用户可批量或逐个选择同步内容/会话**：这是 PiDeck 新增的产品能力。Netcatty 本身没有“会话级选择”，因为它的同步对象是小型 Vault（主机/密钥/片段）。PiDeck 的会话 JSONL 很大，所以学 Netcatty 的 **EncryptedObjectStorage 多对象存储抽象**，把“小索引 + 大会话对象”分开存。全局会话和项目级 `.pi/sessions` 会话都支持用户选择；提供“一键全选/全不选”和“逐个勾选”两种方式；未选择的不同步，选定后按项目身份和相对路径恢复到目标机器正确位置。
6. **密钥默认同步**：pi auth、DSH credentials、imagegen apiKey 等模型密钥一并进入加密 payload；是否同步由用户按分类开关控制，默认开启。因为不同步密钥的话，模型配置跨设备没有意义。

---

## 2. PiDeck 同步范围总表

| 数据域 | 本地位置 | 是否默认同步 | 用户可选择 | 说明 |
|---|---|---|---|---|
| PiDeck 桌面设置 | `userData/settings.json` | 是 | 可按分类开关 | 只同步用户偏好，排除设备相关字段 |
| pi 基础配置 | `~/.pi/agent/models.json`、`settings.json` | 是 | 是 | provider/baseUrl/models/agent 偏好 |
| pi 认证 | `~/.pi/agent/auth.json` | **是（加密同步，可关闭）** | 是 | 模型密钥进入加密 payload，默认同步 |
| pi trust | `~/.pi/agent/trust.json` | 否 | 是 | 目录信任跨设备不一定有效，默认不同步 |
| DSH 配置 | `$DSH_HOME/settings.yaml` | 是 | 是 | provider/模型/默认模型等配置 |
| DSH 凭证 | `$DSH_HOME/.credentials.yaml` | **是（加密同步，可关闭）** | 是 | 密钥进入加密 payload，默认同步 |
| 项目列表 | `userData/projects.json` | 是 | 是 | 只同步项目元数据；路径需要重映射 |
| 会话 Catalog | `userData/session-catalog.json` | 是 | 是 | 同步索引/元数据 |
| 全局 pi 会话文件 | `~/.pi/agent/sessions/**/*.jsonl` | 否 | **由用户逐个选择** | 用户选中的会话才同步全文 |
| 项目级会话文件 | `<project>/.pi/sessions/**/*.jsonl` | 否 | **由用户按项目/会话选择** | 项目已扫描/存在时可选；没有本地项目时先落到全局同步区或等待重映射 |
| DSH 会话文件 | `$DSH_HOME/sessions/**` | 否 | 可后续做 | 第一版先不做；若做也走“用户选择”机制 |
| 用户 Prompt 模板 | `~/.pi/agent/prompts/` | 是 | 是 | 只同步用户创建内容，不内置模板 |
| 用户 Skill | `~/.pi/agent/skills/`、`~/.agents/skills/` | 是 | 是 | 用户内容资产；可打包为文本 |
| 扩展状态 | settings.json 中的 disabled/removed 字段 | 是 | 是 | 只同步状态，不同步扩展安装包本身 |
| ImageGen 配置 | `userData/imagegen.json` | 是 | 是 | 非 secret 字段 + apiKey 一起进加密 payload，默认同步 |
| ImageGen 会话历史 | `userData/imagegen/sessions/*.jsonl` | 否 | 可后续做 | base64 图片大，默认不同步 |
| 飞书配置/绑定 | `userData/pi-desktop/` | 否 | 是 | appSecret 进加密 payload，默认同步；绑定关系可按需开关 |
| 安全策略 | settings.securityConfig | 是 | 是 | 可同步全局策略；sessionOverrides 谨慎 |
| 日志/缓存/诊断 | `userData/logs/`、缓存等 | 否 | 否 | 本地调试数据 |
| 遥测/用量统计 | usage jsonl / dsh-bill | 否 | 否 | 本地统计 |
| 锁文件/运行时状态 | instance-locks、.pideck-host.lock | 否 | 否 | 不应跨设备 |

### 2.2 核心变化：以“项目”为组织维度的统一选择树

不再把“项目列表 / 会话 Catalog / 全局会话全文 / 项目级会话全文”拆成四套独立逻辑，而是统一成一个模型：

```
同步树
├── 全局（全局同步项目）
│   ├── 全局资源：~/.pi/agent/prompts、skills、extensions、settings.json
│   ├── npm 包扩展声明
│   └── 全局会话：~/.pi/agent/sessions/**/*.jsonl（未归属具体项目或用户选择全局）
└── 每个项目
    ├── 项目元数据（id/name/pathHint/environment/pinned/sortOrder/worktree）
    ├── 项目资源
    │   ├── .pi/skills/、.agents/skills/
    │   ├── .pi/prompts/
    │   ├── .pi/extensions/（本地扩展代码）
    │   ├── .pi/npm/**（包扩展安装区，同步声明+锁，默认不同步 node_modules）
    │   └── .pi/settings.json（packages、disabledExtensions 等）
    ├── 项目会话
    │   ├── <project>/.pi/sessions/**/*.jsonl
    │   └── 全局 sessions 中 cwd 可归属该项目的会话
    └── 会话 Catalog 中属于该项目的条目
```

用户操作从“分别勾选项目、catalog、全局会话、项目会话”简化为“一棵树里选择”：

1. 在同步设置页看到一棵“项目树”；
2. 项目只是**归属/组织维度**，不是强制“一键全量同步整个项目”；
3. 提供两种操作方式，互相不冲突：
   - **一键全选/全不选**：点项目节点或全局节点，一键勾选/取消该节点下全部会话；
   - **逐个选择**：展开项目后，一个一个勾选想同步的会话；
4. 项目资源（skill/prompt/ext 配置）也可以按项目维度作为一类内容选择，会话则既支持批量选，也支持逐个选；
5. 全局配置/全局会话仍以“全局”根节点存在，用户可单独选择。

这样“项目列表 / 会话 Catalog / 全局会话全文 / 项目级会话全文”只是同一棵树的展示维度，不再需要四套独立操作。

---

### 2.1 用户可配置的同步开关

用户在云同步设置页里可以按需勾选要同步的内容，而不是由系统一刀切：

| 开关分类 | 控制内容 | 默认 |
|---|---|---|
| 桌面设置 | 主题、快捷键、字体、Git、生图默认值、扩展状态等 | 开 |
| pi 模型配置 | models.json / settings.json | 开 |
| pi 密钥 | auth.json 中的 API Key | 开 |
| DSH 模型配置 | settings.yaml 非敏感配置 | 开 |
| DSH 密钥 | .credentials.yaml | 开 |
| 项目列表 | projects.json 元数据 | 开 |
| 会话 Catalog | session-catalog.json 索引 | 开 |
| 全局会话全文 | `~/.pi/agent/sessions/**/*.jsonl` | 关，用户逐个选 |
| 项目会话全文 | `<project>/.pi/sessions/**/*.jsonl` | 关，用户按项目/会话选 |
| Prompt / Skill | 用户创建的模板与技能 | 开 |
| 生图配置 | imagegen.json（含密钥） | 开 |
| 飞书配置 | feishu.json（含密钥）与绑定 | 关/用户选 |
| 安全策略 | securityConfig 全局策略 | 开 |

---

## 3. PiDeck 版 SyncPayload（索引载荷）

建议把同步数据分成两层：

- **Index payload**：小、所有 provider 都同步，适合冲突合并。
- **Session objects**：用户选中的会话全文，单独加密成对象。

### 3.1 Index payload 草案

```ts
type PiDeckSyncIndexV1 = {
  schemaVersion: 1;

  meta: {
    deviceId: string;
    deviceName?: string;
    appVersion: string;
    syncedAt: number;
  };

  // 桌面端设置（只含可同步字段）
  settings?: {
    theme?: string;
    accent?: string;
    themeSkin?: string;
    customThemeOverrides?: Record<string, string>;
    language?: string;
    sendShortcut?: string;
    busySendDelivery?: string;
    sessionTabOpenMode?: string;
    fontSize?: string;
    fontFamilyBase?: string;
    fontFamilyMono?: string;
    favoriteModels?: string[];
    enableGitManagement?: boolean;
    gitCommitMessagePrompt?: string;
    gitCommitMessageProvider?: string;
    gitCommitMessageModel?: string;
    imageGenSize?: string;
    imageGenWatermark?: boolean;
    imageGenOutputFormat?: string;
    removedBuiltInExtensions?: string[];
    disabledExtensions?: DisabledExtensionEntry[];
    disableExtensionWhitelist?: boolean;
    defaultAgentBackend?: string;
    dshApprovalAutoAllow?: boolean;
    dshAutoImportSessions?: boolean;
    securityConfig?: SecurityConfig;
    // ... 后续按设置页实际字段补齐
  };

  // pi 配置（模型与密钥都进加密 payload；密钥由用户分类开关控制）
  pi?: {
    models?: Record<string, {
      baseUrl?: string;
      api?: string;
      models?: unknown[];
    }>;
    auth?: Record<string, { type?: string; key?: string }>;
    settings?: Record<string, unknown>;
  };

  // DSH 配置（模型与密钥都进加密 payload）
  dsh?: {
    settingsYaml?: string;
    credentials?: Record<string, string>;
    // 或解析后的结构化对象，实现时二选一
  };

  // 统一的项目同步单元：一个项目 = 元数据 + 资源 + 会话 + catalog 条目
  projects?: Array<{
    projectId: string;          // "__global__" 表示全局同步根；其余为真实 Project.id
    name: string;
    kind?: "normal" | "chat" | "external";
    pathHint?: string;          // 原机器路径，仅用于提示/匹配
    environment?: "windows" | "wsl";
    metadata?: {
      pinned?: boolean;
      sortOrder?: number;
      worktreeEnabled?: boolean;
      worktreeParentId?: string;
    };

    // 项目级/全局级资源（prompt/skill/本地扩展/包扩展声明/项目 pi settings）
    resources?: {
      piSettings?: Record<string, unknown>;       // .pi/settings.json 或 ~/.pi/agent/settings.json
      prompts?: Array<FileBundle>;                 // .pi/prompts/** 或全局 prompts
      skills?: Array<FileBundle>;                  // .pi/skills、.agents/skills 或全局 skills
      localExtensions?: Array<FileBundle>;         // .pi/extensions/** 或全局 extensions
      extensionSources?: Array<{
        source: string;                            // npm:xxx / git:... / file:... / github:...
        scope: "user" | "project";
        version?: string;
        lockContent?: string;                      // 可选 package-lock/package.json
      }>;
    };

    // 该项目的会话（用户选中才放）
    sessions?: Array<SessionRef>;

    // 该项目的会话 catalog 条目
    catalogEntries?: SessionCatalogEntry[];
  }>;

  // 生图配置（密钥也进加密 payload，默认同步）
  imageGen?: {
    activeProviderId?: string;
    activeModel?: string;
    providers?: ImageGenProviderConfig[];
  };

  // 全局扩展启用/禁用状态
  extensionState?: {
    removedBuiltInExtensions?: string[];
    disabledExtensions?: DisabledExtensionEntry[];
    disableExtensionWhitelist?: boolean;
  };

  syncedAt: number;
};

// 文件级资源：内容直接进加密 payload，或作为独立对象
type FileBundle = {
  relativePath: string;
  contentHash: string;
  bytes?: string;            // 小文件内嵌；大文件用 objectKey
  objectKey?: string;        // 如 pideck-project-files/<hash>
};

// 会话引用
type SessionRef = {
  sessionId: string;
  scope: "global" | "project";
  projectId?: string;
  relativePath: string;      // 全局：相对 ~/.pi/agent/sessions/；项目：相对项目根或项目 sessionDir
  size: number;
  mtimeMs: number;
  contentHash: string;
  objectKey: string;         // pideck-sessions/<sessionId>.jsonl.enc
};
```

### 3.2 会话对象

用户选中的每个会话，单独加密为对象：

```
pideck-sessions/<sessionId>.jsonl.enc
```

对象内容：

- 原始 pi JSONL 内容，或者 gzip 后再加密；
- 建议同步 `SessionSummary` 级别的 `sessionId`、`scope`、`projectId`、`relativePath`、`contentHash` 作为完整性校验；
- 不包含绝对路径；恢复时由本机按 scope/projectId 解析目标位置：
  - 全局会话：写入 `~/.pi/agent/sessions/<relativePath>`；
  - 项目会话：写入本地匹配项目的 `<project>/.pi/sessions/<relativePath>` 或项目配置的 sessionDir；
  - 本地没有匹配项目时：先写入全局同步区/待映射区，等用户建立项目后再落位。

---

## 4. 会话选择方案（用户选择哪些“会话/绘画”）

### 4.1 产品规则

1. 云同步设置页展示一棵“同步树”：
   - 根节点：“全局”（全局配置、全局 prompt/skill/ext、全局会话）；
   - 子节点：每个可扫描到的项目；
   - 项目是**归类/组织维度**，也是批量选择的便捷入口。

2. **支持两种选择方式，一起提供**：
   - **一键全选/全不选**：点项目节点或全局节点，一键勾选/取消该节点下全部会话；
   - **逐个选择**：展开项目后，一个一个勾选想同步的会话；
   - 两者不互斥：用户可以先“一键全选”，再取消少数不想同步的；也可以只勾选少数。

3. **最小选择单位仍是“会话”**：
   - 不勾选的会话不同步；
   - “一键全选”只是 UI 上批量勾选，不会改变“只有勾选才同步”的规则。

4. 项目资源可以作为另一层选择：
   - 项目级 `.pi/skills`、`.agents/skills`、`.pi/prompts`；
   - 项目级 `.pi/extensions`、`.pi/npm` 扩展声明；
   - 项目级 `.pi/settings.json`；
   - 同样支持“项目资源一键全选”和“细粒度选择”。

5. 全局根节点单独控制：
   - 全局配置（pi/DSH 模型配置与密钥）；
   - 全局 prompt/skill/ext 声明；
   - 全局 `~/.pi/agent/sessions/**/*.jsonl`，同样支持一键全选 + 逐个勾选。

6. 用户选择后，把项目条目写入 `projects[]`，其中每个项目包含 `resources + sessions + catalogEntries`；会话引用写入 `projects[].sessions`，不再单列 `sessionSelection`。

7. 同步时：
   - 未勾选的会话：**不下载、不上传、不删除云端**；
   - 未勾选的项目资源：不同步；
   - 勾选的会话/资源：根据 `projectId / projectName / environment / relativePath` 等标签，在目标机器定位具体位置。

8. 用户取消某个会话/资源勾选：
   - 默认只在云端标记为“不再同步”，**不自动删除云端历史**；
   - 提供“确认清除云端该项目数据”的额外操作，避免误删。

9. 项目在目标机器没有对应项目时：
   - 不强行写坏路径；
   - 资源与会话先落到“全局同步/待映射”区域；
   - 用户在本机添加/映射该项目后，再由“项目归属修复”流程迁移到正确目录。

### 4.2 为什么默认不“全量同步”，但仍支持一键全选

- 会话 JSONL 可能非常大，包含大量工具输出、图片 base64。
- GitHub Gist / Google Drive / OneDrive 有文件大小和频率限制。
- 项目级 `.pi/sessions` 的路径跨设备不可移植，必须依赖项目映射。
- 用户明确要求：**不选就不同步，选了才同步**；
- “一键全选”只是 UI 上的批量勾选快捷方式，不是默认行为。

### 4.3 与 Netcatty 的对应关系

Netcatty 的最佳实践是：

- 所有数据进一个加密 payload；
- 用三路合并按 entity id 合并；
- 用 `EncryptedObjectStorage` 抽象支持多对象。

PiDeck 学过来后的调整：

- “项目/会话/catalog/设置”放 index payload；
- “用户选中的会话正文”放 session objects；
- 合并逻辑对 session object 按 `sessionId` 做 entity 级比较，类似 Netcatty 对 hosts/keys 的合并。

---

## 5. 路径重映射规则

### 5.1 全局 pi 会话

- 只同步 `relativePath`：相对于 `~/.pi/agent/sessions/`。
- 恢复路径统一为 `join(os.homedir(), ".pi", "agent", "sessions", relativePath)`。
- 不允许 `relativePath` 含 `..`、绝对路径、盘符，防止路径穿越。
- WSL 场景：如果本机启用 WSL pi，则需要额外把目标路径切换到 WSL home；第一版可以只支持本机 home。

### 5.2 项目级 pi 会话

- 同步记录里存：
  - `projectId`
  - `projectName`
  - `projectPathHint`（原机器路径，仅作提示/匹配）
  - `environment`（windows / wsl）
  - `relativePath`：相对项目根或相对该项目 sessionDir 的路径
- 恢复时按以下顺序定位目标位置：
  1. 本机已有相同 `projectId` → 使用该项目的当前 `path`；
  2. 本机没有同 id，但 `projectPathHint` 对应路径存在 → 使用该路径并注册/关联项目；
  3. 本机没有该项目 → 先写入“全局同步/待映射区”，等用户添加项目后，再按 `projectId`/`projectName`/`environment` 迁移到正确项目目录。
- 不允许用远端绝对路径直接写本机目录。

### 5.3 项目列表

- `projects.path` 属设备相关，同步时**保留原值但不作为恢复依据**。
- 应用时按 `project.id` 匹配本地项目：
  - 本地已有同 id：更新元数据（name/pinned/sortOrder/worktree 等）。
  - 本地没有同 id：如果 `path` 在本机存在则直接用；否则创建 `missing` 项目记录，让用户重新选择目录。
- 不同步 `dismissed-project-paths.json`、`chat-path.json`。

### 5.4 会话 Catalog

- 全局 pi 会话：`filePath` 转成 relativePath 后写入 catalog。
- 项目级 `.pi/sessions` 会话：catalog 条目带 `projectId`/`relativePath`，由项目映射恢复；没有本地项目时先放待映射区。
- DSH catalog 条目：第一版不做，或按 DSH 的相对路径单独设计。

### 5.5 项目资源同步（skill / prompt / 扩展配置）

当用户选择同步某个项目的资源时，这些内容跟着一起走（会话仍逐个勾选）：

| 资源 | 本地位置 | 同步方式 |
|---|---|---|
| 项目 Skill | `<project>/.pi/skills/**`、`<project>/.agents/skills/**` | 打包为 FileBundle，恢复时原目录写回 |
| 项目 Prompt | `<project>/.pi/prompts/**` | 打包为 FileBundle，恢复时写回 |
| 本地扩展代码 | `<project>/.pi/extensions/**` | 打包为 FileBundle，恢复时写回 |
| 项目 pi settings | `<project>/.pi/settings.json` | 同步 JSON（含 packages、disabledExtensions） |
| 包扩展声明 | `<project>/.pi/settings.json` 中的 `npm:`/`git:` 等 | 只同步 source/version/lock，不同步 node_modules |

### 5.6 扩展/插件（最复杂）处理策略

#### 分类

Pi 扩展分三类，处理方式完全不同：

1. **PiDeck 内置扩展**
   - 例如 `pi-deck-todo.ts`、`pi-deck-goal-mode.ts`；
   - 由 PiDeck 应用自带，**不需要跨设备安装**；
   - 只同步启用/禁用状态（removedBuiltInExtensions / disabledExtensions）。

2. **本地文件扩展**
   - 例如 `.pi/extensions/xxx.ts`、`.pi/extensions/xxx/index.ts`；
   - 本质是源码文件，**随项目资源一起同步**；
   - 如果目录扩展有自己的 `node_modules`/依赖，需要把 `package.json`/lock 一起同步，并在目标机执行 `npm install`；
   - 简单单文件扩展直接复制即可。

3. **包扩展（npm/git/github/file/https）**
   - 例如 `npm:pi-tracker`、`github:xxx/yyy`；
   - 可能是全局 npm 包，由 `pi install` 安装到 `~/.pi/agent/npm/node_modules` 或项目 `.pi/npm/node_modules`；
   - **不要默认同步 node_modules**。原因：
     - 体积大；
     - 含平台/架构相关二进制，跨机器可能失效；
     - 扩展可能从 npm 更新，同步安装目录会让版本状态混乱。

#### 包扩展的同步与恢复

推荐做法：

1. **同步的是“声明 + 版本 + 锁”而不是安装产物**：
   - 记录 `source`（`npm:xxx` / `git:...` / `file:...`）；
   - 记录 `version` / `package.json` / `package-lock.json` 等；
   - 存到 `projects[].resources.extensionSources`。

2. **目标机恢复时自动安装（已确认：允许）**：
   - 全局包：在同步设置页或首次打开项目时自动跑 `pi install <source>`；
   - 项目包：按 pi/项目作用域写入 `.pi/settings.json` 的 packages，并在项目 `.pi/npm` 下安装；
   - 安装失败/离线时：只写声明，标记为“待安装”，不阻断启动。

3. **避免启动报错的核心策略**：
   - 启动 pi 前对项目做“扩展就绪检查”；
   - 如果声明的包扩展未安装：
     - 优先进入白名单模式：`--no-extensions` + `-e` 显式注入 **已安装** 的扩展路径；
     - `enabledExtensionResolver` 已经只会注入存在的路径，天然跳过缺失 npm 包；
     - 如果连白名单都不适合（如用户手动安装未跟踪扩展），则至少不注入缺失路径，并在 UI 提示“该项目缺少扩展：xxx”；
   - 绝不因为“配置文件在但扩展没装”而让 pi 启动失败。

4. **Netcatty 可借鉴的模式：插件 sidecar**
   - Netcatty 对第三方插件不同步插件安装包，而是同步插件“非敏感设置/基线数据”；
   - 插件不存在时不丢数据、不报错，等插件装回来后恢复；
   - PiDeck 项目扩展也采用类似思路：
     - 扩展的启用/禁用/配置声明同步；
     - 扩展代码没有装到目标机时，项目资源仍保留；
     - 用户安装扩展后自动接管。

5. **完整 node_modules 同步：本期不做（已确认）**
   - 不提供“打包 node_modules”高级同步；
   - 离线/内网场景由用户自行通过其他方式准备扩展安装目录，PiDeck 只负责声明 + 自动安装。

---

## 6. 云服务适配层

### 6.1 先抄的 5 类

| Provider | 说明 |
|---|---|
| GitHub | Gist / 多文件 Gist，Device Flow 认证 |
| Google Drive | Drive 文件 + OAuth2 PKCE |
| OneDrive | Graph API + OAuth2 PKCE |
| WebDAV | `webdav` npm 依赖，basic/digest/token |
| S3 | `@aws-sdk/client-s3`，兼容 MinIO/R2 等 |

### 6.2 建议采用“对象存储”接口

```ts
interface PiDeckCloudObjectStorage {
  connect(config): Promise<{ account }>;
  disconnect(): Promise<void>;
  getAccount(): Promise<{ id: string; email?: string } | null>;
  getCapabilities(): Promise<{ maxObjectBytes?: number; maxObjects?: number }>;
  readObject(key: string, opts?): Promise<{ found: boolean; bytes: Uint8Array | null }>;
  writeObject(key: string, bytes: Uint8Array, opts?): Promise<{ created: boolean }>;
  deleteObject(key: string, opts?): Promise<{ deleted: boolean }>;
}
```

- `pideck-index.json`：小对象，所有 provider 都支持。
- `pideck-sessions/<id>.jsonl.enc`：大会话对象，WebDAV / S3 最自然；
  Google Drive / OneDrive 通过“固定文件夹 + 文件名”实现。
- **GitHub Gist 定位（已确认）**：
  - 适合承载：索引、配置声明、轻量数据、**小会话对象**；
  - 不适合承载：大会话正文、大资源文件；
  - 小会话可以直接内嵌在 Gist 的 index/多文件 Gist 中；大会话和资源文件走 WebDAV、S3、Google Drive、OneDrive。

### 6.3 新增依赖

- `webdav`
- `@aws-sdk/client-s3`
- 不新增 Google/OneDrive/GitHub SDK；主进程用全局 `fetch` 即可。

### 6.4 统一抽象：所有 provider 走同一对象存储接口（三类上传方式）

> 结论（调研）：**能统一，且已经在统一**。WebDAV / S3 / Gist 已实现，OneDrive / Google（API 直连）与本地同步文件夹（第 6 类）落地后同样是实现 `PiDeckCloudObjectStorage` 的一个适配器。加密、索引、合并、冲突、缩水保护全部 provider 无关，差异只收敛在“文件如何上传到云端”的连接方式上。

| 上传方式（kind） | 说明 | 适用 provider | 现状 |
|---|---|---|---|
| **oauth**（浏览器授权） | 经官方 API 直连，用户浏览器登录一次即可 | OneDrive（Graph）、Google Drive（Drive API） | ✅ OneDrive 已实现（PKCE + 回环回调，2026-08）；Google 规划中 |
| **config**（账号配置） | 用户填写服务商地址与凭据 | WebDAV、S3、GitHub Gist | ✅ 已实现 |
| **folder**（同步文件夹） | 用户选一个已被网盘客户端自动同步的本地文件夹，上传交给网盘客户端 | 本地文件夹适配器（第 6 类，`"local"`） | ✅ 已实现（`LocalFolderObjectStorage`，2026-08 落地） |

- **类型落点**：`shared/types/cloudSync.ts` 已新增 `CloudProviderKind`（`oauth | config | folder`）与 `CLOUD_PROVIDER_KIND` 映射；`"local"` 与 `"onedrive"` 已并入 `BUILTIN_CLOUD_PROVIDERS`。
- **OneDrive 实现落点**：`main/cloudSync/adapters/OneDriveObjectStorage.ts`（`special/approot` 存储根、eTag revision + If-Match/If-None-Match 条件写、>4MB 走 Graph resumable upload session、token 过期自动刷新）；`CloudSyncManager.startOneDriveOAuth/pollOneDriveOAuth`（PKCE + 127.0.0.1 回环服务，token 只在主进程流转并密封落盘，dispose 清理回环服务）；clientId 由用户在 Azure 注册「移动和桌面应用程序」平台（重定向 `http://localhost`）后自备，与 GitHub Gist 同模式。
- **分块上传结论（评估后不做通用分块层）**：当前无 provider 需要自造分块——S3/R2/本地文件夹原生支持大对象、WebDAV 多数服务可大 PUT、Gist 1MB 是硬上限（分块无意义）；唯一需要"大文件上传机制"的 OneDrive 已用 Graph 原生 **resumable upload session**（上限 250GB ≫ 512MB 会话上限）覆盖。若未来接入坚果云类受限服务，再按服务商原生 multipart 实现，不引入跨 provider 分块抽象。
- **UI 落点**：云同步设置页新增“上传方式说明”图例（`cloudSync.provider.howTo*` / `kind.*` 文案），每个服务卡带一句适用说明（`webdavDesc` / `s3Desc` / `githubDesc` / `localDesc` / `onedriveDesc`）；WebDAV 卡带「坚果云 / InfiniCloud」快捷模板；所有卡片在"已配置未连接"时提供「连接」重试按钮（`configureProvider` 现已自动连接，失败保留配置供重试）。
- **能力差异**：仍由 `getCapabilities()` 表达（单文件上限、revision、条件写），provider 无关的合并逻辑据此降级（如 Gist 1MB 上限、WebDAV 无条件写、本地文件夹全能力、OneDrive 250MB + 条件写）。
- **本地文件夹适配器与一键导入/导出**的完整调研与可用网盘对照见 `docs/cloud-sync-research.md`；导入导出已实现（见 §6.5）。

### 6.5 本地一键导入/导出（`.pideckbackup`，离线兜底）

> 状态：**已实现**（2026-08 随本地文件夹适配器一并落地）。无需任何云服务：导出 = 加密快照文件；导入 = 离线恢复，与云端 pull 共用路径重映射/待映射区/扩展安装/设置应用语义。

- **格式**：单文件容器 `PIDECKBACKUP`（magic + formatVersion + 加密清单头 + 加密对象条目），条目字节与云端对象完全一致 → 导入与云同步共用同一解密路径；流式写入/读取，上限与同步一致（头 16MB / 条目 512MB）。
- **导出**（`CloudSyncManager.exportBackup`）：复用 scanner → `buildLocalIndex` → `encryptObject` 管线，把当前勾选内容打包；需要解锁主密码，不需要连接任何 provider。
- **导入**（`CloudSyncManager.importBackup`）：先解备份头（错误密码/损坏文件在改任何状态前失败）→ 主密码一致性（新机 NO_KEY 用导入密码初始化；已有主密码必须一致）→ 按模式落地：
  - `merge`（默认）：本地已有且内容不同 → 保留本地；`overwrite`：以备份为准；`restoreMissing`：只补缺失。
  - 会话/资源走 `resolveSessionTarget` 路径重映射；本机无对应项目 → 落 `cloud-sync-pending` 待映射区（`pendingProjects` 上报）；设置白名单、密钥（本地优先）、包扩展自动安装与云端 pull 同语义。
- **落点**：`main/cloudSync/exportImport.ts`（容器纯函数 + 流式读写）、`cloudSyncIpc.ts`（`cloud-sync:export` / `cloud-sync:import`，保存对话框在边界内）、preload `exportBackup/importBackup`、设置页「备份与恢复」Tab。
- **测试**：`tests/cloudSyncExportImport.test.mjs`（容器格式/边界/流式往返/manifest 校验/导出/新机往返/三种导入模式/错误密码与损坏文件/待映射区）。

---

## 7. 冲突处理

### 7.1 Index payload

沿用 Netcatty 的三路合并：

- 项目按 `projectId` 合并；
- 项目资源（skill/prompt/localExtension）按 `relativePath + contentHash` 合并；
- 包扩展声明按 `source + scope` 合并；
- 会话按 `sessionId` 合并；
- catalog 条目按 `sessionId` 合并；
- settings 按字段深度合并；
- 双方同改一个字段/实体时弹冲突，默认智能合并（本地优先并记录冲突）。

### 7.2 会话对象

- 已选中的会话在同名 `sessionId` 上比较 `contentHash`。
- 只有本地变化：上传；只有云端变化：下载；两边都变：弹冲突，让用户选本地/云端/合并（第一版可以只做本地/云端二选一）。

### 7.3 缩水保护

- 本地索引突然从 N 个会话变成 0 个，且不是用户主动清除，阻止上传。
- 用户主动“取消所有会话选择”属于显式操作，需二次确认后允许。

---

## 8. 自动同步

学习 Netcatty 的 `useAutoSync` 思路：

- 监听项目树变化：项目元数据、项目资源（skill/prompt/ext）、包扩展声明、会话选择、catalog、settings 变化；
- 变化后 debounce 5 分钟（默认）自动同步；
- 启动时先检查远端，再决定上传/下载；
- 远端有数据且本地为空时，弹“恢复云端 or 保留本地空数据”；
- 同步过程中禁止并发 push/pull；
- 所有异步定时器在主进程注册，并在 quitCleanup 中清理。

---

## 9. PiDeck 架构落点

| 层 | 落点 |
|---|---|
| 共享类型 | `src/shared/types/cloudSync.ts` |
| IPC 通道 | `src/shared/ipc.ts` → `cloudSync:*` |
| 主进程业务 | `src/main/cloudSync/`（manager、encryption、adapters、merge、autoSync） |
| IPC 边界 | `src/main/ipc/cloudSyncIpc.ts` |
| preload | `src/preload/index.ts` 暴露 `cloudSync*` 方法 |
| 渲染状态 | Jotai atom + `useCloudSync` 类似 hook |
| 设置 UI | 渲染层设置页新增“云同步”Tab |
| 文档/测试 | `tests/cloudSync*.test.mjs` 或对应 TS 测试 |

### 9.1 搬运清单

从 Netcatty 搬运并改造：

- `domain/cloudProviderIds.ts`
- `domain/sync.ts`（裁剪成 PiDeck payload）
- `domain/syncMerge.ts`
- `domain/syncGuards.ts`
- `domain/syncStrategy.ts`
- `domain/encryptedObjectStorage.ts`
- `infrastructure/services/EncryptionService.ts`
- `infrastructure/services/adapters/*`
- `infrastructure/services/CloudSyncManager.ts`
- `infrastructure/services/cloudSync/*`
- `application/syncPayload.ts` → `src/main/cloudSync/payload.ts`
- `application/state/useCloudSync.ts` / `useAutoSync.ts` → 主进程 service + renderer hook
- `components/cloud-sync/*` → PiDeck 设置页 UI

---

## 10. 实施里程碑

> 状态图例：✅ 已完成并提交；🟡 主体完成、有明确缺口；❌ 未开始。

1. **M1 基础类型与加密** ✅
   - `shared/types/cloudSync.ts`（共享契约、主密钥配置、Provider 状态）
   - `main/cloudSync/EncryptionService.ts`（PBKDF2-SHA256 + AES-256-GCM，密码/派生 key 只存主进程）
   - 单测：加解密、主密码校验、远端载荷 bounded schema 校验（`tests/cloudSyncEncryption/IndexValidation.test.mjs`）

2. **M2 云适配器** 🟡
   - ✅ WebDAV（临时文件 PUT+MOVE + 写后读回校验）与 S3（ETag revision + 条件写）
   - ✅ GitHub Gist（Device Flow 授权 + 单 Gist 多文件加密对象；token 只在主进程流转；1MB/文件上限按方案 §6.2 处理）
   - ❌ Google Drive / OneDrive：需要用户自备 OAuth 客户端凭据，未实现（工厂明确报错）
   - ✅ 统一 `PiDeckCloudObjectStorage` 接口 + 对象 key 安全校验

3. **M3 Index payload** ✅
   - `payload.ts`：桌面设置白名单过滤、统一 project 树（metadata + resources + sessions + catalogEntries）
   - 路径重映射与安全过滤（相对路径、无绝对路径泄漏；恢复侧 symlink 逃逸检查）
   - 大文件按 SHA-256 生成独立对象，小文件内嵌索引

4. **M4 项目级同步与资源选择** ✅
   - `main/cloudSync/CloudSyncScanner.ts`：扫描全局/项目 `.pi/sessions` 与 `.pi/skills|prompts|extensions|settings.json`；
     每个 root 带 ok/error 状态（失败不伪装空目录）；跳过 symlink/归档；大小上限；catalog 归属的未知项目生成合成节点（待映射）
   - `main/cloudSync/CloudSyncManager.ts`：主密码/Provider 生命周期（凭据经主密钥加密落盘）、扫描选择、版本守卫 push/pull、缩水保护、自动同步定时器 + quit 清理
   - 设置页「云同步」tab：主密码 → Provider 表单 → 扫描/选择树 → 同步操作（`CloudSyncSettingsTab` + `useCloudSync`）
   - IPC/preload：`cloud-sync:*` 通道，入参在边界校验

5. **M5 项目资源落盘与扩展安装** 🟡
   - ✅ 文件资源写回 `.pi/skills` / `.pi/prompts` / `.pi/extensions` / `settings.json`（pull 与合并落地路径）
   - ✅ 包扩展声明恢复：`extensionSources` 结构化（从 pi settings `packages` 提取），恢复后按声明自动 `pi install`（注入 ExtensionManager），失败记录 `missingExtensions` 并在设置页重试
   - ✅ 启动保护：既有 `enabledExtensionResolver` 白名单天然跳过缺失 npm 包，不阻断 pi 启动
   - ❌ 项目内 `npm install` 与“声明+锁文件”细粒度同步未做（当前同步整份 settings.json）

6. **M6 合并与冲突** ✅
   - `main/cloudSync/merge.ts` 三路合并：settings 字段级、会话按 sessionId+contentHash、资源按 (projectId, category, relativePath)、catalog 按 id、project 元数据逐字段；base = 上次成功同步索引
   - 冲突收集 + 设置页逐项选本地/云端并应用（`resolveConflicts`，覆盖全部冲突才继续）
   - shrink guard：选择清空需显式确认；扫描失败阻止推送

7. **M7 自动同步 + 状态** 🟡
   - ✅ auto sync 定时器（间隔可配）、同步状态推送（`cloud-sync:state-changed`）、quit 清理
   - ❌ debounce 触发源：目前按定时轮询；监听项目树/catalog/settings 变更后 debounce 触发尚未接（方案 §8）

8. **M8 打磨** 🟡
   - ✅ 大小上限（会话 512MB / 资源 10MB / 内嵌 256KB / Gist 1MB）与 gzip 对象压缩（向后兼容旧对象）
   - ✅ 密钥同步分类开关：pi auth/models、ImageGen 配置默认进加密载荷，可在选择偏好里关闭
   - ❌ 分块上传、DSH settings/credentials、飞书数据、CRDT 未做
   - ✅ 文档与测试：cloudSync* 共 37 个针对性测试

9. **M9 同步内容与选择重构（§12 定稿）** ❌
   - 节点级二元勾选（全选 + 个别取消），兼容旧 selection 持久化
   - 树重组：项目分类树（会话/提示词/技能/扩展/设置）+ 全局节点（会话/提示词/技能/扩展/配置）
   - 全局配置扫描进树（auth/models/settings/models-store），trust.json 排除
   - 扩展插件配置文件扫描 + 排除名单（内置默认 + 用户黑名单）
   - 「添加」自选同步（文件选择器 + 额外路径清单）
   - 全手动挂载：云端项目 → 首次手动指定本地目录，映射持久化；待映射 UI

---

## 11. 待确认问题

1. **“绘画”确认（已确认）**
   本文按“会话”理解；同步粒度是逐个会话，不默认全量同步项目。

2. **DSH 会话（已确认）**
   第一版只做 pi 全局 + 项目级 `.pi/sessions`，不做 DSH 会话。

3. **密钥默认策略（已实现，DSH 部分待办）**
   pi auth、models 与 imagegen apiKey 默认进入加密 payload 同步，并可在“同步内容选择”里关闭（`CloudSyncContentPreferences`：piCredentials/piModels/imageGen，默认 true）。
   **未实现**：DSH credentials（`$DSH_HOME/.credentials.yaml`）与飞书 appSecret（feishu.json）。

4. **GitHub Gist 容量（已实现）**
   Gist 适配器按方案限制：索引/配置声明/轻量数据/小会话走 Gist；单文件上限 1MB，超出时报错并提示改用 WebDAV/S3（`getCapabilities().maxObjectBytes`）。

5. **是否要抄 CRDT v2（未引入）**
   保持第一版方案：三路合并 + 手动冲突已落地（M6）；CRDT 未引入，后续稳定后再评估。

6. **项目级会话在目标机器没有对应项目时（已实现）**
   恢复时落入 `userData/cloud-sync-pending/<projectId>/` 待映射区；扫描选择树为 catalog 归属但本机未注册的项目生成合成节点（missing=true），用户添加项目后可重新同步落位。

---

## 12. 设计定稿：同步内容与选择（第二轮评审，2026-08）

> 本轮与用户对齐后的最终形态。核心原则：**「一个框 = 底下全部同步」，不搞三态；同步的本质是“把一批文件按目录放到对应文件夹”，UUID 无关紧要；换机器落地目录全手动挂载。**

### 12.1 勾选机制（纯二元）

- 每个节点一个复选框：勾上 = 底下全部选中，不勾 = 不选。
- 不做三态中继、不做“半选”视觉。
- 展开后可**单独取消个别文件**（展示为未勾选），类别框仍表示“整体选中”，个别取消不反向影响类别框。
- 选择模型：`selectedSessionIds / selectedResourceIds` 保持兼容，另加“节点级全选 + 个别取消”两层（nodeSelection + overrides）。

### 12.2 树形结构（按项目分类 + 全局）

```
☐ 全部项目
  ▸ <项目名>                    ☐ 项目整体
    ☐ 会话 (n)                  ← .pi/sessions + .pi/agent/sessions
    ☐ 提示词 (n)                ← .pi/prompts
    ☐ 技能 (n)                  ← .pi/skills + .agents/skills
    ☐ 扩展 (n)                  ← .pi/extensions（本体不传文件，只传安装清单+插件配置）
    ☐ 设置                      ← .pi/settings.json（不单独成类，跟随项目）
  ▸ 全局
    ☐ 会话 (n)
    ☐ 提示词 (n)                ← ~/.pi/agent/prompts
    ☐ 技能 (n)                  ← ~/.pi/agent/skills
    ☐ 扩展 (n)                  ← ~/.pi/agent/extensions（安装清单+插件配置）
    ▸ 配置                      ← 新增：~/.pi/agent 顶层散落配置文件
      ☐ auth.json   ☐ models.json   ☐ settings.json   ☐ models-store.json（默认关）
```

- **trust.json 明确排除**：信任规则是“路径 → 规则”，换机器路径全变，同步无意义且有风险；不扫描、不进树。
- 全局配置默认勾选 `auth.json / models.json / settings.json`；`models-store.json`（~293KB 商店元数据）默认关。

### 12.3 扩展/插件配置文件（用户重点）

- 扩展**本体**不传文件（维持 M5：只同步安装清单，目标机 `pi install` 重装）。
- 扩展目录内的**配置文件**（`extensions/<name>/config.json`、`<name>/.env`、`<name>/settings.json` 等）扫描进树，勾选后随载荷上传。
- 实测当前机器 `~/.pi/agent/extensions` 为空、无 `.env`；真实样例（如搜索插件在 python 子目录的 `web.json`）路径千差万别 → 扫描兜底靠 12.4 的自选同步。

### 12.4 排除名单 + 自选同步（两个互补能力）

- **扫描排除**：内置默认规则（`*.bak*`、`*.log`、`*-events.jsonl`、`node_modules`、`.trash` 等）+ 设置页用户黑名单（路径/glob）；排除项不扫描、不进树。
- **自选同步**：树底部「添加文件/文件夹」按钮 → 原生文件选择器 → 选中路径加入同步清单，树内显示为「自选」节点（文件级勾选）。存储：项目内相对路径 / home 相对路径；无法相对化时标注「仅本机」。

### 12.5 换机器落地：全手动挂载

- **不做 UUID 自动匹配**（用户明确：UUID 匹不匹配无关紧要）。
- 云端按项目名组织目录（`projects/<name>/…` + `global/…`）。
- 拉取时：云端项目未映射 → 待映射列表（现有 `cloud-sync-pending` 机制）；用户首次为每个云端项目手动指定本地目录一次，映射持久化（`remoteProjectId ↔ localPath`），之后稳定落位。
- 全局部分直接落 `~/.pi/agent/` 对应子目录，无需映射。

### 12.6 影响面

| 项 | 状态 |
|---|---|
| 选择模型（节点级 + 个别取消） | 需重构，兼容旧 selection 持久化 |
| 树结构（类别节点 + 全局配置节点） | 需重构渲染层 + scanner 归组 |
| trust.json 排除 / 默认排除规则 | scanner 常量 + 设置项 |
| 用户黑名单 / 自选同步 | 新增 IPC + 存储 + UI |
| 全手动挂载映射 | 新增映射存储 + 待映射 UI |

7. **扩展安装策略（已实现）**
   包扩展只同步“声明”（`extensionSources` 从 settings.json `packages` 提取），不做 node_modules 同步；目标机恢复后自动 `pi install`，失败标记 `missingExtensions`（设置页可重试）；启动保护由 `enabledExtensionResolver` 白名单跳过缺失包，不阻断 pi 启动。
