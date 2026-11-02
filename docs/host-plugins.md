# PiDeck 宿主插件（Host Plugins）

> **Status: Current（2026-10-31 核对；以代码与测试为准）**


> 第一阶段独立插件系统：不依赖 pi 进程，向 PiDeck 桌面壳（而非 pi RPC）注册 UI 面板与受限 API。
> 设计动机：现有扩展点（pi 扩展 + GUI 桥）依赖 pi 进程且受 `ctx.ui` 降级限制；宿主插件让纯查看器/工具类扩展（如 pi-context）直接挂在 PiDeck 上。

## 与既有机制的关系

| 机制 | 归属 | 适用 |
|------|------|------|
| pi 扩展（`resources/extensions/*.ts`，`-e` 注入） | pi 进程内 | 需要扩 pi 的命令/工具/事件、拦截模型请求 |
| 主题定制 | 渲染层 | 纯视觉 |
| **宿主插件（本文档）** | PiDeck 桌面壳 | 只读会话 UI 工具、受控 HTTPS API / 已启动本地服务的前端 |

## 包结构

插件放在 `userData/host-plugins/<id>/`（目录上限 32 个），必须有 `pideck-plugin.json`：

```json
{
	"schemaVersion": 1,
	"apiVersion": 1,
	"id": "example.viewer",
	"name": "Viewer",
	"version": "1.0.0",
	"permissions": ["sessions.read"],
	"contributes": {
		"panels": [{ "id": "context", "title": "Context", "entry": "app.html" }],
		"commands": [{ "id": "context.open", "title": "Open", "panelId": "context" }]
	}
}
```

- `permissions` 白名单：`sessions.read`（读会话）、`sessions.read.workspace`（把会话读取与导航范围扩到整个工作区，必须同时声明 `sessions.read`，单独声明直接拒装）、`workbench.navigate`（导航时间线）、`workbench.openExternal`（系统浏览器开 https）、`network.https`（受控公网 HTTPS）、`network.local`（受控固定端口本地 HTTP）、`service.local`（按名启停 PiDeck 已实现适配器的本地服务）；未知权限直接拒绝加载。网络权限必须配对应的 `network.httpsOrigins` / `network.localPorts`，每类 1–16 个不重复目的地；`service.local` 必须配 `services`（1–8 个，且必须命中 `src/shared/localServices.ts` 白名单）。`storage` 不需要权限，每插件一个独立命名空间（见下）。
- 资产上限：单文件 4 MiB、整包 16 MiB、100 个文件、目录深度 8；禁止符号链接。
- 面板 `entry` 必须是包内相对路径且以 `.html` 结尾（拒 `../` 逃逸）；可服务扩展名固定为 `HOST_PLUGIN_MIME`：html/js/mjs/css/json/svg/png/jpg/webp/woff2，`pideck-plugin.json` 自身永不可服务（`asset-not-allowed`）。资产路径只允许 `^[a-zA-Z0-9_./-]+$`（空格/中文文件名无法引用）。可选 `icon` 走 `src/shared/hostPluginIcons.ts` 白名单，可选 `presentation` 只接受 `modal`/`popover`/`page`，其余值 fail closed 拒装（`src/main/plugins/hostPluginManifest.ts`）。

## 授权与指纹

- 插件默认禁用。启用动作绑定**整包逐文件 sha256 指纹**（不是版本号）：任何文件变化都会使授权失效并要求重新确认（`plugin-changed`）。
- manifest 只读一次——哈希与解析消费同一份字节，杜绝「两次读取之间改 permissions 复用旧授权」的 TOCTOU。
- 运行时重新读取资产还会比对授权时记录的 digest（`plugin-code-changed`）。
- 授权界面从 `HostPluginPermissionDetails` 的统一清单展示所有能力与精确 HTTPS origins / 本地端口 / 可控制的本地服务。会话读取 + 联网同时存在时必须警告数据外发风险；本地端口授权必须警告服务可能有写入/管理能力；服务控制授权必须警告被控服务的 Web 面板通常无鉴权、不得暴露端口。网络目的地变更同样改变指纹，不沿用旧授权。

