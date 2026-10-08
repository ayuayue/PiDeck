# 领域维护手册（改到哪读哪）

> 本文档承接 AGENTS.md 移出的领域运维细节。AGENTS.md 只保留每域一行硬约束速查；
> 动手改对应模块前，先读本文对应小节。

## README 与官网共用图片（docs/images 单一数据源）

- 微信群二维码这类 README 与 docs-site 都要展示、且会**周期性换图**的资源，唯一数据源固定为 `docs/images/<名>`；**不要在 `docs-site/public/images/` 再存一份**（历史上 `wechat_pay.png` 就是两份拷贝，换图要手工同步两处）。
- 映射由 `docs-site/.vitepress/sharedReadmeImages.ts` 插件完成：`configResolved` 阶段把白名单图片复制进 `docs-site/public/images/`，dev / build 因此共用同一条资源链路。**同步必须留在 `configResolved`**——Vite 在 createServer 一开始就快照 publicDir 文件清单，晚于该阶段落盘的文件不会被当成公共资源（dev 回落成 index.html、build 报 `Rollup failed to resolve import`）。
- 生成的副本**不进版本库**（`.gitignore` 显式忽略）；源图缺失时同步函数抛错而非跳过，否则线上直接是一张破图。新增共用图片：加进 `SHARED_README_IMAGES` 白名单 + `.gitignore` + `tests/docsSharedImages.test.mjs` 的四处引用断言。
- README 用仓库相对路径（`docs/images/<名>`）、官网用站点根路径（`/images/<名>`），两者不可互换；`docs-site` 目录下的 TS 已纳入 `npm run typecheck`。

## 公告维护与发布（announcements-md → announcements.json）

- 公告的**唯一编辑入口**是 `announcements-md/*.md`（front matter + markdown 正文；目录内 `README.md` 是维护说明，脚本显式跳过）。**禁止手写仓库根 `announcements.json`**，客户端实际拉取的文件必须由脚本生成。
- 发布流程：改 md → `npm run build:announcements`（`node scripts/build-announcements.js`）生成 json → md 与 json 一起 commit 到 `main` 分支。`npm run check:announcements`（`--check`）断言 json 与 md 逐字节一致，用于 CI 防手工改动漂移。
- md 格式：front matter 必填 `id` / `title` / `level`(info|warn|critical) / `publishedAt` / `effectiveUntil`（ISO 8601），可选 `minVersion`（仅向更低版本客户端展示）；`id` 必须稳定唯一（渲染层已读去重 key）且不含空白；下线公告 = 删除对应 md 文件重新生成，或等 `effectiveUntil` 自然过期。
- 渲染安全边界：公告是外部数据。**列表卡片只展示 `announcementExcerpt()` 清洗后的短摘要（不渲染 md）**；「查看详情」弹窗复用 `MarkdownStream`（light 模式）渲染完整正文——与会话消息同一套 streamdown sanitize 管线。禁止在列表卡片直接渲染 md 或引入第二条公告渲染链。

## 商店提示词库维护（resources/xueprompts.db）

- 数据文件 `resources/xueprompts.db` 通过 `extraResources` 直接打进安装包（dev 读 `app.getAppPath()/resources`，打包版读 `process.resourcesPath`）。**改了 db 必须重新打包**，否则用户升级后仍看到旧数据。
- 内置模板写入入口是 `scripts/add-builtin-prompts.mjs`（源文件 `docs/pi-prompt-templates/*.md`，跳过 README），归入分类 `编程提示词`，可重复执行（`INSERT OR REPLACE` + 分类 count 全量重算）。
- `npm run check:xueprompts`（`scripts/check-xueprompts.mjs`）断言分类 count 与实际分组一致、内置模板全部落库且正文可解压，已挂进 `npm run build`，用于挡住「产物带旧库」这类问题。
- **查询边界**：`content` / `description` 都是 gzip BLOB，**SQL 的 `LIKE` 对 BLOB 只做字节比较，中文关键词恒不命中**。所有涉及这两个字段的文本搜索必须在应用层 `gunzipSync` 解压后匹配（见 `XuePromptManager.list` 的 search 分支）；`title` 是明文 TEXT，可以走 SQL。

## 内置扩展热更新（resources/extensions + userData 覆盖层）

