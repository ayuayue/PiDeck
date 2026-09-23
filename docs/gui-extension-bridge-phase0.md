# Phase 0 Spike 报告 —— pi-deck-gui-bridge

> 实测环境：pi **0.87.1**（全局 npm `@earendil-works/pi-coding-agent`），
> pi-tui `dist/index.js`，Node v24.18.0，Windows。
> 本报告只记录**实测结论**，不写推测。凡与 `pi-gui-bridge-plan.md` 不一致处，附「计划原文 → 实测结论」。

---

## 结论速览

| # | 问题 | 结论 | 对方案的影响 |
|---|---|---|---|
| **S1** | 桥能否拦到别的扩展的 `ctx.ui`？ | ✅ **能**（读源码确证 + 机制成立） | **方案有支点**，Phase 1 可开工 |
| **S2** | pi 有没有扩展→PiDeck 的 RPC 事件通道？ | ❌ 没有通用通道 | 走 §9.2 环境变量端点 |
| **S3** | `instanceof` 是否成立？ | ✅ **成立**（走 pi 的解析路径） | 语义化适配器主路径可用 |
| **S4** | 私有状态可读？ | ✅ **可读**；且部分有公开读法 | 适配器可落地，部分比计划更安全 |
| **S5** | factory 能否重复调用？ | ✅ **可重复调用**，无副作用 | **不需要**缓存组件实例 |
| **S4b** | 公开方法回灌能否触发扩展回调？ | ⚠️ **能，但计划给的方法有误** | **§8.3 必须按本报告修正** |

---

## S1：`ctx.ui` 可拦截 —— **通过（方案地基成立）**

### 证据（读 pi 源码）

`dist/core/extensions/runner.js`：

```
:314  setUIContext(uiContext, mode = "print") {
          this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext;
          this.mode = mode;
      }
:360  getUIContext() { return this.uiContext; }
:553  get ui() { runner.assertActive(); return runner.uiContext; }     // ← 活取值，非快照
```

`dist/modes/rpc/rpc-mode.js` 在建 RPC UI 上下文后调用一次 `setUIContext(...)`。

### 为什么这就够了

- 进程内**只有一份** `uiContext` 实例（`setUIContext` 被调用一次）。
- `ctx.ui` 是 **getter**，每次取都返回**当前** `runner.uiContext`。
- 因此桥只要在 `session_start`（或任何拿到 `ctx` 的时机）对这份实例做一次属性替换，
  **同一进程内其余全部扩展**随后取到的 `ctx.ui` 都已是包装版。

### 计划原文 → 实测

| 计划说法 | 实测 |
|---|---|
| §10 S1「A 在 session_start 里 patch `ctx.ui.setFooter`，观察 B 调用时是否落到 A 的包装里」 | 机制成立：`ui` 是共享单例的活 getter |
| §5.3 注「必须在 pi 的 RPC 降级之前包住」 | ✅ 成立。RPC 降级就是 `rpc-mode.js` 里那批空实现；它们**已经**在 `uiContext` 上了。桥不是「抢在降级前」，而是**替换掉降级后的空实现**——比计划预期更简单，无需 hook 工厂 |
| §13.2「`ctx.ui` 不可拦截（最高风险）」 | **风险解除** |

### 注意（实测到的边界）

- `setUIContext` 传进来的对象**已经**被 `wrapUIPromptContext` 展开成新对象（`{...ui, select, confirm, input, editor, custom}`）。
  桥拿到的是这个展开后的对象 —— 可写、可 patch。
- `runner.assertActive()` 在 session 生命周期外会抛错；桥的 ticker 必须容忍这一点（见「桥实现注意」）。

---

## S2：没有通用扩展→宿主的 RPC 事件通道

### 证据

`rpc-mode.js` 里扩展 UI 上下文**唯一**的出站方式是 `output({type:"extension_ui_request", ...})`，
且每个方法各自硬编码自己的 `method` 名（`notify` / `setWidget` / `setStatus` / `setTitle` / `set_editor_text` / …）。
没有任何「扩展 emit 任意事件 → stdout」的转发口。

### 结论

