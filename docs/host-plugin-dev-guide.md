---
title: 宿主插件开发指南
---

# PiDeck 宿主插件开发指南

> **宿主插件（Host Plugin）** 是挂在 **PiDeck 桌面壳**上的本地静态扩展：一组 HTML / CSS / JS 文件放进一个目录，配一个 `pideck-plugin.json` 声明，就能在 PiDeck 里拥有自己的面板，读取当前项目的会话数据。
>
> 它属于 **PiDeck 的能力域**（不依赖 pi 进程、不联网、不执行命令）。需要拦截模型请求、深度接入 pi 会话流的场景，请改用 pi 扩展 + GUI 桥，见 `docs/plugin-dev-guide.md`。

---

## 1. 先看清边界：能做什么、不能做什么

| ✅ 能做 | ❌ 不能做 |
|--------|----------|
| 在 PiDeck 里注册自己的面板（大弹框 `modal` 或工作区内联页 `page`） | 联网（`fetch`/`XMLHttpRequest`/WebSocket 一律不可用，CSP `connect-src 'none'`） |
| 读取**当前项目**的会话目录：`sessions.list` / `get` / `search` | 读取其他项目的会话、读取任意本地文件 |
| 读取会话的活跃分支历史：`sessions.entries`（分页、有预算） | 修改会话、发消息、调用 pi 或任何 RPC 命令 |
| 让 PiDeck 打开某个会话并定位到某条消息：`workbench.navigate` | 让 PiDeck 执行任意动作（没有通用 IPC 通道） |
| 用系统浏览器打开 https 链接：`workbench.openExternal` | 打开本地文件、`file://`、带账号密码的 URL |
| 每插件 1 MiB 私有 JSON 存储：`storage.*` | 访问别的插件的数据或应用数据目录 |
| 订阅 `context.changed` / `sessions.changed` 事件做实时刷新 | 访问 `require` / `process` / `ipcRenderer` / Node 或 Electron API |
| 注册命令到 PiDeck 命令面板（Ctrl+K） | 注册全局快捷键、改 PiDeck 界面、注入脚本到主界面 |

适合做的：**会话数据查看器、统计面板、本地可视化、批量导出预览**这类「只读 + 展示」工具。

## 2. 需要什么环境

| 项目 | 要求 |
|------|------|
| 写代码 | 任意文本编辑器。**不需要** Node、npm、打包器、TypeScript——插件就是浏览器里的 HTML/CSS/JS |
| 运行 | 一个已安装的 PiDeck（面板运行时在主进程沙箱里，与 pi 版本无关） |
| 调试 | PiDeck 内置的开发者工具（面板上右键 → 检查） |
| 打包/转换脚本 | Node 20+（只有在跑 `scripts/pack-host-plugin.mjs` 等命令行脚本时才需要） |
| 网络 | 全程不需要 |

## 3. 五分钟做出第一个插件（推荐路径）

### 3.1 用脚手架生成（设置 → PiDeck 插件 → 「新建插件…」）

1. 打开 **设置 → PiDeck 插件**；
2. 点 **「新建插件…」**，填：
   - **插件 ID**：小写字母开头，`[a-z0-9.-]`，≤80 字符，例如 `demo.viewer`（同时是生成目录名）；
   - **显示名**：面板与命令里的名字；
   - **权限**：按需勾选 `sessions.read` / `workbench.navigate` / `workbench.openExternal`（默认已勾 `sessions.read`）；
   - **面板形态**：`modal`（大弹框，默认）或 `page`（工作区内联页）；
3. 生成后目录出现在插件目录里，并自动重新扫描（默认**禁用**）；
4. 在列表里点 **「授权并启用」**；
5. 从侧栏入口或命令面板（Ctrl+K）打开面板。

生成物各自的作用：

| 文件 | 作用 |
|------|------|
| `pideck-plugin.json` | manifest：ID、权限、面板与命令声明。**权限以它为准** |
| `app.html` | 面板入口。manifest 的 `entry` 必须指向一个 `.html`，且只能在包内 |
| `app.js` | 示例逻辑：读 context、列会话、翻历史、存一点私有状态 |
| `styles.css` | 消费 PiDeck 注入的主题变量（`--color-*`），亮暗色自动适配 |
| `README.md` | 改哪里、怎么打包、约束清单 |

> 脚手架按你勾的权限生成代码：没勾 `sessions.read` 就不会出现会话列表代码，模板与 manifest 永远一致。

