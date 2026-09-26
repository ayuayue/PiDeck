# GUI 扩展桥（`pi-deck-gui-bridge`）

> 一个 pi 扩展，把 **pi 在 RPC 模式下被丢弃的声明式 UI 扩展点**接回 PiDeck。
>
> **写 GUI 扩展 = 用同一套 `ctx.ui` API 写扩展。** 不需要学 React，不需要构建管线。
> 另有一套 GUI 专属扩展点（`ctx.gui`），写法与 pi 原生扩展点**同形**。

> 📋 **只想查「哪个扩展点能用」** → 看 [扩展点参考](gui-extension-points.md)
> （权威清单：pi 原生 29 条 + 39 个事件 + PiDeck 专属 14 个落点，含每条的桥接状态与宿主）。
> 本文件讲**怎么用**，那份讲**有什么**。

---

## 一句话

桥上线后，**只有一种扩展要写** —— pi 扩展。
TUI 扩展与 GUI 扩展是同一个 `.ts`、同一个 manifest、同一个 `ctx`。

---

## 1. 为什么需要它

pi 以 `--mode rpc` 运行时没有终端，`rpc-mode.js` 里一批 UI 方法被实现成**空函数**：

| 方法 | RPC 下的行为 |
|---|---|
| `setStatus` | 只转发 `pideck:auto-title`，其余被 PiDeck 丢弃 |
| `setWidget(key, string[])` | ✅ 可用 |
| `setWidget(key, factory)` | ❌ **工厂形式被丢弃** |
| `setFooter(factory)` | ❌ 空实现 |
| `setHeader(factory)` | ❌ 空实现 |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | ❌ 空实现 |
| `setHiddenThinkingLabel` | ❌ 空实现 |
| `setTitle` | 转发，但 PiDeck 侧无落点 |
| `setEditorComponent` | ❌ 空实现 |
| `custom()` | ❌ 返回 `undefined` |
| `onTerminalInput()` | ❌ 空实现 |
| `addAutocompleteProvider()` | ❌ 空实现 |

桥在 `session_start` 里**包装一次共享的 `ctx.ui`**，把上表里被丢掉的点接回来。
（`ctx.ui` 是共享单例的活 getter，包装一次即对全部扩展生效。）

---

## 2. 安装

桥是 PiDeck 的**内置扩展**，随应用分发，无需手工安装。

它由 PiDeck 在 spawn pi 时通过 `-e` 注入，并注入三个环境变量：

| 环境变量 | 作用 |
|---|---|
| `PIDECK_BRIDGE_URL` | PiDeck 监听的桥端点（`http://127.0.0.1:<port>/bridge/<token>`） |
| `PIDECK_BRIDGE_TOKEN` | 本次 spawn 独享的令牌（多会话天然隔离） |
| `PIDECK_BRIDGE_PI_PATH` | pi 安装路径（桥据此定位**与 pi 同实例**的 pi-tui） |

**纯终端跑 pi 时**（没有这些环境变量）：桥**静默不工作**，pi 行为完全不变。

---

## 3. 直接用 `ctx.ui` 的扩展点（A 组）

这些**不需要 `ctx.gui`** —— 它们本来就是 pi 的 UI 扩展点，只是以前在 RPC 下是 no-op。

