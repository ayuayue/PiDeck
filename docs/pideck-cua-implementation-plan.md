# PiDeck CUA 实现方案

> 状态：T1–T7 已实现（Plan A：MCP 主进程内托管 + StreamableHTTP），待集成验证与落库\
> 基线：PiDeck v0.7.8-beta，Electron 43.4.0，koffi 3.2.1\
> 分支：基于 main（当前 HEAD 5b1fb1e68）
>
> **Plan A 决策（T7）**：原定「独立 stdio MCP 子进程」方案被否决——独立 node 进程内
> `import { desktopCapturer } from "electron"` 解析为 exe 路径字符串（`desktopCapturer === false`），
> 无法截图。改为 MCP Server 由 PiDeck 主进程内托管、经 **StreamableHTTP** 暴露在 `127.0.0.1`，
> 由 pi 的 `pi-mcp-adapter` 以 `url` 形式连接；审批直连主进程内 IPC（不再需要 HTTP 回环）。

## 1. 目标与边界

### 1.1 目标
在 PiDeck 中增加 **Computer Use Agent（CUA）** 能力：让 pi Agent 能观察屏幕并注入鼠标/键盘输入，从而操作桌面原生应用。

### 1.2 核心边界
- 仅走 **Electron 主进程 + Win32 API**，不引入第二条通信通道。
- 仅支持 **Windows**，macOS 因 AX 路径不同单列二期。
- 坐标系基于 **整屏截图像素**，与 `SendInput` 绝对坐标同源。
- 真实输入必须过 **审批门**；保留全局杀开关。

---

## 2. 地基验证结论（probe1–probe5）

| 能力 | 结论 | 关键约束 |
|------|------|----------|
| 输入注入（SendInput） | ✅ 成立 | 必须用 `MOUSEEVENTF_ABSOLUTE \| VIRTUALDESK`，相对移动会被指针加速放大 |
| 整屏抓取 | ✅ 216–411ms | `desktopCapturer.getSources({types:['screen']})` |
| 按窗口抓取 | ❌ 否决 | 恒定 3.1s，且部分窗口黑帧 |
| SetForegroundWindow | ❌ 否决 | Windows 前台锁定，5 法 × 4 窗口 × 20 次 = 0 成功 |
| 点击激活 | ✅ 成立 | SendInput 绝对坐标点击未被遮挡区域可切前台 |
| 最小闭环 | ✅ 成立 | 整屏抓 → Z-order 分析 → TOPMOST 瞬态置顶 → 点击标题栏 → 内部点击 |

### 2.1 关键工程坑
- koffi `_Out_` 标注必填，否则 `GetWindowRect`/`GetCursorPos` 输出参数不回填。
- koffi 类型名只认 `void *` / `uint32_t` / 已声明 struct，不认 `HWND` / `DWORD`。
- `EnumWindows` 顺序即 Z-order，越前越上层。
- `SetWindowPos(HWND_TOPMOST)` 提 Z-order 后紧跟一次 SendInput 点击，才能把焦点带过去；随后必须 `SetWindowPos(HWND_NOTOPMOST)` 取消置顶。

---

## 3. 架构设计

### 3.1 组件位置
```
src/main/cua/
  CuaWin32.ts           # koffi → user32/kernel32 绑定与常量（SendInput/键盘/滚动/窗口）
  CuaFrame.ts           # 整屏截图 → nativeImage.resize → JPEG/base64（唯一 import electron 的 CUA 文件）
  CuaWindowAnalyzer.ts  # EnumWindows + Z-order + 遮挡计算 + 激活点选择
  CuaEngine.ts          # 抓取、输入、窗口分析、激活总控（注入 gate）
  CuaGate.ts            # 进程内审批门与杀开关（approvalHandler 直连渲染层）
  CuaTools.ts           # 6 个 MCP tool 定义 + zod（HTTP host 与 stdio 共用）
  CuaMcpServer.ts       # 工厂：基于 CuaTools 构建 McpServer 实例
  CuaMcpHttpHost.ts     # 主进程内 StreamableHTTP host（POST/GET/DELETE /mcp，bearer 校验）
  CuaMcpRegistration.ts # 写/删 ~/.pi/agent/mcp.json 的 pideck-cua（url 形式）
  CuaService.ts         # 主进程装配：组装 Engine/Gate/Host/Ipc，随 cuaEnabled 启停
  index.ts              # 装配导出
src/main/ipc/
  cuaIpc.ts             # CuaIpcManager：cua:get-state/set-state/approval-response + 审批推送
src/renderer/src/components/overlays/
  CuaApprovalDialog.tsx # 渲染层审批对话框 + useCuaApproval hook
```