## 运行环境

- 每个面板实例一个独立页面内 `<webview>`：`sandbox: true`、`contextIsolation: true`、无 Node、专属 `partition`，CSP `connect-src 'none'`（页面无直接网络；受控网络只走宿主 API）。
- 自定义协议 `pideck-plugin://<instance>/...` 只解析本实例的包内资产。
- 页面通过注入的 `window.pideck` API 访问能力；请求绑定发送者 frame，切换项目/禁用后未完成的响应被作废（`plugin-revoked`）。
- 频率限制：每实例同时最多 2 个在途请求、每秒最多 20 个请求（1s 滑窗口重置），超出返回 `rate-limited`。

## 会话数据 API（`sessions.read`）

- `sessions.list(offset?)`：已保存会话，分页 100 条，offset ≤ 100000；默认只有当前项目，声明 `sessions.read.workspace` 后是整个工作区（含 DSH/ACP/生图/生视频等所有后端）。
- 每条会话带 `id`/`projectId`/`projectName`/`directory`（项目根目录，不是会话文件路径）/`title`/`backend`/`model`/`createdAt`/`updatedAt`/`readable`；`readable` 只表示「有可读的 JSONL 历史」，不影响 list/get/navigate。
- `sessions.get(id)`：单会话元信息；归属判定与 list 同源，拿不到就 `session-not-authorized`（不泄露范围外会话的存在性）。
- `sessions.search(query, limit?)`：按标题子串（大小写不敏感）搜当前范围，默认 20 条、上限 100；只查目录标题，不读历史文件。
- `sessions.entries`：读会话**活跃分支**的历史（含 compaction/custom 条目，不含 provider 输入），带游标分页；单条上限 256 KiB、单页 1 MiB，超限条目以 `truncated` 标记省略；没有 JSONL 的会话（DSH/ACP/生图）报 `history-unavailable`。
- **范围隔离**：默认会话 id 必须属于当前项目，只有声明 `sessions.read.workspace` 的插件才按整个工作区判定。范围由宿主依 manifest 权限写进 `context.scope`（`project` / `workspace`），面板页伪造该字段无效。fork 祖先链每一跳都按 catalog 重新授权，跨项目祖先自动降级为单文件读（绝不合并外部项目消息）。
- **资源预算**：单次请求（含祖先链全部文件）扫描上限 64 MiB / 10 万条，超限抛稳定错误码 `history-too-large`；索引内存不保留超长 compaction summary（分页读原始字节不受影响）。
- 插件索引使用单槽缓存（只随最后访问的会话 bounded），与桌面历史的 LRU 隔离。
- **字段剥离**：条目过 `projectValue`（`src/main/sessions/boundedEntryPage.ts`）——剔除 `cwd`/`parentSession`/`sessionFile`/`filePath` 与图片内联字节（`data`/`imageRef`/`url`/`source`），递归深度上限 24。
- **游标绑定文件版本**：`nextCursor` 带版本，文件变了报 `stale-cursor`；读取期间文件被改写则整页作废（`history-changed`）。
- **变更推送**：面板挂载后主进程轮询目录签名（`changeSince`），活跃会话追加推送 `{ sessionId }`、目录级变化推送 `{ catalogChanged: true }`，面板据此做定向重读而不是全量轮询。

## 工作台导航（`workbench.navigate` / `workbench.openExternal`）