**走 §9.2 兜底：环境变量注入的本地端点。**
且本仓库已有同款先例可循：
- `PiProcess.ts:657` 注入 `PIDECK_SECURITY_CONFIG`
- `PiProcess.ts:660` 注入 `PIDECK_SESSION_ID`
- `PiProcess.ts:664` 注入 `PIDECK_FEISHU_LINKED`

桥读 env → POST 给 PiDeck 监听的 `/bridge`。**方向是 PiDeck 监听、pi 连接**（桥只做 HTTP 客户端）。

---

## S3：`instanceof` 成立 —— **通过**

### 关键前提

pi-tui **不在仓库 node_modules 里**（本仓库根本没有 `node_modules/@earendil-works`）。
它作为 pi 的依赖存在于：
```
<pi>/node_modules/@earendil-works/pi-tui/dist/index.js
```

桥必须**通过 pi 的解析路径**引入，不能自己装一份（否则两份模块实例 → `instanceof` 全 false）。

实测（`createRequire(<pi>/package.json).resolve("@earendil-works/pi-tui")`）：
```
text instanceof Text        = true
box  instanceof Box         = true
vstack instanceof VStack    = true
vstack instanceof Container = true
同一路径二次 import 得到同一 Text 类 = true      ← 无重复实例问题
```

### 继承关系（实测，与计划表述有差异）

| 组件 | `instanceof Container` | 说明 |
|---|---|---|
| `Text` | ❌ **false** | `Text` **不**继承 `Container` |
| `Box` | ❌ **false** | `Box` 自己持有 `children`，不继承 `Container` |
| `VStack` / `HStack` | ✅ true | `Stack extends Container` |
| `ScrollView` | ✅ true | `ScrollView extends Container` |

**计划原文 → 实测**：
- 计划 §3.1 说「`Container.children: Component[]` 是 public；`Box.children` 也是」
  → 实测 `Box.children` ✅ public，但它**不是** `Container` 的子类。
  适配器**不能**用 `instanceof Container` 兜住 Box，必须显式判 `Box`。
- `Loader extends Text`（实测 d.ts）→ 适配器表里 `Loader` 必须排在 `Text` **之前**，否则永远命中 `Text`。
- `TruncatedText` 与 `Text` 的关系需在实现时确认（同理会影响到顺序）。

### 稳妥做法

按计划 §6.3 对策 2 保留**双轨匹配**：`instanceof` 优先，失败退回 `constructor.name` + 关键属性探测。
实测 `constructor.name` 完好可用（`"Text"` / `"VStack"`）。

---

## S4：私有状态可读 —— **通过，且部分比计划更安全**

TS `private` 在运行时不存在，`as any` 全部读得到：

| 字段 | 实测读值 | 公开替代 |
|---|---|---|
| `SelectList.items` | `[{value,label},…]` ✅ | 无 |
| `SelectList.filteredItems` | 同 items ✅ | 无 |
| `SelectList.selectedIndex` | `0` ✅ | 无（但有 `getSelectedItem()`） |
| `SelectList.getSelectedItem()` | `{value:"a",label:"Alpha"}` | ✅ **公开方法** |
| `Input.value` | `""` ✅ | ✅ **`getValue()` 公开** |
| `Input.placeholder` | `"type here"` ✅ | 仅 private |
| `Text.text` | `"hello"` ✅ | 仅 private（有 `setText` 无 getter） |
| `Box.paddingX/paddingY` | `1, 1` ✅ | 仅 private |
| `Spacer.lines` | `3` ✅ | 仅 private |

**计划原文 → 实测**：计划 §6.3 问题 B 称「`Input` 的当前值在 `.d.ts` 里是 private」——
实测 `Input` **有公开的 `getValue()`**。适配器应优先走公开方法，私有读取仅作兜底。

**仍按计划执行**：能力探测（任一必需字段取不到 → 该组件降级 `ansi`），锁 pi-tui 版本区间。

---

## S4b：事件回灌 —— **通过，但计划 §8.3 的写法有误（必须修正）**

这是本次 spike **最重要**的发现。

### 计划原文（§8.3）

```ts
case "select":   (c as SelectList).setSelectedIndex(event.index);
                 (c as SelectList).handleInput(Key.enter); break;
```

### 实测结果（伪代码同款代码）

