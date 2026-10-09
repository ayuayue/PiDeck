---
title: 宿主插件开发指南
---

# PiDeck 宿主插件开发指南

> 宿主插件（Host Plugin）是挂在 **PiDeck 桌面壳**上的本地静态扩展：不依赖 pi 进程、不能联网、不能执行命令，通过受限 API 读取当前项目的会话数据并展示自己的面板。
> 适合做「会话数据查看器 / 统计工具 / 可视化面板」这类扩展；需要拦截模型请求或深度接入 pi 会话流的场景请继续使用 pi 扩展 + GUI 桥。

## 与其他扩展机制的区别

| 机制 | 运行位置 | 能力边界 | 适用 |
|------|---------|---------|------|
| pi 扩展（+ GUI 桥） | pi 进程内 | 会话流、模型请求拦截 | 深度 pi 集成 |
| 主题定制 | 渲染层 | 纯视觉 | 换肤 |
| **宿主插件** | PiDeck 主进程沙箱 | 只读会话 + 工作台导航 + 小存储 | 本地查看器/工具 |

## 五分钟上手

一个宿主插件就是一个包含 `pideck-plugin.json` 的目录：

```
my-plugin/
├── pideck-plugin.json
├── app.html        # 面板入口（manifest 里声明）
├── app.js
└── styles.css
```

最小 manifest：

```json
{
	"schemaVersion": 1,
	"apiVersion": 1,
	"id": "example.viewer",
	"name": "Viewer",
	"version": "1.0.0",
	"permissions": ["sessions.read"],
	"contributes": {
		"panels": [{ "id": "main", "title": "Viewer", "entry": "app.html" }],
		"commands": [{ "id": "open", "title": "Open viewer", "panelId": "main" }]
	}
}
```

把目录放进 PiDeck 的插件目录（设置 → PiDeck 插件 → 打开插件目录），重新扫描，即可看到插件——默认禁用，点「授权并启用」完成指纹授权后面板即可挂载。

### manifest 字段

| 字段 | 规则 |
|------|------|
| `schemaVersion` / `apiVersion` | 固定 `1` |
| `id` | 小写字母开头，`[a-z0-9.-]`，≤80 字符；同时是安装目录名 |
| `name` / `version` / `description` | 常规字符串（name/version 必填） |
| `permissions` | `sessions.read`（读会话）、`workbench.navigate`（导航时间线） |
| `contributes.panels` | 1–8 个；`entry` 必须是包内相对路径 |
| `contributes.commands` | 0–16 个；出现在 PiDeck 命令面板（Ctrl+K） |

## 运行环境与安全模型

- 每个面板实例一个独立沙箱视图：`sandbox: true`、无 Node、专属 partition，CSP `connect-src 'none'`（**完全无网络**）。
- 页面只能通过注入的 `window.pideck` 对象访问能力；请求绑定当前面板实例，插件禁用/切换项目后未完成的请求作废（`plugin-revoked`）。
- 并发请求上限 10/实例。
- 授权绑定**整包逐文件 sha256 指纹**：任何文件变化都会使授权失效，必须重新确认（「内容已变更，需重新授权」）。
- 预算：单文件 4 MiB / 整包 16 MiB / 100 文件 / 目录深度 8；禁止符号链接；路径不得包含 `..`、反斜杠或绝对路径。

## `window.pideck` API 参考

```js
const ctx = await pideck.context(); // { projectId, locale, theme }
const page = await pideck.sessions.list(offset); // 当前项目已保存会话，分页 100
const history = await pideck.sessions.entries(sessionId, cursor, limit); // 活跃分支历史，游标分页
await pideck.workbench.navigate(sessionId, entryId); // 让 PiDeck 打开会话并定位条目（需权限）
const value = await pideck.storage.get(key); // 每插件 64KiB JSON 小存储
await pideck.storage.set(key, value);
pideck.onChange(() => location.reload()); // 项目/会话变更通知
```

- `sessions.entries` 返回 `{ entries, nextCursor, truncated }`：单条上限 256 KiB、单页 1 MiB，超限条目以 `truncated` 标记省略；单次请求（含 fork 祖先链）扫描上限 64 MiB / 10 万条，超限报 `history-too-large`。
- 会话必须属于当前项目（含 fork 祖先链逐跳校验），跨项目一律 `session-not-authorized`。
- `storage` 键名白名单 `[a-zA-Z0-9_.-]{1,80}`；写入原子提交，重试窗口内撤销会中止（`plugin-revoked`）。

## 打包与分发（`.pideck-plugin`）

```bash
node scripts/pack-host-plugin.mjs <插件目录> [输出.pideck-plugin]
```

- 格式：NDJSON 单文件（header 行 + 每文件一行 base64 + sha256），与目录包同一套预算；归档上限 24 MiB。
- 安装：设置 → PiDeck 插件 →「从文件安装…」（文件选择在主进程完成）。安装后默认禁用，需重新授权。
- 更新语义：**启用中的插件拒绝被替换**（`plugin-in-use`），先禁用再装；禁用状态重装同 id 时，字节一致则指纹不变、内容变化则旧授权失效。

## 复用现有工具：转换 pi-context

仓库自带的转换器把本地 pi-context 的 viewer 一次性转成宿主插件（IO/导航/刷新走桥接层，不执行第三方代码）：

```bash
node scripts/convert-pi-context-host-plugin.mjs "<pi-context 目录>" "<输出目录>"
```

输出默认禁用；上游接缝变化时转换器报错而不是生成不确定产物。

## 常见错误码

| 错误码 | 含义 |
|--------|------|
| `permission-denied` | manifest 未声明所需权限 |
| `session-not-authorized` | 会话不属于当前项目 |
| `history-too-large` | 会话历史超出读取预算 |
| `plugin-changed` / `plugin-code-changed` | 指纹变化，授权失效 |
| `plugin-revoked` | 插件已禁用/卸载，请求作废 |
| `plugin-in-use` | 启用中的插件拒绝被安装替换 |
| `rate-limited` | 并发请求超限 |
| `archive-*` | 分发归档格式/哈希/预算问题 |

## 调试建议

- 面板是普通 Web 页面：在面板上右键 → 检查即可用 DevTools（仅该实例）。
- `pideck.context().theme` 跟随 PiDeck 明暗主题，`locale` 跟随界面语言，建议适配。
- 回归测试参考 `tests/hostPlugins.test.mjs`、`tests/hostPluginArchive.test.mjs`；架构与内部模块说明见仓库 `docs/host-plugins.md`。