| 位置 | 方法 | 落在 PiDeck 的 |
|---|---|---|
| 顶部区 | `ctx.ui.setHeader(factory)` | 聊天区顶部 |
| 底部状态区 | `ctx.ui.setFooter(factory)` | 底部状态区 |
| 状态栏条目 | `ctx.ui.setStatus(key, text)` | 状态栏（多 key 共存） |
| 输入框挂件 | `ctx.ui.setWidget(key, factory \| string[], opts)` | 输入框上/下方 |
| 流式状态行 | `ctx.ui.setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | 流式状态行 |
| 折叠思考块标签 | `ctx.ui.setHiddenThinkingLabel(label)` | 思考块标题 |
| 会话标题 | `ctx.ui.setTitle(title)` | 会话标签 |
| 输入框本体 | `ctx.ui.setEditorComponent(factory)` | 输入框 |

### 语义（照抄 pi 自己的规则）

- `factory` 传 `undefined` → **恢复默认**（内置 header/footer/输入框）
- `setStatus` 传 `undefined` → 清除该 `key`
- `setWidget` 传 `undefined` → 移除该 widget
- 无 `key` 的 setter（header / footer / editorComponent）→ **最后设置的胜出**（pi 原语义）

### 示例：一个纯 TUI 扩展

```ts
import { Text, VStack } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    // 这一行在 TUI 里本来就能工作，在 PiDeck 里以前是 no-op —— 现在两边都能工作
    ctx.ui.setHeader((_tui, theme) =>
      new Text(theme.fg("accent", "我的扩展已加载")),
    );

    ctx.ui.setStatus("my-ext", "就绪");

    // 组件形式的 widget（RPC 下以前被直接丢弃）
    ctx.ui.setWidget("my-widget", (_tui, theme) => {
      const stack = new VStack();
      stack.addChild(new Text(theme.fg("muted", "组件 widget 也能显示了")));
      return stack;
    });
  });
}
```

**这个扩展完全不知道 PiDeck 存在**，但它写的 UI 会出现在 GUI 里。

---

## 4. GUI 专属扩展点（`ctx.gui`，B 组）

`ctx.gui` 的方法与 `ctx.ui` **同形**：同样的 `set*` 命名、同样的
`(…, theme) => Component` 工厂、同样的「传 `undefined` 即恢复默认」、
同样的「带 `key` 可多贡献共存」。作者不学新概念，只是多了几个可挂的位置。

| 方法 | 落在 PiDeck 的 |
|---|---|
| `ctx.gui.setSidebarPanel(key, factory, opts?)` | 侧边栏面板列表 |
| `ctx.gui.setSidebarSection(key, factory, opts?)` | 侧边栏内分区 |
| `ctx.gui.setContentView(key, factory, opts?)` | 主内容区 |
| `ctx.gui.setComposerToolbar(key, factory, opts?)` | 输入框工具栏 |
| `ctx.gui.setTitlebarAction(key, factory, opts?)` | 窗口 / 标签栏动作按钮 |
| `ctx.gui.setBanner(key, factory, opts?)` | 顶部横幅通知区 |
| `ctx.gui.setToolExtra(key, factory, opts?)` | 工具结果卡内部（`key` = `toolName`） |
| `ctx.gui.setMessageExtra(key, factory, opts?)` | 消息气泡内部下方（`key` = `role`） |
| `ctx.gui.setThinkingExtra(key, factory, opts?)` | 折叠思考块内 |
| `ctx.gui.setDialogAction(key, factory, opts?)` | 交互对话框按钮区 |
| `ctx.gui.setDialogBody(key, factory, opts?)` | 交互对话框主体下方 |
| `ctx.gui.setSettingsSection(key, factory, opts?)` | 设置弹窗内 |
| `ctx.gui.setSessionItemExtra(key, factory, opts?)` | 会话列表条目 |
| `ctx.gui.setContextMenuItem(key, factory, opts?)` | 右键菜单 |

**统一签名**：

```ts
type GuiFactory = (gui: GuiSurface, theme: GuiTheme, ctx: ExtensionContext) => GuiComponent | GuiNode;
type GuiSlotOptions = { title?: string; order?: number; placement?: "above" | "below" };
```

- `factory` 传 `undefined` → 移除该 key，位置**回到原样**（不占位）
- `opts.order` 缺省 `1000`，升序；同 `order` 按 key 字母序
- `opts.title` 可选，PiDeck 用它渲染分组标题

### 权力边界：只追加

- 扩展**只能往上面的位置插入内容**，**不能改动、不能顶掉** PiDeck 原有 UI
- 附加型位置（`toolExtra` / `messageExtra` / `thinkingExtra`）的语义是
  「**在默认内容旁边追加**」，**不是**「顶替默认内容」
- 同 `key` 重复设置 → **后设覆盖**
- 某位置 PiDeck 尚未实现 → 记为 pending，**不报错**

### 落点挂载现状

**A 组**（`ctx.ui` 的 pi 原生扩展点）—— 已挂载 7 / 8：

| 位置 | 落点 | 状态 |
|---|---|---|
| 顶部区 | `SessionView` → `BridgeSlot(target="header")` | ✅ |
| 底部状态区 | `SessionView` → `BridgeSlot(target="footer")` | ✅ |
| 状态栏条目 | `ComposerArea` → `BridgeStatusBar`（多 key 共存） | ✅ |
| 输入框挂件 | `ComposerArea` → `BridgeWidgetSlot(aboveEditor / belowEditor)` | ✅ |
| 流式状态行 | `SessionMessageTimeline` → `BridgeWorkingLine`（旁插在原生指示器之后） | ✅ |
| 会话标题 | `useBridgeSessionTitle` → `document.title` | ✅ |
| 折叠思考块标签 | `ThinkingStep` → `ThinkingBlock(hiddenLabel)`，有值时替换折叠行耗时小字 | ✅ |
| 输入框本体 | — | ⛔ **不实现**（见下方「为什么 `setEditorComponent` 不能替换」） |

#### 为什么 `setEditorComponent` 不能替换输入框

计划 §8.2 把 `editor` 标为「**替换组件**」，桥也确实拦截了它并推了节点树。
但实测下来**替换会让输入框变成死控件**，因此**刻意不接**：

1. **草稿状态不在 pi 里**。输入内容存在 PiDeck 的 `sessionDraftByIdAtom` /
   `sessionDraftBySessionIdAtomFamily`，由 `useSessionComposerController` 持有。
   扩展的编辑器组件活在 **pi 进程**，两者没有共享状态。
2. **回灌延迟不可接受**。若靠桥把每次按键送回 pi、扩展处理后再推回来，
   走的是 ~100ms 的 HTTP 轮询 —— 逐字符输入延迟 100ms+，实际不可用。
3. **会孤立整条发送链**。发送按钮、附件、斜杠命令、`@` 引用、粘贴文件、
   图片附件全都挂在 `composer` 控制器上，替换输入框后这些全部失联。

> 这与 §5.4 的三个「不映射点」性质不同：那三个是**终端专属语义**（字符画笔 / 原始按键 / pi-tui 补全模型）；
> 这里是**状态所有权不匹配** —— 输入框的状态属于宿主，不属于扩展。

**桥的现有行为**：`setEditorComponent` 仍被拦截（不会让 pi 的 RPC 空实现吞掉调用），
扩展可以调、桥也照常推节点，只是**宿主不替换输入框** → 表现为「这个点没生效」，**不报错、不影响输入**。

**如果将来要做**：唯一可行的路径是「扩展只提供**样式/工具栏**，草稿仍由 PiDeck 持有」——
即把 `setEditorComponent` 降级成 `setComposerToolbar` 那样的附加型语义，
而不是真的替换。这需要先和计划作者对齐语义，不宜擅自改。

**B 组**（`ctx.gui` 的 GUI 专属位置）—— **已挂载 14 / 14**：

| 落点 | 挂载点 |
|---|---|
| `composer.toolbar` | `ComposerArea` 底栏之后（旁插，不改 `ComposerBottomBar` props） |
| `tool.extra` | `ToolCallComponents` 的 `ToolCard` 内（`matchKey` = toolName） |
| `message.extra` | `turn/TurnRow` 的 `</article>` 前（`matchKey` = `"assistant"`） |
| `thinking.extra` | `TimelineEventCards` 的 `ThinkingBlock` 展开区内 |
| `sidebar.panel` | `SidebarContent` 的 `conversation-list` 内 `ProjectTree` 之后 |
| `sidebar.section` | 同上 |
| `banner` | `SessionView` 标题栏之下、`SessionBranchBar` 之前 |
| `titlebar.action` | `AppHeader`，与 `window-controls` 同级；**显式 no-drag** |
| `settings.section` | `SettingsModal` 全部设置 tab 之下（不改 tab 注册表） |
| `content.view` | `WorkbenchStage` 的 `workbench-content-frame` 内 |
| `session.item` | `SessionTree` 的历史会话行之后 |
| `dialog.body` | `ConfirmDialog` 头部之下（`AlertDialogHeader` 之后） |
| `dialog.action` | `ConfirmDialog` 的 `AlertDialogFooter` 内，既有按钮之前 |
| `context.menu` | `SidebarComponents` 的 `MenuShell`（侧边栏各右键菜单的共享壳） |

> **关于 `session.item` 与 `context.menu` 的覆盖范围**：计划指出这两个点没有统一宿主
> —— `session.item` 在仓库里**四处分散实现**，`context.menu` **无统一菜单项注册表**。
> 当前只接了覆盖面最广的那处（`SessionTree` 的历史会话行 / `MenuShell`）。
> `ActiveSessionsTree` / `RecentSessionsSection` / `SessionTabsBar` 上的会话条目，
> 以及非 `MenuShell` 的右键菜单，仍未接 —— 属**已知覆盖缺口**，不是实现遗漏。

> **pending 的语义**：桥仍然接受这些 `set*` 调用并正常推送，只是宿主没有对应挂载点
> → 表现为「该位置没出现」，**不报错、不影响其他位置**（符合 §7.4 与 fail-safe 承诺）。

#### 应用级 chrome 的会话取值

`AppHeader` / `SettingsModal` / `WorkbenchStage` 是**单实例**组件（不像分屏那样每栏一份），
没有 `sessionId` prop，因此走 `useBridgeSessionId()` 读**当前聚焦会话**。

应用级落点（`titlebar.action` / `settings.section` / `config.page` / `dialog.*` / `context.menu`）
**也走同一个入口**，语义就是：你在哪个会话，那个会话的 pi 进程供给宿主 chrome。
**没有聚焦会话就没有内容** —— 桥的贡献只能由某个 pi 进程产生，这与 pi TUI 里扩展 UI 的
生命周期一致（`session_start` 挂上、会话失效时 `resetExtensionUI()` 清空）。

因此**不做任何回落**：曾经用「最后一个推过桥帧的会话」兜底，多会话并发推帧时会变成
「后写者为胜」，会话删除/关闭后还会留下悬空 id（PR 评审指出）。`bridgeAppScopeOwner.test.mjs`
守着这条不变量。

这不违反 AGENTS.md「多实例必须按 session 订阅」—— 那条针对的是分屏/多栏；
单实例 chrome 按聚焦会话取值是语义正确的。`SidebarContent` 由 App 显式透传
`currentSessionId` prop，两者取值同源，只是接线方式不同。

### 落点排序与 key 匹配（实现细节）

- 桥推的落点 id 形如 `gui:<slot>:<key>`，宿主按前缀聚合
- **排序在渲染层做**（`order` 升序，同 `order` 按 key 字母序）：桥是「推一帧是一帧」，
  无法保证到达顺序，宿主排序才是唯一正确的收敛点
- 附加型落点用 `matchKey` 定位单个贡献（`tool.extra` 传 toolName、`message.extra` 传 role）
- 无贡献时组件返回 `null` → **不产生空 div、不加 margin/gap**（§8.4 C「无内容不占位」）
- `titlebar.action` 的宿主元素必须显式 `-webkit-app-region: no-drag` ——
  app-region **不继承**，祖先的 drag 会让点击被 Electron 的拖拽命中规则吞掉

---

## 5. GUI 作画工厂 `ctx.gui.custom()`

### 注册方法照抄 TUI，只换画框与画笔

```ts
// TUI 的写法（pi 官方）
const r = await ctx.ui.custom<string>((tui, theme, keybindings, done) => {
  return new MyPanel();                       // pi-tui Component
}, { overlay: true });