> 说明：`CuaApprovalServer.ts`（loopback HTTP 审批回环）为 T5 旧方案遗留，Plan A 下已由进程内
> `approvalHandler` 取代，保留为未使用冗余代码，待确认后清理。

### 3.2 与 PiDeck 子系统的接法
- **生命周期**：由设置项 `cuaEnabled`（默认 `false`）驱动。`src/main/index.ts` 在 AnnouncementService 之后
  实例化 `CuaService`；`cuaEnabled=true` 时才 `start()`（监听端点 + 写 mcp.json），关闭时 `stop()`
  （停端点 + 从 mcp.json 注销）。设置变更经 `systemIpc` 的 `reactToCuaSettings` 实时生效。
- **退出清理**：`quitCleanup.register("cua", () => cuaService?.dispose())`，与 Pet/Sound/Announcement 一致。
- **运行时事件**：CUA 不监听 `agents:*`；它作为 MCP Server 被 pi 主动调用。
- **会话身份**：写类 tool 必须带 `sessionId`（仅供会话级杀开关判定；当前 tool 面尚未带
  `agentId + runtimeGeneration`，二期补齐）。
- **审批 UI**：Plan A 下审批经主进程内 IPC 直推渲染层 `CuaApprovalDialog`（channel `cua:approval-request` /
  `cua:approval-response`），不再绕 `agents:ui-request`。

---

## 4. MCP 工具面

CUA 以 **主进程内 MCP Server** 形式挂载到 pi：PiDeck 主进程用 `@modelcontextprotocol/sdk` 的
`McpServer` + `StreamableHTTPServerTransport` 在 `127.0.0.1` 暴露 `/mcp`，通过 `pi-mcp-adapter`
以 `url` 形式写入 `~/.pi/agent/mcp.json`。

### 4.1 Server 元数据
| 字段 | 值 |
|------|-----|
| name | `pideck-cua` |
| transport | `Streamable HTTP`（stateful，会话内多 transport） |
| url | `http://127.0.0.1:<随机端口>/mcp` |
| auth | `bearer`（启动时随机 32 字节 hex token，随注册写入） |
| lifecycle | `keep-alive` |

写入 `~/.pi/agent/mcp.json` 的条目形态：
```json
{ "mcpServers": { "pideck-cua": { "url": "http://127.0.0.1:<port>/mcp", "auth": "bearer", "bearerToken": "<hex>", "lifecycle": "keep-alive" } } }
```
> 端点仅在 `cuaEnabled=true` 时监听；关闭时不监听、不写 mcp.json（默认零副作用）。

### 4.2 工具清单