### 3.2 开发循环

```
改 app.js / styles.css
      ↓
设置 → PiDeck 插件 → 「重新扫描」        ← 内容变了会要求重新授权
      ↓
「授权并启用」→ 打开面板 → 右键 → 检查   ← 看 console / 断点
```

**为什么改一行就要重新授权**：授权绑的是**整包逐文件 sha256 指纹**，而不是版本号。任何文件变化都视为「新代码」，必须重新确认——这是防止「先让你读一个无害版本、再偷偷换成读你数据的版本」的核心机制。开发期这是常态，写好之后不再改动就没有这一步。

### 3.3 不用脚手架：手写一个最小插件

```
my-plugin/
├── pideck-plugin.json
├── app.html
├── app.js
└── styles.css
```

`pideck-plugin.json`：

```json
{
	"schemaVersion": 1,
	"apiVersion": 1,
	"id": "example.viewer",
	"name": "Viewer",
	"version": "1.0.0",
	"description": "最小示例：列出当前项目的会话",
	"permissions": ["sessions.read"],
	"contributes": {
		"panels": [{ "id": "main", "title": "Viewer", "entry": "app.html", "icon": "message", "presentation": "page" }],
		"commands": [{ "id": "open", "title": "打开 Viewer", "panelId": "main" }]
	}
}
```

`app.html`：

```html
<!doctype html>
<html lang="zh-CN">
	<head>
		<meta charset="utf-8" />
		<link rel="stylesheet" href="styles.css" />
	</head>
	<body>
		<h1 id="title">Viewer</h1>
		<ul id="list"></ul>
		<script type="module" src="app.js"></script>
	</body>
</html>
```

`app.js`：

```js
const context = await window.pideck.context.get();
const page = await window.pideck.sessions.list();
document.getElementById("title").textContent = `${context.projectName ?? "未选择项目"} · ${page.sessions.length} 个会话`;

for (const session of page.sessions) {
	const item = document.createElement("li");
	item.textContent = session.title; // 永远用 textContent，不要 innerHTML
	document.getElementById("list").append(item);
}
```

把目录放进插件目录（设置 → PiDeck 插件 → 「打开插件目录」），点「重新扫描」→「授权并启用」，面板即可挂载。

> 已经有 pi-context？不用手写，见第 9 节的一次性转换脚本。

## 4. 目录、manifest 与包预算

### 4.1 manifest 全字段

| 字段 | 必填 | 规则 |
|------|------|------|
| `schemaVersion` / `apiVersion` | ✅ | 固定 `1`。写成别的值直接拒绝（fail closed） |
| `id` | ✅ | `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`，≤80 字符；同时是安装目录名，全局唯一 |
| `name` | ✅ | 非空，≤160 字符，无控制字符 |
| `version` | ✅ | 非空，≤160 字符（仅用于展示，授权不看它） |
| `description` | — | ≤1000 字符 |
| `permissions` | ✅ | 数组，只能取 `sessions.read` / `workbench.navigate` / `workbench.openExternal`，不能重复；未知权限拒装 |
| `contributes.panels` | ✅ | 1–8 个。`id`（同上 ID 规则）、`title`（≤160）、`entry`（包内相对路径，**必须以 `.html` 结尾**）、`icon`（白名单，可选）、`presentation`（`modal` 或 `page`，可选） |
| `contributes.commands` | ✅ | 0–16 个。`id`、`title`、`panelId` 必须指向已声明的面板 |

- **`icon` 白名单**：`bar-chart`、`activity`、`database`、`table`、`calendar`、`file-text`、`terminal`、`globe`、`git-branch`、`message`、`clock`、`layers`（见 `src/shared/hostPluginIcons.ts`）。不填或填未知名字都不会崩，未知名字直接拒装。
- **`presentation`**：`modal`（缺省）= 近全屏大弹框；`page` = 工作区内联页，非模态覆盖会话区，侧栏入口再点即关。统计/浏览类长驻面板建议 `page`。
- **`entry` 资源路径规则**：只用相对路径（`^[a-zA-Z0-9_./-]+$`，≤240 字符），不能以 `/` 开头，不能含 `..`、`.` 段。**文件名不要用空格或中文**，否则 HTML 里引用不到。

### 4.2 包预算（超出即拒装/拒载）

