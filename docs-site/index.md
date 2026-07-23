---
layout: home

hero:
  name: PiDeck
  text: 多项目 pi Agent 桌面工作台
  tagline: 在统一的桌面工作区中管理本地 pi 编码助手会话、配置、Git 和终端，支持 Windows、macOS、Linux，让本地 AI 编码工作流更稳定高效。
  actions:
    - theme: brand
      text: 下载最新版本
      link: https://github.com/ayuayue/PiDeck/releases
    - theme: alt
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 查看 GitHub
      link: https://github.com/ayuayue/PiDeck

features:
  - title: 多项目工作区
    details: 添加、搜索、拖动排序和切换本地项目目录，每个 Agent 会话都保持项目级隔离，同时运行多个 pi Agent。
  - title: 会话历史与恢复
    details: 恢复历史会话，按时间线查看工具调用和回答细节，并回放历史会话中的修改内容，支持 Codex 和 Claude 会话导入。
  - title: Git 集成
    details: 实时分支显示和切换，文件树展示 Git 状态，VS Code 风格三面板（变更/历史/比较），AI 提交摘要生成，branch graph 可视化，cherry-pick/revert/reset/drop 操作，worktree 工作区支持。
  - title: 对话 & 引用
    details: "& 会话引用快捷输入，跨会话上下文注入。消息队列在 Agent 忙碌时排队发送。会话大纲面板快速跳转。"
  - title: 文件编辑器
    details: 多 Tab 文件编辑器，弹框/侧栏双模式，Diff 差异对比，Markdown 预览，Monaco 编辑器支持。
  - title: 内置工具
    details: 内置浏览器（多标签/全屏/设备预设）、草稿本、外部编辑器集成、浮动快捷操作栏、内置终端。
  - title: 内嵌终端 Dock
    details: 当前 Agent 绑定独立终端 tab，支持 PowerShell/cmd/sh fallback、多 tab、主题切换、拖拽高度、右键复制。
  - title: 配置与插件管理
    details: 可视化编辑 Models、Auth、Settings，全局和项目级 Skills 与 Extension 管理，斜线命令和模板快速插入。
  - title: 跨平台下载
    details: Windows、macOS、Linux 安装包通过 GitHub Releases 发布，源码开发支持 npm 命令，内置浏览器预览。
---

<figure class="home-showcase">
  <img src="/images/overview.png" alt="PiDeck 工作区与对话界面截图">
  <figcaption>工作区、会话、文件抽屉、Git 分支和工具调用集中在同一个桌面窗口中。</figcaption>
</figure>

## 面向本地开发的桌面控制台

`PiDeck` 不是 pi 的分支。它是一个轻量 Electron 外壳，通过启动多个 `pi --mode rpc` 进程，把项目管理、会话管理、配置管理和桌面交互整合起来，Agent 能力仍由 pi 原生提供。

<div class="info-strip">
  <div>
    <strong>一个 Agent Tab</strong>
    一个独立 pi RPC 进程，避免不同项目和对话互相污染。
  </div>
  <div>
    <strong>一个工作台</strong>
    聊天、文件、历史、配置、终端和 Git 信息都在同一个桌面布局里。
  </div>
  <div>
    <strong>一个下载入口</strong>
    预构建包统一发布到 GitHub Releases，发现新版本后应用内会提示。
  </div>
</div>

## 截图预览

<div class="screenshot-grid">
  <div class="screenshot-card">
    <img src="/images/config.png" alt="配置管理界面">
    <strong>配置管理</strong>
    <span>可视化编辑模型、认证、设置和 Skills。</span>
  </div>
  <div class="screenshot-card">
    <img src="/images/slash-commands.png" alt="斜线命令与会话历史">
    <strong>命令与历史</strong>
    <span>内置斜线命令建议，快速恢复历史会话。</span>
  </div>
  <div class="screenshot-card">
    <img src="/images/files.png" alt="文件树与会话操作">
    <strong>文件抽屉</strong>
    <span>查看项目文件、Git 状态和本次会话修改。</span>
  </div>
  <div class="screenshot-card">
    <img src="/images/terminal.png" alt="终端 Dock 界面">
    <strong>终端 Dock</strong>
    <span>为当前 Agent 保留独立终端 tab。</span>
  </div>
</div>

## 社区交流

加入 PiDeck QQ 群进行交流、反馈和讨论：

**1026218644**

---

## 下一步

- 想直接使用：前往 [下载安装](/guide/getting-started#下载安装)。
- 想从源码运行：查看 [快速开始](/guide/getting-started#从源码运行)。
- 想了解功能边界：查看 [功能介绍](/guide/features)。