- `pideck.workbench.navigate(sessionId, entryId?)`：让 PiDeck 选中该会话并滚动到指定时间线条目（`entryId` 可省略，省略时落到底部）。
- Broker 门禁与 `sessions.*` 同源：目标会话必须落在插件的数据范围内（默认当前项目，`sessions.read.workspace` 下为整个工作区），否则 `session-not-authorized`；导航事件的 `projectId` 取自会话归属（工作区范围下会切到那个项目），不携带任何插件数据。
- pi-context viewer 的「在浏览器中查看」按钮即走此链路：转换器给模型行补 `id`，桥接层 `host.locate` 反查快照行 → `navigate`。
- `pideck.workbench.openExternal(url)`：只接受 https 且不带账号密码（其余一律 `invalid-request`），经主进程 sink 交给 `openExternalUrl`；不返回接口结果，也不授予网络权限。

## 受控网络（`network.https` / `network.local`）

- 链路：专属 preload 的 `pideck.network.request(input)` → 同一个 sender-bound Broker → `HostPluginNetwork` → `hostPluginNetworkTransport`。页面的 CSP / webRequest 仍只允许自身资产，不开放 fetch / XHR / WebSocket。
- HTTPS 精确匹配 `manifest.network.httpsOrigins`（无路径/查询/通配符）；DNS 所有结果必须是公网单播地址，私网/特殊地址/混合结果全部拒绝。Node socket 固定到已验证的 IP，原 URL 保留给 Host / SNI / TLS 证书校验，不做第二次 DNS 解析、不复用连接池。
- 本地只允许单独声明的 `http://127.0.0.1:<明确端口>`（1–65535），不接受 localhost / IPv6 回环 / 局域网地址。服务必须已运行；PiDeck 不执行 BAT、不启动进程。
- GET / POST、有界 UTF-8 text/JSON：POST ≤256 KiB、响应 ≤1 MiB、请求头 ≤32 个 / 16 KiB、响应头 ≤16 KiB；默认 15 秒总超时、最多 30 秒，覆盖 DNS 到全部响应。禁止 Cookie / 连接与分帧控制头，不共享宿主凭据；允许插件自己的 Authorization / API key。压缩与二进制响应拒绝。
- 重定向最多 3 次，仅同 origin；每跳重新验证授权/DNS。301/302/303 的 POST 转 GET，307/308 保留；不跨 origin 转发凭据或正文。
- Broker 的请求 AbortController 属于实例 binding；update / unbind / 禁用 / 指纹变化 / dispose 都同步撤销，ViewHost 在 guest 已销毁时也必须 unbind。取消 socket 不回滚服务已经执行的操作。
- HTTP 4xx/5xx 返回 `{ status, ok: false, body }`；策略/传输失败抛稳定错误码，不泄露 URL、凭据或操作系统诊断。不提供代理、Cookie 登录、流式消费、大文件或命令执行。
- 独立静态 demo：`docs/examples/host-plugins/example.network/`，首次加载零请求、按钮触发两类网络，不读会话、不自动启动服务；回归只用替身网络。

## 本地服务（`service.local`）