- 内置扩展（`resources/extensions/*.ts`）随包分发，RPC 启动时经 `-e <绝对路径>` 注入 pi。打包态 `resources` 只读，扩展出 bug 原本只能等下次发版；**热更新**把这条例外路径补上：拉远端清单 → 写 `<userData>/builtin-extensions/` 覆盖层 → 路径解析覆盖层优先 → 重启会话即生效。
- 清单 `resources/extensions/extensions-manifest.json`（schemaVersion / version / bundleSha256 / 每文件 name+sha256+bytes）由 `scripts/generate-extensions-manifest.mjs` 生成并**提交到仓库 main 分支**，`npm run generate:extensions-manifest` 生成、`npm run check:extensions-manifest` 校验，已挂进 `npm run build` / `build:fast`。版本号 `version` 是**包级**版本（`--set-version` bump），**不跟 PiDeck 应用版本走**。
- **`package.json` 的 `extraResources` filter 必须同时包含 `*.ts` 与 `extensions-manifest.json`**，否则打包版没有清单，扩展页看不到内置版本（漏了就只剩目录扫描兜底）。
- 更新/检测入口在扩展设置页的「内置扩展」面板（`BuiltInExtensionsUpdatePanel`）+ `extensions:builtin-update-*` 通道；默认源 AtomGit（`api.atomgit.com/api/v5/repos/.../contents/...` 返回 base64，匿名可读），`settings.updateSource=github` 时 GitHub raw 直连优先。分支只接受 main/dev 白名单。
- **判据是逐文件 sha256，不是版本号**：改了扩展却忘记 bump 版本也必须能检出更新；远端清单里出现**本地不认识的新文件名一律忽略**（注入清单 `BUILT_IN_EXTENSIONS` 编译在应用代码里，热更新不该也无法凭空引入新代码）。
- **覆盖层必须是完整自洽快照**：扩展之间存在相对 import（`pi-deck-todo.ts` → `./pi-deck-todo-state.ts`，后者不在 `BUILT_IN_EXTENSIONS` 里但在清单内）。因此更新写的是「变化文件取远端 + 未变化文件从当前生效源复制」的全集，且 `resolveBuiltInExtensionPath` 只在 `readVerifiedArtifact` 整份校验通过时才认覆盖层——半截覆盖层（缺文件/被外部改动）会让 pi 报模块找不到。
- **覆盖层必须自带 vendored 运行时依赖**（`node_modules/undici` 等）：pi 扩展加载器按扩展文件所在目录**向上查 node_modules**。随包目录有 extraResources 复制的 `extensions/node_modules/<pkg>` 兜底，覆盖层 `<userData>/builtin-extensions/` 上层没有——缺了就是扩展顶部 `import "undici"` MODULE_NOT_FOUND → pi 启动失败 → PiDeck 禁用全部扩展重启（2026-09-15 事故，与 2026-08-09 打包版缺 undici 同类）。更新器随 tmp 复制（源目录走 `resolveVendorNodeModulesDir`），旧覆盖层由启动装配的 `ensureOverlayVendorDependencies()` 自愈；`VENDOR_DEP_PACKAGE_NAMES` 与扩展裸导入的集合一致性由 `tests/extensionPackagingDeps.test.mjs` 双向把关，新增运行时依赖必须同步 extraResources 与该清单。
- 安全底线：先下载校验、后原子替换（tmp → `.bak` 换位 → rename，失败回滚）；`invalidateBuiltInExtensionsOverlayCache()` 必须在写盘/还原后调用，否则本次更新要等重启才参与注入。
- 三处磁盘根（`ExtensionManager` 列表/版本、热更新器写盘、`-e` 注入解析）必须同源，统一走 `src/main/index.ts` 的 `resolveBuiltInExtensionRoots()`；各拼一次路径迟早漂移成「更新成功但会话仍加载旧扩展」。

## 会话消息编辑/删除/重发（SessionFileEditor 墓碑协议，与 pi 的跨系统契约）

