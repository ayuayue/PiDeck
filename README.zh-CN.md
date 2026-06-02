# pi-desktop

[English](README.md) · [LinuxDO 友链](https://linux.do)

**一个用于管理多个 [pi](https://pi.dev) 编码 Agent 会话的桌面工作台。**

![Status](https://img.shields.io/badge/status-experimental-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Electron](https://img.shields.io/badge/Electron-38-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![Version](https://img.shields.io/badge/version-0.3.0-green)

`pi-desktop` **不是** pi 的分支。它是一个轻量 Electron 外壳，通过启动多个 `pi --mode rpc` 进程，将项目管理、会话管理、对话界面、配置管理和工具编排整合到一个原生桌面应用中——所有 Agent 能力由 pi 原生提供。

---

## 核心功能

| 功能 | 说明 |
|---|---|
| **多项目工作区** | 添加、搜索和切换本地项目目录，同时运行多个 pi Agent，项目间完全隔离。 |
| **配置管理** | 可视化编辑器管理 pi 的 `models.json`、`auth.json`、`settings.json`——无需手动编辑 JSON 文件即可管理 Provider、API Key 和模型配置。 |
| **斜线命令 & `!` Shell** | 内置斜线命令建议（`/reload`、`/compact`、`/session` 等），支持 `!command` / `!!command` 在聊天输入框直接执行 Shell 命令。 |
| **会话管理** | 新建会话、恢复历史会话、内联重命名、导出 HTML、关闭 Agent——通过侧边栏或右键菜单即可完成。 |
| **Git 集成** | 实时显示当前分支，支持本地 + 远程分支选择器、分支数量徽章和分支切换。 |
| **工具调用可视化** | 工具调用聚合卡片，摘要 + 可展开详情，运行中/完成/失败状态清晰标识。 |
| **上下文感知输入** | `@` 文件引用建议、`!` Shell 执行、`/` 斜线命令——统一在同一个输入框中。 |
| **系统托盘** | 关闭窗口默认最小化到托盘，托盘右键菜单，双击恢复窗口。 |

---

## 截图

### 工作区与对话界面

![工作区总览](docs/images/overview.png)

Markdown 渲染 + 流式输出、工具调用详情、模型/思考等级/上下文/缓存状态栏、Git 分支选择器、操作按钮（New Session · Stop · Reload · Restart）。

### 配置管理

![配置管理](docs/images/config.png)

可视化编辑器：Models（Provider 卡片 + 模型网格）、Auth（API Key 管理）、Settings（类型感知的键值编辑器）、源文件（原始 JSON 编辑）——保存后自动重载，热生效到运行中的 Agent。

### 斜线命令与会话历史

![斜线命令及会话历史](docs/images/slash-commands.png)

内置斜线命令建议面板（带功能说明），配合右侧历史会话抽屉，快速浏览和恢复过往对话。

### 文件树与会话操作

![文件树及会话操作](docs/images/files.png)

项目文件树（含 Git 状态标识）、输入框 `@` 文件引用建议、会话右键菜单（打开会话 · 导出 HTML · 关闭 Agent）。

---

## 架构设计

```txt
pi-desktop
├─ Electron 主进程
│  ├─ 管理项目记录
│  ├─ 启动 pi --mode rpc 进程
│  ├─ 桥接文件、会话、Git 操作
│  └─ 暴露安全 IPC API
│
├─ Electron Preload
│  └─ 向 Renderer 暴露 window.piDesktop
│
├─ React Renderer
│  ├─ 项目和 Agent 列表
│  ├─ 聊天时间线（流式输出）
│  ├─ 文件 / 历史抽屉
│  ├─ 配置管理弹窗（Models / Auth / Settings / 源文件）
│  ├─ 模型与上下文状态栏
│  └─ 设置 UI
│
└─ Pi 运行时
   ├─ 每个 Agent Tab 一个独立 pi RPC 进程
   ├─ 项目级 cwd 隔离
   └─ 使用 pi 原生会话 / 工具 / 模型 / 上下文
```

核心设计原则：**一个 Agent Tab = 一个 pi RPC 进程**，确保会话隔离，让 pi 继续负责其原生能力。

---

## 环境要求

- Node.js 20+
- npm
- 系统 `PATH` 中可访问 `pi` 命令
- 已完成 pi 的 Provider / 登录 / API Key 配置

验证 pi 是否可用：

```bash
pi --version
pi --mode rpc
```

---

## 下载安装

**Windows**、**macOS**、**Linux** 平台的预构建安装包在 GitHub Release 中发布：

👉 **[GitHub Releases](https://github.com/ayuayue/pi-desktop/releases)**

> pi-desktop 需要单独安装 `pi` CLI 并确保其加入系统 `PATH`。

---

## 快速开始（从源码运行）

```bash
git clone https://github.com/ayuayue/pi-desktop.git
cd pi-desktop
npm install
npm run make-icon
npm run dev
```

---

## 开发命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动开发模式 |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm run build` | 构建 Renderer + Main 产物 |
| `npm run dist` | 为当前平台打包 |
| `npm run dist:win` | 打包 Windows（NSIS + portable + zip） |
| `npm run dist:mac` | 打包 macOS（DMG + zip） |
| `npm run dist:linux` | 打包 Linux（AppImage + deb + tar.gz） |
| `npm run make-icon` | 生成图标资源到 `build/icon.svg` |

### 浏览器预览模式

直接打开 `http://localhost:5173/` 进行布局和响应式调试。Renderer 在 `window.piDesktop` 不可用时自动降级为 mock 数据，无需 Electron 环境。但涉及 Agent、会话、文件操作等真实 IPC 功能仍需在 Electron 中验证。

---

## 项目结构

```txt
src/
├─ main/
│  ├─ fs/                 # 文件树服务
│  ├─ git/                # Git 分支服务
│  ├─ pi/                 # Pi 进程与 RPC 管理
│  ├─ projects/           # 项目记录持久化
│  ├─ sessions/           # Pi 会话扫描
│  ├─ settings/           # 应用设置持久化
│  └─ index.ts            # Electron 主入口
│
├─ preload/
│  └─ index.ts            # 安全 IPC 桥接
│
├─ renderer/
│  └─ src/
│     ├─ App.tsx          # 主界面
│     ├─ previewApi.ts    # 浏览器预览降级
│     ├─ styles.css       # 应用样式
│     └─ main.tsx         # React 入口
│
└─ shared/
   ├─ ipc.ts              # IPC 通道名称
   └─ types.ts            # 共享类型定义
```

---

## 更新日志

详细版本历史请查看 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（中文）或 [CHANGELOG.md](CHANGELOG.md)（英文）。

---

## 安全说明

本应用启动本地 `pi` 进程并通过 Electron IPC 暴露有限的文件操作。请仅运行你信任的源码。应用不发送遥测数据，不上传文件——所有模型和 Provider 的网络行为由 pi 及其配置决定。

## License

MIT