// GUI 的写法 —— 注册方法同形，画框变 GUI
const r = await ctx.gui.custom<string>((gui, theme, keybindings, done) => {
  return new MyPanel();                       // GuiComponent
}, { overlay: true });
```

**四参数一一对应**：

| # | TUI | GUI |
|---|---|---|
| 1 | `tui: TUI` | `gui: GuiSurface`（画布 / GUI 能力） |
| 2 | `theme: Theme` | `theme: GuiTheme`（语义主题 token） |
| 3 | `keybindings: KeybindingsManager` | `keybindings: GuiKeybindings` |
| 4 | `done: (result: T) => void` | 同（原样） |

**组件接口同形，只把「画出来是什么」换掉**：

```ts
// TUI
interface Component {
  render(width: number): string[];                            // ← 画成字符行
  handleInput?(data: string): void;                           // ← 收原始按键
}

// GUI
interface GuiComponent {
  render(): GuiNode;                                          // ← 画成 GUI 视图树（自适应宽度）
  handleAction?(actionId: string, payload?: unknown): void;   // ← 收语义化交互
}
```

### `GuiNode` 两种写法都接受

```ts
// 写法 A：控件工厂（类型安全，推荐手写）
new GuiStack({ direction: "column", gap: 8 }, [
  new GuiText("会话：foo", { tone: "accent" }),
  new GuiButton("刷新", { onPress: () => refresh() }),
]);