- **PiDeck 的 `deleted` 墓碑（`{type:"deleted", id, originalEntryId, parentId, ts, reason?}`）是自造格式，不是 pi 的 SessionEntry 类型**；pi 1.0 已实测兼容（2026-10 探针，真实 SessionManager）：`parseSessionEntryLine` 是裸 `JSON.parse` 无类型校验，投影按类型白名单跳过 unknown 条目 → 墓碑不进模型上下文、不抢 leafId、墓碑后 append 正常。**不要因为「pi 没这个类型」误判要迁移**；pi 升大版本后重跑探针验证（构造含墓碑的 jsonl → `SessionManager.open` + `buildSessionProjection` 断言被删文本不出现）。
- 删除/重发截断只影响模型上下文，原文永远保留在 jsonl（pi 官方删除语义 `context_edit + replacement:null` 同理是 append-only）。墓碑必须带 id+parentId（pi 索引把最后一条带 id 的记录当 leaf，无 id 墓碑会让 `get_messages` 整页变空）。
- **pi 进程运行中禁止外部改会话文件**：pi 内存 fileEntries 是唯一权威，外部改行被忽略，一旦 pi 全量重写（版本迁移/fork 新文件）外部修改会被覆盖丢失。三道闸（coordinator `requireStoppedForFileMutation` 写前+写后、AgentManager 对 live runtime 二次防御、runtime 通道 `ensureAgentIdle`）不许放宽；写盘期间被重新激活时按「已生效」返回成功并记 warn 日志，不要报 BUSY 引导用户重试（文件已是新内容，重试=二次编辑，2026-10 修复）。
- rewind checkpoint：merge 冲突（unmerged index）时真实 index 的 `write-tree` 必败，必须降级为 HEAD 树（`indexTreeDegraded` 标志 + warn 日志）而不是放弃快照（2026-10 事故：冲突期间检查点 3 连败整体不可用）；conversation 回退找不到 fork 锚点必须先于文件回退抛错拒绝，静默跳过会 UI 假成功（2026-10 事故）。
- 失败日志：`logSessionCommandFailure` 标题带错误码（`(SESSION_RUNTIME_BUSY)` 等），按关键词可搜；不要加「无 debugDetails 就不打日志」类早退。

## 生图会话存储（userData/imagegen：sessions 索引 + blobs 图片）

- 生图（`backend: "imagegen"`）不走 pi/DSH agent，历史独立落在 `<userData>/imagegen/sessions/<sessionId>.jsonl`（`ImageSessionStore`），**图片二进制另存 `<userData>/imagegen/blobs/<sha256>.<ext>`**（`ImageBlobStore`，内容寻址天然去重）。两个磁盘根必须同源解析，统一走 `src/main/index.ts` 的 `resolveImageGenStorageRoots()`。
- **硬约束：base64 不进 JSONL。** 消息里的图片只留 `{type:"image", ref, mimeType}`；`ImageContent.data` 是「正在生成 / 正在发送」的临时形态，落盘前必须换成 `ref`。理由见下条。
- **事故教训（2026-09 白屏）**：旧实现把每张图完整 base64 内联进 JSONL，`MAX_MESSAGES=2000` 只限行数不限字节 → 28 轮（56 行）达 246 MB；`append()` 每轮全量读 + 全量重写；`readMessages()` 全量回传渲染层 ⇒ 渲染进程 OOM（`reason:"oom"`）→ 崩溃自动重载循环 → 60s 内 2 次额度耗尽后白屏，手动重启聚焦该会话 1.8 秒再崩。三条防线必须同时成立：字节水位 + 只追加写 + 尾部有界读取。
- **读取永远有字节上界**：`readMessages()` 只读尾部 `MAX_READ_BYTES` 窗口（起点落在行中间就丢掉半截行），主进程不会 materialize 整个文件，渲染层拿到的图片数据量因此有上界。改这里时不要退回 `readFile(整文件)`。
- **旧格式自愈**：首次读写内联 base64 的旧文件时按行流式迁移为引用格式（一次只持有一行，输出只有百字节级），迁移前后体积差一个量级；损坏行原样保留。判据是 `"type":"image","data":` 与长 base64 字面量两个标记，引用格式不会误命中。
- **渲染层不允许手写 `data:${mimeType};base64,${data}`**：历史图的 `data` 是 undefined，会渲染成一张白图且不报错。所有 `<img src>` 走 `shared/imageContentSrc.ts` 的 `imageContentSrc()`（内联 → data URL；ref → `pideck-img://blob/<ref>`）；复制 / 保存 / 重发带回参考图才用 `loadImageBase64()` / `hydrateImageContents()` 走 `imagegen:read-image-blob` 按需取回。
- `pideck-img://` 是自定义协议（`main/imagegen/ImageGenImageProtocol.ts`）：`registerSchemesAsPrivileged` 在 ready 前声明、`protocol.handle` 在 ready 后注册，`img-src` 已在 `src/renderer/index.html` 的 CSP 里放行。内容寻址 ⇒ ref 与内容一一对应，可长缓存。**别把 ref 回读成 base64 塞回消息对象**，那等于把 200 MB 字符串搬回渲染进程堆。
- 孤儿 blob 回收（`pruneOrphanBlobs`）带 1 小时宽限期（`put` 落盘与引用写进 JSONL 之间有窗口），且**扫描失败整体放弃**（fail-closed：宁可留垃圾也不删掉读不到会话所引用的图）。

