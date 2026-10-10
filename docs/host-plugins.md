# PiDeck 宿主插件（Host Plugins）

> 第一阶段独立插件系统：不依赖 pi 进程，向 PiDeck 桌面壳（而非 pi RPC）注册 UI 面板与受限 API。
> 设计动机：现有扩展点（pi 扩展 + GUI 桥）依赖 pi 进程且受 `ctx.ui` 降级限制；宿主插件让纯查看器/工具类扩展（如 pi-context）直接挂在 PiDeck 上。

## 与既有机制的关系

| 机制 | 归属 | 适用 |
|------|------|------|
| pi 扩展 + GUI 桥（`pi-deck-gui-bridge`） | pi 进程内 | 需要读会话流/拦截模型请求的扩展 |
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

- `permissions` 白名单：`sessions.read`（读会话）、`workbench.navigate`（导航时间线）、`workbench.openExternal`（系统浏览器开 https）、`network.https`（受控公网 HTTPS）、`network.local`（受控固定端口本地 HTTP）；未知权限直接拒绝加载。网络权限必须配对应的 `network.httpsOrigins` / `network.localPorts`，每类 1–16 个不重复目的地。`storage` 不需要权限，每插件一个独立命名空间（见下）。
- 资产上限：单文件 4 MiB、整包 16 MiB、100 个文件、目录深度 8；禁止符号链接。
- 面板 `entry` 必须是包内相对路径且以 `.html` 结尾（拒 `../` 逃逸）；可服务扩展名固定为 `HOST_PLUGIN_MIME`：html/js/mjs/css/json/svg/png/jpg/webp/woff2，`pideck-plugin.json` 自身永不可服务（`asset-not-allowed`）。资产路径只允许 `^[a-zA-Z0-9_./-]+$`（空格/中文文件名无法引用）。可选 `icon` 走 `src/shared/hostPluginIcons.ts` 白名单，可选 `presentation` 只接受 `modal`/`page`，其余值 fail closed 拒装（`src/main/plugins/hostPluginManifest.ts`）。

## 授权与指纹

- 插件默认禁用。启用动作绑定**整包逐文件 sha256 指纹**（不是版本号）：任何文件变化都会使授权失效并要求重新确认（`plugin-changed`）。
- manifest 只读一次——哈希与解析消费同一份字节，杜绝「两次读取之间改 permissions 复用旧授权」的 TOCTOU。
- 运行时重新读取资产还会比对授权时记录的 digest（`plugin-code-changed`）。
- 授权界面从 `HostPluginPermissionDetails` 的统一清单展示所有能力与精确 HTTPS origins / 本地端口。会话读取 + 联网同时存在时必须警告数据外发风险；本地端口授权必须警告服务可能有写入/管理能力。网络目的地变更同样改变指纹，不沿用旧授权。

## 运行环境

- 每个面板实例一个独立页面内 `<webview>`：`sandbox: true`、`contextIsolation: true`、无 Node、专属 `partition`，CSP `connect-src 'none'`（页面无直接网络；受控网络只走宿主 API）。
- 自定义协议 `pideck-plugin://<instance>/...` 只解析本实例的包内资产。
- 页面通过注入的 `window.pideck` API 访问能力；请求绑定发送者 frame，切换项目/禁用后未完成的响应被作废（`plugin-revoked`）。
- 频率限制：每实例同时最多 2 个在途请求、每秒最多 20 个请求（1s 滑窗口重置），超出返回 `rate-limited`。

## 会话数据 API（`sessions.read`）