// 写法 B：对象字面量（agent 生成最省事，完全等价）
{ kind: "stack", direction: "column", gap: 8, children: [
    { kind: "text", text: "会话：foo", tone: "accent" },
    { kind: "button", label: "刷新", onPress: () => refresh() },
]};
```

> **`onPress` 等回调是 pi 进程里的真闭包，不需要序列化。**
> 桥给每个交互节点分配 `actionId`，只把这个 id 推给 PiDeck；
> 用户点了 → PiDeck 回传 `actionId` → 桥在进程内调回调。

### 选项

```ts
ctx.gui.custom<T>(factory, {
  overlay?: boolean,                                    // 覆盖层（同 TUI）
  modal?: boolean,                                      // 模态：挡住底下交互
  position?: "center" | "right" | "bottom" | "fullscreen",
  size?: { width?: number | string; height?: number | string },
  onHandle?: (h: GuiHandle) => void,                    // 同 TUI
  onDismiss?: () => void,                               // 用户按 ESC / 点遮罩
});
```

`GuiHandle`：

```ts
interface GuiHandle {
  update(next: GuiNode): void;     // 局部重画
  close(result?: unknown): void;   // 等价于 done(result)
  readonly element: string;        // 覆盖层 id
}
```

### 与 TUI `custom` 的差异（**不兼容**，别指望直接跑）

| 维度 | TUI `custom` | `ctx.gui.custom` |
|---|---|---|
| 画框 | 终端字符网格 | GUI（DOM） |
| 画笔 | pi-tui 组件（`Text` / `SelectList` …） | **GUI 控件**（`GuiText` / `GuiTable` …） |
| 布局 | 自己算 `width`，返回字符行 | 声明式布局，GUI 自适应 |
| 输入 | `handleInput(data: string)` 原始按键串 | `handleAction(actionId, payload)` 语义事件 |
| 观感 | 终端风 | **GUI 原生风** |

**注册方法同形是刻意的**（便于移植），但组件类型不同，**不要试图让一个 `render()` 同时满足两者**。

---

## 6. 控件库（画笔）

| 分类 | 控件 |
|---|---|
| **布局（6）** | `stack`（column/row + gap/align）、`grid`、`split`、`card`、`spacer`、`scroll` |
| **基础（6）** | `text`、`markdown`、`badge`、`divider`、`icon`、`image` |
| **交互（8）** | `button`、`input`、`textarea`、`select`、`checkbox`、`switch`、`slider`、`list` |
| **数据（7）** | `table`、`tree`、`keyvalue`、`codeblock`、`progress`、`spinner`、`tabs` |
| **反馈（3）** | `modal`、`toast`、`banner` |

### 配色铁律

扩展**只能选语义档**，**不能指定颜色值**：

- `tone`：`default` / `muted` / `accent` / `success` / `warning` / `danger`
- `variant`：`solid` / `outline` / `ghost`

真实色值由 PiDeck 主题与亮/暗模式决定 → 天然无样式污染，且自动跟随主题。
**指定颜色值会被忽略。**

---

## 7. 移植指南：TUI `custom` 扩展 → GUI

**目标：注册那段一行不改，只换画笔与输入。**

```ts
// 移植前（TUI）
const picked = await ctx.ui.custom<number>((tui, theme, kb, done) => {
  class Picker extends Container {
    private sel = 0;
    render(width: number) { return [theme.fg("accent", `选：${ITEMS[this.sel]}`)]; }
    handleInput(data: string) { if (matchesKey(data, "down")) { this.sel++; this.invalidate(); } }
  }
  return new Picker();
});