| 限制 | 值 |
|------|-----|
| 单文件 | 4 MiB |
| 整包 | 16 MiB |
| 文件数 | 100 |
| 目录深度 | 8 |
| 符号链接 | 一律禁止 |
| 可服务文件类型 | 只有 `.html` `.js` `.mjs` `.css` `.json` `.svg` `.png` `.jpg` `.webp` `.woff2`；`pideck-plugin.json` 本身不可被页面访问 |

### 4.3 面板页运行环境

- 每个面板实例是一个独立沙箱视图：`sandbox: true`、无 Node、无 Electron、专属 partition；
- 入口页由 PiDeck 用 `pideck-plugin://<实例ID>/app.html` 提供，引用包内文件用**相对路径**（不要带 `?query`）；
- CSP 由宿主注入：脚本样式只能来自本包，`connect-src 'none'`（**没有任何网络**）；
- 用 ES Module（`<script type="module" src="app.js">`）即可 `import` 包内其他模块。

## 5. `window.pideck` API 参考

面板里唯一可用的能力面就是 `window.pideck`（`apiVersion: 1`）。所有方法返回 Promise，失败时抛出 `Error`，`error.message` 是错误码（见第 7 节）。

| 方法 | 需要权限 | 返回 |
|------|---------|------|
| `pideck.apiVersion` | — | `1` |
| `pideck.context.get()` | — | `HostPluginContext` |
| `pideck.sessions.list(offset?)` | `sessions.read` | `{ sessions, nextOffset }` |
| `pideck.sessions.get(sessionId)` | `sessions.read` | `HostPluginSession` |
| `pideck.sessions.search(query, limit?)` | `sessions.read` | `HostPluginSession[]` |
| `pideck.sessions.entries(sessionId, cursor?)` | `sessions.read` | `{ entries, nextCursor, version, truncated }` |
| `pideck.storage.get(key)` | — | `unknown`（不存在为 `null`） |
| `pideck.storage.set(key, value)` | — | `void` |
| `pideck.storage.keys()` | — | `string[]`（自己的键） |
| `pideck.storage.remove(key)` | — | `void` |
| `pideck.workbench.navigate(sessionId, entryId?)` | `workbench.navigate` | `void` |
| `pideck.workbench.openExternal(url)` | `workbench.openExternal` | `void` |
| `pideck.onEvent(listener)` | — | 取消订阅函数 |

> 兼容策略：新能力只做加法。老插件不受影响；想探测新方法用 `typeof pideck.sessions.search === "function"`。

### 5.1 context

```ts
type HostPluginContext = {
	projectId?: string; // 当前项目（未选项目时为 undefined）
	projectName?: string; // 项目显示名（PiDeck 侧补全，可直接当标题用）
	sessionId?: string; // 当前会话
	sessionTitle?: string; // 当前会话标题（PiDeck 侧补全）
	locale: "zh-CN" | "en-US"; // 跟随界面语言
	theme: "light" | "dark"; // 跟随明暗主题
	tokens?: Record<string, string>; // 主题色变量（CSS 自定义属性）
};
```

```js
const { projectName, sessionTitle, locale, theme } = await pideck.context.get();
```

- 作用域由 **PiDeck 分配**，不接受插件传参：插件只能看到当前项目。
- `projectName` / `sessionTitle` 由 PiDeck 补全，插件自己伪造无效；拿不到就是 `undefined`，**不要假设一定有值**。

### 5.2 sessions

```js
// 目录分页：每页 100 条，offset 上限 100000
const page = await pideck.sessions.list(0); // → { sessions, nextOffset: number | null }

// 单条元信息：标题栏/详情页不必先翻页找
const session = await pideck.sessions.get("session-id");

// 标题搜索：只比对目录标题（不读历史文件），默认 20 条、上限 100
const hits = await pideck.sessions.search("重构", 50);

// 活跃分支历史：游标分页
const history = await pideck.sessions.entries("session-id"); // → { entries, nextCursor, version, truncated }
```

`HostPluginSession`：`{ id, projectId, title, updatedAt, createdAt, model?, readable }`。

`entries` 的边界（都需要记住）：