- 链路：`pideck.services.status/start/stop/openUi(id[, pid])` → sender-bound Broker → `src/main/localServices/LocalServiceRegistry.ts` → 适配器（当前只有 `billion-context`）。
- **能力面不扩大**：插件只能传 service id；`openUi` 多出的 `pid` 只是从当次 `status.instances` 白名单里点名某个实例的指针（不是地址、不是端口，未知 pid 回 `service-not-running`），命令名/参数/端口仍全部是主进程适配器里的常量（`localServiceCli.ts` 的命令与参数各自过字符白名单，Windows 走 `cmd.exe /d /s /c` 的 `.cmd` 垫片范式，不拼字符串 shell）。未在 `src/shared/localServices.ts` 白名单里的 id 在 manifest 校验阶段就被拒（`invalid-services`）。
- **多实例**：`bili` 支持 lane daemon（如 pi 扩展自拉的 18790），`bili doctor --json` 的进程表会同时有多行。`status.instances` 按进程表顺序列出全部活实例，第一个是主实例（顶层 `pid`/`uiUrl` 就是它），单实例服务省略该字段；`openUi(id, pid)` 在这份每次查询都重新取的白名单里点名。
- 双重门：权限 + `manifest.services` 点名。Broker 里四个方法（`status`/`start`/`stop`/`openUi`）逐个登记，不用前缀推断——新增方法忘登记会报错而不是白拿权限。
- 启停轮询跟着授权绑定走（Broker binding 的 AbortController）：插件被禁用 / 上下文更新 / 面板关闭时立即中断还在等的 `start`/`stop`。
- 停止只能按 pid 终止（外部 CLI 没有 stop 子命令）：pid 一律来自 `bili doctor --json` 的报告，不猜、不按名字杀。UI 地址同样从报告里取，但只接受 `http://127.0.0.1|localhost:<port>`，防报告被改写成公网地址把内置浏览器带走。
- 停止**不保证停得住**：billion-context 的 pi lane 由 pi 自己的扩展持有（`dist/agent/pi-native.js` 的 `ensureProxyRunning`），进程一死 pi 会立刻重新拉起——实测杀掉 pid 后约 2 秒就有新 pid 监听同一端口。适配器在轮询窗口内看到「仍在运行但 pid 已变」时返回 `reason: "stop-restarted"`（带新 pid 与 uiUrl），而不是报 `stop-failed` 或假装成功；只有 pid 没变才算真失败。面板要如实转述（要彻底停掉需先退出 pi），不要自动重试。
- 「打开面板」不走插件：Broker 转发 `onOpenBrowser` sink → `hostPluginOpenBrowser` IPC → 渲染层 `workspace.openDrawerForce("browser") + navigateTo(url)`。插件页 CSP 是 `frame-src 'none'`，本来就无法内嵌这类 SPA。
- 内置示例：`resources/host-plugins/billion-context/` 随包分发（`extraResources` → `resources/host-plugins`），由 `HostPluginManager.seedBuiltin()` 在 `load()` 前落位到 `userData/host-plugins/`。落位不等于授权：首次落位同样是 `requiresConsent`，仍需用户按指纹确认。
- 落位的三种情形（`seeded` 记录上次落位指纹，存在 `host-plugin-state.json`）：目录不存在 → 复制一份；目录内容仍等于上次落位的指纹（用户没动过）→ 用新版内置内容替换；其余（用户改过、装过别的版本、自己写了同 id 的）→ **永不覆盖**。只有第一种情形（上一版内置内容）升级时授权顺延，避免每次应用更新都要求重新批准自己的内置示例；第三方与用户改过的副本不在顺延范围。顺延只在新载荷的权限没有扩大时成立（旧权限集合必须是新集合的超集）：内置示例新增权限就是扩大数据范围，必须回到 `requiresConsent` 让用户按指纹重新批准。
- 旧状态文件（`seeded` 机制之前）没有落位记录，磁盘上分不出「我们落的」与「用户自己装的同 id 插件」：这种情形只用一次，拿 `manifest.version` 当第二条线索——版本不同 ⇒ 来自另一个 PiDeck 版本的内置载荷（即我们自己落的），替换并顺延授权；版本相同则当作用户的副本不覆盖。`seedBuiltin` 写过一次 `seeded` 后该分支就永久失效。
- 卸载：`HostPluginManager.remove(id)` 先撤权再删目录（顺序与 `setEnabled` 一致，挂载中的视图立刻失效），同时清掉授权与落位记录。`seeded` 里的 id 拒绝卸载（`plugin-builtin`）——下次启动 `seedBuiltin` 会把它重新落位，删了只会让人以为卸载没生效；要停用请用禁用。渲染层入口在设置页插件行（`HostPluginsTab` 的「卸载」+ 确认框）。
- 新增服务的成本：`src/main/localServices/` 加适配器 + 在 `src/shared/localServices.ts` 登记 ID，插件侧 manifest 校验随之放行。第三方插件无法自行扩展能力面。

## 面板形态与入口（`presentation`）

