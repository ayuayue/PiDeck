# 第三批（远端/文件/Git 链路）只读审查

> 范围：`55f3e93c8..62b24815c`（12 个提交，HEAD `62b24815c`，分支 `dev`）中 `src/main/ipc/**`、`src/main/files/**`、
> `src/main/git/**`、`src/main/remote/**`、`src/renderer/src/services/**`、`src/renderer/src/utils/**`、`src/preload/index.ts`。
> 方法：纯只读（`read`/`ffgrep`/`fffind` + 只读 `git`/`grep`）；**未**跑 `typecheck`/`node --test`/`playwright`（同一工作区有并行 agent 在编译），
> 因此本文所有结论都能由「文件:行」独立复核，不引用测试输出。
> 交付边界：只新增本文件，未改任何 `src/`、`tests/`、`e2e/`、`docs/`（既有）、i18n。
> **处置状态（2026-11-07，主 agent 复核）**：P0-1、P1-4、P2-4/5/7/8/9/10 已修（提交 `a4bc471f4`）；P1-1/2/3/5/6 与 P2-1/2/3/11 已登记在 `remote-ui-unification-wave-3-plan.md` §7.1，附不做的理由。
>
> **行号基准**：全部引用按提交 `62b24815c` 计。审查期间工作区出现并行 agent 的未提交删除（`src/main/ipc/remoteGitReadIpc.ts`、
> `src/preload/index.ts`、`src/shared/ipc.ts`、`src/renderer/src/previewApi.ts` 正在摘掉 `git:remote-repos|log|compare` 三个兼容通道），
> 那几处行号在工作区里已经漂移；本文结论针对已提交状态，不评价那批未完成的改动。

## 结论摘要

- 一个 P0：新公共写面 `files:rename` 的 ssh 分支绕过了本机侧被明确标成「P0 security」的「newName 必须是纯文件名」判据。
- 六个 P1：Op 信封在公共写面被降级成抛 Error；跨目录移动退化成两步写；rename/delete 乐观锁降级；文档里的
  `git:remote-check-ignore` 通道并不存在；WSL helper 路径拿不到 ignore 修饰；ignore 判定没有随目录事实缓存。
- 十条 P2：闸门计数漂移、死接口、两套 ignore 口径、缓存没有连接身份、文档表格自相矛盾、测试缺口清单。
- 三条本轮要求的安全边界**未发现被绕过**（详见最后一节），但也都能被上面的 P1 间接影响，不是空欢喜。

---

## P0

### P0-1 `files:rename` 的 ssh 分支把「改名」重新变成「跨目录 move 原语」

**结论**：公共 `files:rename` 在远端分支只校验了长度与非空，就把 `parent + "/" + newName` 当**路径**交给 entry 服务；
本机分支经 `FileSystemService.rename` 显式拒绝分隔符与 `..`。同一通道在两位置语义不同，且旁路了两条远端名字规则。

**证据**

- `src/main/ipc/filesIpc.ts:718` 只校验 `typeof newName === "string" && newName.trim() && newName.length <= 255`；
  `:722-724` 直接拼 `targetPath` 并调用 `remoteEntries.rename`。
- 本机对照：`src/main/fs/FileSystemService.ts:243-255` —— 注释自称 **P0 security**，理由是
  「含分隔符或「..」组件会把 rename 变成跨目录 move 原语」，判据是 `newName !== basename(newName)`。
- 远端校验用的是**路径**规则 `validateRemoteProjectEntryPath`（`src/main/remote/RemoteProjectEntryCommands.ts:49-52`，
  允许 `a/b`），不是**单段名字**规则 `validateRemoteProjectEntryName`（`:61-66`，禁 `/`、禁 `.pideck-tmp` 后缀、
  禁保留名）。`assertRemoteProjectEntryMutablePath`（`:79-90`）只拦 `.git`/`.pi`/`.pideck-trash`，**不拦 `.pideck-tmp` 后缀**。
- 附带两处不一致：`source === target` 在远端抛 `REMOTE_FILE_INPUT_INVALID`（`RemoteProjectEntryCommands.ts:108`），
  本机同名改名是无害成功；长度判据本机是 UTF-16 字符、远端是 UTF-8 **字节**（`filesIpc.ts:718` vs `RemoteProjectEntryCommands.ts:62`）。