| 项 | 规则 |
|----|------|
| 分页方向 | **从最新往前**翻；`nextCursor` 为 `null` 表示到头 |
| 单页上限 | 100 条 / 1 MiB |
| 单条上限 | 256 KiB，超限条目被省略并置 `truncated: true` |
| 单次请求扫描预算 | 64 MiB / 10 万条（含 fork 祖先链全部文件），超限报 `history-too-large` |
| 游标 | `nextCursor` 自带文件版本；文件变了要重新从 `undefined` 开始（旧游标报 `stale-cursor`） |
| 读期间文件被改写 | 整页作废，报 `history-changed`，重读即可 |
| 图片 / 长压缩摘要 | 图片内联字节与超长 compaction summary 不会传给插件；分页读原始条目不受影响 |
| 被剥掉的字段 | `cwd`、`parentSession`、`sessionFile`、`filePath`，以及图片的 `data` / `imageRef` / `url` / `source` |
| `readable: false` | 该会话不可读（例如由别的后端创建），不要尝试读它的历史 |

### 5.3 storage（无需权限）

```js
await pideck.storage.set("layout", { mode: "compact" }); // 值必须是 JSON 可序列化
const layout = await pideck.storage.get("layout"); // 不存在返回 null
const keys = await pideck.storage.keys(); // 只有自己的键
await pideck.storage.remove("layout");
```

| 项 | 规则 |
|----|------|
| 容量 | 每插件 1 MiB，最多 200 个键（超限报 `storage-too-large` / `storage-full`） |
| 键名 | `[a-zA-Z0-9_.-]{1,80}`；`__proto__` / `prototype` / `constructor` 保留（报 `invalid-storage-key`） |
| 原子性 | 写盘走「临时文件 + 原子替换」；重试窗口内插件被撤销会中止（`plugin-revoked`） |
| 隔离 | 一个插件一个 JSON 文件；`keys()` 看不到别的插件 |

### 5.4 workbench

```js
await pideck.workbench.navigate("session-id", "entry-id"); // 让 PiDeck 打开该会话并定位到条目（entryId 可省）
await pideck.workbench.openExternal("https://github.com/ayuayue/PiDeck/blob/main/docs/host-plugin-dev-guide.md");
```

- `navigate` 只对**当前项目的可读会话**生效，否则 `session-not-authorized`；它由 PiDeck 主界面执行，插件页不做任何跳转。
- `openExternal` 只接受 **https** 且不能带账号密码；系统浏览器打开。带 `http:`、`file:`、`javascript:`、`pideck-plugin:` 一律 `invalid-request`。

### 5.5 事件

```js
const off = pideck.onEvent((event) => {
	if (event.type === "context.changed") render(event.context); // 新 context 在负载里
	if (event.type === "sessions.changed") reload(event.detail); // { catalogChanged, sessionId? }
});
// 面板卸载时记得 off()，避免重复订阅
```

| 事件 | 负载 | 何时发出 |
|------|------|---------|
| `context.changed` | `{ context }` | 切换项目/会话、切语言、切主题 |
| `sessions.changed` | `{ detail: { catalogChanged, sessionId? } }` | 目录级变化（新建/删除/归档/改名）→ `catalogChanged: true`；活跃会话追加 → `sessionId` |

只有变化过的会话需要重读，别每次事件都全量拉取。

### 5.6 主题与样式

PiDeck 把语义色注入为 CSS 变量（`:root`，随主题/语言实时更新），直接用即可：

`--color-bg-app`、`--color-bg-panel`、`--color-bg-input`、`--color-text-primary`、`--color-text-secondary`、`--color-border-default`、`--color-accent`、`--color-text-inverse`。

```css
body {
	background: var(--color-bg-panel, #1b1b1f);
	color: var(--color-text-primary, #e6e6e6);
}
.primary {
	background: var(--color-accent, #3b82f6);
	color: var(--color-text-inverse, #fff);
}
```

- 一定要带缺省值，且**不要**只按暗色硬编码——亮色主题下会看不清。
- `--color-accent` 是「面」色：文字要用 `--color-text-inverse`，别拿它当文字色。

## 6. 安全模型（为什么这些限制是这样）