同一个 `contributes.panels` 声明，三种呈现方式（缺省 `modal`）：

- `modal`：近全屏大弹框（与页面级设置面板同一尺寸语系），适合统计/浏览类长驻页面；
- `popover`：侧栏那一行旁边就地展开的浮层（`HostPluginDockButtons` 里的 `Popover`），适合「状态行 + 几个按钮」这种紧凑面板；从设置页/命令面板这类没有锚点的入口进来时退化成小对话框；
- `page`：工作区内联页，非模态覆盖会话区，侧栏入口再点即关。

侧栏入口位于「定时任务」下方（`SidebarContent.tsx` 的宿主插件区），只列**已启用**插件的面板；无已启用面板时整块不渲染。

抽屉 rail 的可见性过滤含 `|| action.active`——不变式是「rail 永远显示当前活动面板」。没有这一条时，外部入口（如 `service.openUi` 打开内置浏览器、消息里的「在浏览器打开」）只切抽屉内容而不钉住面板，rail 上就没有归属 tab。

## 存储（`storage`）

- 每插件一个 JSON 文件，上限 1 MiB / 200 个键（`storage-too-large` / `storage-full`），键名白名单 `[a-zA-Z0-9_.-]{1,80}`（拒 `__proto__` 等）；API 面 `get`/`set`/`keys`/`remove`，`keys()` 只返回自己的键。
- 写入走 tmp + 原子 rename；rename 瞬态锁（EPERM/EBUSY）退避重试约 300ms，**每次尝试前复查授权**——重试窗口内插件被禁用时中止提交（`plugin-revoked`），绝不覆盖正式文件。

## 脚手架（设置页「新建插件…」）

- 入口：`HostPluginDesktopApi.scaffold(input)` → `src/main/plugins/hostPluginScaffold.ts` 在插件目录生成 `<id>/`；复用与安装路径同一套 `isHostPluginId` / `parseHostPluginManifest` 自检——**生成的包必须过安装校验**，否则宁可不生成。
- 产物：`pideck-plugin.json` / `app.html` / `app.js` / `styles.css` / `README.md`。模板按勾选裁剪：没勾 `sessions.read` 就不生成会话列表代码，没勾 workbench / 网络权限就不生成对应按钮与调用；网络声明先过安装路径的权威解析器，示例 URL 从规范化后的同一份授权派生（`hostPluginScaffoldNetwork.ts`）。默认不联网，网络示例点击才请求、不上传会话、不启动服务。
- 目标目录已存在时拒绝（`already-exists`），绝不覆盖作者代码；失败时清理已写入的部分产物。
- 生成后与手工放置等价：重新扫描 → 默认禁用 → 「授权并启用」，指纹与授权链路完全相同。

## 分发与安装（`.pideck-plugin`）

- 格式：NDJSON 单文件（header 行 + 每文件一行 base64 + sha256），与目录包同一套预算（单文件 4MiB / 展开 16MiB / 100 文件 / 深度 8）；归档总体上限 24MiB。选自描述行格式而非 zip：无运行时解压依赖，预算与逐文件校验内建在解析器（`src/main/plugins/hostPluginArchive.ts`）。
- 打包：`node scripts/pack-host-plugin.mjs <插件目录> [输出.pideck-plugin]`。
- 安装：设置 → PiDeck 插件 →「从文件安装…」收 `.pideck-plugin` 归档，「从文件夹安装…」收已解压的目录包；两条路径都：路径只来自主进程对话框（渲染层不传路径）→ 拷/写到隐藏 temp 目录（`stageHostPluginFile` 逐级建目录，支持 `assets/app.html` 这类嵌套资产）→ 走 `readHostPluginPackage` 全量验证 → 原子换入，失败自动清理。目录来源额外跳过 `.git`/`node_modules` 整棵；路径形状不合法（空格/中文名等）或超限的文件被跳过而不是造成整包失败，其余文件照搬到落位目录。
- 第三条路径「从 GitHub 安装…」只收 `https://github.com/<owner>/<repo>[/tree/<ref>[/<subpath>]]`，下载固定走 `codeload.github.com` 的 tar.gz + 自写 tar 解析（无 `git`、不执行仓库脚本）；三条路径共用 `HostPluginManager.installFiles` 同一套预算与信任判定。
- 替换语义：启用中的插件拒绝替换（`plugin-in-use`，先禁用再装）；禁用状态重装同 id 允许，字节一致则指纹不变，内容变化则旧授权失效。