**影响边界**（不要夸大）：helper 有 root containment，不会被 esc 出项目根；真实影响是「公共通道语义按位置分叉」
+「上传私有临时名 `.pideck-tmp` 可被当成用户文件名造出来」（`RemoteProjectEntryCommands.ts` 的 `ENTRY_TEMP_SUFFIX` 规则本意就是防混）。

**建议**：ssh 分支复用 `validateRemoteProjectEntryName(newName)`（放进 `remoteEntries.rename` 内，而不是只写在 IPC 层），
跨目录只走 `files:move`。

---

## P1

### P1-1 公共写面把 `Op` 信封降回「抛 Error」，unknown 语义不再结构化

**结论**：本批新增的公共读 `files:search-page` 返回 `Op`，同一批新增的公共写 `files:create/rename/move/delete` 的 ssh 分支
以 `throw` 结束；`outcome` 只能靠 `Error.message` 里的码 + 闭集反推，直接违反 `shared/op.ts` 写下的硬规定。

**证据**

- `src/shared/op.ts:9-12`：两条硬规定（「跨 main↔renderer 的每个操作只允许一种结果形状」「`outcome` 必填」），`:42-52` `OP_UNKNOWN_CODES`。
- `src/main/ipc/filesIpc.ts:663-684`（create）、`:686-714`（delete）、`:716-745`（rename）、`:754-780`（move）全部以 throw 结束；
  同文件 `:393` 的 `files:search-page` 返回 `Op<ProjectFileSearchPage>`。一个公共文件面两种结果形状。
- 反推点：`src/renderer/src/services/projectServiceFence.ts:29-37` —— 稳定码取自 message，`outcome` 由 `OP_UNKNOWN_CODES` 决定
  （Electron 不保留自定义 Error 属性，所以只剩这条路）。
- 已被写成「结构性」的地方仍这么写：`src/main/ipc/remoteProjectEntryIpc.ts:20-24`（「`outcome` 在结构上就传得下去，不再依赖渲染层猜码」）
  —— 对 `remote:*` 成立，对 `files:*` 已不成立。
- 今天没炸只因 `REMOTE_FILE_RESULT_UNCONFIRMED` 恰好在闭集里；一旦新增 unknown 码或改写 message 措辞，
  「可能已执行」会被降级成 `rejected`，UI 立刻允许重试 → 重复建文件/重复删。

**建议**：这四条通道改成 `Op<T>`（至少返回 `{ok:false, code, outcome}` 结构化字段），并补一条「`files:*` ssh 失败必须保 unknown」的单测。

### P1-2 跨目录移动退化成两步写，第二步失败会留下「已移动未改名」且没有收据

**结论**：`moveEntry` 的公共实现是「先 move 到目标父目录，再 rename 到目标名」，两次都是独立远端写；
本批之前远端是**一次** `renameProjectEntry` 到目标全路径。文档 §7 片 2 声明「无（失败码与收据不变）」与实现不符。

**证据**

- `src/renderer/src/services/projectFileService.ts:56-70`（`moveProjectEntry`：`:63` move、`:66` rename，两步都成功才返回收据）。
- `src/main/ipc/filesIpc.ts:754-780`：ssh 分支逐项 `remoteEntries.move`（`:772-777`），多源同样没有补偿。
- 旧实现：`git show 55f3e93c8:src/renderer/src/services/projectFileService.ts`（远端 provider 一次 `renameProjectEntry(... destinationRelativePath ...)`）。
- 声明：`docs/remote-ui-unification-wave-3-plan.md:92`「无（失败码与收据不变）」。

**建议**：entry 服务加一个「移动到指定全路径」的单一写（`source→target` 一次 stat+rename），`moveEntry` 直接用；
或至少在文档里写明两步语义与残局。

### P1-3 rename/delete 的乐观锁从「用户确认时的版本」降级为「main 现读现用」

**结论**：`remoteEntries.rename/move/delete` 先 `stat` 签令牌、紧接着用掉，两次调用之间没有用户动作；
契约层仍声明 `expectedVersion?` 但已无人使用。删除进回收站（可恢复），所以不是数据永久丢失，但用户预期变了。

**证据**

- `src/main/ipc/remoteProjectEntryIpc.ts:233-246`、`:248-264`、`:266-278`（`stat` → `writeWithFacts` → `entry.*`，中间只有一个 await）。
- 契约残留：`src/renderer/src/services/projectServiceContracts.ts:184`（`renameEntry(..., expectedVersion?)`）、`:187`（`deleteEntry(..., expectedVersion?)`）；
  实现忽略：`src/renderer/src/services/projectFileService.ts:201-204`、`:208-212`。