```
setSelectedIndex(1) + handleInput(Key.enter)
  → onSelect = null            ❌ 扩展的回调没有被触发
```

### 两个独立缺陷

**缺陷 1：`Key.enter` 不能用作 `handleInput` 的入参**

`SelectList.handleInput` 的实现是：
```js
const kb = getKeybindings();
...
else if (kb.matches(keyData, "tui.select.confirm")) { ... this.onSelect(selectedItem) }
```

它匹配的是 **keybinding 定义**，不是 `Key.enter` 常量。实测：
```
TUI_KEYBINDINGS["tui.select.confirm"] = { defaultKeys: "enter", description: "Confirm selection" }
kb.matches("\r",  "tui.select.confirm") = true      ← 正确
kb.matches("\n",  "tui.select.confirm") = true      ← 正确
kb.matches(Key.enter /* 字面量 "enter" */, "tui.select.confirm") = false   ← 失败
```
`Key.enter` 的值是字符串 `"enter"`（键名），而 `handleInput` 要的是**原始字节序列** `"\r"`。

**修正**：桥回灌必须送 **`"\r"`**（CR），不能送 `Key.enter`。

**缺陷 2：`setSelectedIndex()` 是裸 setter，不触发 `onSelectionChange`**

```js
setSelectedIndex(index) {
    this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
}   // ← 没有 notifySelectionChange()
```

实测：
```
sl.setSelectedIndex(2) → selectedIndex=2, onSelectionChange=null
```

只有 `handleInput` 的 up/down 分支、以及鼠标事件才调 `notifySelectionChange()`。

**修正**：GUI 点选序号时，若扩展依赖 `onSelectionChange` 感知高亮，
桥必须**走 `handleInput` 的方向键**而不是 `setSelectedIndex`，或用「setSelectedIndex + 显式补一次通知」。
实测方向键字节有效：
```
handleInput("\x1b[B")  → selectedIndex 0→1, onSelectionChange={"value":"b",...}   ✅
handleInput("\x1bOA")  → selectedIndex 0→2（非标准序列，行为不可靠，勿用）
```

### 正确的回灌写法（实测通过）

```ts
// 选中某一项（触发扩展的 onSelect）
function replaySelect(list: SelectList, index: number): void {
  list.setSelectedIndex(index);   // 公开方法，绝对定位
  list.handleInput("\r");         // ★ CR，不是 Key.enter —— 触发 onSelect
}

// 仅移动高亮（触发 onSelectionChange）
function replayNavigate(list: SelectList, index: number): void {
  const cur = (list as any).selectedIndex;
  const seq = index > cur ? "\u001b[B" : "\u001b[A";   // down / up
  for (let i = 0; i < Math.abs(index - cur); i += 1) list.handleInput(seq);
  // 或：直接 setSelectedIndex(index) 后按需补 notifySelectionChange（若上游暴露）
}
```

### `Input` 回灌（实测通过）

```
逐字符 handleInput("h"),("i") → getValue()="hi"
再送 "\r"                     → onSubmit="hi"    ✅
setValue("xyz") 后 getValue()="xyz"              ✅
```
`Input` 同样用 `"\r"` 提交；`setValue()` 是公开方法。

### 对计划的影响

**§8.3 的事件回灌表必须整体修正**：
| 事件 | 计划写法 | 实测正确写法 |
|---|---|---|
| `select` | `setSelectedIndex(i)` + `handleInput(Key.enter)` | `setSelectedIndex(i)` + **`handleInput("\r")`** |
| `navigate` | `setSelectedIndex(i)` | `setSelectedIndex(i)`，或方向键序列以触发 `onSelectionChange` |
| `input` | `handleInput(event.value)` | ✅ 同（逐字符追加语义需注意，见下） |
| `key` | `handleInput(KEY_DATA[event.key])` | ✅ 但 `KEY_DATA` 必须映射**原始字节**（enter→`\r`、escape→`\x1b`、up→`\x1b[A`…），**不能**用 `Key.*` 常量 |

> ⚠️ `input` 事件的语义要注意：`handleInput("abc")` 是**逐字符**处理的（实测两端一致）。
> 而「设置输入框内容」应当用公开的 `setValue(v)`，两者语义不同。

