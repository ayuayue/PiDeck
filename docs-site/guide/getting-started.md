---
title: 快速开始 | PiDeck 安装与首次配置 | pi desktop 入门
description: PiDeck（pi desktop 桌面客户端）快速上手：下载安装 Windows/macOS/Linux 安装包、首次启动环境自检、一键安装 Node 与 pi CLI、创建第一个 Agent 会话。
---

# 快速开始

PiDeck 是一个用于管理多个 [pi](https://pi.dev) 编码 Agent 会话的桌面工作台。它负责桌面端工作流，Agent 能力仍由 pi CLI 提供。

## 环境要求

- Node.js 20+
- npm
- 系统 `PATH` 中可访问 `pi` 命令
- 已完成 pi 的 Provider、登录或 API Key 配置

验证 pi 是否可用：

```bash
pi --version
pi --mode rpc
```

## 下载安装

Windows、macOS、Linux 的预构建安装包发布在 GitHub Releases：

[打开 GitHub Releases](https://github.com/ayuayue/PiDeck/releases)

安装后首次启动时，PiDeck 会尝试自动检测 `pi` 路径。如果检测失败，可以在设置里手动填写 pi 可执行文件路径。

## 从源码运行

```bash
git clone https://github.com/ayuayue/PiDeck.git
cd PiDeck
npm install
npm run make-icon
npm run dev
```

## 基本工作流

1. 启动应用。
2. 添加一个本地项目目录。
3. 在项目里创建 Agent 会话。
4. 选择模型和思考等级。
5. 在聊天输入框中发送任务，或使用 `/`、`@`、`!` 提升输入效率。

## 浏览器预览模式

开发 UI 时可以直接打开浏览器预览：

```bash
npm run preview
```

Renderer 在 `window.piDesktop` 不可用时会降级为 mock 数据，适合调试布局和响应式表现。真实 Agent、会话和文件操作仍需要在 Electron 环境中验证。