| 机制 | 说明 |
|------|------|
| 沙箱视图 | 每面板一个独立 webview：`sandbox: true`、无 Node、专属 partition、CSP 禁网 |
| 唯一能力面 | 页面只能通过注入的 `window.pideck` 请求；没有通用 IPC、没有文件系统、没有 pi RPC |
| 请求绑定实例 | 每个请求绑定它所在的面板实例；插件被禁用、或作用域切走后未完成的结果直接作废（`plugin-revoked`） |
| 项目隔离 | 会话读取逐条校验归属（含 fork 祖先链逐跳校验）；跨项目一律 `session-not-authorized`，也不泄露「该会话是否存在」 |
| 指纹授权 | 授权 = 整包逐文件 sha256。内容一变授权即失效，必须重新确认；启用中的插件不能被静默替换（`plugin-in-use`） |
| 频率限制 | 每实例同时最多 2 个在途请求，每秒最多 20 个请求，超出 `rate-limited` |
| 隐私 | `projectName` / `sessionTitle` 由 PiDeck 补全；未授权项目的会话标题根本不会下发 |

## 7. 错误码

运行时请求（`error.message`）：

| 错误码 | 含义 | 怎么办 |
|--------|------|--------|
| `permission-denied` | manifest 未声明该权限 | 补 `permissions` 后重新扫描 + 重新授权 |
| `session-not-authorized` | 会话不属于当前项目（或不可读） | 只用 `sessions.list` 返回的 id |
| `history-unavailable` | 该会话没有可读的历史文件 | 以 `readable` 判断 |
| `history-too-large` | 本次读取超扫描预算 | 分页、缩小范围，不要整包拉 |
| `history-changed` / `stale-cursor` | 读期间文件变化 / 游标过期 | 清掉游标重新从 `undefined` 拉 |
| `invalid-request` / `invalid-offset` / `invalid-context` | 参数不合法（offset 上限 100000、search limit 1–100…） | 按第 5 节的范围传参 |
| `rate-limited` | 超出并发/频率 | 合并请求、加节流 |
| `plugin-revoked` / `plugin-not-authorized` | 插件已被禁用/卸载，或请求来自非面板页 | 让用户重新启用；不要在其他页面直接用 |
| `storage-too-large` / `storage-full` | 存储超 1 MiB / 超 200 键 | 精简数据或分片存 |
| `invalid-storage-key` | 键名不合法或命中保留字 | 用 `[a-zA-Z0-9_.-]{1,80}` |
| `unsupported-method` | 请求了不存在的 API | 检查 `apiVersion` |

加载/安装/发布：

| 错误码 | 含义 |
|--------|------|
| `missing-manifest` | 目录里没有 `pideck-plugin.json`（选错目录/选到父目录） |
| `invalid-manifest` / `invalid-panel` / `invalid-command` / `invalid-contributions` | manifest 字段不合法（ID、title、entry、panelId…） |
| `invalid-panel-icon` / `invalid-panel-presentation` | icon 不在白名单 / presentation 不是 `modal`\|`page` |
| `duplicate-panel` / `duplicate-command` / `duplicate-plugin-id` | id 重复 |
| `unsupported-permission` | 权限不在允许集合内 |
| `missing-panel-entry` / `invalid-asset` / `asset-not-allowed` | 入口或资产路径不合法（缺文件、`..`、绝对路径、非法字符） |
| `asset-too-large` / `package-too-large` / `package-too-deep` / `invalid-package-file` / `symlink-not-allowed` | 超出包预算（见 4.2） |
| `already-exists` | 脚手架：目标目录已存在（不覆盖作者代码） |
| `plugin-changed` / `plugin-code-changed` | 内容变了，授权失效 → 重新授权 |
| `plugin-in-use` | 启用中的插件拒绝被安装替换 → 先禁用 |
| `archive-*` | 分发归档格式/哈希/预算问题（`archive-hash-mismatch` 等） |

## 8. 调试

- **面板是普通网页**：在面板上右键 → 检查，即可用 DevTools（只作用于该实例，看不到其他面板）。
- **白屏**：99% 是 `app.js` 抛错——先看 console；其次是 manifest 的 `entry` 指错、文件名带空格/中文。
- **改文件后面板没变**：内容变了必须**重新扫描 + 重新授权**（指纹机制），旧实例会被卸载。
- **想脱离 PiDeck 调 UI**：可以在普通浏览器里起个假 `window.pideck` 来调样式，但权限/沙箱行为仍要在 PiDeck 里验证：

```html
<script>
	window.pideck = {
		context: { get: async () => ({ locale: "zh-CN", theme: "dark", projectName: "假项目" }) },
		sessions: { list: async () => ({ sessions: [{ id: "a", projectId: "p", title: "假会话", updatedAt: Date.now(), createdAt: 0, readable: true }], nextOffset: null }) },
		onEvent: () => () => {},
	};
</script>
```