#### `cua_capture` — 单屏截图
```json
{
  "name": "cua_capture",
  "description": "Capture one display and return a JPEG image. displayId comes from cua_get_state.displays (a displayId or sourceId) or is \"primary\". The response screenRect is that display in absolute click coordinates: x = screenRect.x + imageX * screenRect.width / width, y = screenRect.y + imageY * screenRect.height / height.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "displayId": { "type": "string", "description": "Display to capture: a displayId or sourceId from cua_get_state.displays, or \"primary\". Omit for primary." },
      "maxLongEdge": { "type": "integer", "default": 1280, "description": "Resize so the longer edge <= this." },
      "quality": { "type": "integer", "default": 75, "description": "JPEG quality 1-100." }
    }
  }
}
```
- 返回 `image_url`（base64 data URL）+ 元数据（width/height/displayId/**screenRect**/screenDisplayId/scaleFactor/isPrimary/timestampMs）。
- **坐标契约**：`screenRect` 是该屏在绝对点击坐标空间（物理像素、可负）中的矩形；模型用它把截图像素换算成 `cua_click` 的坐标。没有这个字段时，200% 缩放的副屏截图是没法点的（图像被缩过，DIP≠物理，工具面里也没有别处能查到屏幕位置）。
- `displayId` 省略 = **主屏**（按 `source.display_id === primaryDisplay.id` 匹配，不依赖 `sources[0]` 顺序——实测本机 `sources[0]` 是副屏）；也可传 source id（`screen:0:0`）或 Electron display id。
- `thumbnailSize` 请求值 = `maxLongEdge`：Electron 的 thumbnail 会按请求框缩放（可放大），旧的 8192 上限等于每帧先放大到 8K 再缩回 1280，双重采样、更慢更糊。
- 预算 ≤ 190KB base64；默认 1280 长边/quality 75 可在 2560×1440 场景下压到 ~100KB。

#### `cua_list_windows` — 列出可见顶层窗口
```json
{
  "name": "cua_list_windows",
  "description": "List visible top-level windows with Z-order and geometry.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "includeInvisible": { "type": "boolean", "default": false }
    }
  }
}
```
- 返回数组：`[{ hwnd, title, pid, zIndex, rect: {x,y,width,height}, isForeground, isTopmost }]`。

#### `cua_click` — 绝对坐标点击
```json
{
  "name": "cua_click",
  "description": "Click at absolute screen coordinates.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "x": { "type": "integer" },
      "y": { "type": "integer" },
      "button": { "type": "string", "enum": ["left", "right", "middle"], "default": "left" },
      "double": { "type": "boolean", "default": false },
      "activateTarget": { "type": "string", "description": "Optional target window title substring to activate before clicking." }
    },
    "required": ["x", "y"]
  }
}
```
- 若提供 `activateTarget`，先走「瞬态置顶 + 标题栏点击」激活，再执行目标坐标点击。
- 默认需要审批门；如命中杀开关则直接拒绝。

#### `cua_type` — 键盘输入
```json
{
  "name": "cua_type",
  "description": "Type a text string or press key combinations.",
  "inputSchema": {
    "type": "object",
    "oneOf": [
      { "properties": { "text": { "type": "string" } }, "required": ["text"] },
      { "properties": { "key": { "type": "string" }, "modifiers": { "type": "array", "items": { "enum": ["ctrl", "alt", "shift", "win"] } } }, "required": ["key"] }
    ]
  }
}
```
- 支持 Unicode 文本（逐字符 SendInput 虚拟键/扫描码）和常见快捷键。
- 同样需要审批门。

#### `cua_scroll` — 滚动
```json
{
  "name": "cua_scroll",
  "description": "Scroll the mouse wheel at absolute screen coordinates.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "x": { "type": "integer" },
      "y": { "type": "integer" },
      "deltaY": { "type": "integer", "default": -120 },
      "deltaX": { "type": "integer", "default": 0 }
    },
    "required": ["x", "y"]
  }
}
```

#### `cua_get_state` — 读取 CUA 状态
只读，无需审批：返回 `display`（主屏尺寸）、`displays[]`（每块屏的 displayId/label/isPrimary/scaleFactor/bounds，bounds 为绝对点击坐标即物理像素）、`virtualDesktop`（所有屏的并集矩形）、杀开关状态、最近审批结果等。

> 多显示器：`cua_click`/`cua_scroll` 与 `cua_list_windows` 的 rect 都在**物理虚拟桌面**坐标（原点可能为负）。`display.bounds = DIP bounds × scaleFactor`，逐屏换算后与 `GetSystemMetrics(SM_X/Y/CX/CYVIRTUALSCREEN)` 严格对账（本机 100%+200% 双屏实测并集完全一致）。