// 移植后（GUI）—— 注册那一行的形状完全一致
const picked = await ctx.gui.custom<number>((gui, theme, kb, done) => {
  class Picker implements GuiComponent {
    private sel = 0;
    render() { return { kind: "stack", direction: "column", gap: 8, children: [
      { kind: "text", text: `选：${ITEMS[this.sel]}`, tone: "accent" },
      { kind: "button", label: "确定", actionId: "ok" },
    ]}; }
    handleAction(actionId: string) { if (actionId === "down") { this.sel++; this.invalidate(); } }
  }
  return new Picker();
});
```

### 移植清单

| # | TUI | GUI |
|---|---|---|
| 1 | `ctx.ui.custom` | `ctx.gui.custom` |
| 2 | `Container` / `Box` / `VStack` / `HStack` | `stack` / `card` / `grid` |
| 3 | `Text(theme.fg("accent", s))` | `{ kind: "text", text: s, tone: "accent" }` |
| 4 | `SelectList` | `list` 或 `select` |
| 5 | `Input` / `Editor` | `input` / `textarea` |
| 6 | `SettingsList` | `keyvalue` + 各输入控件 |
| 7 | `Loader` / `CancellableLoader` | `spinner` / `progress` |
| 8 | `render(width) { return string[] }` | `render() { return GuiNode }` |
| 9 | `handleInput(data)` + `matchesKey` | `handleAction(actionId)` |
| 10 | `tui.requestRender()` / `invalidate()` | 同名保留（`invalidate()`） |

---

## 8. ⚠️ 明确不映射的三个点

这三条**必须知道**，否则会困惑「为什么我的扩展在 GUI 里少了一块」。

| 点 | 为什么不映射 | 替代方案 |
|---|---|---|
| **`ctx.ui.custom()`** | 它画的是 `render(width): string[]`，即**字符行**。观感是终端风，与 GUI 原生风格不合 | 用 **`ctx.gui.custom()`** —— 注册方法同形，画笔换成 GUI 原生控件 |
| **`ctx.ui.onTerminalInput()`** | 语义是「监听原始终端按键」。GUI 里**没有终端** | 用 GUI 控件自己的交互（`actionId`） |
| **`ctx.ui.addAutocompleteProvider()`** | GUI 输入框有自己的补全机制。硬接会把 pi-tui 的补全模型塞进 DOM，收益低于成本 | 无（GUI 补全由 PiDeck 提供） |

---

## 9. 事件回灌：扩展的回调怎么被触发

GUI 上的一次点击 → PiDeck 回传事件 → 桥在 pi 进程内调**公开方法** →
扩展自己的 `onSelect` / `onSubmit` 回调**原样触发**。扩展作者感觉不到桥在中间。

| GUI 操作 | 桥对组件做的 |
|---|---|
| 点选列表第 i 项 | `setSelectedIndex(i)` + `handleInput("\r")` |
| 悬停列表第 i 项 | `handleInput("\u001b[B"/"\u001b[A")`（方向键序列） |
| 输入框改值 | `setValue(v)` |
| 按 Enter | `handleInput("\r")` |
| 点按钮 | 进程内直接调 `onPress`（按 `actionId` 找到） |

**只调公开方法**，**绝不直接改私有字段** —— 那会让扩展的回调不触发，行为分叉。

### 限制

- 回灌只承诺 `select` / `navigate` / `input` / `key` / `filter` / `action` 六类
- 部分组件的交互无法用公开方法驱动（如 `Editor` 的光标位置）→ 该组件降级为只读展示

---

## 10. 零构建约束

`factory` 与 `render()` 都跑在 **pi 的 Node 进程**里，只产出可序列化的 `GuiNode`：

- 扩展里**不允许** `import React`、**不允许** JSX
- 扩展也**不接触 DOM**
- 桥侧会校验 `render()` 的返回值是合法 `GuiNode`（不是 React 元素、不是函数、不是 cyclic 对象）

---

## 11. 容错承诺（fail-safe）

桥的任何失败都只表现为「**某个点在 GUI 里没出现**」：

- pi 会话照常，PiDeck 照常
- 未知组件 → 降级为**剥了 ANSI 的等宽文本块**，绝不白屏
- 任一适配器取不到私有字段 → 该组件降级，不抛错
- 非法贡献（`key` 为空 / 返回非 `GuiNode` / 节点过深或过多）→ 该贡献隐藏并记日志
- `PIDECK_BRIDGE_URL` 缺失（纯终端跑 pi）→ 桥**静默不工作**，pi 行为不变

---

## 12. 卸载与状态清理

- 桥注入的所有 GUI 状态**挂在 `runtimeGeneration` 上**，走现有 widgets 同一套重置路径
- 不写 localStorage、不写配置文件；pi 进程退出后**不留任何磁盘痕迹**
- 应用重启后所有落点回到 PiDeck 原生形态，**无残留**

---

## 13. 排障

桥的日志走 **stderr**（不污染 RPC 的 stdout JSONL），可在 PiDeck 的日志面板看到，
前缀 `[pi-deck-gui-bridge]`。

常见日志：

| 日志 | 含义 |
|---|---|
| `已包装 ctx.ui 的声明式扩展点（…）` | 桥已挂载成功 |
| `pi-tui 已加载: <来源>` | 语义化翻译可用（`instanceof` 生效） |
| `pi-tui 加载失败，适配器退化为形状判定` | 仍可用，但组件识别精度下降 |
| `PIDECK_BRIDGE_URL 未设置：桥静默不工作` | 纯终端模式，符合预期 |
| `落点 xxx 的 factory 抛错，该落点隐藏` | 你的 `factory` 抛了异常，检查扩展代码 |
| `落点 xxx 的 render() 返回值非法，该贡献隐藏` | `render()` 返回的不是合法 `GuiNode` |
| `ctx.gui 无法挂到 ctx（可能被 freeze）` | 退化为模块级函数，改用 `import { guiSet } from "…"` |
