# PiDeck 宿主插件（Host Plugins）

> 第一阶段独立插件系统：不依赖 pi 进程，向 PiDeck 桌面壳（而非 pi RPC）注册 UI 面板与受限 API。
> 设计动机：现有扩展点（pi 扩展 + GUI 桥）依赖 pi 进程且受 `ctx.ui` 降级限制；宿主插件让纯查看器/工具类扩展（如 pi-context）直接挂在 PiDeck 上。

## 与既有机制的关系

| 机制 | 归属 | 适用 |
|------|------|------|
| pi 扩展 + GUI 桥（`pi-deck-gui-bridge`） | pi 进程内 | 需要读会话流/拦截模型请求的扩展 |
| 主题定制 | 渲染层 | 纯视觉 |
| **宿主插件（本文档）** | PiDeck 主进程 | 只读会话数据的本地 UI 工具 |

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

- `permissions` 目前支持 `sessions.read`、`workbench.navigate` 与 `storage`（storage 无需声明，见下）；未知权限直接拒绝加载。
- 资产上限：单文件 4 MiB、整包 16 MiB、100 个文件、目录深度 8；禁止符号链接。
- 面板入口必须是包内相对路径（拒绝 `../` 逃逸），资产只允许 html/js/mjs/css/json/svg/png/jpg/webp/woff2。

## 授权与指纹

- 插件默认禁用。启用动作绑定**整包逐文件 sha256 指纹**（不是版本号）：任何文件变化都会使授权失效并要求重新确认（`plugin-changed`）。
- manifest 只读一次——哈希与解析消费同一份字节，杜绝「两次读取之间改 permissions 复用旧授权」的 TOCTOU。
- 运行时重新读取资产还会比对授权时记录的 digest（`plugin-code-changed`）。

## 运行环境

- 每个面板实例一个独立 `WebContentsView`：`sandbox: true`、`contextIsolation: true`、无 Node、专属 `partition`，CSP `connect-src 'none'`（无网络）。
- 自定义协议 `pideck-plugin://<instance>/...` 只解析本实例的包内资产。
- 页面通过注入的 `window.pideck` API 访问能力；请求绑定发送者 frame，切换项目/禁用后未完成的响应被作废（`plugin-revoked`）。
- 并发请求上限 10/实例，超出返回 `rate-limited`。

## 会话数据 API（`sessions.read`）

- `sessions.list`：仅当前项目的已保存会话，分页 100 条。
- `sessions.entries`：读会话**活跃分支**的历史（含 compaction/custom 条目，不含 provider 输入），带游标分页；单条上限 256 KiB、单页 1 MiB，超限条目以 `truncated` 标记省略。
- **跨项目隔离**：会话 id 必须属于当前项目；fork 祖先链每一跳都按 catalog 重新授权，跨项目祖先自动降级为单文件读（绝不合并外部项目消息）。
- **资源预算**：单次请求（含祖先链全部文件）扫描上限 64 MiB / 10 万条，超限抛稳定错误码 `history-too-large`；索引内存不保留超长 compaction summary（分页读原始字节不受影响）。
- 插件索引使用单槽缓存（只随最后访问的会话 bounded），与桌面历史的 LRU 隔离。

## 工作台导航（`workbench.navigate`）

- `pideck.workbench.navigate(sessionId, entryId?)`：让 PiDeck 选中该会话并滚动到指定时间线条目（`entryId` 可省略，省略时落到底部）。
- Broker 门禁与 `sessions.entries` 同源：目标会话必须属于当前项目，否则 `session-not-authorized`；导航事件不携带任何插件数据。
- pi-context viewer 的「在浏览器中查看」按钮即走此链路：转换器给模型行补 `id`，桥接层 `host.locate` 反查快照行 → `navigate`。

## 存储（`storage`）

- 每插件一个 64 KiB JSON 文件，键名白名单 `[a-zA-Z0-9_.-]{1,80}`（拒 `__proto__` 等）。
- 写入走 tmp + 原子 rename；rename 瞬态锁（EPERM/EBUSY）退避重试约 300ms，**每次尝试前复查授权**——重试窗口内插件被禁用时中止提交（`plugin-revoked`），绝不覆盖正式文件。

## 分发与安装（`.pideck-plugin`）

- 格式：NDJSON 单文件（header 行 + 每文件一行 base64 + sha256），与目录包同一套预算（单文件 4MiB / 展开 16MiB / 100 文件 / 深度 8）；归档总体上限 24MiB。选自描述行格式而非 zip：无运行时解压依赖，预算与逐文件校验内建在解析器（`src/main/plugins/hostPluginArchive.ts`）。
- 打包：`node scripts/pack-host-plugin.mjs <插件目录> [输出.pideck-plugin]`。
- 安装：设置 → 扩展 → 桌面插件 →「从文件安装…」。文件选择在主进程对话框内完成，渲染层不传路径；提取到隐藏 temp 目录 → 走 `readHostPluginPackage` 全量验证 → 原子换入，失败自动清理。
- 替换语义：启用中的插件拒绝替换（`plugin-in-use`，先禁用再装）；禁用状态重装同 id 允许，字节一致则指纹不变，内容变化则旧授权失效。

## pi-context 本地适配

`scripts/convert-pi-context-host-plugin.mjs <pi-context 目录> <输出目录>` 把本地 pi-context 的 viewer 一次性转换为宿主插件：

- 只转换无 import 的纯模型层与 viewer 静态资产；IO/导航/刷新生命周期改走 `resources/host-plugin-adapters/pi-context/` 的桥接层。
- 输出必须在新目录（`wx` 独占创建，不覆盖既有包与授权身份），产物默认禁用，需在设置 → 扩展 → 桌面插件里手动启用。
- 第三方代码不 vendoring、不自动启用；上游接缝变化（精确字符串匹配失败）时报错而不是生成不确定产物。

## 开发与验证

- 回归测试：`node --test tests/hostPlugins.test.mjs`（manifest/授权/隔离视图/预算/跨项目 fork/撤销提交）、`node --test tests/piContextHostAdapter.test.mjs`（转换器）。
- 主进程模块在 `src/main/plugins/`；IPC 入口 `src/main/ipc/hostPluginsIpc.ts`；共享契约 `src/shared/types/hostPlugin.ts`；preload 白名单 `src/preload/hostPlugin.ts`。