---

## 5. 审批门与杀开关

### 5.1 层级
1. **全局杀开关**：`settings.json` 中 `cuaEnabled: false` 时，所有 CUA tool 返回 `CUA_DISABLED` 错误。
2. **会话级开关**：每个会话可单独关闭 CUA（默认继承全局）。
3. **动作审批门**：`cuaAutoApprove` 默认 `true`，`cua_click` / `cua_type` / `cua_scroll` 自动放行，但仍受全局/会话杀开关限制；用户关闭自动审批后，每次写操作需要显式确认。新安装或旧配置缺少该字段时采用新默认值，已保存的 `false` 保持不变。`cua_capture` / `cua_list_windows` / `cua_get_state` 只读，无需审批。

### 5.2 审批弹窗内容
- 操作类型（点击/输入/滚动）
- 目标坐标或文本摘要
- 目标窗口标题（若可识别）
- 自动审批关闭时的按钮：允许一次 / 允许 5 分钟 / 拒绝 / 拒绝并关闭 CUA

### 5.3 错误码
| 错误 | 说明 |
|------|------|
| `cua_disabled` | 全局/会话杀开关关闭 |
| `no_approval_handler` | 未接入审批处理器（fail-closed） |
| `approval_request_failed: <msg>` | 审批处理器异常 |
| `approval_timeout` | 用户未在 30s 内响应 |
| `no_window` | 审批时渲染层主窗不可达 |
| `cua_not_foreground` | 需要目标窗口已前台但未做到（Plan A 暂由 `activateTarget` 前置激活承担） |
| `cua_no_visible_point` | 目标窗口被完全遮挡，无安全点击点 |

> 实现层面（`CuaGate.check`）：只读动作（capture/list_windows/get_state）直接放行；
> 写动作依次过全局杀开关 → 会话覆盖 → 审批 handler；无 handler 时 fail-closed。

---

## 6. 与 pi 现有 MCP 通道的接法

### 6.1 作为 MCP Server 暴露
CUA 的 MCP Server 由 PiDeck 主进程内部托管，注册到 `~/.pi/agent/mcp.json`（url 形式）：

```json
{
  "mcpServers": {
    "pideck-cua": {
      "url": "http://127.0.0.1:<port>/mcp",
      "auth": "bearer",
      "bearerToken": "<hex>",
      "lifecycle": "keep-alive"
    }
  }
}
```

实际不 spawn 独立 node 进程；`McpServer` 与 `StreamableHTTPServerTransport` 都在主进程内，
pi 的 `pi-mcp-adapter` 以 HTTP transport 连接（原生支持 `url` 字段）。

### 6.2 不引入第二条通道
- CUA 工具调用走 **pi 的标准 tool_call → tool_result JSON-RPC**，与所有 pi 工具一致。
- 审批弹窗走 **PiDeck 主进程内 IPC**（`cua:approval-request` / `cua:approval-response`）：
  CUA MCP Server 已在 PiDeck 主进程内，审批无需回环 HTTP，直接经 `CuaIpcManager` 推渲染层。
  这仍不构成「第二条 pi↔PiDeck 通信通道」：pi 侧只看到标准 MCP tool 调用，
  审批通道完全在 PiDeck 进程内。
- 截图/输入事件不回传 pi，只有 tool_result 返回结构化数据。

---

## 7. 实现阶段

> 下列 T1–T7 均已完成（Branch：未 commit）。测试：`tests/cua/*.test.mjs` 42 pass / 0 fail；
> typecheck 0 错误。

### T1：Win32 地基与帧管线 ✅
- `CuaWin32.ts`：koffi 绑定 user32/kernel32 常量与函数（SendInput/键盘/滚动/窗口操作）。
- `CuaFrame.ts`：`desktopCapturer` + `nativeImage.resize` + `toJPEG`。
- 单测：`tests/cua/CuaWin32.test.mjs`、`CuaFrame.test.mjs`。