- 旧行为对照（同 55f3e93c8 的远端 provider）：`requireEntryVersion(... expectedVersion)` 把快照版本带进写，版本不一致 → `REMOTE_FILE_CHANGED`。

**建议**：要么把「对话框打开时的版本」继续传下来（服务仍可校验），要么删掉契约里的 `expectedVersion` 并在文档写明删除不看快照状态。

### P1-4 文档里的 `git:remote-check-ignore` 通道不存在，`checkIgnore` handle 方法也无消费者

**结论**：两份文档都把它写成「保留给显式调用方的 IPC 方法」，实际它只是 `registerRemoteGitReadIpc` 返回对象上的方法
（还带着 `IpcMainInvokeEvent` 参数），没有 `ipcMain.handle` 绑定、没有 preload 转发、全仓零调用。

**证据**

- `src/main/ipc/remoteGitReadIpc.ts:676-690`：方法体在返回对象里；同文件 `:324-577` 的 `ipcMain.handle` 列表里没有它。
- 全仓 grep `remote-check-ignore`/`remoteCheckIgnore`：只命中文档。
- 文档：`docs/remote-file-tree-and-git-unification-plan.md:538`、`docs/remote-ui-unification-wave-3-plan.md:81`。
- 同两处还引用了不存在的文件 `src/main/remote/RemoteDirectoryIgnore.ts`（真实文件是 `src/main/files/DirectoryIgnore.ts`，见 `ls src/main/remote | grep -i ignore` 无输出）。

**建议**：删掉这个 handle 方法（`probeIgnore` 直接调 `git.checkIgnore` 即可），并把文档里的通道名/文件路径改成真实值。

### P1-5 WSL 项目（helper 链路正常时）拿不到 ignore 修饰，与「WSL 经同一 git 分派」不符

**结论**：WSL 项目的目录页由 `WslProjectFileBackend` 提供，它没有 `checkIgnore`；只有 helper 链路不可用、回退到
`LocalProjectFileBackend` 时才走 Git 判定。文档把「本机已接」笼统写成含 WSL。

**证据**

- `src/main/files/ProjectFileBackend.ts:37`：WSL 项目 → `wslBackend`。
- `src/main/files/WslProjectFileBackend.ts:198-219`：`directoryPage` 只有 `reader.list` 投影，无 `ignored`；
  `:219` 的 `fallback.directoryPage` 才是唯一能带修饰的路径（回退条件见 `:68-72`，仅 helper 链路不可用）。
- `src/main/files/LocalProjectFileBackend.ts:110-123`：修饰只在这里。
- 文档：`docs/remote-ui-unification-wave-3-plan.md:81`、`docs/remote-file-tree-and-git-unification-plan.md:489`（「WSL 经同一 git 分派」）。

**建议**：先把文档改成「仅宿主 git 路径生效，WSL 在 helper 回退时生效」，或在 WSL backend 里补一次同口径判定（同一个 git 分派）。

### P1-6 ignore 判定没有随目录事实缓存，暖命中每次重判（与模块头声明相反），远端每页最多 1+N/64 帧

**结论**：`DirectoryIgnore.ts` 写明「结果随目录页事实一起缓存，暖命中不重复判定」，但探针在 `projectDirectoryPage`
之外、每次调用都跑；远端一页 2000 条 = 1 次仓库发现（60s TTL）+ 32 个 `git.checkIgnore` 帧，文件树的 tree 失效会对所有已加载目录都重来一遍。

**证据**

- 声明：`src/main/files/DirectoryIgnore.ts:10`。
- 远端：`src/main/ipc/remoteProjectDirectoryReads.ts:66-78`（每次 `projectDirectoryPage` 都 `await input.ignoreProbe(...)`），
  批大小/上限 `src/main/files/DirectoryIgnore.ts:16-18`，逐批发帧 `src/main/ipc/remoteGitReadIpc.ts:737-746`；
  `remoteGitReadIpc.ts:172-190` 只缓存**仓库列表**，不缓存判定结果。
- 本机：`src/main/files/LocalProjectFileBackend.ts:110-123`（每次目录页起一次 `git check-ignore`，失败的「非仓库」也不做负缓存）。

**建议**：把 `ignored` 并入目录 FactCache（或按「目录 + 仓库代」记一次结果），本机加一句「非仓库不重试」的负缓存。

---

## P2

