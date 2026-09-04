# 常见问题

这里整理了一些与 **PiDeck**、**pi Agent 桌面工作台**、**本地 AI 编码助手** 相关的常见问题，帮助搜索引擎和用户更快找到答案。

## PiDeck 是什么？

**PiDeck** 是一个开源的桌面工作台，用于在本地项目目录中统一管理 pi Agent 会话，并支持导入 Codex、Claude 本地会话以便统一浏览和恢复。它基于 Electron + TypeScript 构建，提供多项目工作区、AI 会话管理、Git 集成、内置终端、模型配置和插件扩展能力。

## PiDeck 和 pi 是什么关系？

PiDeck **不是** pi 的分支。它是一个轻量 Electron 外壳，通过启动多个 `pi --mode rpc` 进程，把项目管理、会话管理、对话界面、配置管理和工具编排整合到原生桌面应用中；所有 Agent 能力仍由 pi 原生提供。

## 支持哪些 AI 编码助手？

PiDeck 原生支持 **pi** Agent。通过会话导入功能，你也可以将本地的 **Codex** 和 **Claude** 会话导入为 PiDeck 历史会话，方便统一浏览和恢复。

## 支持哪些平台？

PiDeck 提供 **Windows**、**macOS**、**Linux** 的预构建安装包，通过 [GitHub Releases](https://github.com/ayuayue/PiDeck/releases) 发布。源码开发环境要求 Node.js 20+ 和 npm。

## 如何下载安装 PiDeck？

前往 [GitHub Releases](https://github.com/ayuayue/PiDeck/releases) 下载对应平台的安装包。安装后首次启动时，PiDeck 会尝试自动检测 `pi` 路径；如果检测失败，可以在设置里手动填写 pi 可执行文件路径。

## 从源码运行需要什么环境？

- Node.js 20+
- npm
- 系统 `PATH` 中可访问 `pi` 命令
- 已完成 pi 的 Provider、登录或 API Key 配置

验证 pi 是否可用：

```bash
pi --version
pi --mode rpc
```

## PiDeck 的主要功能有哪些？

- **多项目工作区**：同时管理多个本地项目，每个项目独立运行 pi Agent
- **会话历史与恢复**：浏览、恢复、导出历史对话
- **Git 集成**：实时分支显示、文件状态、本地和远程分支管理
- **内置终端 Dock**：Agent 绑定独立终端 tab，支持多标签、主题切换
- **可视化配置管理**：图形化编辑 Models、Auth、Settings
- **插件与 Skill 管理**：全局和项目级 Skills 与 Extension 管理
- **上下文感知输入**：`@` 文件引用、`&` 历史会话引用
- **内置浏览器预览**：右侧抽屉浏览网页，支持多标签和视口预设

## PiDeck 是免费的吗？

是的，PiDeck 基于 **MIT License** 开源，完全免费使用。

## 如何从源码开发 PiDeck？

```bash
git clone https://github.com/ayuayue/PiDeck.git
cd pi-desktop
npm install
npm run make-icon
npm run dev
```

常用开发命令：

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动开发模式 |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm run build` | 构建 Renderer + Main 产物 |
| `npm run dist` | 为当前平台打包 |

## PiDeck 会收集我的数据吗？

PiDeck 默认发送匿名、低频的 `app_heartbeat` 使用统计，用于了解版本分布、平台兼容性和活跃安装数量，可在设置中关闭。它**不会**收集项目路径、代码、消息内容、会话内容或文件名，也不会上传文件。

## 如何参与贡献？

欢迎提交 Issue 和 Pull Request。详细贡献说明请查看 [CONTRIBUTORS.md](/guide/contributors)。

## 遇到问题怎么办？

- 先看 [问题排查指南](/guide/troubleshooting)，按症状分类的处理路径
- 查看 [GitHub Issues](https://github.com/ayuayue/PiDeck/issues)
- 加入 **QQ 群：1026218644** 进行交流
