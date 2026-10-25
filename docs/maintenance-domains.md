# 领域维护手册（改到哪读哪）

> 本文档承接 AGENTS.md 移出的领域运维细节。AGENTS.md 只保留每域一行硬约束速查；
> 动手改对应模块前，先读本文对应小节。

持久数据迁移统一登记在 [数据迁移台账](data-migrations.md)：新增、调整或退役迁移时，同次更新其触发条件、完成判据、失败/冲突行为、验证证据与退役条件。

## 应用命名与历史数据目录迁移

- 三平台显示名统一 `PiDeck`，Dev 通道为 `PiDeck Dev`；npm 包名为 `pideck`，Linux 可执行文件为 `pideck` / `pideck-dev`。Linux 必须显式配置 `linux` / `deb` / `appImage` 的产物名，不能让 `.deb` 回退到 npm 历史名称；Dev 单独覆盖三者，避免空格或继承 stable 的 Debian 替代关系。
- 正式安装版根为 Windows `%APPDATA%\PiDeck`、macOS `~/Library/Application Support/PiDeck`、Linux `~/.config/PiDeck`（遵循 Electron/XDG 路径）；调试态为 `PiDeck-dev[-<branch>]`，Dev 独立环境为 `PiDeck-channel-dev`。便携版仍为 exe 同级 `data/` / `data-channel-dev/`，显式目录不更名。
- `userDataNameMigration.ts` 负责正式根与开发根的整目录更名、设置/自动化/目录记录/草稿/飞书配置里的绝对路径和会话 token 改写、pi 会话目录迁移与 `header.cwd` 修复；历史消息正文不改。`devUserDataMigration.ts` 必须在读取 Dev 决策指针之前调用，防止升级后独立环境被误判为未选择。
- 完成状态存于各新根的 `user-data-name-migration.json`（`userDataMigrationState.ts`）：目录、列出的持久化配置路径和适用会话修复全部成功后才原子发布；绑定迁移版本、旧/新根、会话根与平台。命中有效记录后跳过扫描；没有记录的存量用户继续补修，读写失败或会话目录冲突不发布新完成记录、下次重试。根改名失败用旧根，根已改名后的补修失败继续用新根；会话目录两代并存时保留两边、不合并。此记录只证明本条迁移链，不代表飞书子目录/Bot 格式/凭据及其它迁移已验收；完整登记及当前验收状态见 [UD-001](data-migrations.md#ud-001本次补齐的完成状态)。
- 飞书子目录由 `pi-desktop/` 整体迁到 `feishu/`，保留密文和绑定；路径在实际读写时解析，不在模块导入时缓存，避免早于 `app.setPath`。环境导入兼容两种子目录。改名失败继续旧目录并重试；两代目录并存时使用新目录，但不覆盖、删除或自动合并旧数据。
- `appBrand.initializeAppBrand` 在 ready 前保留历史运行时名供 Electron 初始化 Linux/macOS 密钥环，ready 时恢复品牌；不能提前改加密身份，否则既有 safeStorage 密文/Cookie 无法使用原密钥。Windows AUMID、macOS bundle ID 和旧 localStorage key 保持兼容身份；旧名只用于兼容，不作为新的安装包或数据目录名。
- 更新缓存新写入使用 `pideck-updater`，旧缓存可重建，保留不删除。验证入口：`tests/appBrand*.test.mjs`、`tests/*UserData*.test.mjs`、`tests/userData*.test.mjs`、`tests/feishuConfigDirectory.test.mjs`、`tests/feishuSecretStorage.test.mjs`、`tests/channelDataImport.test.mjs`；真实安装与系统密钥环仍需按平台 smoke。

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

## 商店提示词库维护（resources/xueprompts.db 远程拉取 + xue-index Go sidecar）

- **db 不再打进安装包**（#2 远程化）：客户端首次使用时从 Release 资产拉取双源（AtomGit 主 + GitHub raw 兑底，`XuePromptDbStore`），sha256 版本文件与 db 必须同源成套（跨源指纹不匹配整体作废），缓存落 `<userData>/xue/xueprompts-<sha16>.db`，1h TTL 后台重查。db 有更新：跑 `node scripts/publish-xueprompts.mjs` → 两文件成套上传 Release 资产（`gh release upload <tag> resources/xueprompts.db resources/xueprompts.db.sha256`；AtomGit 侧由 sync-atomgit workflow 同步）。
- dev 模式优先读仓库副本 `resources/xueprompts.db`（`repoResourceDir()`），打包后无副本强制远程。
- **检索走 Go sidecar**（`native/xue-index`，modernc.org/sqlite 纯 Go）：常驻进程预解压建索引，中文搜索可用；宿主客户端 `XueIndexService`，协议 NDJSON stdio（`SESSIONS/XUE_INDEX_PROTOCOL_VERSION` 不匹配即弃用）。二进制缺失/失败自动降级 sql.js 路径（应用层逐行 gunzip，慢但可用），商店永不因 sidecar 缺席而坏。
- 构建链：`npm run build:xue-index`（fail-open，无 Go 只告警）；`scripts/dev.js` 自动构建；三平台 workflow 经 `XUE_INDEX_OS/ARCH` env + setup-go 1.26 交叉编译（modernc.org/sqlite 要求 go 1.26，漏钉版本会静默跳过=包里没 sidecar）。
- **查询边界（降级路径仍适用）**：`content` / `description` 都是 gzip BLOB，SQL `LIKE` 对 BLOB 只做字节比较，中文关键词恒不命中；降级路径的文本匹配必须在应用层 `gunzipSync` 后做（`XuePromptManager.list` search 分支），`title` 是明文 TEXT 可走 SQL。
- 内置模板写入入口 `scripts/add-builtin-prompts.mjs`（源 `docs/pi-prompt-templates/*.md`），`npm run check:xueprompts` 挡「产物带旧库」，均在 build 链。

## 跨会话正文搜索（session-index Go sidecar）

- **能力**：侧栏搜索词（≥2 字符，debounce 300ms）除标题过滤外，在全部历史会话**正文**里搜词，跨项目命中展示在 `SessionContentSearchResults`（DshSearchResults 同模式），点击打开会话并经 `pendingMessageJumpAtom` 定位到首个命中消息（`ChatSessionPane` 聚焦后消费；消息未就绪时保留 pending，加载完成重试）。
- **架构**：Go sidecar（`native/session-index`，纯标准库零依赖）预提取 user/assistant text 正文到语料文件（`<userData>/session-index/corpus.bin`，29MB 级 vs 源 1.67GB）+ 定长二进制快照 `state.json`（mtime/size 增量：全量首建 ≈12s，快照启动 37ms）。搜索=多核分片 ReadAt 扫描（纯 CJK 快路径 + ASCII 大小写折叠）。
- **查询语义（多词 AND，③）**：查询按空白（含全角空格）切词、最多 16 词（超出按整句处理），**每个词都必须在同一条消息里命中**才返回（多词是收窄而非放宽）；片段与排序偏好整句连续命中（`contentPhraseBonus`）与词距更近的命中（跨度衰减），会话按「最高分 → 最近活跃」排，每会话最多 5 条命中、最多 30 个会话，`hitCount` 回传未截断的命中总数。
- **降级链（fail-open）**：无 sidecar/binary 缺失/boot 中/超时/roots 为空（WSL 不支持）→ IPC 一律返回 null → 渲染层只剩既有标题过滤，搜索入口永不报错。宿主客户端 `src/main/sessions/SessionIndexService.ts`（roots 签名变化重启、迟到响应丢弃、进程身份核对，与 XueIndexService 同哲学；`isReady()` 同步探测 + `warmup()` 让未就绪时只降级一次、后台照常建索引）。
- **roots 口径（①）**：`SessionScanner.resolveContentSearchRoots(projectPaths)` = 默认 `~/.pi/agent/sessions` + 全局 settings 的 sessionDir + **各项目 `.pi/settings.json` 的 sessionDir**（项目级漏掉就会出现「明明有这条消息却搜不到」——不少项目的会话落在仓库内）；WSL 项目/模式整体跳过（宿主 Go 读 UNC 不可靠）；项目设置按 `mtime:size` 版本缓存，两个项目指向同一目录会去重；每次搜索前先 `refresh(roots)` 增量重扫（stat 毫秒级）保证新会话可搜；启动 5s 后台预热首建。
- **会话内查找（Ctrl/Cmd+Shift+F；IPC 入参 = SessionRecord.id，主进程按 catalog 后端分派）**：pi 会话只扫**当前会话单个文件**（Go 命令 `search-session`），DSH 会话把整段 host 历史投影成消息后做同语义词元匹配（`DshAgentManager.searchSessionMessages` + `src/main/dsh/dshSessionFind.ts`，命中 id 即投影消息 id `dsh:<seq>`），命中按**时间线顺序**返回（上一条/下一条导航，与跨会话搜索的相关度排序刚好相反），默认上限 100 条；`Get` 侧先按 `fileRef` 过滤 entries 再分片读语料，实测 42.7MiB 会话 2ms。入口有两个：`SHORTCUT_DEFS` 的 `findInSession`（**不要**复用 Ctrl+F——那是侧栏「搜索会话」）与会话头部工具条（`SessionHeader` actions）里的放大镜按钮。按钮向 `atoms/session-find-atoms.ts` 的 `sessionFindOpenRequestsAtom` 按会话 id 累加请求，`ChatSessionPane` 的快捷键写同一份计数、浮层只订阅本会话那一格（`openSignal` 只认变化）；浮层本身收起态**不渲染任何常驻按钮**——不要再把放大镜浮回消息区右上角（既压正文，自定义标题栏下还会落到窗口关闭键位置）。入口与浮层共用 `utils/sessionFindSupport.ts` 判据（pi 有会话文件 / DSH 有 dshSessionId）；主进程 before-input-event 广播 id，只有**聚焦**的会话栏响应（分屏作用于用户正在看的那栏）。浮层 `SessionFindOverlay` 走 portal + `fixed`、以**消息区（时间线滚动视口 `sessionTimeline.timelineRef`）矩形**为锚点，不是整栏 `chatPaneRef`：单栏模式下会话栏根节点是 `display: contents`，栏内插绝对定位元素会多出一个网格项挤坏布局；而整栏矩形在自定义标题栏下 top≈0、right≈视口宽，会把浮层叠到窗口关闭键上（见 `sessionFindAnchor.ts` 的 `SESSION_FIND_TITLEBAR_MIN_TOP=52` 夹紧）；浮层状态按会话隔离（`key={sessionId}` 强制重挂，单栏 pane 实例跨会话复用），`openSignal` 只认「变化」不认挂载时已有的值——否则切会话/浮层重挂会把上次按键重放成自动弹出搜索。降级：主进程返回 `null`（pi：sidecar 缺失/未就绪/WSL/未索引路径；DSH：host 未就绪/启动失败）→ 渲染层显示「暂时读不到」而不是「没有匹配」；ACP 后端与还没有内容的草稿会话（pi 未落盘 / DSH 未建 host 会话）都不挂入口。测试：`tests/sessionFindInSession.test.mjs`（防抖/切会话迟到回包丢弃/unavailable 语义/接线契约）+ `tests/dshSessionFind.test.mjs`（DSH 匹配语义：多词 AND/ASCII 折叠/snippet 窗口/截断）+ `tests/sessionIndexService.test.mjs` 的 `search-session` 帧用例。 **跳转落位补强（2027-02）**：命中在已完成轮的执行过程折叠区里时（中间回答/工具被 Radix 收起整块卸载，扩窗只多挂轮次永远挂不出来），controller 先写 `timelineRevealRequestsAtom` 让包含目标的 TurnRow 展开折叠（`runContainsMessage` 判定归属），节点挂载后再落位；实在挂不上（超出单轮挂载预算）就退到包含目标的那一轮（`resolveJumpFallbackEntry`），只有目标已不在已加载数据时才 toast `sessionFind.jumpFailed`。DSH 运行时窗口 attach 只取尾部 200 条消息事件：`dshRuntimeWindowFields` 把「有更早历史」编码成 `windowStart=1` + `windowStartFilePos=窗口最旧事件 seq`（`totalLength` 同步 +1 保证卡片数恒 0），渲染层已有的 `windowStart`/`windowStartFilePos` 补页游标对 DSH 同样生效；测试 `tests/sessionJumpReveal.test.mjs` + `tests/dshHistoryPagePlan.test.mjs`。 **点击命中的跳转口径（2027-02 用户反馈「搜到了但点了没反应」）**：Go 索引返回的 `match.messageId` 是**会话文件条目 id**（JSONL 行 `id`），而时间线消息/节点的 `id` 是投影 id（`${agentId}-history-${entryId}`，见 `src/main/pi/AgentMessageProjector.ts`），条目 id 只落在 `meta.entryId`；直接拿命中 id 查 `[data-message-id]` 永远查不到 → 既不滚动也不高亮。跳转前必须先归一：`src/renderer/src/components/session/timeline/jumpTarget.ts` 的 `resolveJumpMessageIndex()` 先按消息 id 精确匹配（刻度/大纲传的就是投影 id，语义不变），再按 `meta.entryId` 匹配；挂起跳转每轮补页后重新归一。落位用 `resolveJumpScrollTarget()`：轮内中间回答在「执行过程」折叠里是 `display:none`（几何全 0，直接算 scrollTop 会跳到时间线顶部），命中节点不可见时退回所属 `.turn-row`。挂起策略 `resolveJumpPendingAction` 的 `targetInLoadedData` 分支加了 `JUMP_MAX_EXPAND_ATTEMPTS=8` 上限，补页 40 页上限（`JUMP_MAX_LOAD_ATTEMPTS`）以外一律 `give-up` 并 toast `sessionFind.jumpFailed`（放弃原因有三种：历史太远加载不到、已被 context_edit 移出展示、命中属于其它分支——Go 索引按文件行扫描、不做分支过滤）——放弃时静默就是本次 bug 的用户感受。命中行显示角色 + 相对时间（不再露条目 id）；同一消息多个文本块会撞 key，列表 key 用 `${messageId}-${index}`。
- **构建链**：`npm run build:session-index`（fail-open）；`scripts/dev.js` 自动构建；三平台 workflow `SESSION_INDEX_OS/ARCH` env；纯标准库无 go.sum（setup-go 缓存清单只列 xue-index）。
- 测试：`tests/sessionIndexService.test.mjs`（宿主协议生命周期 9 项）+ `tests/sessionContentSearchChain.test.mjs`（IPC 三处同步/降级 stub/挂载点源码契约 7 项）+ Go 侧 `native/session-index/*_test.go`。

## 工作区文件搜索（file-index Go sidecar）

- **能力**：文件抽屉（Ctrl+F）除按名称搜索外，另在**工作区文件正文**里搜词，结果按「名字命中 / 文件内容」两段展示（内容行含相对路径:行号 + 命中片段），点击打开该文件。文件名命中仍是毫秒级本地扫描，内容命中有独立的加载态。
- **架构**：Go sidecar（`native/file-index`，纯 Go，唯一依赖 `github.com/mozillazg/go-pinyin`（字典随包，走 `go.sum` + workflow 模块缓存），源码 `native/file-index/{main,index,fuzzy,textmatch,pinyin}.go`）持有**单项目**的常驻内存索引（全量重扫 + 目录名/路径模糊匹配 + 拼音检索 + 文本文件内容扫描），宿主客户端 `src/main/files/FileIndexService.ts`（与 session-index 同哲学：roots 变化重启进程、请求超时、迟到响应丢弃、fail-open）。**索引跨项目切换会重建**（requests 带 roots，签名变化即杀进程重拉）——后续可扩成多项目缓存。
- **拼音检索（文件名/目录名，硬性语义）**：含汉字的条目在索引期预算两把键（`native/file-index/pinyin.go`）：首字母按「逐字读音集合」存（重 → `zct`，因此 `cq` 与 `zq` 都能命中「重庆」），全拼取库默认读音。查询是纯 ASCII 字母且长度 2–24 时才启用，四级优先：整名首字母（700）> 首字母前缀（680）> 全拼子串（640）> 跳字首字母（560），全部落在名字通道内、路径命中（400/250）之上，不改动既有名字/路径分级。已知边界：全拼不覆盖异读（`chongqing` 搜不到「重庆」，`cq` 可以）、内容检索不参与拼音、`FileSystemService` 扫盘兜底路径**没有**拼音（sidecar 不可用时行为与今天一致）。
- **渲染层会话标题拼音（与 sidecar 同字典）**：侧栏「搜索会话」是渲染层本地过滤（拿不到 file-index 索引），所以拼音键在渲染层算：`src/renderer/src/utils/pinyinSearch.ts`（纯函数 + 按标题缓存）消费**生成物** `src/renderer/src/utils/pinyinTable.ts`（26k 条，243 KiB）。表由 `native/tools/pinyin-table`（同一本 go-pinyin 字典）通过 `npm run gen:pinyin-table` 生成，**禁止手改**；升级 go-pinyin 后必须重跑并提交生成物，`tests/pinyinSearch.test.mjs` 会钉住条目数量级与关键映射（中/用/查）。分级分数与 sidecar 逐值一致（整名 700 / 前缀 680 / 全拼 640 / 跳字 560），命中只决定「留下」不重排——侧栏搜索的顺序必须与侧栏树一致。装配点在 `SidebarContent`：项目项与会话项分别 `pinyin: pinyinKeys(projectTitle|sessionTitle)`，漏喂这一行不会报错、只是拼音静默搜不到，靠 `tests/morphingSearchFilter.test.mjs` 的源码契约兜住。
- **内容扫描边界（硬性）**：文本扩展名白名单 + 已知文本文件名（Makefile/Dockerfile/.env/README…）；跳过忽略目录（与 `FileSystemService` 的 `ignoredNames` 同源，改一处必须改两处）、二进制探测（头部含 NUL 即跳过）；单文件默认 1MiB、单次查询总扫描 64MiB 字节预算，超限截断并回传 `truncated`；片段前后各截 80 字符且单行只保留前 3 条命中。
- **降级链（fail-open）**：IPC 侧 `files:search-content` 在「没有 sidecar / 未就绪 / 异常」时返回 null，渲染层不渲染内容分区（名字结果照常返回）；`files:search`（名字）在 sidecar 不可用时回退既有 `FileSystemService.searchNames` 目录扫描，行为与今天一致。
- **WSL**：WSL 项目不进索引（宿主 Go 进程读 UNC 不可靠），`files:search-content` 对 WSL 项目直接不启用（返回 null），名字搜索保持原样。
- **构建链**：`npm run build:file-index`（fail-open，Go 缺失/构建失败只告警 exit 0）；`scripts/dev.js` 自动构建；`package.json` 的 `build` 链与 `extraResources`（`resources/file-index/bin` → `file-index`）；`.gitignore` 忽略产物只留 `.gitkeep`；`native/file-index/go.sum` 必须入库（拼音依赖），三平台 workflow 的 `FILE_INDEX_OS/ARCH` env + `cache-dependency-path` 含该 go.sum + `go -C native/file-index test ./...`。
- 测试：`tests/fileIndexService.test.mjs`（宿主协议生命周期）+ `tests/fileSearchContentChain.test.mjs`（IPC 三处同步/降级/渲染层接线/拼音依赖入库源码契约）+ Go 侧 `native/file-index/*_test.go`（名字排序/模糊匹配/拼音分级与异读/内容扫描/预算截断/片段）。

## 会话数据面 sidecar（session-store，Wave 1 骨架 + Wave 2/2b 条目表默认开）

- **定位**：同一份 pi 会话 JSONL 现在被四套 TS 各自解析（`SessionScanner`/`SessionCatalog`/`SessionHistoryReader`/`usageStats`），这是 `docs/session-data-plane-plan.md` 要收口的对象。Wave 1 交付骨架（Go 侧快照 + 行边界增量扫描、宿主客户端、构建/CI/装配登记），Wave 2 补上 `get-index`（行级条目表）并接到 `SessionHistoryReader`，Wave 2b 把条目表落盘后**收益门禁通过 → `settings.sessionStoreEnabled` 默认开**（置 false 即回退纯 TS 逐行解析；见计划 §8.11：重启后首次打开 19–31MiB 会话 14–20ms，TS 冷建表 99–188ms）。
- **条目表落盘（Wave 2b，改格式必须升 `tableFileVersion`）**：`<userData>/session-store/tables/<sha1(小写 slash 路径)>.table`；首行 header JSON `{version,path,size,mtimeMs,endsWithNewline,lastEntryId,oversizedLines,entryCount}`，其后每行一个 `displayEntry` JSON。复用条件与内存缓存同口径（`size`+`mtimeMs` 都相等）；只变长且上次停在换行边界 → 读旧条目 + `scanTableFrom(start)` 只解析尾部；否则单文件重扫。目录上限 256 文件 / 512MiB（按 mtime 淘汰，永不删当前写入的那个），单表 32MB 超限不落盘；写盘 `.tmp` + rename，失败只 log（加速器，失败不影响可用性）。**两种复用命中前都必须过 `verifyTableBoundary`（`tablepersist.go`，`tableFileVersion = 2`）**：按 `offset/byteLength` 回读首/末条目字节比 `id`（超长行只读 64KiB 前缀），不符即丢弃命中、全量重扫覆盖落盘——版本键看不出「文件被整份重写后恰好更长」，那会让尾部增量从旧 `size` 处错位、`parentId` 链在断点截断，表现就是「只剩最后几轮、没有『加载更多』」且重启不自愈（issue #392）。残留取舍：同长改写且首/末条未变的中段改写仍可能误命中（与 TS 侧 `appendIndexFromTail` 首/末探针一致）。
- **快照口径（改这里必须同步改两侧测试）**：`<userData>/session-store/state.bin`（JSON，`formatVersion = 1`，单文件多条记录，先写 `state.bin.tmp` 再 rename 原子替换，与 `snapshotFormatVersion` 常量同源）。每文件记录 `{path,size,mtimeMs,entryCount,hasCompaction,endsWithNewline}`：`size` **只会推进到最后一个完整行**（末尾残行不入账），`entryCount` 是带 `id` 的完整行数（**行口径**，未做身份去重），`hasCompaction` 是文件里出现过 `compaction` 行（**文件口径**）。Wave 2 接真实时条目表时需升 `formatVersion` 并补去重。
- **增量前提（性能核心）**：只有「`size` 变大 **且** 上次记录以换行结尾（`endsWithNewline`）」才从 `prev.size` 开始尾扫；其余（变小/mtime 变但 size 同/上次残行结尾/无记录）一律全量重建。**换行结尾的判断不能省**（打开前尾部就是半行时接着扫会把半行当整行固化）。
- **扫描口径**：只收 `*.jsonl`（大小写不敏感），跳过 `.pideck-archive` 与 `subagent-artifacts` 目录（成品归档/子代理产物不是可读会话，与 TS 侧一致），深度≤ 32，同路径去重；单行 ≥ 64MiB 时只用一个 64KiB 前缀探 `id`/`compaction`（与 `src/main/pi/jsonlLineStream.ts` 的 `MAX_JSONL_LINE_BYTES` 同口径），不会 OOM。
- **与三个兄弟 sidecar 的差异（勿盲改）**：roots **不进 spawn 参数**（`spawnFn(binaryPath, args)`，`args = [statePath]` 或 `[statePath, tablesDir]`），而是 `list-files {roots}` / `refresh {roots}` 的逐请求字段——快照按绝对路径分键，换 roots 不重启进程也不丢未变更文件的复用记录（解决了计划 §8.8 Q1）。
- **fail-open**：二进制缺失/启动失败/boot 超时/协议版本不符/请求超时全部返回 `{ ok: false, reason }`，调用方回退 TS 解析；sidecar 永不抛异常。装配在 `src/main/index.ts`（`new SessionStoreService({...})` + `quitCleanup.register("session-store")`）；`settings.sessionStoreEnabled`（**默认 true**、无 UI，置 false 即回退）= 读取路径总闸；装配处据此决定是否预热 sidecar（不预热则「只在已就绪时问」的读者路径不会生效）。二进制已进 `extraResources`（`resources/session-store/bin` → `session-store`）。
- **构建链**：`npm run build:session-store`（fail-open，Go 缺失/构建失败只告警 exit 0），产物 `resources/session-store/bin/session-store(.exe)`（`.gitignore` 忽略，只留 `.gitkeep`）；`scripts/dev.js` 自动构建；三平台 workflow 的 `SESSION_STORE_OS/ARCH` env + `go -C native/session-store test ./...`。
- **实测（本机 889 文件 / ~595MiB）**：首建全量扫 `indexMs = 7224`（端到端 7.26s，快照 221KB）；快照命中二开 `indexMs = 40`/`bootMs = 2`（端到端 65ms）。对照 TS 侧首屏 699ms（只读每文件前 1MiB）——**冷启慢一个量级、复用后快 ~17×**，所以 Wave 2 只能把它接到「重复读」路径（打开会话/读窗口），不能接到首屏清单扫描。
- 测试：`tests/sessionStoreService.test.mjs`（宿主协议/超时/降级/roots 逐请求/`get-index`/`tablesDir` argv）+ `tests/sessionStoreChain.test.mjs`（装配/构建/CI/开关/`tablesDir`/extraResources 源码契约）+ `tests/sessionStoreIndexParity.test.mjs`（同一文件、native reader vs sidecar reader 的公开 API 输出逐字段相等；残行/坏形状/抛错回退）+ Go 侧 `native/session-store/{store_test.go,table_test.go,tablepersist_test.go,parity_test.go}`（复用/尾扫/残行/变小重建/压缩粘滞/忽略目录/快照损坏/巨型行/条目表镜像/落盘复用与淘汰/整份重写与旧版本号丢弃）。

## Go sidecar 宿主客户端（共享传输层）

- **唯一实现**：`src/main/sidecar/GoSidecarClient.ts`。`SessionIndexService` / `FileIndexService` / `SessionStoreService` / `XueIndexService` 全部继承它；**禁止再复制 NDJSON 行泵、boot 计时器、pending Map 或进程身份核对**。
- **基类负责**：spawn、boot 超时、ready 协议版本校验、请求 id 配对、请求超时、stdout 单行上限、stderr 尾部、迟到响应丢弃、stdin 管道错误、dispose 结算、`isReady` 同步三态、复用键变化重启。任何失败一律 `{ ok: false, reason }`，不抛异常。
- **子类只提供差异**：`name`、`resolveBinaryPath`、`spawnFn`（测试注入）、`timeouts` 默认值、`maxLineChars`、`messages`（各服务文案）、`onReady`（日志/诊断字段）、`logStderr` / `writeFailureLogLevel`（保留原行为）。进程复用键与 spawn 参数由子类的 `ensureChild` 传入 `ensureReady(key, args)`：session-index/file-index 用 roots 签名，xue-index 用 dbPath，session-store 用常量键 + 逐请求 roots。
- **新增 sidecar 的接线**：继承基类 + 在 `ensureChild` 里做业务前置校验（空 roots/path → `not-ready`）+ 只发本服务的命令帧；`ready` 附加字段通过 `onReady` 或 `getReadyFrame()` 读取，不参与生命周期判断。测试至少覆盖：ready 握手、复用键变化、boot/请求超时、协议版本不匹配、进程退出、dispose；共享层边界由 `tests/goSidecarClient.test.mjs` 兜底（非法行、stdout 溢出、stdin 错误、运行期协议漂移、写入抛错）。
- **结果类型**：各服务的 `*FailureReason` / `*CallResult<T>` 是 `GoSidecarFailureReason` / `GoSidecarCallResult<T>` 的别名；新增失败原因先改基类并在四个服务的测试与调用方确认。

## 技能商店安装链路（net.fetch 搜索 + spawn 进度 + 代理 env 注入）
- **主进程联网一律走注入的 `fetchImpl`（= Electron `net.fetch`）**：裸全局 `fetch` 是 undici，既不读系统代理也不读 Electron 桌面 session 代理，代理环境下境外 API 挂到超时且只抛含糊 `AbortError`。`storeIpc.ts` 四个商店 handler（`skillHubSearch` / `skillStoreSearch` / `promptStoreSearch` / `promptStoreGet`）全部经 `deps.fetchImpl`；测试用 `createStoreIpc({ fetchImpl })` 注桩，未注入时才回退全局 fetch（测试沙箱无 fetch，故必须惰性取值）。
- **搜索入参契约（preload ↔ 主进程）**：`skill-hub:search` 两侧共用 `shared/types` 的 `SkillHubSearchOptions`（`{ query, limit }`，limit 缺省 50）。preload 曾透传 api.skillhub.cn 时代的 `page/pageSize/sortBy/order`，主进程只读 `limit`——面板传的第二个参数落到 `page` 上被静默丢弃；`tests/skillHubSearchContract.test.mjs` 用「preload 捕获真实 payload → 主进程 handler」端到端锁住契约。
- **安装用 `spawn` + 流式解析，不用 `execFile`**：`execFile` 要等进程结束才有输出、且旧实现丢掉了 stdout——`npx skills add` 冷启动实测 30.25s 期间 UI 零反馈，失败时用户只看到 npm warn（CLI 的真报错在 stdout，带 ANSI 的 spinner 也在 stdout）。现在 `runSkillHubInstall` 逐块喂 `createInstallProgressParser`，阶段 `preparing → downloading → installing`、百分比同阶段单调不倒退，节流 `INSTALL_PROGRESS_MIN_INTERVAL_MS=200` 经 `skillHub:install-progress` 推送；preload `skillHub.onInstallProgress` 返回退订函数，`previewApi` 走 no-op 订阅。
- **渲染层**：`SkillHubStorePanel` 用进度帧替换纯 spinner（阶段文案 + 百分比条）；错误文案取 `cleanInstallOutput` 清洗后的 stdout 尾部（`isNetworkFailure` 命中时给网络提示），i18n 键 `config.skillHub*`（renderer 三词典）与 `mainProcessCopy*` 同步。
- **代理 env（`skillHubInstallProxy.ts`）**：桌面代理设置优先（fixed_servers 规则 → `HTTP(S)_PROXY`），未启用时回退 `session.defaultSession.resolveProxy`（系统代理），`NO_PROXY` 取桌面 bypass 列表，附 `NODE_USE_ENV_PROXY=1`；`parseElectronProxyRules` 只接受 `PROXY host:port` / `DIRECT`。理由：CLI 内部 `git clone github.com` 不读 npm 的 proxy 配置，不注入 env 时代理环境下必失败（实测 `fatal: unable to access 'https://github.com/...': Recv failure: Connection was reset`）。
- **模块划分**：`skillHubInstallCommand.ts`（命令行构造，win32 走 `cmd.exe /d /s /c`）、`skillHubInstallProgress.ts`（ANSI/CR 归一 + 阶段/百分比解析 + 输出裁剪）、`skillHubInstallProxy.ts`、`skillHubInstallRunner.ts`（spawn 生命周期 + 超时杀进程树 + close 前 flush 残余行）；测试 `tests/skillHubInstallFlow.test.mjs`。

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

## 会话索引身份修复（#354）

- `sessionCatalogIdentityRepair.ts` 在 catalog 启动加载、恢复运行时前修复身份；`filePath` 即使已是正确绝对路径，也要按当前路径规则重算 `originKey`。native POSIX 保留大小写，不能继续使用早期全小写的持久化键。
- **只有 resolver 返回无歧义绝对路径（`/`、`C:\`、UNC）的条目才参与归并**：生产 resolver（`main/index.ts` 装配）在项目解析不出来时按契约原样返回入参，把相对路径当「已确认物理位置」会让两个项目各自的 `.pi/sessions/x.jsonl`（键不含 projectId）被破坏性归并成一条。无法确认时既不重算键也不归并、不落盘；同层标题冲突又拿不到权威证据的组同样整组保留**原始记录（含旧键）**、不落盘 normalized 克隆，下次启动重试。
- **归并只在路径与完整 origin（来源、环境、WSL 发行版/用户、导入源 ID、路径）相同时发生**，旧小写键记录优先保留稳定 ID，无此证据时保留最早 `createdAt` 的记录；人工标题优先于自动/兜底名。
- **标题冲突不得用 `updatedAt` 决胜**：runtime attach、重命名、普通扫描都会刷新它，重开一个旧重复条目就能把陈旧标题选回来，而 manual 锁让扫描永远纠正不了。同优先级（同层）标题不一致时只认有界读取到的 `session_info` 权威名（`SessionTitleFetcher`，`nameFromSessionInfo === true`）且与某一方标题逐字相同；无 fetcher / 读失败 / 权威名不匹配任何候选时**整组保留**（两条记录都不删、下次启动重试），禁止猜一个标题删掉另一条。
- **物理文件确认必须覆盖所有破坏性操作，运行时归并也不能只看持久化键**：`attachRuntime` 的同源折叠先对 survivor 与每个候选跑与启动修复同一道闸（pi 文件会话 + resolver 返回无歧义绝对路径 + 按完整 origin 现场重算键，`SessionCatalog.confirmedOriginKey`），不能拿持久化 `originKey` 或相对路径派生键当「已确认同一文件」——两个项目各自的 `.pi/sessions/x.jsonl` 键不含 projectId，只比键就会跨项目吸收记录。无法确认时保守保留（不归并、不改写身份键；改写会洗掉「这条是小写旧键」这一唯一证据，下次启动就会按 `createdAt` 错选存活 ID）。
- **标题归属按整组最高优先级层（manual > legacy > auto > fallback > undefined）**，只有同层标题冲突才读磁盘权威名（`arbitrateRuntimeMergeTitle` → `resolveConflictTitleOwner`）；同层无冲突时也必须在归并时明确把该层三件套（title/titleOrigin/titleLocked）应用到结果上，否则存活条目（往往是刚建的 provisional 草稿，优先级最低）会把自己的临时名留在上面，吞掉被吸收记录的手工名。禁止用 `updatedAt` 仲裁。磁盘证据缺失 / 权威名与任何候选都不匹配时**不得归并**：启动时保守保留的冲突组不能因为用户激活其中一条就在运行时被静默删掉。标题必须在全组 fold **完成后**应用（逐次 merge 会重建对象，按对象 identity 记 owner 会在第二轮失效）。成功归并时吸收**全部**同源条目（不是只删一条），把被吸收 ID 与其历史别名累计进 `mergedSessionIds`（别名索引随快照重建）。
- 被归并的历史稳定 ID 记入存活条目的 `mergedSessionIds`（可选字段，与 catalog 原子快照一起落盘，多轮归并累积、不重复、不遮蔽真实存在的会话、不产生环）；旧数据没有该字段无需迁移。字段来自用户可手改的 JSON，读侧必须收窄（`readMergedSessionIds`）：非数组、元素非字符串一律按「没有别名表」处理——字符串若直接迭代会被拆成逐字符别名，`mergedSessionIds: 42` 曾让整个 catalog 启动抛 `TypeError`；坏字段只删字段项，不动条目本身。
- **稳定 ID 引用必须迁移，不能只删重复条目**：`settings.pinnedSessionIds`（侧栏置顶）由主进程在 `sessionCatalog.load()` 之后、建窗口之前经 `sessions/sessionPinnedIdsMigration.ts`（`migrateSessionIdList` 的装配层薄包装，catalog/settings/日志由 `main/index.ts` 注入）重写到存活 ID（幂等、无变化不写、失败只记日志不阻断启动）；渲染层持久化的 Tab 置顶与「最近活动」经 `sessions:catalog-list` 载荷里的同一字段、用 `shared/sessionIdAliases.ts` 的同一套解析迁移，**迁移必须跑在 Tab 存在性清理之前**（否则清理先把被归并 ID 当已删除记录丢掉）。不新增 IPC 通道。
- 旧 ID 的迟到请求不得报「会话不存在」或另起一个 runtime：`SessionCatalog` 的 `get/getRecord/update/remove/removeWithDescendants/attachRuntime/promoteToActive/claimTitleOwnership/apply*Title/markSuperseded` 统一先经 `resolveSessionId` 归一化；**写队列里的操作必须在事务执行时按最新别名表再归一一次**（`requireEntry`/`findEntryInTransaction`）——入队时的快照会指向排队期间被 attach 折叠吸收掉的旧 ID，真实顺序「attach 先入队 → 在旧 ID 上改名的操作后入队」会以 `Session not found` 被拒。runtime 激活（`ensureRuntime`）、target 命令（`runTargetCommand`/`restartRuntime`）与查询/生命周期入口（`activateRuntime` 的返回值构造、`getTarget`、`getAgentId`、`hasLiveRuntime`、`isActivating`、`releaseRuntimeForDelete`、`bindAnonymousRuntime`）也走同一入口；`send` 的投递缓存 key 用现存 ID，别名与现存 ID 的同一 `requestId` 只投递一次。generation/dispatch lease 守卫语义不变（归一化只改身份，不放宽断言）。
- 归并补齐原记录缺失的偏好/结构元数据，并改写 catalog 内 `supersededBy` 引用；不改写或删除 JSONL。
- **扫描不得回退活动时间，且存储与返回记录必须一致**：`mergeScanned` 在写事务内取目录现值与扫描时间的较新值，`recordFromEntry` 同样不得优先返回过期摘要时间；否则「扫描先读 → 用户改名提交 → 旧扫描后合并」会让标题正确但会话沉回旧排序位置。活动时间不受 `titleOrigin`/`titleLocked` 限制，manual/auto 会话有新文件活动仍须前移；仅时间较旧且无其他字段变化的重复扫描不落盘、不轮转 `.bak`。`tests/sessionCatalogActivityTime.test.mjs` 覆盖持久化、返回值、重启、乱序扫描和暂停后台扫描时的连续改名同步。
- 修复沿用 catalog 的 `.bak` + 原子快照；写失败记日志、内存修复仍生效，下次启动重试。回归：`node --test tests/sessionCatalogIdentityRepair.test.mjs tests/sessionRuntimeIdAlias.test.mjs tests/sessionIdAliases.test.mjs tests/sessionPinnedIdsMigration.test.mjs tests/sessionDuplicateDisplay.test.mjs tests/sessionCatalogActivityTime.test.mjs`。

## 会话消息编辑/删除/重发（原生 context_edit + 重发墓碑，与 pi 的跨系统契约）

- **普通编辑/删除写 pi 原生 `context_edit`**（`{type:"context_edit", id, parentId, timestamp, targetId, replacement}`）：删除用 `replacement: null`，编辑用 `replacement: {content}`。原文行一字不改，模型上下文由 pi 的 `buildSessionProjection` 投影得出。因此「删了但原始历史里还在」是设计而非 bug：**已发生的 token/费用不回退，已被压缩摘要转述的内容也不会因这条记录消失**（原始文件、导出、计费仍能看到它）。
- **展示口径（2026-10 产品决定）**：被移出的条目在时间线上**直接不显示**（无徐章、不折叠，删除就是看不到）；被改写内容显示改写后的正文且不加标记。过滤发生在 `SessionHistoryReader.applyContextEdits`（读取侧），因此桌面、Web、离线 Viewer 同一口径；原始行仍留在文件里，只是不参与展示。
- 编辑只改文本：`replaceTextInContent` 保留图片/工具块等其它内容后作为 `replacement.content`（直接把新文本当 content 会把附件整体替掉）。
- **重发（resend）仍用 `deleted` 墓碑做分支截断**，不用 context_edit：重发是「回到这条消息重来」，必须真的截断后续分支，否则旧回答的 tool_call / toolResult 配对会被保留，重发后报工具调用不匹配。墓碑（`{type:"deleted", id, originalEntryId, parentId, ts, reason?}`）是自造格式，pi 1.0 实测兼容（墓碑不进模型上下文、不抢 leafId、墓碑后 append 正常）；**不要因为「pi 没这个类型」误判要迁移**，pi 升大版本后重跑探针。
- **追加新条目的 parentId 必须是「当前 leaf」而不是「最后一条 message」**（`currentLeafId`：跳过 session 头、取最后一条带 id 的条目）。编辑/删除会追加 `context_edit` 并成为新 leaf，若新消息挂到更早的 message 上就会绕开它分叉，pi 沿新 leaf 回溯时收集不到该编辑——用户的修改静默失效（2026-10 实测：追加后投影回旧内容）。同理，墓碑也必须带 id+parentId，pi 索引把最后一条带 id 的记录当 leaf。
- **编辑器写盘的 leaf 语义必须与 pi 一致**：pi `SessionManager._buildIndex` 跳过 `type:"session"`、其余条目（含 `context_edit`、`label`、墓碑）都进索引并更新 leafId；PiDeck 侧的 `activeBranchIds`/`currentLeafId` 必须同口径，否则编辑/删除/追加会落在不同分支上。
- 一次操作追加多条 `context_edit`（删除 assistant 回答时连带 thinking-only / toolResult 祖先）时必须**串成 parent 链**（后一条的 parentId = 前一条的 id）。都挂在同一个 parent 上时后者成侧分支，pi 只沿 leaf 父链收集编辑，前几条会静默失效。
- 读取侧（`SessionHistoryReader`）把有效编辑汇总成内部 `SessionContextEditsDetail` 后直接作用于消息数组：被移出的条目整条丢弃、被改写的替入新 `text`；`replacement` 形态不认识时按「无编辑」处理（宁可显示原文也不凭空清空上下文）。页面契约不再下发编辑汇总（过滤已在读取侧完成，跨 IPC 再传一遍是重复数据）。按文本定位的回退必须同时匹配原文与有效文本（连续两次编辑时 UI 手里是改写后的文本）。
- **pi 进程运行中禁止外部改会话文件**：pi 内存 fileEntries 是唯一权威，外部改行被忽略，一旦 pi 全量重写（版本迁移/fork 新文件）外部修改会被覆盖丢失。三道闸（coordinator `requireStoppedForFileMutation` 写前+写后、AgentManager 对 live runtime 二次防御、runtime 通道 `ensureAgentIdle`）不许放宽；写盘期间被重新激活时按「已生效」返回成功并记 warn 日志，不要报 BUSY 引导用户重试（文件已是新内容，重试=二次编辑，2026-10 修复）。
- 改写入路径后**必须用真实 pi 验收**（本地 pi 的 `loadEntriesFromFile` + `buildSessionProjection`）：断言编辑后模型看到新文本、删除后不出现、原文仍在文件里、继续 append 后编辑仍生效。只跑 PiDeck 自己的读取端会漏掉「leaf 接错导致编辑掉出分支」这类只有 pi 才能发现的失效。
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

## 智能体与划词工具（agent-profiles.json + 一次性补全侧车 + 系统级划词浮窗）

- 智能体是 PiDeck 层的「提示词预设」，不是 pi 的东西：名称 / 简介 / emoji 图标 / 分类 / 角色设定（systemPrompt）/ 可选模型 / **会话后端（backend: pi|dsh）**，全部落 `<userData>/agent-profiles.json`（`{version,revision,settings,agents}`，`AgentProfileStore` 串行写 + 读盘归一化）。**内置智能体只在 id 缺失时补种，绝不覆盖用户编辑**；新增内置智能体只改 `src/main/agents/builtinAgents.ts` 的 `BUILTIN_AGENT_SEEDS`（id 一旦发布不可改；内置删除返回 false，可编辑、可用 `resetBuiltin` 恢复出厂内容）。当前内置：翻译官（`builtin-translate`，划词默认回退）、PiDeck 小助手（`builtin-pideck-helper`，产品/使用/开发/FAQ 入门）、PiDeck 问题诊断助手（`builtin-pideck-diagnostic`，诊断报告/日志/体检/Issue 草稿）、PiDeck 插件开发助手（`builtin-pideck-plugin-dev`，宿主插件从脚手架到打包发布）；提示词是种子里的产品内容，不进 i18n，改完要同步 `tests/builtinPideckAgents.test.mjs` 的关键事实断言。
- **清空可选模型**的约定与自动化任务一致：更新传 `model: null` 或成对空串 `{provider:"",modelId:""}`，归一化层丢字段（= 跟随会话模型）；半填/超长/控制字符的 ref 一律丢弃，绝不落半截值。**清空 backend** 同理：update patch 自带 `backend` 键且值为 `undefined/null` = 跟随设置默认（`Object.hasOwn` 判定，不能靠缺键）。
- **「智能体」是会话 Tab 栏里的页面式 Tab（不是弹窗、也不是会话 Tab）**：`AgentMarketPage` 覆盖会话列（`absolute inset-0 z-30`，与 `HostPluginPageOverlay` 同约定），Tab 由 `SessionTabsBar` 的 `pageTabs` 渲染，状态在 `workspace-page-atoms`（Tab 列表 + active）。**切会话只失活**（页面子树保留挂载、`hidden` 隐藏，搜索/详情/编辑状态不丢），关闭页面 Tab 才卸载；页面标题固定走 i18n，不进 `sessionTabIds`、不参与自动会话标题。**划词设置全部在「设置 → 通用」的 `SelectionToolSettingsSection`**（应用内开关 / 系统级开关 / 默认智能体 / 只读快捷键提示）；页面里不再有设置页。
- **定时任务同一套页面 Tab**：`AutomationPage` 复用 `AutomationWorkspace`（页面逻辑不变），旧 `AutomationModal` 已删除；项目菜单入口经 `openAutomationPageAtom(projectId)` 锁项目范围。页面 Tab 与会话 Tab 同栏并列，可关闭、不可拖拽/固定/分屏。
- 一次性调用（划词翻译 / 系统浮窗）：`agent-profiles:invoke` → `AgentInvokeService` → 注入的**独立** `EnhancePromptService` → `resources/pi-enhance-host.mjs`（AGENTS.md 例外四）。边界：**systemPrompt 只能由主进程按 agentId 从 store 解析**，渲染层只传 agentId / 短 instruction / 目标语言 / provider+modelId；事件按 runId 配对（started|delta|done|aborted|error 恰好一次）；单飞语义（新 run 打断旧 run）意味着**不能与输入框增强共用实例**，否则划词会打断增强。
- 智能体模型优先级复用 `shared/enhanceModelPreference.ts` 的解析链（agent.model > 会话记录 > 设置 enhanceModel > 引导页偏好）；系统浮窗没有会话上下文，最后兜底 `sessions.resolveLaunchDefaults()` 的默认模型。
- **「使用」= 会话页面复用 + 隐藏提示词 + 输入框上方可见**：页面「使用」→ `sessions.createDraft`（标题=智能体名，backend=agent.backend ?? 设置默认，仅 pi 带 agent.model）→ `agent-profiles:bind-session` 写 `settings.sessionAgentBindings` → 打开会话。绑定的会话每次发送，`sessionIpc` 用 `composeAgentInstruction` 把角色设定拼进 `SendPromptInput.agentMessage`（pi/acp 隐藏，时间线只显示用户输入；DSH 显式拒绝 agentMessage 且会拒收整条 prompt → 退化为可见前缀）。绑定表只能经 bind-session 改（`updateSettings` 的 patch 含 bindings 会被 IPC 拒绝）；上限 2000 条，删除智能体会同一次写入里清掉指向它的绑定，悬空/坏键在读盘时修复。PiDeck 不写 pi 的系统提示。绑定的会话在输入框上方常驻 `SessionAgentPromptBar`（按 `sessionAgentBindings` 解析智能体，可展开只读查看完整 systemPrompt；发送消息后仍可见，绝不写进对话正文/会话文件）。
- **应用内划词**：document 级 mouseup/keyup 捕获选区快照；**浮钮 mousedown 必须 preventDefault**，否则按下瞬间浏览器清掉选区；跳过 `INPUT/TEXTAREA/SELECT/contenteditable` 与 `[data-selection-tool-ui]` 子树。结果**在划词工具栏里内联输出**（紧凑工具栏 ~400px，打开即自动翻译，无「开始」按钮），不是弹窗。默认智能体 `settings.selectionToolAgentId` 悬空时主进程归一化清空、渲染层回退内置翻译官（`builtin-translate`）。
- **与时间线「引用并提问」浮层共存**：会话消息里划选时，时间线自带的胶囊浮层渲染两个动作（`data-quote-action="quote"` / `"translate"`）；它可见期间（`quoteToolbarVisibleAtom`）全局划词浮钮不再出现，翻译动作写 `openSelectionInlineAtom({text, rect})` 由 `SelectionToolHost` 打开内联工具栏——同一时刻只有一个浮层。e2e 点击必须命中 `[data-quote-action="quote"]` 而不是容器中心。
- **复制/菜单不算划词**：全局监听在 `pointerdown`（工具 UI 自身除外）先清快照，`copy` 事件也清；mouseup 在 Radix portal/菜单、引用浮层、任意 `button` 上不重新评估选区。否则「右键 → 复制」会让引用浮层让位、菜单 mouseup 又被当成新手势，复制 toast 后重新冒出翻译浮钮（2026-10 用户反馈）。策略集中在 `selectionToolPolicy.ts` 的 `SELECTION_TOOL_IGNORED_MOUSEUP_SELECTOR`，回归见 `tests/selectionToolPolicy.test.mjs`。
- **系统级划词默认隐藏/关闭**：`SYSTEM_SELECTION_TOOL_ENABLED=false`，`DEFAULT_AGENT_MARKET_SETTINGS.systemSelectionEnabled=false`；设置页不渲染系统级开关/快捷键/冲突提示，快捷键页隐藏 `openSelectionTool` 行；复制监听、Windows 原生捕获与 `globalShortcut` 全部不启动，浮窗也不预热。恢复时把开关改 true 并补回设置入口。**恢复后的设计 = 选区/复制即触发**（其他应用也能用）：Windows 优先 `WindowsSelectionCapture`：PowerShell 常驻进程轮询鼠标左键，拖选（位移 >6px）或双击后沿鼠标点父链查 UIAutomation TextPattern 选区，直接读文本（不读写剪贴板、不模拟按键；UIAutomationClient 是系统程序集，不需要额外 DLL；实现取舍对齐 Magpie 的 WH_MOUSE_LL + UIAutomationCore，但用轮询代替低级钩子）；读不到时由 `ClipboardSelectionWatcher` 轮询剪贴板兜底，变化即把文本交给 `SelectionToolService.showText`，在光标附近只弹出折叠操作栏（不自动调用模型）；点「翻译/问答」后才展开结果并请求智能体；Windows 原生捕获触发时 `suppressFor(2500)` 抑制复制兜底；`systemSelectionEnabled` 控制 start/stop，**自己的任一窗口有焦点时跳过**（应用内复制/浮窗自己复制不重复弹），取词模拟复制期间 `suppressFor(2500)` 抑制哨兵与恢复内容；空/过短忽略、超长按 `SELECTION_TOOL_TEXT_MAX_CHARS` 截断。**快捷键是备用入口**：`shared/shortcuts.ts` 的 `openSelectionTool`（默认 Ctrl/Cmd+Shift+X）仍是唯一 `globalShortcut` 注册，`syncSelectionToolShortcut()` 在启动、设置保存、市场设置变更时同步——关开关立即注销、改键先释放旧键。**注册失败必须可见**：`SelectionToolWindowState` 带 `shortcutRegistered/shortcut`，设置页在系统级开关下显示占用警告且说明复制触发不受影响；主进程同时发一次 toast，并在 `browser-window-focus` 时重试（dev 与安装版同时跑时，后启动者会因快捷键被先启动者占用而失败——实测日志里的 `Global shortcut registration rejected: Ctrl+Shift+X`）。快捷键取词 `systemSelectionReader.ts`：保存剪贴板 → 写唯一哨兵 → 平台模拟复制（win32 CUA SendInput / macOS osascript / Linux X11 xdotool）→ 轮询 → 恢复；失败返回 structured reason 绝不抛。浮窗 `SelectionToolWindow`（折叠 360×46 / 展开 440×280，无边框透明置顶、独立 `selection-tool.html`、复用主 preload）等加载完成再推 `selection-tool:captured`；`showInactive` 不抢目标应用焦点，未点击时 30s 自动收起，点击获得焦点后失焦即藏；展开/折叠经 `selection-tool:resize` 调整窗口并夹回工作区。**视觉对齐应用内划词/Magpie**：折叠态一条 360px 操作栏只留智能体 / 翻译·问答 / 关闭，展开后才出现目标语言与复制·发送；正文只留原文引用与结果，不再有一排语言 chip、嵌套表单和「开始」按钮；「发送到 PiDeck」经 `selection-tool:insert-to-main` 插入主窗口当前会话输入框。macOS 原生选中捕获需要 CGEventTap + Accessibility（AX）helper 与「辅助功能/输入监控」授权（Magpie `macos.rs` 的做法）；当前未内置该 helper，macOS 仍走复制触发与快捷键兜底。
- i18n：文案键分 `agentMarket.*` / `agentInvoke.*` / `selectionTool.*` / `settings.selectionTool.*` 四组，zh-CN + en-US 同步、改完跑 `node scripts/genZhTwCopy.mjs`（生成物禁止手改）。



## 会话 Markdown 渲染管线（MarkdownStream / streamdown 唯一引擎）

- 唯一引擎是 `src/renderer/src/components/session/MarkdownStream.tsx`（streamdown 2.x + gfm/codeMeta/remarkLinkifyPaths）。公告详情、diff 预览、便签等静态 markdown 场景复用同一套管线（公告走 light 模式），**禁止再引一套 marked/react-markdown**，也禁止 `dangerouslySetInnerHTML` 绕过 sanitize。
- **流式与 settle 是两条渲染路径**：流式期间不跑 remark 插件（`NO_STREAM_REMARK_PLUGINS`），只做 marked 核心解析；`isStreaming` 转 false 后先保持轻量渲染，`requestIdleCallback` 空闲才切全量（高亮/mermaid/表格）。所以在流式输出里看不到的问题，很可能在 settle 后才暴露——**复现问题要看最终态，别只盯流式过程**。
- **mdast 插件用「临时属性 + 父节点整体替换 children」协议时，必须补回 `last → text.length` 的尾段**。`MarkdownLinkCore.ts` 的 `remarkLinkifyPaths` 把裸路径文本节点拆成 `[text, link, …]` 写进 `node.__segs`，父节点随后整体替换原文本节点；漏掉尾段，路径之后的全部正文（含 mdast 里同一 text 节点携带的换行后续行）会整段消失——用户看到的现象是「/ 后面的文本不显示、后一行整行不见」。
- **事故教训（2026-09-23，用户报「斜杠后文本不显示」）**：尾段回填在 `fb6b5667`（feat(markdown): 文件链接存在性校验，失效路径降级纯文本）把 `while` 改成 `for-of` 时被丢掉；表格 cell / API 路径场景下一个 text 节点几乎必以路径结尾，而日常只在段中命中路径，样例永远测不出来。用真实会话 jsonl 实测：91 条回复 47 条丢文本。判据是解析产物可见文本与原文一致，而不是「链接能点」。
- **HTML 净化只有一条路：`components/session/markdownSanitize.ts` 的 `UNTRUSTED_MARKDOWN_REHYPE_PLUGINS`**（raw → 摘危险子树 → `rehype-sanitize` 白名单）。会话正文与文件预览（`FileDiffViewer`）都挂这一份，**新增 HTML 能力 = 同时改白名单 + `tests/markdownHtmlSanitize.test.mjs`**；不要给 MarkdownStream 传只含 `raw` 的插件数组。
- **事故（2026-10，issue #397）：只挂 `rehype-raw` 不挂 sanitize 会把模型输出的 HTML 原样注入应用 DOM**。AI 画图/写 HTML 常带 `<style>svg{width:100%}</style>`，style 元素一进 DOM 就是全局 CSS——标题栏与时间线所有 lucide 图标一起被放大，**切到别的会话（消息卸载）才恢复**；同一条路径还放行了 `<iframe>`、`onerror=`、`javascript:` 链接。「切换会话就自愈」这类现象先怀疑消息内的全局 CSS。
- **sanitize schema 的三处本应用定制**（改之前先读注释）：① `href` 放行 `tel`/`file`/`pideck-file`；② `src` **不做**协议白名单——本地图地址（`C:\x.png`、`./out/a.png`、`pideck-file:`）要先经 `resolveMarkdownImageSrc`，按 http(s) 过滤会把本地图全清空；③ 内联 SVG 只放行几何/描边属性（`SVG_TAGS` + `SVG_ATTRIBUTES`），不含 `<style>`/`<image>`/`<foreignObject>`/事件属性。
- **`harden` 故意不启用**：它会把被拦的链接/图片替换成英文「[blocked]」文案并重写树，`pideck-file:` 本地图与 `file://` 本地链接会被一起打死；URL 安全由 `markdownUrlTransform` / `resolveMarkdownImageSrc` 统一负责。KaTeX / mermaid 的 rehype 产物在 sanitize **之后**生成，扩展插件要追加在净化序列尾部（见 `FileDiffViewer` 的 `rehypeKatex`）。
- **不要用 HTML 属性给自定义组件传上下文**（用 React context）：非白名单属性会被 sanitize 静默剥掉（2026-10-20 实测 `{src, alt, data-md-image-count}` 只剩 `{alt}`）；`src` 现在免协议校验，但新增 `data-*` 仍要先进 schema 才留得住。
- **回归测试必须跑真实层级**：表格行（cell 内 text）、跨换行正文（`\n` 之后仍是同一个 text 节点）、inline code `__fileLink` 分支、路径正好在末尾（不留空 text 节点）。写法见 `tests/markdownPathTailTruncation.test.mjs`（unified + remark-parse 二次解析对比可见文本，不依赖 cwd/真实项目）。
- **考古别只看最近几笔提交**：渲染丢文本这类回归可能潜伏数周，用 `git log --oneline -- <文件>` / `git log -S <片段>` 回到底，确认是「谁引入、为什么当时测不出」，再把这两件事写进注释与测试。

## 用户消息 chip 与自包含块（引用 / 会话 / 技能 / 提示词模板 / 文件）

- **完整账本**：谁在展开（pi / DSH / PiDeck 的所有权矩阵）、与上游的对齐清单与「有意不同」的理由、已知缺口台账，见 `docs/chip-rendering-refactor-plan.md` §10–§12。本节只放每次改代码前必须知道的硬约束。
- **一条契约**：需要折叠成 chip 的东西，**落盘文本必须自带展示身份**（`<quoted_context label message_id>` / `<referenced_session name>` / `<skill name>` / `<prompt_template name>`）。展示侧只认块（`src/shared/expandedRefBlocks.ts`）与裸 token（`composer/chips.ts`）两种形态，不做「按正文反查名称」；旧消息没有块就显示全文，这是有意的兼容策略。
- **保护区规则（2026-10 实测 bug 的结论）**：发送侧有三个展开器（引用 → 会话引用 → 提示词模板）。后一个不得改写前一个已生成的块，否则「引用里提到 `/commit`」会被替换成整份提交模板——落盘的引用原文被篡改，模型读到的历史与真实不符。判据集中在 `src/renderer/src/utils/protectedText.ts`（`computeProtectedRanges` / `replaceOutsideProtected`）。
- **模板清单两个来源**：来源 A = `prompts:list`（`~/.pi/agent/prompts` + `<项目>/.pi/prompts`，带编辑元数据、离线可用）；来源 B = pi `get_commands` 的 `source: "prompt"` 条目 + 按 `sourceInfo.path` 读回的正文（覆盖 npm 包声明的 `pi.prompts`，例如 pi-subagents 的 `parallel-review`）。合并规则在 `src/renderer/src/utils/templateCatalog.ts`：**同名正文取 B**（B 是 pi 去重后的最终视图），A 的展示元数据保留。只缺 B 时 `/parallel-review` 会被原样发给 pi、由 pi 展开成无名字的正文，表现为「运行中有 chip、暂停/重载后整段展开」。
- **参数既进正文、也要在块外留一份**：模板用 `$@`/`$1` 时，参数要按 pi 原位替换进正文（模型看到的形状与 pi 一致）；但整段正文会被折成 chip，所以**块外必须再追加一份用户原文**，否则用户发完看不到自己写的话（2026-10-21 实测）。没有占位符的模板本来就追加在块外（pi 在那种情况下会直接丢掉用户输入，PiDeck 不丢）。占位符目前只集中在包带模板（pi-subagents 6 个全是 `$@`），PiDeck 内置模板不用占位符。
- **frontmatter 剥离照抄 pi**（`utils/frontmatter.ts`，对齐 `dist/utils/frontmatter.js`）：先 `stripBom` + 换行归一（`
` 与裸 `
` 都变 `
`）→ 从下标 3 找**第一个** `
---` 作结束标记（所以 `--- ` 带尾空格也能剥）→ 正文 `trim()`。**三条缺一条就漏**：Windows 编辑器存的模板常带 BOM 或裸 `
`，旧正则直接匹配失败，`---
description: …
---` 就漏进消息（2026-10 实测）。「一键插入全文」走 `stripMarkdownFrontmatter`，保留文件原换行风格（CRLF 还是 CRLF），只额外容忍 BOM 与结束标记尾空格。
- **模板参数替换照抄 pi**：`utils/templateArgs.ts` 逐条移植 pi 的 `parseCommandArgs` / `substituteArgs`（`$1` `$@` `$ARGUMENTS` `${N:-默认}` `${@:-默认}` `${@:N}` `${@:N:L}`；bash 切词支持引号；只替换模板串、参数内容不二次展开）。pi 的语义是「参数只进占位符，模板没占位符就丢弃用户输入」，PiDeck 保留一层兜底：**模板没有占位符时把用户输入追加在块后**（绝不丢字），有占位符时按 pi 把参数放进正文且不再追加。参数区间以「下一个命令 / 引用块起点 / 消息末尾」为界，不会吞掉相邻命令或引用块。
- **两个后端的斜杠语义不同，展开责任也不同**（2026-10-20 调研确认）：
  - **pi**：`prompt()` 里 `_tryExecuteExtensionCommand`（扩展命令）→ `_expandSkillCommand`（`/skill:名`）→ `expandPromptTemplate`（`/模板名`，要求消息以 `/` 开头）。pi **会自己展开模板**，但只存正文、不留名字。
  - **DSH**：只有一条 slash 桥（`src/main/dsh/hostEntry.ts` 生成的 `pideck-slash-bridge.js`，挂 `agent/pre-step`）：消息以 `/` 开头 → `ctx.commands.execute`；命中命令则 reject（消息不进模型），未命中则原样当普通消息。**DSH 没有任何模板展开，也没有命令元数据字段**（用户消息只有 content 文本块 + `source.kind`）。所以 DSH 上 `/模板名` 的展开**只能由 PiDeck 做**——否则命令要么被 host 执行、要么以字面量喂给模型。
  - 因此展开前必须避让「后端已接管的命令」：`utils/reservedCommandNames.ts` 把 `source !== "prompt" && source !== "builtin"` 的命令名（pi 的 extension/skill、DSH 的 host 命令、ACP 命令）列为保留集，`expandPromptTemplates` 命中即原样保留。`builtin` 不保留：桌面内置命令由 `classifyComposerSlashCommand` 接管，未接管的本来就只是文本，否则用户建 `/export` 模板会失效。
- **DSH 的 `/goal` 语义（读官方实现，不改）**：`packages/goal/command-goal` 把 objective 存进 goal 域（`ctx.goals.create`），命令本身不产生模型消息；之后**每一轮**由 `goal-round-driver` 发一条新的用户消息 `<goal_round>Objective: "…" Round: n/N …</goal_round>`，带 `source: { kind: "goal" }`。PiDeck 的投影器只认 `source.kind === "user"`（`dshEventProjector.ts` 的 `user/message` 分支），所以目标轮次**不进时间线**。结论：目标文本每轮重复是 DSH 的设计，若目标里含模板正文就随轮次重复——**属后端语义，PiDeck 不改**（不跳过 `/goal` 包装、不拆分消息），chip 只负责把所见文本渲染成标签。
- **同名模板以项目为准（照抄 pi 的规则，不是自创）**：pi 的资源路径按 `resourcePrecedenceRank` 升序加载——project = 0 < user/global = 2 < package = 4 < builtin = 5，`dedupePrompts` 按名字去重且**先加载者胜**；被禁用的模板根本不会被加载。`assembleTemplates`（`utils/templateCatalog.ts`）复刻这三条：先剔除 `enabled === false`（项目禁用 → 回落到全局那份，而不是直接消失）→ 项目在前全局在后 → 按名去重留第一个。以前是「数组最后一个胜」的隐式约定，既与 pi 相反，也靠顺序巧合才碰对。
- **已知缺口（记账，未修）：DSH 的技能可能被同名提示词模板抢走**。DSH 的技能不是命令表里的命令，而是扫用户消息里的 `(^|\s)/名字` 手势（`dsh` 的 `tool-skill` 里 `SKILL_GESTURE`），而 PiDeck 的保留集只收 DSH 的**命令**名。若同一项目里既有 DSH 技能 `cv-writer`、又有同名 PiDeck 模板，`/cv-writer` 会被本地展开成块 → DSH 看不到手势 → 技能静默不执行。**为什么先不修**：PiDeck 的技能清单（`~/.pi/agent/skills` + `~/.agents/skills`）与 DSH 的不同源（DSH 还有 `~/.dsh/skills`、项目 `.dsh/skills`），直接拿去当保留集会两头错——漏掉 DSH 独有技能、又误占只属于 pi 的技能名。要做对需先给 DSH 加一个技能清单桥（照 `pideckCommandsBridge` 的形态），再只对 DSH 会话使用真实清单。
- **保留名的副作用（须知）**：后端命令优先意味着**同名提示词模板永远不展开**。例如装了本仓库内置扩展时 `/plan` `/goal` `/todo` `/todos` `/reload` 归扩展所有；DSH 会话里 `/permission` `/plan` `/compact` `/help` `/goal` `/subagent` `/feedback` 归 host 所有。想用同名模板只能改名或停用对应扩展。
- **补拉只针对「可能存在的模板」**：`needsTemplateRefetch`（同文件）返回 false 的三种情况——不是 `/名称`、当前表里已有、名字属于保留集（保留名永远不会出现在模板表里，否则每发一次 `/permission` 都白跑三趟 IPC）。
- **DSH 的命令表此前拿不到**：`DshAgentManager` 只实现了 `listCommands`，但网关按能力名调 `getCommands` → `TypeError` → 命令白名单恒空（历史 `/命令` 不出 chip、`/` 菜单只剩静态建议）。已补同名别名，并在 `tests/dshAgentManager.test.mjs` 加了「声明即实现」断言。
- **模板正文由主进程读**（`src/main/prompts/runtimeTemplateBodies.ts`，IPC `sessions:runtime-prompt-templates`）：只读 `get_commands` 报出的路径（provenance 白名单），再校验绝对路径 / `.md` / 单份 ≤256KB，任一不满足就跳过该条并退回「交给 pi 展开」。禁止改成自己扫目录——pi 的模板来源含设置启用状态与包声明，重扫一份必然错位。
- **两个展开入口都要补模板表**：直发走 `prepareMessage`，忙碌队列（steer/followUp）在**入队时**就展开（更早，不经 prepareMessage）。两处都要 `ensureTemplates`，且都必须 fail-open（补齐失败只影响「能否本地展开」，不能把消息卡住不发）。漏掉队列入口的现象：agent 收尾那一拍发 `/模板名`，原样入队 → flush 发 pi → chip 丢失（2026-10 e2e 间歇复现）。
- **发送期读取用 ref 不用 state**：`useSessionSend` 的模板清单是 `getTemplates()` 回调（`templatesRef` 由 `loadTemplates` 同步写入 + 写入序号防旧结果覆盖）。用 state 快照会出现「打开会话立刻发 `/模板名` → 展开器认不出 → 退回 pi 展开」。
- **草稿会话也能出 chip**：草稿还没有 runtime target，`loadTemplates` 走 `sessions:draft-prompt-templates`（复用 standby 池的命令预览借用，见 `AgentManager.draftCommands`）拿同一份正文；池关闭/未就绪时返回 null，退回 `prompts:list`（旧行为）。这条是「打开会话立刻发 `/模板名` 也能出 chip」的兜底，失败不影响发送。
- **相邻命令**：`/a /b` 两条都要展开。单次 `String.replace` 会吃掉 `/a` 后的分隔符，让紧邻的 `/b` 失去 `(^|\s)` 前缀；`expandPromptTemplates` 因此循环替换到稳定（上限 8 轮）。块内文本受保护区约束，不会重复展开。
- **块的 `kind` = pi 的资源类型**：`quote` / `session` / `skill` / `template` 四种，模板不再冒充技能（pi 自己就把 `source: "skill"` 与 `source: "prompt"` 分开）。展示层用 `visualKind` 映射复用同一套斜杠 chip 外观，`data-type` 保留真实类型——按类型写样式/测试时认 `data-type`，不要按 class 猜。
- **扩展注册的命令**（`/plan`、第三方 `/xxx`）由 pi 执行且**不落盘任何消息**（`_tryExecuteExtensionCommand` 执行后早退），所以它们只有临时气泡，不做持久 chip；桌面接管命令（`/new` `/login` `/hotkeys` `/reload` `/compact`）由 `utils/composerSlashCommand.ts` 单一分类点拦截，不发给模型。

## 推送与 AtomGit 镜像（pre-push 钩子）

- `.githooks/pre-push`（`core.hooksPath=.githooks`，`npm install` 的 prepare 会安装）会把本次推送的引用镜像到 AtomGit；默认尽力而为，失败只提示不阻断，`PI_DECK_ATOMGIT_STRICT=1` 才让镜像失败即推送失败。
- **无凭据的非交互环境（CI、agent 会话）里，镜像步骤会让随后的 GitHub 主推送失败**：`Connection to github.com closed by remote host` / `fatal: unable to write flush packet: Broken pipe`（2026-10-19 连续三次必现，跳过镜像即成功）。绕过：`PI_DECK_SKIP_ATOMGIT=1 git push origin dev`；新设备首次镜像需在交互终端完成一次 AtomGit 授权。
- 判据：`git ls-remote origin dev` 正常但 `git push` 报 broken pipe ⇒ 先怀疑镜像钩子，不要当网络问题反复重试。

## 对话内图片渲染（Markdown img / 本地路径 / 协议取舍）

- **现状（未改造）**：`MarkdownStream` 的 `components` 只覆盖了 `a`，`img` 走 streamdown 默认渲染；样式只有 `.markdown-body img{max-width:100%;border-radius}`。缺懒加载、限高、点击放大（生图消息有预览浮层，可复用）、加载失败兜底、多图并排——要并排只能把图物理缩成小图再一行引用。
- **URL 白名单**：`markdownUrlTransform` 放行 `file://` 与 http(s)，`data:` 被 `defaultUrlTransform` 清空 ⇒ **不能内联 base64**，本地图必须先落盘成文件。`![](C:\a.png)` 这类盘符写法被当作「本地路径」原样塞进 `src`（`C:` 被 Chromium 当 scheme）⇒ 静默破图；只有 `file:///C:/...` 成立。
- **dev 态直接不可用**：dev 渲染层页源是 `http://localhost`，Chromium 拒绝 `file://` 子资源 ⇒ 同一段 Markdown 在 dev 里是白图、打包版才显示。改这块必须同时验 dev 与打包两种加载方式。
- **取舍结论（2026-10 讨论，暂不实现）**：①不做「消息内 ref 存储」——那等于改会话格式与跨层契约，收益不匹配；②优先「协议直读」：新增只读协议服务白名单根目录，替换裸 `file://`；③「渲染期复制缓存 + LRU」只在「temp 被清后历史白图」成为真实抱怨时再加，且只能以**缓存**身份存在（可淘汰、可回源），不做权威存储。
- **白名单根**：项目目录 + `<userData>` + **桌面** + **专属 temp 子目录**（如 `<tmp>/pideck-shots`），不放行整个 `%TEMP%`（临时解压/安装器写入的图不可信，且 temp 随时被清理）。桌面必须用 `app.getPath("desktop")`（跟随 OneDrive/自定义重定向，别拼 `home/Desktop`）：2026-10-21 实测会话里 `~/Desktop/PiDeck-Settings-*/x.png` 全被判 403、降级成「图片加载失败 · 路径」——人和 agent 最常把截图/设计稿放桌面。协议必须做路径规范化 + 逃逸检查，与 `webSecurity: true` 下的既有文件读取口径一致。
- **路径规范化要与协议同步做**：盘符/绝对路径按本地路径处理、相对路径按会话 cwd 解析，否则模型默认写法（`C:\…`、`./out/chart.png`）仍然破图。失败兜底 UI 至少给 alt + 原路径 + 可点击打开，比任何视觉打磨都省排查时间。
- **工具结果里的 image block 目前不可见**：交互动线只渲染类别文案「已读取图片」（`src/renderer/src/components/session/timeline/toolCategory.ts`），主进程 `AgentManager` 的 `formatToolDetail` / `extractToolResultText` 只产出文本；assistant 消息里的 image block 在 `src/main/pi/messageContent.ts` 的 `extractMessageText` 被 `if (type === "image") continue` 丢弃。做可视化等于改工具投影契约（消息带 `images` 或写 blob 存 ref），**单独立 issue**，别混进渲染层改动。
- **边界**：PiDeck 不提供「截图/贴图到会话」的工具 API——agent 行为归 pi；PiDeck 的职责只有「任何指向本地图片的 Markdown 都能稳定渲染」。
- **已落地（2026-10，阶段 1+2）**：本地图不再走裸 `file://`，统一 `pideck-file://local/?path=<绝对路径>`（`src/shared/localImage.ts` 是线格式唯一来源）。白名单根 = userData + 桌面 + `<tmp>/pideck-shots` + 聊天工作区 + 全部项目路径；**realpath 后复检**（防符号链接逃逸）、≤32MiB、`no-store` + `nosniff` + CSP sandbox，判定在 `src/main/media/localImageAccess.ts`（纯函数、可单测）。不要退回 `file://`：dev 页源是 `http://localhost`，Chromium 直接拒 `file://` 子资源，等于同一段 Markdown 在 dev 白图。
- **渲染侧硬约束**：Markdown 图片唯一入口是 `MarkdownImage`（`MarkdownStream` 的 `components.img` 注入）——单图 `block` + `max-width:min(100%,640px)` + `max-height:360px`；同段 ≥2 张切 96px 瓷砖（张数由 `p` 组件数出来经 context 下发，**不要改回 HTML 属性**：`rehype-sanitize` 会剥掉非白名单属性）；懒加载、点击放大、失败降级成「失败文案 · alt/原路径」+ 重试，**任何分支都不得产出空 `src` 的白图**。图片动作（复制/保存）走 `MarkdownImageActions`（`fetch(src)` 取字节，**CSP `connect-src` 必须含 `pideck-file:`**，否则本地图保存无反应）。预览浮层唯一实现是 `ImageLightbox`（`ImagePreviewModal` 只剩“注入复制/保存动作条”的薄壳，Markdown 图与附件图共用）。`remarkRecoverLocalImages` 只在「段落仅一个未转义 text 节点 + `/`、`./`、盘符前缀 + 图片扩展名 + 路径含空格」时动手，放宽它会改写正文里的语法示例。
- **两个真机坑（2026-10-19 dev 实例 smoke 暴露，单测看不见）**：① Windows `app.getPath("temp")` 返回 **8.3 短名**（`C:\Users\ADMINI~1\…`），消息里是长名 → 白名单比较字面不等，白名单内的图全判 403；必须用 `realpath.native`（`main/media/nativeRealpath.ts`），**普通 `fs.realpath` 不展开中间段短名**。② `mdast-util-to-hast` 把反斜杠编码成 `%5C`（`C:\Users\a` → `C:%5CUsers%5Ca`），图片目标必须先百分号解码再判盘符/协议，否则被当未知协议丢弃、图静默变 alt。**测试要喂 hast 形态的 src**，只测 mdast url 会漏掉这两层。
- **后续计划**：阶段 3（工具结果 image block 可视化）**探针已完成**（2026-10-19）：pi 的 `toolResult.content` 确实带 `{type:"image", data:<base64>, mimeType}`，且 base64 直接内联写进 pi 的会话文件 ⇒ 可行；但当前决定**只记账不实施**。真要做时：main 侧读时投影成 blob ref（**不把 base64 塞进消息对象、不改写 pi 会话文件**），约束与范围见 `docs/markdown-image-rendering-plan.md` 阶段 3。设计参照 dsh 的“双通道”（进会话的图入库做 ref，被引用的图借看）；白名单与上限是 PiDeck 自建（dsh 靠 fs sandbox，PiDeck 没有那一层）。

## 自定义主题包（userData/custom-themes + shared/customThemes）

- 单一事实源是 `src/shared/customThemes.ts`：token 白名单（`CUSTOM_THEME_TOKEN_GROUPS`，来自 foundation.css 语义 token 人工梳理）、id/颜色值校验、`DEMO_CUSTOM_THEME`、`CUSTOM_THEME_TEMPLATE` 全在这；主进程保存/目录扫描、渲染层编辑器提示、AI 指南（`customThemeGuide.ts` 生成的表格与示例）都从这里取数。**改 foundation token 命名或新增 token 时三处同步：foundation.css、白名单、指南测试断言**（`tests/customThemes.test.mjs` 会校验白名单全量 token 都出现在指南里）。
- 用户 JSON 是不可信输入，两道闸都不可放宽：键必须在白名单内；值必须匹配静态颜色正则（`#hex` 或纯数值参数的 `rgb()/hsl()/oklch()`），天然排除 `var()/url()/渐变`（值最终只进 inline style，双保险）。坏文件不致命：目录扫描降级为 `parseError` 条目呈现。
- 设置快照 `settings.customTheme`（无前缀键，亮暗双档）在 `SettingsStore.update` 里过 `sanitizeCustomThemeSnapshot`；**快照仅 `themeSkin === "custom"` 时生效**（`applyCustomThemeTokens` 守卫），切回内置皮肤的路径（AppearanceThemePicker onPick）必须同步 `customTheme: undefined`，否则残留快照压过内置皮肤。注入函数是 App 持久化应用（useAppAppearance）与设置弹窗预览/回滚（SettingsModal）共用入口，别复制第二份注入逻辑。
- 内置示例 `DEMO_CUSTOM_THEME` 是常量不上磁盘：列表由它推导（校验不过就不上架，防常量与校验器漂移）；其 id 保留（`saveCustomTheme` 拒绝同名保存，否则列表里会出现两张同名卡片），「复制为新主题」靠字符串改写 id 生成副本。读写删一律以 **fileId（文件名去 `.json`）** 定位文件，不用包内 id：用户文件可以改名、可以与内置示例同 id（历史 bug：按内置 id 早退 → 界面提示「已删除」而文件仍在）。删除走 `trashPath` 回收站，文件不存在时报错不谎报成功；主题文件被删后已应用主题不失效（快照内嵌设置文件）。

## 宿主插件（userData/host-plugins：独立于 pi 进程的 PiDeck 原生插件）

- **与 pi 扩展是两套系统**：pi 扩展（`resources/extensions/`，`-e` 注入）活在 pi 进程里管 Agent 行为；宿主插件是 PiDeck 自己的插件——面板是渲染层创建的页面内 `<webview>`（partition `host-plugin:<instanceId>`，与内置浏览器同层叠模型，可被弹层正常覆盖），由主进程 `HostPluginViewHost` 签发实例、经窗口 attach 策略（`hostPluginWebviewPolicy`）校验后加载 `userData/host-plugins/<id>/` 资产，不经 pi、不走 pi 的扩展点。代码全部在 `src/main/plugins/`（Broker/Manager/Service/Sessions/Storage/ViewHost + policy/manifest/files/archive/webviewPolicy）。IPC 通道集中在 `shared/ipc.ts` 的 `host-plugins:*` 一组。
- **授权看内容指纹不看版本**：manifest 权限白名单是注册表式的，插件目录内容 sha256 指纹变化 → 旧授权立即失效需重新授权——这是安全特性，**禁止放宽为版本号比较或沿用旧授权**。storage rename 等敏感操作在 `beforeAttempt` 每次尝试前复查授权。
- **网络不解除页面沙箱**：`network.https` + `network.httpsOrigins` / `network.local` + `network.localPorts` 经 `HostPluginNetwork` 代发；CSP `connect-src 'none'` 与页面 webRequest 包内资产门禁保持不变。HTTPS 每跳检查精确 origin、DNS 全结果公网且 socket 固定已验证 IP；本地只收 `http://127.0.0.1:<已授权端口>`。授权 UI 必须显示具体目的地并提示「会话读取 + 联网」的数据外发风险。**`network.local` 仍然不启动任何进程**（只访问已运行的服务）；启停进程是另一个权限 `service.local`（见下条）。Broker 的 binding 撤销必须同步 abort，在 guest 已销毁时 ViewHost 也要 unbind，不能只丢弃迟到结果。守卫：`tests/hostPluginNetwork{,Transport,Ui,Demo}.test.mjs`；可导入示例：`docs/examples/host-plugins/example.network/`。
- **服务控制只给「点名权」（`service.local` + `manifest.services`）**：插件能提供的只有 service id，命令名/参数/端口全部是 `src/main/localServices/` 适配器里的常量（`localServiceCli.ts` 对命令与每个参数做字符白名单，Windows `.cmd` 垫片走 `cmd.exe /d /s /c` + `windowsVerbatimArguments`，**不拼字符串 shell**），id 必须在 `src/shared/localServices.ts` 白名单里，否则 manifest 校验直接拒（`invalid-services`）。当前唯一适配器是 billion-context（`bili doctor --json` 读状态/端口，`bili start` 起进程，停止按报告 pid 终止——它没有 stop 子命令，而且 pi lane 的代理由 pi 自己的扩展 respawn，杀掉后约 2 秒就换新 pid 回来：这种情况适配器返回 `stop-restarted` 而不是假装停成功）。两条硬约束：**pid 只能来自 CLI 报告**（不按名字杀、不猜）；**UI 地址只接受 `http://127.0.0.1|localhost:<port>`**（防报告被改写成公网地址把内置浏览器带走）。「打开面板」不经插件：Broker 转 `onOpenBrowser` sink → `hostPluginOpenBrowser` IPC → 渲染层内置浏览器抽屉（插件页 `frame-src 'none'`，本来就内嵌不了这类 SPA）。内置示例 `resources/host-plugins/billion-context/` 由 `HostPluginManager.seedBuiltin()` 在 `load()` 前落位到 `userData/host-plugins/`：目录不存在 → 复制；内容仍等于上次落位指纹（用户没动过）→ 用新版替换；其余 → **永不覆盖**（`seeded` 记录存在 `host-plugin-state.json`；旧状态文件没这个字段，那种情形只能用一次 `manifest.version` 当第二线索：版本不同 ⇒ 来自另一个 PiDeck 版本的内置载荷，替换并顺延授权，写过一次 `seeded` 后该分支永久失效）。只有「上一版内置内容」升级时授权顺延，避免每次应用更新都要重新批准自己的内置示例；落位不等于授权。`remove(id)` 先撤权再删目录，`seeded` 里的 id 拒绝卸载（`plugin-builtin`，下次启动会被重新落位，删了只会让人以为卸载没生效），要停用请用禁用。**Windows 起进程本身另有一条硬约束**（2026-02 修「点启动弹黑框」）：长驻服务必须 `detached` 才能活过 PiDeck 退出（非 detached 子进程挂在 libuv 的 job 上，PiDeck 一退就被 `KILL_ON_JOB_CLOSE` 连坐杀掉，实测如此），但 detached 的**控制台子系统**子进程会被 Windows 新建控制台，而 `windowsHide` 对「新建的」控制台不生效——直接 `cmd.exe /d /s /c bili start` 就是那个黑框。所以 win32 的直接子进程换成 GUI 子系统的 app 自身二进制（`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + `-e` 注入 `LOCAL_SERVICE_LAUNCHER_PROGRAM`，见 `localServiceCli.ts`）：GUI 进程不带控制台也不新建窗口，它再以 `windowsHide` 拉起 CLI，CLI 与孙进程（bili 里的 node 代理）继承「无窗口的可继承控制台」，全程不出现窗口。启动器必须**与 CLI 同生共死**（不能 `unref` 后先撤：CLI 落在启动器自己的 job 上，启动器一退就一起死），代价是服务存活期间多一个空转的 electron 进程（实测工作集 ≈40MB）；非 Windows 仍直接 detached。守卫：`tests/hostPluginLocalService.test.mjs`。
- **历史读取有硬预算**：`HostPluginSessions` 单次请求 64MiB/10 万条上限，超限抛 `history-too-large`，不退化为全量扫描；目录索引用 changeSince 签名对比做粒度推送（活跃会话追加报 `{ sessionId }`，目录级变化报 `{ catalogChanged: true }`），面板侧定向失效、epoch 不打断其他在途读取。
- **`.pideck-plugin` 归档是 NDJSON**（header 行 + 每文件一行 base64+sha256+size）：上限归档 24MiB / 单文件 4MiB / 100 文件 / 展开 16MiB，逐文件 sha256 校验，超限抛稳定错误码。选 NDJSON 而非 zip 是因为 Node 运行时无内置 zip 解压。
- **主题跟随是全局驱动 + 每实例补充**：`prefers-color-scheme` 由应用既有的 `nativeTheme.themeSource` 驱动（改 PiDeck 主题即生效）；ViewHost 按当前主题对每实例 `insertCSS` 注入 `color-scheme`（适配原生控件/滚动条）。Electron 43 没有 per-contents `setEmulatedMedia`，不要再尝试。
- **参考实现 pi-context 是双向契约**：适配器 `resources/host-plugin-adapters/pi-context/`（bridge/data），转换器对 viewer 的 seam（DOM/字段名）有 fail-closed 契约测试——上游改字段名时测试必须红，红后同步适配器，不许放宽断言。
- 面向插件作者的文档单一数据源是 `docs/host-plugin-dev-guide.md`（官网指南页从它同步）；`tests/docsSharedGuide.test.mjs` 守卫两处不漂移。改 API 面（新增权限/方法/事件）必须同步五处：`shared/types/hostPlugin.ts` 契约 + `src/preload/hostPlugin.ts` 注入面 + dev-guide 的 API/错误码表 + `tests/hostPlugins.test.mjs` + 脚手架（`hostPluginScaffold.ts` + `config/hostPluginScaffoldDraft.ts` + `HostPluginPermissionDetails.tsx` 的权限清单）。
- **脚手架是权限真相的第一个消费者**：设置页「新建插件…」经 `host-plugins:scaffold` → `src/main/plugins/hostPluginScaffold.ts` 生成 `<id>/`（已存在则 `already-exists`，不覆盖作者代码）。生成物必须过与安装路径**同一套** `isHostPluginId`/`parseHostPluginManifest` 自检，且模板只生成已勾选权限对应的代码（manifest 的 `permissions` 与生成代码同一份真相）；改 API/权限面时漏同步它，作者拿到的示例一运行就 `permission-denied`。守卫：`tests/hostPluginScaffold.test.mjs`（含每种权限组合的 `new Function` 语法解析）、`tests/hostPluginDirectoryInstall.test.mjs`（「从文件夹安装…」）。
- **面板呈现三模式**（manifest `panels[].presentation`，缺省 `modal`）：`modal` 走 `HostPluginPanelHost` 大弹框；`popover` 在侧栏那一行旁边就地展开（`HostPluginDockButtons` 的 `Popover`，给 `HostPluginSurface` 一个定高 flex 列——它内部是 `flex-1`，非 flex 父级下 webview 高度会塌成 0），从无锚点入口（设置页/命令面板）进来时退化成小对话框；`page` 走 `HostPluginPageOverlay`——在 App 会话列外包一层 relative 容器，以 `absolute inset-0` 非模态覆盖层呈现，会话树不卸载（滚动/草稿/终端内存态保留），侧栏对 page 面板做开关切换（再点即关）。三者共用 `hostPluginPanelAtom` 同一入口，命令面板/设置页自动兼容。**抽屉 rail 的可见性过滤含 `|| action.active`**：不变式是「rail 永远显示当前活动面板」，否则只切内容不钉面板的外部入口（`service.openUi` 开内置浏览器、消息里的「在浏览器打开」）会出现「有页面没有归属 tab」。共享的加载/错误面在 `HostPluginSurface.tsx`。侧栏入口/图标/呈现方式的源码契约由 `tests/hostPluginSidebarEntry.test.mjs` 守卫，rail 由 `tests/workspaceDrawer.test.mjs` 守卫。
- **主题令牌**：`context.tokens` 把 PiDeck 语义色注入为页面 CSS 变量，`context.changed` 实时更新；converter 适配层把 pi-context 自己的 `:root` 中性色（`--bg/--card/--fg/--muted/--blue` 等）重映射到这些 token（后写覆盖，不改上游文件），图表系列色保留上游色板。新插件页面样式应消费 token 变量带缺省值，硬编码暗色在亮色主题下会露馅。

## dev 态渲染层缓存（Vite 预构建 chunk 的 immutable 陷阱）

- 现象：`npm run dev` 启动或打开资源弹层/编辑器时报 `Failed to fetch dynamically imported module: http://127.0.0.1:<port>/@fs/.../node_modules/.vite/deps/<chunk>.js?v=<hash>`。不是代码 bug，是渲染进程命中了上一轮预构建的旧模块。
- 机理：Vite 给 `.vite/deps` 打 `Cache-Control: max-age=31536000, immutable`，缓存键只有「URL + `?v=browserHash`」，而 browserHash 由 lockfile 与配置推导——重新预构建改变 chunk 切分时它可以不变。于是同一 URL 磁盘内容已换、Chromium 仍返回旧副本，旧副本 import 的 chunk 已被删除，Vite 回 504；又因为请求没出网络，Vite「504 → full-reload」的自愈路径也不会触发。
- 收口：`src/main/devRendererCache.ts` + `src/main/index.ts` 的 `createWindow`，仅在 dev（`shouldUseDevRendererUrl()`）加载 renderer 前 `await` 清一次默认 session 的 HTTP 缓存与 JS 编译缓存；清理失败只记日志，不挡窗口创建。打包态零影响。
- 逃生开关：`PIDECK_DEV_KEEP_HTTP_CACHE=1` 跳过清理（需要保留 dev 态登录态时）。手工排查用 `grep -rl <chunk后缀> node_modules/.vite/deps/_metadata.json` 与 `%APPDATA%/PiDeck-dev[-<branch>]/Cache/Cache_Data`：URL 里的 `?v=` 若与当前 metadata 的 browserHash 相同却找不到对应文件，即为陈旧缓存。
- 时序是契约：清理必须 `await` 在 `loadURL` 之前，写在之后等于没清。守卫见 `tests/devRendererCache.test.mjs`。

## 本地打包的 Electron 下载源（pack:dev / dist:* 走 npmmirror）

- 现象：`npm run pack:dev` / `dist:fast` / `dist:win` 在 `packaging platform=win32` 后直接 `⨯ connect ETIMEDOUT 20.205.243.166:443`（该 IP 是 github.com），退出码 1，`release-dev/` 只剩 `builder-effective-config.yaml`。
- 机理：Electron 二进制由 `@electron/get` 取，**zip 已在缓存也不等于离线可打包**——`validateArtifact` 每次都把 `SHASUMS256.txt` 以 `cacheMode: Bypass` 重新拉一遍（源码注释：Never use the cache for loading checksums），那一步同样走 github.com。国内直连 github.com 常只有 ~9KB/s，SHASUMS 请求超时 → retry 3 次 → ETIMEDOUT。CI 早已在 `.github/workflows/{release,build-dev}.yml` 的 win/linux 矩阵注入 `ELECTRON_MIRROR`，本地脚本此前没注入，于是只有本地踩坑。
- 收口：`scripts/electronBuilderEnv.js`（`electronBuilderEnv()`）统一补齐 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`，四个本地打包脚本（`pack-dev.js` / `dist-fast.js` / `dist-win.js` / `dist-dev.js`）的 `npx electron-builder` 调用必须传 `env:`。**已有配置优先**（含 `npm_config_*` 形态），显式设空字符串 = 走 GitHub 默认源（`mirrorVar` 用 `||` 取值，空串自动回落 BASE_URL），因此 CI 的 `ELECTRON_MIRROR: ""` 语义不变。
- 判定：`npm run pack:dev` 日志出现 `• downloaded electron zip extracted successfully` 即通；守卫 `tests/electronBuilderEnv.test.mjs` 同时断言解析语义与「每个脚本真的把 env 传给子进程」（漏传 = 静默退回 GitHub）。
- 手动逃生（不想改代码时）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron-builder --win --dir`；镜像目录形如 `/mirrors/electron/v43.4.0/`（带 `v`）。

## Tab 激活态语言（两种声明约定，2027-10 统一）

改任何 tab/导航激活态前先对号，不要发明第三种：

- **横向 tab 条（内容区切换）**＝下划线：`border-b-2 border-primary` + `text-primary`，shadcn `TabsTrigger variant="line"`（tabs.tsx）是唯一实现；集成浏览器 tab 条手写实现但对齐同一 token。分段条（`variant="default"`，bg-muted 容器+白底高亮）保留给页面/分组级切换，不与 line 混用。
- **纵向选择列表（侧栏/导航）**＝软填充：`bg-bg-active text-foreground`（SessionTree selectedRowClass 是参照实现），不用下划线、不用 raised card。
- **豁免**：终端 dock tab 走 `--terminal-*` 主题变量族（foundation.css 有声明注释），不套应用 chrome 语言。

## 繁体中文（zh-TW 四份词典 + locale 分支点）

- 繁体词典**不手写**：`scripts/genZhTwCopy.mjs` 用 opencc-js 的 s2twp 链路（整串分词，不是逐段换字）从 zh-CN 源生成四份产物——`src/renderer/src/i18n/rendererCopy.zh-TW.ts`、`src/shared/i18n/mainProcessCopy.zh-TW.ts`、`src/main/web/WebI18n.zh-TW.ts`、`src/main/feishu/FeishuI18n.zh-TW.ts`。每份带生成器标识头 + `source-sha256` 源指纹，**改 zh-CN 源后必须重跑**（漏跑先在 `npm run typecheck` 报 TS2739「缺少属性」——报错本身不提生成器，容易被当成自己写错了类型；随后 `tests/zhTwCopy.test.mjs` 的键集断言也会红并直接给出重跑命令。#336 / #338 两次实战都是先被 typecheck 拦下）。
- opencc-js 按项目惯例**不是**项目依赖（与 `scripts/generate-t2s-table.cjs` 同：运行时只带生成出来的常量表）：首次生成 `npm i --no-save opencc-js@1.4.2 && node scripts/genZhTwCopy.mjs`。**新鲜度有两道不需要 opencc 的门禁**（都在 `tests/zhTwCopy.test.mjs`）：键集断言（加/删键）与产物头部的 `source-sha256` 指纹——它是 zh-CN 词典区块（`startMarker`…`endMarker` 之间原文）的 sha256，由生成器写入、测试复算，因此「只改值不加键」也会报红。脚本自身的 `--check` 在无 opencc 时直接跳过，**不能当门禁**；产物清单与指纹算法在 `scripts/zhTwCopySources.mjs`（生成器与测试共用，新增第五份产物只改这一处）。脚本头部的 `OVERRIDES` 是分词误伤修正表（opencc 把「内置→內建」拆成「内置→內置」、「播放按钮」附近消出「撥」字这类），**只增改有实际误伤的条目**，别拿它当通用术语表。
- 语言分支点清单（新增语言/调整判定时一起改，否则某个进程会掉回简体）：`src/shared/types/settings.ts` 的 `AppLanguageMode` + `isTraditionalChineseLanguageTag`（简繁标签判定的唯一实现，其它进程都 import 它）→ `src/renderer/src/i18n.ts` 的 `resolveLocale` → `src/shared/i18n/mainProcessCopy.ts` 的 `normalizeMainProcessLocale` → `src/main/web/WebI18n.ts` 词典 + `src/main/web/WebServiceManager.ts` 注入脚本按浏览器语言分流（`zh-Hant` 也要认，客户端标签全是 `zh-TW`/`zh_CN` 形态）→ `src/main/feishu/FeishuI18n.ts` 的 `normalizeFeishuLocale`/`feishuLanguage`（飞书富文本 API 只认 zh/en，繁体沿用 `zh`）→ `src/main/floating/MiniOverlayWindow.ts` 的浮窗语言分支 → `CommonTab.tsx` 语言下拉。
- 加载 i18n 模块的测试**别手写 vm 沙箱**：`FeishuI18n.ts` 现在有运行时依赖（繁体词典 + 简繁判定），旧式 `vm.runInNewContext` 沙箱一加 import 就整片失败——用 `tests/helpers/createTsSandbox.mjs`（按源文件目录解析），桩注入见 `tests/feishuI18n.test.mjs`。

## ACP 会话链路（backend=acp 的第三方 CLI 接入）

> 硬边界：ACP 是与 pi 并列的会话后端（`src/main/acp/`），不走 pi SDK/RPC；协议字段以 Agent Client Protocol v1 为准，类型收口在 `src/main/acp/acpProtocol.ts`，禁止为兼容单一 CLI 把非标准字段写回出站协议。

- **wire 兼容红线**（都有针对性测试锁住，改前先看红名单）：initialize 必须 `protocolVersion:1` 且按 `agentCapabilities.loadSession` 决定恢复路径；`session/load` 返回 `result:{}` 合法（不带 sessionId）；权限应答必须嵌套 `{outcome:{outcome:"selected",optionId}}`/`{outcome:{outcome:"cancelled"}}`；配置写入是 `configId`（非 `id`）；`session/update` 通知按 `params.sessionId` 过滤，跨会话的 update 不得进时间线。工具/计划用标准 `tool_call_update` 局部补丁语义（省略字段保留旧值，content 是整表替换），`plan.entries` 整表替换 todos。入站键名宽容：`available_commands_update` 兼容 `commands`（规范 SDK）与 `availableCommands`（opencode 实测，2027-02 smoke 抓到）；非标准 `usage_update`（opencode/kimi 流传）投影进 runtime.state 上下文仪表（used/size/cost），缺失字段 last-wins 不抹旧值。
- **投影器（AcpEventProjector.ts，纯函数）**：一次 user_message_chunk 只携带一个 content block，同一 prompt 的多块必须并回同一条 user 消息；工具 content 里的图片块保进消息 `images`（随物化链落 ref），detailText 里只窗 `[image]` 占位；settle 时 `max_tokens`→stopReason `length`、`cancelled/aborted`→`aborted`，其余才是 error。工具卡 UI 目前不渲染 images（与 DSH 一致），但数据不许丢。
- **并发串行化**：manager 的 `updateChain`（投影→物化→flush）与 `configChain`（set_config_option 请求）都是按 runtime 串行的链——乱序响应会让迟到的旧整表回退 `runtime.configOptions` 并推过期通知，并发物化会用旧 messages 快照覆盖后到的新投影；动这两处前先读链上注释。
- **传输（AcpConnection.ts）**：超限大行走 parseQueue 异步解析，小帧也须入队保序（禁止小帧超车）；stdout EOF 在队列排空前不得关连接；stdin 同步写抛错要收敛成 close 而不是崩主进程。行上限检查是逐行的字节上限，不是整 chunk。
- **测试基建**：`tests/helpers/acpAgentHarness.mjs` 是内存 fake CLI（PassThrough 子进程 + 帧 handler，handler 返回 `undefined` 即不自动回包，可模拟乱序/延迟响应）；加载生产 TS 一律用 `tests/helpers/loadTsCommonJs.mjs`。ACP 回归集：`tests/acp{Connection,EventProjector,AgentManager,Compatibility,MessagePage,RuntimeLifecycle}.test.mjs` + `tests/useAcpSessionConfig.test.mjs`，改动后全跑。
- **忙碌投递收敛**：ACP v1 无 steer 通道（回合中 agent 只认 `session/cancel`），`resolveBusySendDelivery` 第三参 `backend==="acp"` 恒回 followUp（split 菜单 steer 项置 undefined 隐藏、队列行 steer 按 `steerSupported` 禁用、`useQueuedPrompt.flushQueuedSteerPrompts` 防御跳过）——忙碌直发只会被 `AcpAgentManager` 拒收成失败队列项。steer 项留给空闲 drain（空闲时 steer 语义≈直发）。
- **拒收/错误的本地化通道**：`SendPromptResult` 带 `I18nDescriptor`（`i18nKey`/`i18nParams`/`debugDetails`，渲染层 `translateI18nDescriptor` 消费）；激活**失败是 throw**，网关给 Error 挂同名描述符属性，coordinator 经 `shared/errorI18n.ts` 的 `descriptorFromThrownError` 透传。`localizeCreateFailure` 覆盖的场景：AUTH_REQUIRED(-32000)→`acp.authRequired`（create/prompt 两路）、spawn ENOENT→`acp.toolNotInstalled`（含完整命令行）、握手超时→`acp.startupTimeout`（deps.handshakeTimeoutMs 可注入）、工具被删/禁用→`acp.toolMissing`、turnBusy/processNotRunning/hostInstructionsUnsupported/imagesNotSupported；规则：换 i18nKey 必须同步验证主错误文案（`errorMessage(error)`）与 debugDetails，别吞掉根因。
- **冷会话恢复提示**：`SessionAcpRestoreStrip`（纯函数 `utils/acpSessionRestore.resolveAcpRestoreHint`，单测 tests/acpSessionRestore.test.mjs）挂在 `SessionStartSurface` widgets 顶层，只有「backend=acp + acpSessionId + 未激活」才显示；绑定工具被删降级为只读引导。composer 占位符对 ACP 会话用 `app.composerAcpPlaceholder`（工具名来源：激活后 runtime.modelName，草稿期 acpToolId 查表）。
- **图片能力门控**：`agentInfo.capabilities.promptImage` 来自 initialize 的 `promptCapabilities.image`；未声明时 `sendPrompt` 带图直接拒收（`acp.imagesNotSupported`），不然给不支持图的 agent 发 image 块只会换来整回合协议错误（acpCompatibility/acpRuntimeLifecycle 的物化用例显式声明 image=true）。
- 已知未做（勿宣称完整支持）：冷历史自动恢复（catalog 恢复依赖 AcpMessagePage 游标）、真实 CLI smoke（`scripts/acpLiveSmoke.mjs` 需真实 agent，不进 CI）、工具卡图片渲染、`authenticate` RPC（AUTH_REQUIRED 目前只引导用户去终端登录，未拉起 agent 声明的 `authMethods`）。

## Web 端流式链路（WebChatApp：/api/chat 一次性流 + /api/sessions/:id/stream 保活流）

> 硬边界：Web 只有一条流式协议（AI SDK UIMessageStream，响应头 `x-vercel-ai-ui-message-stream: v1`）。任何后端都必须先翻译成同一形状的 pi 事件再进 `PiEventToUiMessageStream`；禁止在翻译器或前端里按后端分叉。

- **两条连接语义相反**：`/api/chat`（useChat 一次性 fetch）非 keepAlive，finish 帧后必须补 `[DONE]` 并 `response.end()`，否则前端 status 永远停在 streaming；`/api/sessions/:id/stream`（外部流，页面可见且本页未发消息时订阅）keepAlive，finish 后换新适配器继续等下一轮，客户端在下一轮 `start` 帧上重置合并器。收尾统一走 `WebEventStreamRouter.emitFrames`（finish 帧后跟 `SSE_DONE`）。
- **事件源按后端分别注入**（`bindPiSource` / `bindChannelSource`）：pi 走 `deps.subscribePiEvents`；DSH 等非 pi 后端走 `deps.subscribeAgentChannelEvents`——`src/main/index.ts` 注入时**只订 `dshAgentManager.onOutput`**，不能订 `compositeAgentGateway`（它把 pi 的 `agents:text-stream` 一并转发，会与 pi 源重复推帧）；`agents:state` 载荷是无 agentId 的数组，天然被过滤。缺这一层的表现就是「输出很慢」（只剩 3s 状态轮询 + 5s 防抖磁盘重拉）与「察觉不到结束/停止」（整轮没有 finish 帧）。未注入时静默退化为旧行为（fail-safe）。
- **DSH 通道 → pi 事件**（`src/main/web/DshChannelToPiEvents.ts`，每条连接一份实例）：`agents:text-stream` / `agents:thinking` 是**累积全量文本**，用游标取增量后当 `text_delta`/`thinking_delta`；工具卡从 `agents:message` 快照补 input/output（首个消息帧是整会话历史，只保留在跑的卡与本轮新卡，否则刷新页面会把满屏旧卡片追加进当前回复）。
- **回合边界只认 `turnEnded: true`**（由 `DshAgentManager` 在四处发：正常 turn/end、abort、停止后迟到的 turn/end、host 崩溃恢复；desktop 渲染层不读该字段）。`isStreaming=false` **不能**当收口信号——带工具调用的 `assistant/message` 也会把它置 false，而回合还在跑。
- **停止的重复收口**：abort 先收一次，host 随后补发的 turn/end 会带同一份全文再收一次；翻译器用 `closedRunText` 忽略第二次，避免保活连接上重复上屏一条回复。
- **状态推送**：通道事件同样触发 `scheduleStatePush()`（400ms 去抖），运行时忙闲翻转即时可达；5s tick 只兜不住事件流里的目录变更。
- 回归集：`tests/webDshChannelStream.test.mjs`（翻译器 + 路由 + 契约）、`tests/webServiceDshStream.test.mjs`（真实 WebServiceManager + 真实 HTTP：帧序列 / 保活 / 状态推送）、`tests/webEventStream.test.mjs`、`tests/webExternalReplyMerger.test.mjs`。

## 会话定位轴（消息区刻度条 / outline rail）

**它是什么**：会话消息区**右缘**一列 1px 横杠，一根 = 一个用户提问；悬停出预览卡，点击跳转。

**位置与显隐是用户定的**：必须贴右缘（`right: 0`，预览卡向左展开 `previewSide="before"`），且**静默态整体不可见**——`.outline-hover.session-outline-pane > * { opacity: 0 }`，仅 `:hover` / `:focus-within` 时 `opacity: 1`（`focus-within` 兜键盘用户，不能只写 `:hover`）。历史上 commit `3303200ae` 把它挪到过左缘、并长期保持常显，2026-10 用户明确要求回到右侧 + 悬停才出现；守卫在 `tests/outlineDrawerOffset.test.mjs`。规划逻辑在 `src/renderer/src/components/session/timeline/outlineRailTicks.ts`（纯函数），渲染在 `SurfaceComponents.tsx` 的 `ConversationOutline` + beUI 的 `preview-rail.tsx`。

**条数上限是 30，且是「滑动窗口」不是采样**（2026-10 用户反馈「旁边横条太多」）：

- `windowRailItems(items, activeIndex)` 取以当前阅读位置为中心、最多 `RAIL_TICK_LIMIT = 30` 条的窗口。停在底部 = 「最新的 30 条」；往上翻窗口跟着上移。
- **不要改回均匀采样**。三个真实实现调研过：Proma `scroll-minimap.tsx` 用 20 根**不可点的桶**（`MAX_BARS`，每桶 = `items.length/20` 条）纯粹当位置图；dsh `TurnNavigator.tsx` 与 vivid-layer Chat Minimap 都是「全部条目 + 内部滚动」。**没有一家把稀疏采样出来的条当成跳转按钮**——刻度可点就必须点得动，采样会留下点不动的假按钮。
- 已知副作用：条数超 30 后，刻度的**纵向位置不再代表整段会话的进度**（当前刻度永远落在窗口中段）。要恢复「进度感」只能改成 Proma 的桶方案（条不可点 + 悬浮列表里跳转），这是产品取舍，不要单方面改回去。

**间距**：`RAIL_TICK_MAX_SIZE = 14` / `RAIL_TICK_MIN_SIZE = 6`，按可用高度收缩到下限，**不做内部滚动**。30 × 6 = 180px 已覆盖「小窗口 + 终端坞 + 高缩放」，所以 2026-10 重构把早前那套滚动/两端渐隐/自动跟随/`railMaxHeight`/`onWheelFallback` 一并删了（上限 30 之后它只在极端窄高下才可能触发，纯属屎山）。**滚轮仍要转发**：导轨是时间线滚动视口的兄弟节点（绝对定位），不转发的话指针在刻度上滚动时间线不动——用容器上的原生非 passive 监听（React 的 `onWheel` 是 passive，`preventDefault` 会被忽略）。

**显隐分工（用户明确要求）**：**导轨常显**，只有**预览卡**在悬停/固定/聚焦时才出现。实现上 `highlightedId`（含当前活动刻度）只驱动刻度缩放，预览卡必须挂 `displayedId`（`hoveredId ?? pinnedId ?? focusedId`）。这两个混用会让卡片在没有悬停时也常显在活动刻度上——2026-10 就是这么出的 bug，守卫在 `tests/outlineRailContract.test.mjs`。

**未加载刻度**：目录里有、消息还没加载的检查点（`outline-pending:<entryId>`）画淡一档（`opacity-60`，对齐 dsh 的 `markUnloaded`）。点它会走补页循环（`SessionSurfaceStage`）：每 60ms 轮询一次、最多 `RAIL_PENDING_MAX_ATTEMPTS = 10` 次；补不到要弹 `outline.jumpUnreachable`，**不许静默放弃**。

**这里有个反直觉的坑**：`loadMoreMessages` 在上一页仍在飞时**直接 return**（`useSessionTimelineController` 的 in-flight 守卫），所以「10 次轮询」是**约 600ms 的墙钟时间盒，不是 10 页**。窗口内最靠前的几条仍可能补不到——写代码时别承诺「看得见就一定点得到」。

**beUI 组件分叉纪律**：`preview-rail.tsx` 是官方 `@beui/preview-rail` 的本地分叉，头注释列了 4 条差异（`muted` 淡显 / 预览卡只渲染一张 + 纯计算定位 / `resolveCardTop` 钳制 / 卡片位移过渡）。`npx shadcn add @beui/preview-rail --overwrite` 会整份覆盖，必须按头注释重新施加；`tests/outlineRailContract.test.mjs` 的源码契约断言是那次覆盖的兜底（覆盖后会变红）。

**回归集**：`tests/outlineRailTicks.test.mjs`（窗口/间距纯函数）、`tests/outlineRailContract.test.mjs`（源码契约：预览卡触发条件、纯计算定位、`muted`、滚轮转发、窗口按源下标截取、已删滚动子系统不许长回来）、`tests/outlineRailActive.test.mjs`（活动刻度解析）、`tests/sessionOutlineDirectory.test.mjs`（目录取数）。没有 e2e 覆盖（本机 seeded-项目 e2e 环境不可用）。
