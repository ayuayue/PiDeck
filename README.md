# PiDeck

[English](README.en.md) · [LinuxDO 友链](https://linux.do)

**一个用于管理多个 [pi](https://pi.dev) 编码 Agent 会话的桌面工作台。**

![Status](https://img.shields.io/badge/status-experimental-orange)
![License](https://img.shields.io/badge/license-MIT-blue)
![Electron](https://img.shields.io/badge/Electron-38-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![Version](https://img.shields.io/badge/version-0.6.6--beta.1-yellow)

**PiDeck** 是一个开源的Pi桌面工作台，用于在本地项目目录中统一管理 pi Agent 会话，并支持导入 Codex、Claude 本地会话以便统一浏览和恢复。基于 Electron + TypeScript 构建，提供多项目工作区、AI 会话管理、Git 集成、内置终端、模型配置和插件扩展能力，让本地 AI 编码助手在多项目环境中保持统一、可追溯、可配置。

**适合谁用：** 希望在桌面端同时管理多个本地项目的 AI 编程助手会话、需要统一查看会话历史与 Git 状态、并希望以图形化方式管理 pi 配置的开发者。

`PiDeck` **不是** pi 的分支。它是一个轻量 Electron 外壳，通过启动多个 `pi --mode rpc` 进程，将项目管理、会话管理、对话界面、配置管理和工具编排整合到一个原生桌面应用中——所有 Agent 能力由 pi 原生提供。

---

## 📋 更新日志

> **最新版本 v0.6.6-beta.1**（2026-07-22）

### v0.6.6-beta.1 更新亮点
- 🚀 **Git 源代码管理**：VS Code 风格三面板（变更/历史/比较）、AI 提交摘要生成、Cherry-pick/Revert/Reset/Drop、Graph 可视化、分支切换、Worktree 工作区
- 🚀 **& 会话引用快捷输入**：键入 `&` 搜索引用同项目会话、选择特定消息或全部上下文、持久化选择
- 🚀 **多 Tab 文件编辑器**：5 个并发 Tab、弹框/侧栏双模式、Diff 对比
- 🚀 **消息队列**：Agent 忙碌时排队发送、支持撤回编辑、Follow-up/Steer 模式
- 🚀 **WSL 环境支持**：完整 WSL 隔离、pi 检测、会话扫描、发行版选择
- 🚀 **内置浏览器**：多标签、全屏、设备预设
- 🚀 **SkillHub 社区技能商店**
- ✨ 设置页重构、分区域字体、窗口缩放、文件图标（VS Code Seti）
- ✨ 浮动快捷操作栏（终端/文件/Git/浏览器/草稿本/编辑器）
- 🐛 RichInput 光标漂移根治、Monaco 懒加载、大量稳定性修复

[查看完整更新日志 →](CHANGELOG.zh-CN.md)

---

## 核心功能

| 功能 | 说明 |
|---|---|
| **多项目工作区** | 添加、搜索、拖动排序和切换本地项目目录，同时运行多个 pi Agent，项目间完全隔离。 |
| **内置 Chat 对话区** | 项目列表顶部固定 Chat 入口，写入应用用户目录，适合无需绑定代码项目的通用对话。 |
| **计划模式 (Plan Mode)** | Composer 工具栏切换计划模式，Agent 先生成计划，逐条确认后执行，取消后返回选单。 |
| **消息编辑/删除** | AI 回答和用户消息均支持复制、编辑和删除，编辑后回填到输入框重新发送。 |
| **草稿本 (ScratchPad)** | 浮层式草稿本，支持内容预览、勾选映射和动画，颜色使用主题语义 token。 |
| **内容行宽限制** | 可拖拽的内容宽度滑块，默认不限宽，往左拖逐渐变窄，适应长行代码阅读或紧凑布局需求。 |
| **配置、Skill 与 Extension 管理** | 可视化编辑器管理 pi 的 `models.json`、`auth.json`、`settings.json`，并可管理全局 Skills 与 Extensions。 |
| **扩展启用/禁用** | 支持禁用/启用内置扩展，项目级技能/扩展管理，区分全局与项目级配置。 |
| **信任确认系统** | 桌面端拦截信任确认，不信任仍可打开项目；有 Agent 运行时禁止删除项目。 |
| **代理设置** | 独立管理 pi agent 子进程代理和桌面端代理，模型拉取与连接测试可走桌面端代理。 |
| **斜线命令 & `!` Shell** | 内置斜线命令建议（`/compact`、`/session` 等），支持 `!command` / `!!command` 在聊天输入框直接执行 Shell 命令。 |
| **内嵌终端 Dock** | 当前 Agent 绑定独立终端 tab，支持 PowerShell/cmd/sh fallback、多 tab、主题切换、拖拽高度、右键复制选区和关闭确认。 |
| **会话管理** | 新建会话、项目内联历史、恢复历史会话、重命名、复制、导出 HTML、删除历史会话和关闭 Agent——通过侧边栏或右键菜单即可完成。 |
| **会话导入** | 项目右键可导入 Codex 和 Claude 本地会话，转换为 PiDeck 历史会话后继续浏览和恢复。 |
| **Git 集成** | 实时显示当前分支，支持本地 + 远程分支选择器、分支数量徽章、分支切换和新建分支。 |
| **局域网 Web 服务** | 可在设置中启动本机 Web 服务，局域网设备可通过电脑 IP 和端口访问。 |
| **会话活动轨迹** | 思考、工具调用和回答片段按流程聚合展示，工具详情可展开复制，状态和退出码清晰标识。 |
| **内置浏览器预览** | 右侧抽屉内置浏览器，支持多标签、地址栏、全屏以及 PC/手机/平板视口预设，便于边对话边查看网页。 |
| **回答级修改摘要** | Agent 每轮回答完成后在对应回答下方以紧凑列表展示本轮修改文件名和修改行数，Files 面板保留本次会话总览。 |
| **上下文感知输入** | `@` 文件引用建议、`!` Shell 执行、`/` 斜线命令和命令历史——统一在同一个输入框中。 |
| **应用更新提示** | 定时检查 GitHub Release，发现新版本后展示发布日志和推荐下载入口，下载交由系统默认浏览器处理。 |
| **系统托盘** | 关闭窗口默认最小化到托盘，托盘右键菜单，双击恢复窗口。 |

---

## 截图

### 工作区与对话界面

![工作区总览](docs/images/overview.png)

Markdown 渲染 + 流式输出、活动轨迹、工具调用详情、回答级修改文件摘要、模型/思考等级/上下文/缓存状态栏、Git 分支选择器、操作按钮（New Session · Stop · Restart · Files · History · Terminal）。

### 配置管理

![配置管理](docs/images/config.png)

可视化编辑器：Models（Provider 卡片 + 模型网格 + 连接测试）、Auth（API Key 管理）、Settings（类型感知的键值编辑器）、源文件（原始 JSON 编辑）——保存后可按需重启 Agent 生效。

### 斜线命令与会话历史

![斜线命令及会话历史](docs/images/slash-commands.png)

内置斜线命令建议面板（带功能说明），配合右侧历史会话抽屉，快速浏览和恢复过往对话。

### 文件树与会话操作

![文件树及会话操作](docs/images/files.png)

项目文件树（含 Git 状态标识）、输入框 `@` 文件引用建议、Files 面板顶部的本次会话修改列表、会话右键菜单（重命名 · 复制 · 导出 HTML · 删除 · 关闭 Agent）。

---

## 架构设计

```txt
PiDeck
├─ Electron 主进程
│  ├─ 管理项目记录
│  ├─ 启动 pi --mode rpc 进程
│  ├─ 管理 Agent 绑定的本地 pty 终端
│  ├─ 桥接文件、会话、Git 操作
│  ├─ 检查 GitHub Release 更新
│  └─ 暴露安全 IPC API
│
├─ Electron Preload
│  └─ 向 Renderer 暴露 window.piDesktop
│
├─ React Renderer
│  ├─ 项目和 Agent 列表
│  ├─ 聊天时间线（流式输出）
│  ├─ 文件 / 历史抽屉
│  ├─ 配置与 Skill 管理弹窗（配置管理 / Skills）
│  ├─ Agent 绑定的 Terminal Dock
│  ├─ 模型与上下文状态栏
│  ├─ 会话结束修改摘要与更新提示弹窗
│  └─ 设置 UI（基础设置 / 代理设置 / 开发设置）
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

👉 **[GitHub Releases](https://github.com/ayuayue/PiDeck/releases)**

> PiDeck 需要单独安装 `pi` CLI 并确保其加入系统 `PATH`。

---

## 快速开始（从源码运行）

```bash
git clone https://github.com/ayuayue/PiDeck.git
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
│  ├─ terminal/           # Agent 绑定的 pty 终端
│  └─ index.ts            # Electron 主入口
│
├─ preload/
│  └─ index.ts            # 安全 IPC 桥接
│
├─ renderer/
│  └─ src/
│     ├─ App.tsx          # 主界面
│     ├─ components/      # 拆分后的 UI 组件
│     ├─ config/          # 配置弹窗子组件和配置工具
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

## 贡献者

感谢所有为 PiDeck 做出贡献的人！完整名单请查看 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

---

## QQ 交流群

欢迎加入 PiDeck QQ 群进行交流、反馈和讨论：

**1026218644**

---

## 安全说明

本应用启动本地 `pi` 进程并通过 Electron IPC 暴露有限的文件操作。请仅运行你信任的源码。应用默认发送匿名、低频的 `app_heartbeat` 使用统计，用于了解版本分布、平台兼容性和活跃安装数量，可在设置中关闭；不会收集项目路径、代码、消息内容、会话内容或文件名，也不会上传文件。第三方统计服务会接收请求元数据。pi agent 子进程代理和桌面端模型拉取/测试代理可独立配置；系统浏览器打开的外部链接仍由系统浏览器网络设置决定。

## License

MIT