| # | 结论 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | 共用闸门的 `endRead()` 不是令牌作用域：`retire()` 把在途计数清零后，旧读的 `endRead()` 会扣掉新读的计数，静默轮询与显式刷新可能重叠（发布仍由代数挡住，影响限于多发一次读）。 | `src/renderer/src/utils/gitOperationGate.ts:69-76`（`retire` 清零、`endRead` 无令牌）；调用点 `src/renderer/src/utils/remoteGitStatusPolling.ts:110,116,124`、`src/renderer/src/components/app/GitPanel.tsx:576,757` | `endRead(token)` 只减属于自己那一代的计数 |
| P2-2 | 闸门里一半接口是死的：轮询侧从不 `markUnknown/resolveUnknown`，`writing()` 全仓无调用。 | `gitOperationGate.ts:84-90`；`remoteGitStatusPolling.ts:81`（`createGitOperationGate()` 无 options） | 要么让轮询用 unknown，要么把这两个 API 从轮询路径剥掉 |
| P2-3 | 本机与远端 ignore 判定口径不同：远端「最长仓库前缀归因 + 64/批 + 能力门控」，本机「一次全量 + 不归因」；`DIRECTORY_IGNORE_BATCH_SIZE` 只有远端在用。 | `src/main/files/DirectoryIgnore.ts:16-18`（模块头称两 backend 共用规则）vs `LocalProjectFileBackend.ts:112-123`；`src/main/git/GitService.ts:73-82`（单次 `-z --stdin`） | 二选一：要么本机也做批次/归因，要么把模块头的「共用」限定为「只共用 applyDirectoryIgnore」 |
| P2-4 | `probeIgnore` 的文档行与实现矛盾：头注释写「任一帧失败都整页放弃修饰」，实现是「单批失败只丢这一批」。 | `src/main/ipc/remoteGitReadIpc.ts:708` vs `:739-746` | 按实现改注释（或按注释改成整页放弃） |
| P2-5 | 仓库归因缓存没有连接身份/ locator 维度：只按 `projectId` + 60s TTL，断连与重绑都不清（只有 Git 写成功/`invalidateProject` 清），重绑后 60s 内可能按旧仓库前缀把路径送去错误的 `repo` scope。 | `src/main/ipc/remoteGitReadIpc.ts:125-131`、`:172-190`（`clearDirectoryIgnoreRepos` 只在 `:196`、`:663` 调） | 缓存 key 里带 locator 快照/连接代，断连时一起清 |
| P2-6 | §10.8 兼容壳表相邻两行互相矛盾：一行说 `remoteHosts.*` 写面「renderer 全部不再调用」，下一行又说 `searchProject`/条目 stat/create/rename/delete/trash/upload「当前装配可达」。实际 renderer 已全走 `files:*`（grep 无 `createProjectFile`/`renameProjectEntry` 调用）。另外 `files:search`（旧形状）与 §10.8 说的 `listProject` 同样是零消费者，但只有后者被标成「后续清理候选」。 | `docs/remote-file-tree-and-git-unification-plan.md:537` vs `:541`；`src/preload/index.ts:473-481`（仍暴露）、`:587`（`files.search` 只剩 preload 声明）；`src/renderer/src/services/projectFileService.ts:74,182`（只调 `searchPage`） | 把 `:541` 改成「无 renderer 消费者，兼容壳保留一版」，并把 `files:search` 归到同一清理候选组 |
| P2-7 | 重构留下的死导入。 | `src/renderer/src/hooks/files/useProjectFileTreeController.ts:9`（`ProjectDirectoryEntry` 只出现在 import 与注释里；`tsconfig.json:13` `noUnusedLocals: false`，所以门禁不会报） | 删掉该 import |
| P2-8 | 预览模式两个搜索 stub 对同一件事给了两种答案。 | `src/renderer/src/previewApi.ts:672`（`search → []`）vs `:675`（`searchPage → UNSUPPORTED_PROJECT_LOCATION`） | 统一成同一种「没有后端」的表达 |
| P2-9 | 清单一致性测试只守住 `git.*`，且扫描窗口是 `function dispatch(` 之后固定 6000 字符（当前 40 个 `frame.method ===` 只用到 2275，余量约 3700；dispatch 一重构就假红/假绿）。`fs.*`/`config.*`/`terminal.*` 的「声明↔分派」没有兜底（本次人工核对：38 个 CAPABILITIES 全部有分派，另多出 `hello`/`cancel` 两个非能力分支）。 | `tests/remoteHelperEntry.test.mjs:1820-1832` | 解析整段 `dispatch`（或按 `CAPABILITIES` 全集校验，不只 `startsWith("git.")`） |
| P2-10 | 「未知写」在公共写面上的端到端没有单测：路由测试用假端口，Op 通道测试只覆盖 `remote:*`；没有用例走「`files:create` 抛 `REMOTE_FILE_RESULT_UNCONFIRMED` → `normalizeProjectServiceError` → `outcome: "unknown"`」。 | `tests/filesWriteRouting.test.mjs:92-181`（假 `remoteEntries`）；`tests/remoteProjectEntryIpc.test.mjs`（只测 Op 通道）；反推逻辑 `src/renderer/src/services/projectServiceFence.ts:29-37` | 加一条直连 `registerFilesIpc` + 真 `registerRemoteProjectEntryIpc` handle 的用例，断言 outcome 存活 |
| P2-11 | 移动的两步语义没有用例：第二步 rename 失败、多源中途失败都无覆盖。 | `src/renderer/src/services/projectFileService.ts:59-70`、`src/main/ipc/filesIpc.ts:772-777`；现有 `tests/filesWriteRouting.test.mjs:148`（单源成功路径） | 补「move 成功 / rename 失败」的残局断言（文件在目标目录、旧名、无收据） |