## 会话 Markdown 渲染管线（MarkdownStream / streamdown 唯一引擎）

- 唯一引擎是 `src/renderer/src/components/session/MarkdownStream.tsx`（streamdown 2.x + gfm/codeMeta/remarkLinkifyPaths）。公告详情、diff 预览、便签等静态 markdown 场景复用同一套管线（公告走 light 模式），**禁止再引一套 marked/react-markdown**，也禁止 `dangerouslySetInnerHTML` 绕过 sanitize。
- **流式与 settle 是两条渲染路径**：流式期间不跑 remark 插件（`NO_STREAM_REMARK_PLUGINS`），只做 marked 核心解析；`isStreaming` 转 false 后先保持轻量渲染，`requestIdleCallback` 空闲才切全量（高亮/mermaid/表格）。所以在流式输出里看不到的问题，很可能在 settle 后才暴露——**复现问题要看最终态，别只盯流式过程**。
- **mdast 插件用「临时属性 + 父节点整体替换 children」协议时，必须补回 `last → text.length` 的尾段**。`MarkdownLinkCore.ts` 的 `remarkLinkifyPaths` 把裸路径文本节点拆成 `[text, link, …]` 写进 `node.__segs`，父节点随后整体替换原文本节点；漏掉尾段，路径之后的全部正文（含 mdast 里同一 text 节点携带的换行后续行）会整段消失——用户看到的现象是「/ 后面的文本不显示、后一行整行不见」。
- **事故教训（2026-09-23，用户报「斜杠后文本不显示」）**：尾段回填在 `fb6b5667`（feat(markdown): 文件链接存在性校验，失效路径降级纯文本）把 `while` 改成 `for-of` 时被丢掉；表格 cell / API 路径场景下一个 text 节点几乎必以路径结尾，而日常只在段中命中路径，样例永远测不出来。用真实会话 jsonl 实测：91 条回复 47 条丢文本。判据是解析产物可见文本与原文一致，而不是「链接能点」。
- **回归测试必须跑真实层级**：表格行（cell 内 text）、跨换行正文（`\n` 之后仍是同一个 text 节点）、inline code `__fileLink` 分支、路径正好在末尾（不留空 text 节点）。写法见 `tests/markdownPathTailTruncation.test.mjs`（unified + remark-parse 二次解析对比可见文本，不依赖 cwd/真实项目）。
- **考古别只看最近几笔提交**：渲染丢文本这类回归可能潜伏数周，用 `git log --oneline -- <文件>` / `git log -S <片段>` 回到底，确认是「谁引入、为什么当时测不出」，再把这两件事写进注释与测试。

## 自定义主题包（userData/custom-themes + shared/customThemes）