### T2：窗口分析与激活 ✅
- `CuaWindowAnalyzer.ts`：EnumWindows、rect、pid、遮挡计算、标题栏候选点。
- `CuaEngine.activateWindow(titleSubstring)`：TOPMOST → 点击标题栏 → NOTOPMOST。
- 单测：`CuaWindowAnalyzer.test.mjs`。

### T3：输入注入 ✅
- `CuaEngine.click/type/scroll`；审批门钩子（`CuaGate` 全局杀开关 + 会话覆盖 + write stub）。
- 单测：`CuaKeyboard.test.mjs`、`CuaGate.test.mjs`。

### T4：MCP Server 与注册 ✅
- `CuaTools.ts`（6 tool）+ `CuaMcpServer.ts`（工厂）+ `CuaMcpHttpHost.ts`（StreamableHTTP）。
- `CuaMcpRegistration.ts` 写/删 `~/.pi/agent/mcp.json`（url 形式）。
- 单测：`CuaMcpRegistration.test.mjs`、`CuaMcpHttpHost.test.mjs`（真实 MCP client 经 HTTP 连接）。

### T5：审批通信 ✅
- 决策：放弃 loopback HTTP 回环，改主进程内 `approvalHandler` 直推渲染层。
- `CuaGate` 重写为进程内审批；`CuaApprovalServer` 降级为保留未使用冗余。
- 单测：`CuaGate.test.mjs`（8）、`CuaApprovalServer.test.mjs`。

### T6：渲染层审批 UI + IPC ✅
- `CuaApprovalDialog.tsx` + `useCuaApproval` hook；`cuaIpc.ts`（CuaIpcManager）。
- `src/shared/ipc.ts` 新增 CUA channels；`src/preload/index.ts` 暴露 `api.cua`。
- 单测：`CuaIpc.test.mjs`。

### T7：主进程装配（Plan A）✅
- 阻断与决策：独立 stdio 子进程无 `desktopCapturer` → 改为主进程内 StreamableHTTP。
- `CuaService.ts` 组装 Engine/Gate/Host/Ipc；`index.ts` 装配 + `quitCleanup`；
  `systemIpc` 增 `reactToCuaSettings`；`settings` 增 `cuaEnabled`。
- 待办：端到端实机验证（开启设置 → pi 列到 6 个 tool → 只读可用 → 写操作弹审批）。

### 二期项
- UIA 读树（Windows 侧 AX 等价物）。
- 写类 tool 补齐 `agentId + runtimeGeneration`。
- 清理冗余 `CuaApprovalServer.ts` 及其测试。

> 多显示器已交付（原二期项）：`cua_get_state.displays` + `cua_capture.screenRect`。实测结论是注入链路（SendInput + `MOUSEEVENTF_VIRTUALDESK`）本来就在副屏可用、负坐标精确落点，缺的只是“看”——模型拿不到屏幕列表，也拿不到截图与绝对坐标的换算比例。

---

## 8. 风险与兜底

| 风险 | 影响 | 兜底 |
|------|------|------|
| koffi 在 Electron 43 行为变化 | 高 | 持续跑 probe 单测，异常时退回 helper 进程 |
| 审批弹窗被遮挡 | 高 | 审批 UI 使用系统 Notification + 主窗口强制置顶 |
| 多显示器坐标系 | 低 | 绝对坐标已是物理虚拟桌面；`cua_get_state.displays` 给每屏 rect，`cua_capture.screenRect` 给换算比例，DIP×scaleFactor 与 `GetSystemMetrics` 对账 |
| UAC 应用无法点击 | 中 | 标记 `cua_not_foreground` 错误，二期评估 UIAccess |

---

## 9. 参考
- `C:\Users\14012\.qoder-cn\tmp\cua-probe\probe*.cjs`
- `C:\Users\14012\.qoder-cn\tmp\zcodepro-probe\runtimes\zcode-cua\`
- `docs/process-group-implementation-contract.md`
- `docs/windows-quick-task.md`