- `sessions.list(offset?)`：仅当前项目的已保存会话，分页 100 条，offset ≤ 100000。
- `sessions.get(id)`：单会话元信息；归属判定与 list 同源，拿不到就 `session-not-authorized`（不泄露其他项目会话的存在性）。
- `sessions.search(query, limit?)`：按标题子串（大小写不敏感）搜当前项目，默认 20 条、上限 100；只查目录标题，不读历史文件。
- `sessions.entries`：读会话**活跃分支**的历史（含 compaction/custom 条目，不含 provider 输入），带游标分页；单条上限 256 KiB、单页 1 MiB，超限条目以 `truncated` 标记省略。
- **跨项目隔离**：会话 id 必须属于当前项目；fork 祖先链每一跳都按 catalog 重新授权，跨项目祖先自动降级为单文件读（绝不合并外部项目消息）。
- **资源预算**：单次请求（含祖先链全部文件）扫描上限 64 MiB / 10 万条，超限抛稳定错误码 `history-too-large`；索引内存不保留超长 compaction summary（分页读原始字节不受影响）。
- 插件索引使用单槽缓存（只随最后访问的会话 bounded），与桌面历史的 LRU 隔离。
- **字段剥离**：条目过 `projectValue`（`src/main/sessions/boundedEntryPage.ts`）——剔除 `cwd`/`parentSession`/`sessionFile`/`filePath` 与图片内联字节（`data`/`imageRef`/`url`/`source`），递归深度上限 24。
- **游标绑定文件版本**：`nextCursor` 带版本，文件变了报 `stale-cursor`；读取期间文件被改写则整页作废（`history-changed`）。
- **变更推送**：面板挂载后主进程轮询目录签名（`changeSince`），活跃会话追加推送 `{ sessionId }`、目录级变化推送 `{ catalogChanged: true }`，面板据此做定向重读而不是全量轮询。

## 工作台导航（`workbench.navigate` / `workbench.openExternal`）

- `pideck.workbench.navigate(sessionId, entryId?)`：让 PiDeck 选中该会话并滚动到指定时间线条目（`entryId` 可省略，省略时落到底部）。
- Broker 门禁与 `sessions.entries` 同源：目标会话必须属于当前项目，否则 `session-not-authorized`；导航事件不携带任何插件数据。
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
- 替换语义：启用中的插件拒绝替换（`plugin-in-use`，先禁用再装）；禁用状态重装同 id 允许，字节一致则指纹不变，内容变化则旧授权失效。

## pi-context 本地适配

`scripts/convert-pi-context-host-plugin.mjs <pi-context 目录> <输出目录>` 把本地 pi-context 的 viewer 一次性转换为宿主插件：

- 只转换无 import 的纯模型层与 viewer 静态资产；IO/导航/刷新生命周期改走 `resources/host-plugin-adapters/pi-context/` 的桥接层。
- 输出必须在新目录（`wx` 独占创建，不覆盖既有包与授权身份），产物默认禁用，需在设置 → PiDeck 插件里手动启用。
- 第三方代码不 vendoring、不自动启用；上游接缝变化（精确字符串匹配失败）时报错而不是生成不确定产物。
- 转换后的 viewer 通过 `sessions.*` 获取数据，不依赖原 BAT / Web 服务，不需要网络权限。

## 开发与验证

- 网络回归：`node --test tests/hostPluginNetwork.test.mjs tests/hostPluginNetworkTransport.test.mjs tests/hostPluginNetworkUi.test.mjs tests/hostPluginNetworkDemo.test.mjs`（策略/撤权、真实 hop 的替身 socket、授权展示、静态 demo；不启动服务或连接真实接口）。
- 回归测试：`node --test tests/hostPlugins.test.mjs`（manifest/授权/隔离视图/预算/跨项目 fork/撤销提交）、`node --test tests/hostPluginScaffold.test.mjs`（脚手架产物与新增 API 面）、`node --test tests/hostPluginDirectoryInstall.test.mjs`（目录安装）、`node --test tests/hostPluginArchive.test.mjs`（归档）、`node --test tests/piContextHostAdapter.test.mjs`（转换器）。
- 主进程模块在 `src/main/plugins/`（含 `hostPluginScaffold.ts`）；IPC 入口 `src/main/ipc/hostPluginsIpc.ts`；共享契约 `src/shared/types/hostPlugin.ts`；preload 白名单 `src/preload/hostPlugin.ts`。面向插件作者的完整文档是 `docs/host-plugin-dev-guide.md`（同一份文件同步上官网 `/guide/host-plugins`）。