- 单一事实源是 `src/shared/customThemes.ts`：token 白名单（`CUSTOM_THEME_TOKEN_GROUPS`，来自 foundation.css 语义 token 人工梳理）、id/颜色值校验、`DEMO_CUSTOM_THEME`、`CUSTOM_THEME_TEMPLATE` 全在这；主进程保存/目录扫描、渲染层编辑器提示、AI 指南（`customThemeGuide.ts` 生成的表格与示例）都从这里取数。**改 foundation token 命名或新增 token 时三处同步：foundation.css、白名单、指南测试断言**（`tests/customThemes.test.mjs` 会校验白名单全量 token 都出现在指南里）。
- 用户 JSON 是不可信输入，两道闸都不可放宽：键必须在白名单内；值必须匹配静态颜色正则（`#hex` 或纯数值参数的 `rgb()/hsl()/oklch()`），天然排除 `var()/url()/渐变`（值最终只进 inline style，双保险）。坏文件不致命：目录扫描降级为 `parseError` 条目呈现。
- 设置快照 `settings.customTheme`（无前缀键，亮暗双档）在 `SettingsStore.update` 里过 `sanitizeCustomThemeSnapshot`；**快照仅 `themeSkin === "custom"` 时生效**（`applyCustomThemeTokens` 守卫），切回内置皮肤的路径（AppearanceThemePicker onPick）必须同步 `customTheme: undefined`，否则残留快照压过内置皮肤。注入函数是 App 持久化应用（useAppAppearance）与设置弹窗预览/回滚（SettingsModal）共用入口，别复制第二份注入逻辑。
- 内置示例 `DEMO_CUSTOM_THEME` 是常量不上磁盘：列表由它推导（校验不过就不上架，防常量与校验器漂移）、不可删除不可覆盖；「复制为新主题」靠字符串改写 id 生成副本。删除用户主题走 `trashPath` 回收站；主题文件被删后已应用主题不失效（快照内嵌设置文件）。

## 插件开发支持（pluginDev 目录 + demo + AI 指南）

- 能力目录单一事实源 `src/shared/pluginDevCatalog.ts`（19 落点/42 节点 kind/事件节选/硬约束），镜像自桥实现：`GUI_SLOT_METHODS`（`pi-deck-gui-bridge-gui-spec.ts`）与 `UINode` 联合（`pi-deck-gui-bridge-types.ts`）。**桥新增落点/kind 必须同步目录，否则契约测试红**（`tests/pluginDevGuide.test.mjs` 双向校验 kind、逐项校验 slot；`tests/guiExtensionPointsDoc.test.mjs` 保证 `docs/gui-extension-points.md` 含全部 id）。
- 指南 `AI-PLUGIN-GUIDE.md` 由 `pluginDevGuide.ts` 双语生成、写入用户扩展目录并覆盖旧版（生成物不备份）；demo 插件 `resources/plugin-dev/pi-deck-demo-plugin.ts` 复制到同目录，**已存在不覆盖**（用户改过的模板）。落盘路径固定 `~/.pi/agent/extensions/`，home 与 `ExtensionManager.userHomeDir` 同源（WSL 跟随扩展列表解析），保证复制进去的文件一定被扩展页本地扫描发现。
- `resources/plugin-dev` 必须在 `extraResources`（filter `*.ts`）里，漏了打包版「复制 demo」直接报错（源缺失显式抛错，不静默）；demo **不在** `BUILT_IN_EXTENSIONS` 白名单（不是 `-e` 注入的内置扩展，是拷给用户的起步文件）。
- 架构/文件地图/更新步骤详见 `docs/plugin-dev-guide.md`；无热重载（改插件重启会话），这是文档化的有意取舍。

## dev 态渲染层缓存（Vite 预构建 chunk 的 immutable 陷阱）

- 现象：`npm run dev` 启动或打开资源弹层/编辑器时报 `Failed to fetch dynamically imported module: http://127.0.0.1:<port>/@fs/.../node_modules/.vite/deps/<chunk>.js?v=<hash>`。不是代码 bug，是渲染进程命中了上一轮预构建的旧模块。
- 机理：Vite 给 `.vite/deps` 打 `Cache-Control: max-age=31536000, immutable`，缓存键只有「URL + `?v=browserHash`」，而 browserHash 由 lockfile 与配置推导——重新预构建改变 chunk 切分时它可以不变。于是同一 URL 磁盘内容已换、Chromium 仍返回旧副本，旧副本 import 的 chunk 已被删除，Vite 回 504；又因为请求没出网络，Vite「504 → full-reload」的自愈路径也不会触发。
- 收口：`src/main/devRendererCache.ts` + `src/main/index.ts` 的 `createWindow`，仅在 dev（`shouldUseDevRendererUrl()`）加载 renderer 前 `await` 清一次默认 session 的 HTTP 缓存与 JS 编译缓存；清理失败只记日志，不挡窗口创建。打包态零影响。
- 逃生开关：`PIDECK_DEV_KEEP_HTTP_CACHE=1` 跳过清理（需要保留 dev 态登录态时）。手工排查用 `grep -rl <chunk后缀> node_modules/.vite/deps/_metadata.json` 与 `%APPDATA%/pi-desktop-dev[-<branch>]/Cache/Cache_Data`：URL 里的 `?v=` 若与当前 metadata 的 browserHash 相同却找不到对应文件，即为陈旧缓存。
- 时序是契约：清理必须 `await` 在 `loadURL` 之前，写在之后等于没清。守卫见 `tests/devRendererCache.test.mjs`。