---

## S5：factory 可重复调用 —— **通过（无需缓存）**

实测：
```
factory 调用两次 → calls=2, c1.text="call 1", c2.text="call 2"
两次返回同一实例? false
同一实例两次 render 一致? true
```

工厂**无副作用、可重复调用**，每次返回新实例。渲染是纯的（同实例同宽两次 render 一致）。

**计划原文 → 实测**：计划 §10 S5 的备选是「缓存组件实例，只调一次」。
实测**不需要**——但如果 ticker 每 tick 都调 factory，会每秒造几十个组件实例（GC 压力）。
**建议**：仍按计划缓存实例，理由是**性能**而非正确性，并在 `setXxx` 替换/清除时 `dispose()` 旧实例。

### render 行为（影响「变更检测」）

```
Text.render(20)      = ["                    ", " hello              ", "                    "]
Box.render(20)       = []                       ← 空 Box 渲染为空数组
SelectList.render(30)= ["→ Alpha", "  Beta", "  Gamma"]
```
- `Text` 自带 **paddingY=1** 的上下留白（默认行为），语义化翻译时应当**丢掉这些空白行**，交给 GUI 布局控制间距。
- `Box.render` 空 children → `[]`，不会画 padding。**渲染输出哈希**做变更检测时，需要注意「内容为空」与「未变化」的区别。

---

## 桥实现注意（由实测推导，写进实现）

1. **pi-tui 引入方式**：`createRequire(<pi>/package.json).resolve("@earendil-works/pi-tui")` 再动态 `import`。
   静态 `import ... from "@earendil-works/pi-tui"` 会让 jiti 从**扩展文件所在目录**向上找 node_modules，
   覆盖层/仓库目录下找不到 → MODULE_NOT_FOUND → pi 启动失败。
   > 参照本仓库既有事故（AGENTS.md「覆盖层必须自带 vendored 运行时依赖」）：
   > 扩展的裸 import 会向上查 node_modules，这条**必须在实现里显式处理**。
2. **适配器顺序**：`Loader`（extends `Text`）、`TruncatedText`（疑似 extends `Text`）必须排在 `Text` **之前**。
3. **`instanceof Container` 不能兜 `Box`**，`Box` 要单列判定。
4. **回灌字节**：`"\r"`（确认）、`"\u001b[A"/"\u001b[B"`（上下）、`"\u001b"`（取消）。
   **禁用 `Key.*` 常量**做 `handleInput` 入参。
5. **`getKeybindings()` 在没有真实 TUI 时仍可用**（实测 `kb 存在? true`），所以回灌路径在 RPC 下可行。
6. **ticker 容忍 `assertActive()` 抛错**：session 结束后取 `ctx.ui` 会抛，桥必须 try/catch 并停 ticker。
7. **`"pideck:auto-title"` 不要碰**（计划 §7.7 第 5 条），它是 PiDeck 设计内的持久化行为。

---

## 通过/不通过判定

| 门禁 | 判定 |
|---|---|
| S1 能否拦截（方案地基） | ✅ **通过** |
| S3 `instanceof` 是否成立 | ✅ **通过** |
| S4 私有状态可读 | ✅ **通过** |
| S5 factory 可重复调用 | ✅ **通过** |
| S2 有无现成 RPC 事件通道 | ❌ 无 → 走 §9.2 兜底（不阻塞） |
| S4b 事件回灌 | ⚠️ **通过，但计划写法有误，按本报告修正** |

**结论：Phase 0 通过，Phase 1 可以开工。**

---

## 实现完成后的复验（最终状态）

Phase 0 的结论已落地为**永久回归测试**，不再是临时脚本：