## 插件市场（双源发现）

设置 → PiDeck 插件 →「插件市场」（`src/renderer/src/config/HostPluginMarketDialog.tsx` → `host-plugins:market-search` → `src/main/plugins/hostPluginMarket.ts`）把「搜到」和「装」分开，两个源都**只产出链接、不产出字节**：

| 源 | 来源与顺序 | 卡片标记 |
| --- | --- | --- |
| 官方收录 | `https://raw.githubusercontent.com/ayuayue/pideck-plugins/main/registry.json`（人工核对过 manifest 与权限，支持 `repo` + `ref` + `subpath` 精确到子目录，可一仓多插件） | 官方收录 |
| 社区 | GitHub `topic:pideck-plugin`，按星标倒序，排除 fork/归档，**只认仓库根**的 `pideck-plugin.json` | 社区 · 未审阅 |

- 安装复用 `hostPluginsInstallGitHub`（`downloadGitHubPlugin(installUrl)` → `installFiles`），所以市场拿不到任何额外能力：装完仍是禁用 + 需授权，指纹链路与手工安装完全相同。
- 合并规则：官方收录排在社区结果之前；**官方源内部不按仓库去重**（一个 monorepo 可以出多条，`subpath` 各自精确，见已有 4 条收录）；社区条目只要它那个仓库已被收录就跳过（社区只能整仓装，registry 那条更准）；其余按 `installUrl` 去重；结果截断 40 条。
- 单源失败不阻断：失败文本进 `warnings` 由 UI 展示；**双源全挂才抛错**。所有远程数据当不可信输入：形态不对的 registry 条目、`installUrl` 拼不出来的条目（缺 `repo`、`repo` 不是 `owner/name`、`ref`/`subpath` 含空段或 `.`/`..`）一律丢弃，宁可少一条也不给点下去必然失败的安装按钮。
- 为什么只按 topic 拉一次再本地过滤：`api.github.com/search/repositories` 未认证限 10 请求/分钟，而用户会连打十几次关键词。缓存：社区源 10 分钟、官方索引 6 小时（`clearHostPluginMarketCache()` 供测试清缓存）。
- 桌面端所有请求走 Electron `net.fetch`（动态 `import("electron")` 取，跟随 PiDeck 代理设置）；**禁裸全局 `fetch`**——undici 不读系统代理，境外 API 会挂到超时。
- 卸载/撤下**不追溯**已装实例：删 `registry.json` 里那一行或撤 topic 只影响后续搜索。

## 内置示例（`resources/host-plugins/`）

- 目录：`resources/host-plugins/<id>/`（目录名必须等于 `manifest.id`，落位按目录名走），`extraResources` → `<resources>/host-plugins`，开发态取 `appPath/resources/host-plugins`（`src/main/plugins/builtinHostPlugins.ts`）；`seedBuiltin()` 在 `load()` 前落位到 `userData/host-plugins/<id>/`。目录缺失只少一个面板，内置插件是可选示例而不是功能依赖。
- 当前两个内置插件：