## Tab 激活态语言（两种声明约定，2027-10 统一）

改任何 tab/导航激活态前先对号，不要发明第三种：

- **横向 tab 条（内容区切换）**＝下划线：`border-b-2 border-primary` + `text-primary`，shadcn `TabsTrigger variant="line"`（tabs.tsx）是唯一实现；集成浏览器 tab 条手写实现但对齐同一 token。分段条（`variant="default"`，bg-muted 容器+白底高亮）保留给页面/分组级切换，不与 line 混用。
- **纵向选择列表（侧栏/导航）**＝软填充：`bg-bg-active text-foreground`（SessionTree selectedRowClass 是参照实现），不用下划线、不用 raised card。
- **豁免**：终端 dock tab 走 `--terminal-*` 主题变量族（foundation.css 有声明注释），不套应用 chrome 语言。

## 繁体中文（zh-TW 四份词典 + locale 分支点）

- 繁体词典**不手写**：`scripts/genZhTwCopy.mjs` 用 opencc-js 的 s2twp 链路（整串分词，不是逐段换字）从 zh-CN 源生成四份产物——`src/renderer/src/i18n/rendererCopy.zh-TW.ts`、`src/shared/i18n/mainProcessCopy.zh-TW.ts`、`src/main/web/WebI18n.zh-TW.ts`、`src/main/feishu/FeishuI18n.zh-TW.ts`。每份带生成器标识头，**改 zh-CN 源后必须重跑**（漏跑由 `tests/zhTwCopy.test.mjs` 的键集断言报红）。
- opencc-js 按项目惯例**不是**项目依赖（与 `scripts/generate-t2s-table.cjs` 同：运行时只带生成出来的常量表）：首次生成 `npm i --no-save opencc-js@1.4.2 && node scripts/genZhTwCopy.mjs`。脚本头部的 `OVERRIDES` 是分词误伤修正表（opencc 把「内置→內建」拆成「内置→內置」、「播放按钮」附近消出「撥」字这类），**只增改有实际误伤的条目**，别拿它当通用术语表。
- 语言分支点清单（新增语言/调整判定时一起改，否则某个进程会掉回简体）：`src/shared/types/settings.ts` 的 `AppLanguageMode` + `isTraditionalChineseLanguageTag`（简繁标签判定的唯一实现，其它进程都 import 它）→ `src/renderer/src/i18n.ts` 的 `resolveLocale` → `src/shared/i18n/mainProcessCopy.ts` 的 `normalizeMainProcessLocale` → `src/main/web/WebI18n.ts` 词典 + `src/main/web/WebServiceManager.ts` 注入脚本按浏览器语言分流（`zh-Hant` 也要认，客户端标签全是 `zh-TW`/`zh_CN` 形态）→ `src/main/feishu/FeishuI18n.ts` 的 `normalizeFeishuLocale`/`feishuLanguage`（飞书富文本 API 只认 zh/en，繁体沿用 `zh`）→ `src/main/floating/MiniOverlayWindow.ts` 的浮窗语言分支 → `CommonTab.tsx` 语言下拉。
- 加载 i18n 模块的测试**别手写 vm 沙箱**：`FeishuI18n.ts` 现在有运行时依赖（繁体词典 + 简繁判定），旧式 `vm.runInNewContext` 沙箱一加 import 就整片失败——用 `tests/helpers/createTsSandbox.mjs`（按源文件目录解析），桩注入见 `tests/feishuI18n.test.mjs`。
