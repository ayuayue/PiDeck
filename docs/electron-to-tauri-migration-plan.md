# Electron → Tauri 迁移计划

> 创建日期：2026-07-06  
> 目标技术栈：Tauri 2 + Rust + React 19 + Vite 7  
> 参考项目：[Blink](https://github.com/bmarti44/blink) — 在 Tauri 中完整运行 VS Code workbench

---

## 1. 为什么考虑迁移

| 维度 | Electron（现状） | Tauri（目标） | 收益 |
|---|---|---|---|
| 安装包大小 | ~100–150 MB（含 Chromium） | ~10–20 MB（用系统 WebView） | ↓ 80–90% |
| 空闲内存 | 150–300 MB | 30–80 MB | ↓ 60–70% |
| 启动速度 | 中（初始化 Chromium） | 快（系统 WebView 已驻留） | 感知明显 |
| 安全模型 | 需手动配置 contextIsolation / sandbox | 默认能力声明（capabilities） | 默认更安全 |
| 更新包大小 | 每次更新需下载数 MB–数十 MB 的 Chromium | 仅应用自身更新包 | ↓ 60%+ |
| 跨平台 | 桌面四平台（Win/Mac/Linux） | 桌面四平台 + iOS + Android | 扩展至移动端 |

> **适用前提**：项目仍处于功能迭代期/用户量不大/用户反馈安装包过重。  
> **不适用前提**：项目已稳定维护 / 用户不抱怨大小内存 / 团队无 Rust 意愿 / 需要 Chromium 级渲染一致性。

---

## 2. 架构对比

```
Electron（当前）                                       Tauri（目标）
┌──────────────────────────┐                  ┌──────────────────────────┐
│   Renderer (React+Vite)  │  ← 复用 →        │   WebView (React+Vite)   │
│   src/renderer/src/      │  95%+ 不变      │   src/ (前端)            │
├──────────────────────────┤                  ├──────────────────────────┤
│   Preload (contextBridge)│  ── 替换 ──→    │   @tauri-apps/api (JS)   │
│   src/preload/           │                  │   调用 Rust command      │
├──────────────────────────┤                  ├──────────────────────────┤
│   Main Process (Node.js) │  ── 重写 ──→    │   Rust Backend           │
│   src/main/ (~20 模块)   │  100% 替换      │   src-tauri/src/         │
│   ipcMain.handle × ~80   │                  │   #[tauri::command]      │
├──────────────────────────┤                  ├──────────────────────────┤
│   node-pty（终端）        │  ── 替换 ──→    │   tauri-plugin-pty /     │
│   child_process（子进程）  │                  │   portable-pty crate     │
│   node:fs（文件系统）      │                  │   tauri-plugin-fs        │
│   node:path / crypto     │                  │   Rust std / serde       │
│   @larksuiteoapi（飞书）   │                  │   自有飞书 HTTP 封装      │
└──────────────────────────┘                  └──────────────────────────┘
```

---

## 3. 页面布局兼容性（逐层评估）

| 层次 | 现状 | Tauri 兼容性 | 需要改动 |
|---|---|---|---|
| **React 19** | `src/renderer/src/` ~30+ 组件 | ✅ 完全兼容 | 几乎不改 |
| **Vite 7** | `electron.vite.config.ts` | ✅ Tauri 原生支持 Vite | 改 `vite.config.ts` + `tauri.conf.json` 的 devUrl |
| **zustand 状态** | 全局 store 管理 | ✅ 纯前端库，无平台依赖 | 不改 |
| **CSS 语义 token** | `styles.css` + 暗色模式变量 | ⚠️ WebView2/WKWebView 差异极小 | 个别 CSS 特性需 polyfill |
| **Monaco Editor** | `@monaco-editor/react` v0.55 | ✅ Blink 项目已验证可运行 | 可能需配置 webview 预加载 |
| **react-markdown / mermaid / katex** | 纯前端 Markdown 渲染链 | ✅ 完全兼容 | 不改 |
| **三栏布局** | 左侧项目列表 + 中间会话 + 右侧文件抽屉 / 底部终端 | ✅ 标准网页布局 | 不改 |
| **VirtualScroller** | `src/renderer/src/components/ui/VirtualScroller.tsx` | ✅ 纯逻辑组件 | 不改 |
| **xterm 终端 UI** | `@xterm/xterm` + `@xterm/addon-fit` | ✅ 纯前端 | 不改 |
| **自定义标题栏** | `frame: false` + `titleBarStyle: 'hidden'` | ✅ Tauri 的 `decorations: false` + `drag-region` | HTML/CSS 可能需微调 |

**评估结果：前端代码可复用 95%+，是迁移中改动最小的部分。**

---

## 4. 后端模块迁移难度分级

### 🟢 低难度（可快速迁移）

| 模块 | 位置 | 替换方案 |
|---|---|---|
| **FileSystemService** | `src/main/fs/FileSystemService.ts` | `tauri-plugin-fs` |
| **GitService** | `src/main/git/GitService.ts` | shell `git` 命令 → `tauri-plugin-shell` |
| **SettingsStore** | `src/main/settings/SettingsStore.ts` | `tauri-plugin-store` 或 `confy` crate |
| **AppLogger** | `src/main/logging/AppLogger.ts` | `tracing` / `log` crate + 写文件 |
| **SessionScanner** | `src/main/sessions/SessionScanner.ts` | 标准文件遍历 |
| **EditorDetector** | `src/main/editors/EditorDetector.ts` | 注册表/文件检测 → Rust 直读 |
| **ConfigManager** | `src/main/config/ConfigManager.ts` | 读/写 JSON 文件 |
| **SkillManager** | `src/main/skills/SkillManager.ts` | 文件系统操作 |
| **ExtensionManager** | `src/main/extensions/ExtensionManager.ts` | 文件系统 + pi CLI 子进程调用 |
| **ProjectStore** | `src/main/projects/ProjectStore.ts` | 文件系统 + store |
| **WebServiceManager** | `src/main/web/WebServiceManager.ts` | `tiny_http` / `axum` crate 嵌入 HTTP 服务 |
| **PiLocator** | `src/main/pi/PiLocator.ts` | 环境变量/注册表检查 |
| **RpcLogger** | `src/main/logging/RpcLogger.ts` | 文件追加写 |

### 🟡 中等难度（需较多注意）

| 模块 | 位置 | 挑战 |
|---|---|---|
| **AgentManager** | `src/main/pi/AgentManager.ts` | 子进程管理（spawn / kill / stdin/stdout）→ `tauri-plugin-shell` 的 Command API + 自定义 RPC 通信（stdin JSON-RPC, stdout 流式解析），状态管理（stop / restart / compact 等状态机） |
| **PiRpcClient** | `src/main/pi/PiRpcClient.ts` | JSON-RPC over stdin/stdout → 需要 Rust 的 `serde_json` 流式读取 + 请求/响应匹配，超时控制 |
| **TelemetryService** | `src/main/telemetry/TelemetryService.ts` | PostHog HTTP API 封装 |
| **ProjectResourceManager** | `src/main/projects/ProjectResourceManager.ts` | 文件系统操作 + AGENTS.md 管理 |
| **DesktopProxy** | `src/main/settings/DesktopProxy.ts` | 系统代理设置（不同 OS API 不同） |
| **Tray / Menu** | `src/main/index.ts` | Tauri tray API（功能对等，API 不同） |
| **Auto-Update** | `src/main/index.ts` | `tauri-plugin-updater`（配置方式不同） |
| **Pet Patrol** | `src/main/pet/PetPatrol.ts` | 多窗口（宠物悬浮窗）、屏幕区域检测 → Tauri 多 window API |
| **PetWindow / PetStateBridge** | `src/main/pet/` | 多窗口 IPC（Tauri 的 window emit/listen） |

### 🔴 高难度（需做技术验证）

| 模块 | 位置 | 挑战 |
|---|---|---|
| **TerminalSessionManager** | `src/main/terminal/TerminalSessionManager.ts` | **`node-pty` 是最大依赖**。Tauri 侧有 `tauri-plugin-pty`（社区）但功能完整性不如 node-pty。可能需要基于 `portable-pty`/`tokio-pty` crate 自写 PTY wrapper，并暴露 xterm 数据通道作为 Tauri event。这是全迁移的最高风险点。 |
| **FeishuBridge** | `src/main/feishu/FeishuBridge.ts` | **`@larksuiteoapi/node-sdk` 是 Node.js 专有包**。需要：<br>1. 自封装飞书 REST API（OAuth 认证 + 事件订阅 + 消息收发）<br>2. 管理 WebSocket/Webhook 长连接<br>3. 流式 Card 渲染（SSE 转发到 WebView）<br>4. 加密存储 appSecret |
| **Claude/Codex/OpenCode Session Importer** | `src/main/sessions/*.ts` | 解析其他工具的 session 格式（JSON / TOML / 目录结构），逻辑上不复杂但细节多 |

---

## 5. IPC 架构迁移（核心工作量）

当前约 **80 个 IPC handler** 全部分散在 `src/main/index.ts` 中。迁移方案：

```
Electron:                    Tauri:
ipcMain.handle(channel,fn)   #[tauri::command]
  → preload 转发               → JS 侧直接调用
  → renderer 调用              → @tauri-apps/api 的 invoke()

// Electron 风格
ipcMain.handle("projects:list", () => projectStore.list());

// Tauri 风格                                   
#[tauri::command]
fn list_projects(state: State<AppState>) -> Vec<Project> {
    state.project_store.list()
}
```

**IPC 映射表示例**（完整表在后续实施时生成）：

| Electron Channel | Rust Command | 依赖 |
|---|---|---|
| `projects:list` | `list_projects` | — |
| `projects:add` | `add_project` | Tauri dialog |
| `files:list` | `list_file_tree` | tauri-plugin-fs |
| `files:readContent` | `read_file_content` | tauri-plugin-fs |
| `agents:create` | `create_agent` | tauri-plugin-shell |
| `agents:prompt` | `send_prompt` | 自定义 RPC |
| `terminal:input` | `terminal_input` | tauri-plugin-pty |
| `terminal:data` | event `terminal-data` | tauri-plugin-pty |
| `feishu:connect` | `feishu_connect` | 自封装 HTTP |
| `feishu:statusRequest` | `feishu_status` | — |

---

## 6. 风险矩阵

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| `node-pty` 替代方案功能不完整 | 🔴 高 | 先用 `tauri-plugin-pty` 做 POC，验证 `pty.spawn()` + xterm 双向数据流能否达到当前效果 |
| 飞书 SDK 无 Rust 版导致 Feishu 功能退化 | 🔴 高 | 分步迁移：第一阶段只保留「消息接收+转发」，第二阶段再实现完整 Card 镜像、SSE 流式渲染 |
| 80 个 IPC handler 改写工作量大 | 🟡 中 | 按模块分批迁移，每次交付一个功能集群；可先搭 Rust 骨架再逐个填充 command |
| WebView 跨平台渲染差异 | 🟡 中 | 建立跨平台截图测试（CI 中跑 Win/macOS/Linux），发现差异后加 polyfill |
| 打包/签名/自动更新流程变更 | 🟡 中 | Tauri 的 CI 配置与 electron-builder 不同，需在 `tauri.conf.json` 中重新配置 |
| 团队尚无 Rust 经验 | 🟡 中 | 先从低难度模块（文件系统、store）写 Rust 练兵，再挑战核心模块 |

---

## 7. 迁移顺序（推荐分期）

### Phase 0：技术验证（POC，1–2 天）
- [ ] 初始化 Tauri 2 项目（`npm create tauri-app`）
- [ ] 将当前 `src/renderer/src/` 目录作为前端源引入 Tauri
- [ ] 验证 React 页面能在 Tauri WebView 中正常运行
- [ ] 实现一个最简单 Rust command（如 `greet`），验证 JS→Rust 双向调用
- [ ] 验证 `tauri-plugin-pty` 能否创建终端并接收数据

### Phase 1：基础设施迁移（1–2 周）
- [ ] 搭建 Rust 项目骨架：`src-tauri/src/` 模块划分
- [ ] 迁移 SettingsStore → 实现 `AppState` 全局状态
- [ ] 迁移 ProjectStore → Tauri store
- [ ] 迁移 FileSystemService → tauri-plugin-fs
- [ ] 迁移 GitService → shell command
- [ ] 迁移 AppLogger → tracing crate
- [ ] 建立前端类型映射：`shared/types.ts` → Rust `struct`

### Phase 2：核心 Agent 逻辑迁移（2–3 周）
- [ ] 迁移 PiLocator → 环境检测
- [ ] 迁移 PiRpcClient → Rust 版 JSON-RPC over stdin/stdout
- [ ] 迁移 AgentManager → 子进程管控状态机
- [ ] 迁移 Session Scanner / Importer → 文件解析
- [ ] 迁移 会话相关 IPC（fork / switch / clone / exportHtml）

### Phase 3：终端迁移（1–2 周）
- [ ] 验证/修复 `tauri-plugin-pty` 或自写 PTY wrapper
- [ ] 实现 TerminalSessionManager 的 Rust 等价物
- [ ] 建立终端数据流的 Tauri event（onData / onExit）
- [ ] 前端 xterm 适配 Tauri event 通道

### Phase 4：复杂模块迁移（2–3 周）
- [ ] Feishu Bridge（HTTP 封装 + 事件订阅 + 流式 Card）
- [ ] Desktop Pet 系统（多窗口 + 透明背景 + 精灵动画）
- [ ] Config Manager（模型/认证/信任配置）
- [ ] Telemetry → PostHog API
- [ ] Web Service → 嵌入式 HTTP

### Phase 5：打包与发布（1 周）
- [ ] 配置 `tauri.conf.json`（图标、窗口、能力权限）
- [ ] 配置代码签名（Windows Authenticode + macOS notarization）
- [ ] 配置 Auto-Updater（tauri-plugin-updater）
- [ ] 配置 CI/CD（GitHub Actions 构建 + 签名 + 发布）
- [ ] 生产测试（Windows / macOS / Linux 全平台）
- [ ] 更新 README、CHANGELOG 和文档站

---

## 8. 参考资源

- [Tauri 2 官方文档](https://v2.tauri.app/)
- [Blink — Tauri + Monaco + React IDE](https://github.com/bmarti44/blink)
- [tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty) — 社区 PTY 插件
- [tauri-plugin-shell](https://v2.tauri.app/plugin/shell/) — 官方 Shell 插件
- [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api) — Monaco 编辑器 VS Code API 兼容层

---

## 9. 决策清单（启动迁移前确认）

- [ ] 核心痛点是否来自 Electron 的体积/内存/启动速度？
- [ ] 团队是否愿意投入 Rust 学习成本？
- [ ] 是否已用 `tauri-plugin-pty` 做终端 POC 并确认可行？
- [ ] 飞书连接是否能接受功能退化的分期迁移方案？
- [ ] 用户基数是否足够小，可以在迁移期间进行 Beta 测试？
- [ ] 是否准备好了双线维护（旧版 Electron 维护 + 新版 Tauri 开发）的时间？

> 如以上全部为「是」→ 启动 Phase 0  
> 如有任一「否」→ 建议优先在 Electron 上微调优化