| 验证 | 位置 | 结果 |
|---|---|---|
| S1 端到端（**真实 `ExtensionRunner`**） | `tests/guiBridgeS1Interception.test.mjs` | ✅ **5/5**（无 pi 环境自动跳过） |
| 翻译层 + 回灌 + 拦截 + 通路 + `ctx.gui` | `tests/guiBridge.test.mjs` | ✅ **81/81** |
| 桥端点（**真实 HTTP 往返**） | `tests/guiBridgeServer.test.mjs` | ✅ **19/19** |
| 真实 pi-tui 组件往返 | Phase 0 脚本（一次性，已清理） | ✅ **32/32** |
| 桥扩展 strict 类型检查 | 独立 tsc（`--strict`） | ✅ **0 error** |
| 全量测试回归 | `npm test` vs HEAD 基线 | ✅ **零净新增失败**（149 = 149；失败名去重后 185 = 185） |
| 受影响的既有契约测试 | builtInExtensions / directEmitChannels / portableUserData / feishuSessionRuntimeBinding / builtinExtensionDescriptions | ✅ **44/44** |

> 基线的 149 条失败**全部**是 `Cannot find package/module`（本机无 `node_modules`：
> `typescript` / `jotai` / `minimatch` / `@electron/asar` / monaco 等），与桥无关 ——
> 失败列表中**没有任何一条**提到桥相关文件或我触碰的契约测试。

### 交付物结构

```
resources/extensions/            ← 桥扩展本体（零构建纯 .ts，Node 原生类型擦除即可执行）
  pi-deck-gui-bridge.ts                    入口：拦截时机、装配、导出
  pi-deck-gui-bridge-types.ts              UINode / GuiNode / 事件 / 更新载荷
  pi-deck-gui-bridge-theme.ts              哨兵主题 + ANSI 兜底解析
  pi-deck-gui-bridge-tui.ts                pi-tui 定位与加载（同实例保证）
  pi-deck-gui-bridge-serialize.ts          适配器：Component 树 → UINode
  pi-deck-gui-bridge-transport.ts          通路：HTTP 客户端（静默降级）
  pi-deck-gui-bridge-runtime.ts            拦截层 + ticker + 事件回灌
  pi-deck-gui-bridge-gui-types.ts          ctx.gui 公开类型（作者契约）
  pi-deck-gui-bridge-gui-spec.ts           白名单 / 上限 / 校验 / 状态（纯规格）
  pi-deck-gui-bridge-gui.ts                落点 setter + 命名空间装配

src/main/pi/bridge/BridgeServer.ts         宿主端点（PiDeck 监听、pi 连接）
src/shared/types/bridge.ts                 跨进程契约（唯一类型来源）
src/renderer/src/components/bridge/        渲染层：节点树 → PiDeck 已有 UI 组件
src/renderer/src/hooks/useBridgeEventSink.ts  事件上报 hook
docs/gui-extension-bridge.md               作者文档（含 §5.4 三个不映射点）
docs/examples/pi-gui-slot-hello.ts         参考示例（纯 TUI 扩展，不知道 PiDeck 存在）
```

### 实施中发现并修正的额外问题

除 S4b 之外，落地过程中还实测到以下与计划不同之处，均已在实现里处理：

1. **`Loader extends Text`** —— 适配器表里 `Loader` 必须排在 `Text` **之前**，
   否则永远命中 `Text`。（`TruncatedText` 实测**不**继承 `Text`，无此问题。）
2. **`instanceof Container` 兜不住 `Box`** —— 实测 `Box` 与 `Text` 都**不**继承 `Container`
   （只有 `Stack`/`ScrollView` 继承）。计划 §3.1 的表述需按此修正。
3. **`Input` 有公开 `getValue()`** —— 计划 §6.3 说「值在 `.d.ts` 里是 private」，
   实测有公开读法，适配器优先走公开方法。
4. **`@earendil-works/pi-coding-agent` 是 ESM-only** —— 其 `exports` 只有 `import` 条件，
   `createRequire().resolve()` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
   因此 pi-tui 的定位必须**以文件系统探测为主**，不能只依赖 resolve。
5. **npm 全局前缀位置** —— Windows 上是 `%APPDATA%\npm`（不在 node 安装目录旁），
   只查 `execPath` 同级会漏检。桥的加载器已补上这条兜底。
6. **辅助模块不能进 `BUILT_IN_EXTENSIONS`** —— 该表用于 `-e` 注入，
   只应列**扩展入口**；被 import 的 9 个辅助模块必须进 `extensions-manifest.json`
   但**不进** `-e` 表。这与既有 `pi-deck-todo-state.ts` 的处理方式一致。