---

## 附：renderer 里仍按位置分支的清单（本轮第 2 项）

结论：文件写面与搜索面已收口，剩下的是**装配层与产品语义**分支，不构成第二套通道；唯一真欠账是 Git provider。

| 位置 | 分支内容 | 判定 |
|---|---|---|
| `src/renderer/src/services/projectServices.ts:54,65` | `files` 已位置无关（只注入端口）；`git` 仍 `remote ? createRemoteProjectGitService : createLocalProjectGitService` | 已登记为下一步；不是第二事实源 |
| `src/renderer/src/hooks/useProjectServices.ts:25-26` | 用 locator 拼 runtime 身份键（id/host/root 变化换 runtime） | 合理，非选通道 |
| `src/renderer/src/services/projectServiceRuntime.ts:50`、`projectServiceFacts.ts:59` | 事实采集按位置（local/ssh 两套来源） | 合理，位置本身就是事实 |
| `src/renderer/src/utils/fileSearchCapability.ts:23` | 内容检索能力按位置取（helper 声明 vs 本机索引） | 能力判定，非通道 |
| `src/renderer/src/components/workspace/ProjectGitDrawer.tsx:22`、`DrawerSurface.tsx:138`、`components/session/RemoteProjectPanel.tsx:55` | 组件级选择远端/本机面板 | 产品形态，已由 T8 登记 |
| `src/renderer/src/hooks/useSessionComposerController.ts:447,2493,2497`、`App.tsx:1667` | 远端项目强制 `backend: "pi"` | 产品语义（远端无 dsh/acp），不是漏收口 |

## 附：本轮要求核查、但未发现问题的安全边界

1. **令牌签发/使用只在 main**：`files:*` 的 ssh 分支只把 `event.sender` 交给 handle（`src/main/ipc/filesIpc.ts:672,695,726,766`），
   `stat` 在 `remoteProjectEntryIpc` 内部完成（`:233-246`），renderer 侧已无 `remoteHosts.createProjectFile/renameProjectEntry/deleteProjectEntry` 调用，
   版本令牌不再出现在任何 renderer 载荷里（`src/renderer/src/services/projectFileService.ts:190-212`）。
2. **trust 没有被缓存绕过**：`probeIgnore` 虽然绕过 `guardRead`/`verifyFactsBoundary`（`src/main/ipc/remoteGitReadIpc.ts:700-760`
   直接调 `git.checkIgnore`），但 `RemoteGitService.run` 每次都在发帧前重新 `await ports.trusted(locator)` + `assertCurrent`
   （`src/main/git/RemoteGitService.ts:519-520`），`target(projectId)` 也每次重读 locator（`:468-472`）。暖缓存因此不是权限旁路。
3. **unknown 写不会自动重放**：`writeWithFacts` 只在 `isUncertainWrite` 时标脏、不再发一帧（`src/main/ipc/remoteProjectEntryIpc.ts:76-93`）；
   渲染层 unknown 只会把状态机推到 `unknown` 等显式刷新（`src/renderer/src/components/session/remoteFileManagementState.ts:29-41`）。
   剩下的是人工重试（`files.busy` 只管 busy 态：`src/renderer/src/components/session/RemoteProjectPanel.tsx:250-253,414`），与冻结契约「不自动重放」一致。