| id | 演示了什么 | 权限 | 面板 |
| --- | --- | --- | --- |
| `billion-context` | 本地服务点名与启停（适配器只认 service id） | `service.local` | `popover` |
| `session-groups` | 只读会话目录 + 工作区分组 + 工作台跳转 + 私有 `storage` 持久化；首个 `page` 形态完整示例（按目录建组，上游 [Lamb-Yang/pideck-plugin](https://github.com/Lamb-Yang/pideck-plugin) 的随包副本，见该目录 README 的同步说明） | `sessions.read`、`sessions.read.workspace`、`workbench.navigate` | `page` |

- `session-groups` 的分组关系只写插件自己的 `storage`（`ws.meta` + 每个分组一个 `ws.g.<groupId>`；分组可带 `dirs` 目录范围，超 800 条 id 自动分片到 `ws.g.<groupId>.<n>`；旧版按项目隔离的 `grp.<projectId>` 会一次性并入且保留原键），不写会话文件、不联网；它没有网络/服务权限。
- 内置插件的能力面在 `tests/builtinHostPlugins.test.mjs` 的登记表里锁定：目录与登记表必须一一对应，权限/面板形态变化会让测试先红——因此把上游新版复制进来（尤其上游新增 `network.*` / `service.local`）时必须先审一遍数据外发与命令执行风险、改登记表，再随包。
- 落位、升级、卸载语义与「本地服务」一节同一套：落位 ≠ 授权（首次仍是 `requiresConsent`），只有内容仍等于上次落位指纹才随新版替换并顺延授权（权限扩大时不再顺延），手改过的副本永不被覆盖；`seeded` 里的 id 拒绝卸载（`plugin-builtin`，要停用请用禁用）。

## pi-context 本地适配

`scripts/convert-pi-context-host-plugin.mjs <pi-context 目录> <输出目录>` 把本地 pi-context 的 viewer 一次性转换为宿主插件：

- 只转换无 import 的纯模型层与 viewer 静态资产；IO/导航/刷新生命周期改走 `resources/host-plugin-adapters/pi-context/` 的桥接层。
- 输出必须在新目录（`wx` 独占创建，不覆盖既有包与授权身份），产物默认禁用，需在设置 → PiDeck 插件里手动启用。
- 第三方代码不 vendoring、不自动启用；上游接缝变化（精确字符串匹配失败）时报错而不是生成不确定产物。
- 转换后的 viewer 通过 `sessions.*` 获取数据，不依赖原 BAT / Web 服务，不需要网络权限。

## 开发与验证

- 网络回归：`node --test tests/hostPluginNetwork.test.mjs tests/hostPluginNetworkTransport.test.mjs tests/hostPluginNetworkUi.test.mjs tests/hostPluginNetworkDemo.test.mjs`（策略/撤权、真实 hop 的替身 socket、授权展示、静态 demo；不启动服务或连接真实接口）。
- 回归测试：`node --test tests/hostPlugins.test.mjs`（manifest/授权/隔离视图/预算/跨项目 fork/撤销提交）、`node --test tests/hostPluginScaffold.test.mjs`（脚手架产物与新增 API 面）、`node --test tests/hostPluginDirectoryInstall.test.mjs`（目录安装）、`node --test tests/hostPluginArchive.test.mjs`（归档）、`node --test tests/hostPluginMarket.test.mjs`（双源搜索/去重/单源降级/缓存/registry 解析）、`node --test tests/builtinHostPlugins.test.mjs`（随包内置插件的出厂契约与能力面登记）、`node --test tests/piContextHostAdapter.test.mjs`（转换器）。
- 主进程模块在 `src/main/plugins/`（含 `hostPluginScaffold.ts` / `hostPluginGitHub.ts` / `hostPluginMarket.ts`）；IPC 入口 `src/main/ipc/hostPluginsIpc.ts`；共享契约 `src/shared/types/hostPlugin.ts`；preload 白名单 `src/preload/hostPlugin.ts`。面向插件作者的完整文档是 `docs/host-plugin-dev-guide.md`（同一份文件同步上官网 `/guide/host-plugins`）；插件模板与收录仓库是 [ayuayue/pideck-plugins](https://github.com/ayuayue/pideck-plugins)。