7. **新增内置扩展必须同步三处**（仓库既有契约测试会挡住，实测踩到）：
   `BUILT_IN_EXTENSIONS` 表、`rendererCopy.{zh-CN,en-US}.ts` 的
   `config.builtInExtDesc.*`、`extensionsTableRows.tsx` 的 `BUILT_IN_EXTENSION_DESC` 映射。
8. **`setEditorComponent` 不能替换输入框**（落地时发现的设计冲突，**刻意不实现**）。
   计划 §8.2 把 `editor` 标为「替换组件」，但实测：
   - 草稿状态在 **PiDeck 的 atoms**（`sessionDraftByIdAtom`），不在 pi 进程；
     扩展的编辑器组件与宿主没有共享状态。
   - 靠桥回灌每次按键要走 ~100ms HTTP 轮询 → 逐字符输入延迟 100ms+，不可用。
   - 发送按钮/附件/斜杠命令/`@` 引用/粘贴文件全挂在 `composer` 控制器上，替换即全部失联。

   性质与 §5.4 的三个「不映射点」**不同**：那三个是终端专属语义，
   这条是**状态所有权不匹配**。桥仍拦截该调用（不让 RPC 空实现吞掉），只是宿主不替换。
   详见 `docs/gui-extension-bridge.md` 的「为什么 `setEditorComponent` 不能替换输入框」。
9. **落点宿主并非处处唯一**。计划已提示 `session.item` 四处分散、`context.menu` 无注册表；
   落地时确认属实 —— 当前只接了覆盖面最广的宿主（`SessionTree` 历史会话行 / `MenuShell`），
   其余实现（`ActiveSessionsTree` / `RecentSessionsSection` / `SessionTabsBar`）为**已知覆盖缺口**。
10. **计划的行号相对 v0.7.7 已漂移**（`audit-plan-refs.mjs` 实测：**28 准 / 18 漂移 / 0 失效**，最大偏移 **35 行**）。

    计划文件**没有声明它是对着哪个 pideck 版本写的**。逐条核对它 §8.2 / §15 里的
    `file:line` 引用后发现：**路径全对（0 失效），但 18 条行号对不上**。
    典型偏移：

    | 计划声称 | 实际（v0.7.7） | 偏移 |
    |---|---|---|
    | `session/SessionHeader.tsx:71` | `:36` | −35 |
    | `sidebar/AppSidebar.tsx:48` | `:15` | −33 |
    | `atoms/session-atoms.ts:988` | `:956` | −32 |
    | `composer/TipTapComposer.tsx:33` | `:2` | −31 |
    | `atoms/session-atoms.ts:920` | `:949` | **+29** |
    | `main/extensions/ExtensionManager.ts:534` | `:515` | −19 |

    > 偏移有正有负，说明是**多次提交累积**的结果，不是统一的行首/行尾差异。

    **对本实现的影响：无。** 每个落点都是**读 v0.7.7 实际源码**定位的，
    不依赖计划的行号；`selfcheck.mjs` 会逐个断言宿主文件里真的存在
    `slot="..."`，从源码级证明挂载点没挂错地方。

    **给后来者的教训**：计划里的 `file:line` 只当**线索**用，落地前必须打开文件确认。
    对着一份行号漂移 35 行的表直接改代码，会挂到隔壁函数里去。

    > 审计脚本：`audit-plan-refs.mjs`（工作区根）。它从 `git show HEAD:<file>` 读
    > **未被本次实现改动过的**原始源码，因此结论不受实现影响。可重跑。

### 落点挂载完成度（最终）

| 组 | 完成度 | 说明 |
|---|---|---|
| **A 组**（`ctx.ui` 原生扩展点） | **7 / 8** | 唯一未接的是 `setEditorComponent`，理由见上（**刻意不接**，非遗漏） |
| **B 组**（`ctx.gui` 专属位置） | **14 / 14** | 全部有挂载点；其中 2 个（`session.item` / `context.menu`）只覆盖了主宿主 |

### 零构建的实证

桥的全部 10 个 `.ts` 文件用 **Node 24 原生类型擦除**即可直接执行
（三个桥测试就是这么加载的，没有 `typescript`、没有打包器）——
这是对 §2「零构建」约束的一次硬证据。