- **插件目录在哪**：设置 → PiDeck 插件 → 「打开插件目录」（即应用数据目录下的插件目录）。
- 回归测试参考：`tests/hostPlugins.test.mjs`、`tests/hostPluginScaffold.test.mjs`、`tests/hostPluginArchive.test.mjs`。

## 9. 打包与分发（`.pideck-plugin`）

```bash
node scripts/pack-host-plugin.mjs <插件目录> [输出.pideck-plugin]
```

- 格式：单文件 NDJSON（header 行 + 每文件一行 base64 + sha256），与目录包同一套预算；归档上限 24 MiB。
- 安装（两条路径信任判定完全一致，装完都是**禁用 + 需重新授权**）：
  - **「从文件安装…」**：选 `.pideck-plugin` 归档（文件选择在主进程完成，渲染层不传路径）；
  - **「从文件夹安装…」**：直接选**已解压的插件目录**（就是含 `pideck-plugin.json` 的那一层），适合开发目录；`.git`、`node_modules` 整棵跳过，路径形状不合法（带空格/中文名）或超限的文件也跳过而不会让整包失败。
- 更新语义：启用中的插件拒绝被替换（`plugin-in-use`），先禁用再装；禁用状态下重装同 id，字节一致则指纹不变、内容变化则旧授权失效。

## 10. 复用现有工具：转换 pi-context

仓库自带转换器，把本地 pi-context 的 viewer 一次性转成宿主插件（IO/导航/刷新走桥接层，**不执行第三方代码**）：

```bash
node scripts/convert-pi-context-host-plugin.mjs "<pi-context 目录>" "<输出目录>"
```

产物默认禁用；上游接缝变化时转换器报错而不是生成不确定产物。

## 11. 让 AI 帮你写插件

把这几样交给 AI（Claude Code / pi / 任意编码助手）就能直接开工：

1. 本文件（`docs/host-plugin-dev-guide.md`，官网同页 `/guide/host-plugins`）；
2. 脚手架产出的目录（`app.js` / `app.html` / `styles.css` 就是可运行的最小骨架）；
3. 约束清单（照抄给它）：

```
约束：
- 只用 window.pideck（context/sessions/storage/workbench/onEvent），没有 fetch、没有 Node、不能用 innerHTML 插入未转义文本
- 会话数据只读，且只属于当前项目；分页用 nextCursor / nextOffset，不要一次拉全量
- 视觉只消费 --color-* 变量并带缺省值；文案按 context.locale 出中英两份
- 权限最小化：默认只要 sessions.read，需要跳转/外链才加 workbench.navigate / workbench.openExternal，并同步改 manifest
- 改完必须提示「重新扫描 + 重新授权」（授权绑定内容指纹）
```

4. 让 AI 用第 3.2 节的开发循环自测：改文件 → 重新扫描 → 授权 → 打开面板看 console。

## 12. 参考与源码索引

| 内容 | 位置 |
|------|------|
| 架构与内部模块说明（贡献者向） | `docs/host-plugins.md` |
| manifest 校验规则 | `src/main/plugins/hostPluginManifest.ts` |
| 请求解析与上下文校验 | `src/main/plugins/hostPluginPolicy.ts` |
| 会话读取（权限/预算/描述补全） | `src/main/plugins/HostPluginSessions.ts` |
| 请求分发与频率限制 | `src/main/plugins/HostPluginBroker.ts` |
| 私有存储 | `src/main/plugins/HostPluginStorage.ts` |
| 包扫描与资产预算 | `src/main/plugins/hostPluginFiles.ts` |
| 归档格式 | `src/main/plugins/hostPluginArchive.ts` |
| 脚手架（本指南第 3 节） | `src/main/plugins/hostPluginScaffold.ts` |
| 面板运行时（webview + CSP + 主题注入） | `src/main/plugins/HostPluginViewHost.ts`、`src/renderer/src/hooks/plugins/useHostPluginView.ts` |
| 面板侧 API（唯一对外面） | `src/preload/hostPlugin.ts`、`src/shared/types/hostPlugin.ts` |
| icon 白名单 | `src/shared/hostPluginIcons.ts` |
| 测试 | `tests/hostPlugins.test.mjs`、`tests/hostPluginScaffold.test.mjs`、`tests/hostPluginDirectoryInstall.test.mjs`、`tests/hostPluginArchive.test.mjs` |
