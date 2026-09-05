# 功能介绍

PiDeck 的核心目标是把多个本地 pi Agent 会话收拢到一个稳定的桌面工作台里。

## 多项目工作区

- 添加、搜索、拖动排序和切换本地项目目录。
- 每个项目可以运行多个 Agent tab。
- 项目之间通过独立 cwd 和独立 pi RPC 进程隔离。
- 项目列表顶部提供内置 Chat 入口，适合不绑定代码目录的通用对话。

<img class="doc-screenshot" src="/images/overview.png" alt="工作区与对话界面">

## 会话管理

- 新建会话、恢复历史会话、重命名会话。
- 通过项目历史按钮、侧边栏或右键菜单操作会话。
- 从项目右键菜单导入 Codex 或 Claude 本地会话。
- 支持将会话导出为 HTML。
- Agent 每轮回答完成后展示本轮修改文件名和修改行数。

## 输入增强

- `@` 文件引用建议。
- `&` 历史会话消息引用。
- 方向键可在合适的光标位置复用历史输入。

## 文件与 Git

- 文件抽屉展示项目文件树。
- 文件项显示 Git 状态。
- 右键菜单支持打开文件、在系统文件管理器中定位文件。
- 顶部显示当前 Git 分支，并支持本地与远程分支切换。

<img class="doc-screenshot" src="/images/files.png" alt="文件树与会话操作">

## 工具调用展示

思考、工具调用和回答片段会聚合为活动轨迹，工具详情可展开和复制，运行中、完成、退出码等状态会在同一条流程里展示。对长任务来说，这比把所有调用明细直接堆进对话更容易扫描。

## 外部编辑器集成

PiDeck 支持在设置中配置外部编辑器，配置后在项目右键菜单或文件面板右键菜单中可以用指定编辑器打开项目或文件。

目前支持以下编辑器：

- **Visual Studio Code**（含 Insiders、VSCodium）
- **Cursor**
- **Zed**
- **IntelliJ IDEA**
- **WebStorm**
- **PhpStorm**
- **PyCharm**

Windows 下编辑器检测会依次尝试 PATH、常见安装目录、Windows 注册表，自动发现已安装的编辑器。

## 日志面板

设置中的日志页现在支持按日志级别（Debug / Info / Warn / Error）和时间范围筛选，方便排查运行时问题。

## 终端 Dock

当前 Agent 可以绑定独立终端 tab，支持 PowerShell、cmd、sh fallback、多 tab、主题切换、拖拽高度、右键复制选区和关闭确认。

<img class="doc-screenshot" src="/images/terminal.png" alt="终端 Dock 界面">
