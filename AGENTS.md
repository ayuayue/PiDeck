# AGENTS.md

## 项目简介

PiDeck 是一个面向本地开发工作的 Electron 桌面应用，用于在多个项目目录之间管理和运行 pi RPC Agent。应用提供多项目工作区、会话时间线、历史会话恢复、文件抽屉、Git 面板、模型选择、工具调用展示、内置浏览器、中文提示词精选、技能/扩展商店以及打包发布能力，目标是让用户可以在桌面端更稳定地管理多个 pi 编码助手会话。

技术栈：Electron 38 + React 19 + TypeScript + Vite。

## 目录结构

```
src/
├── main/              # Electron 主进程
│   ├── pi/            # pi RPC 进程管理、消息解析
│   ├── sessions/      # 会话扫描、导入、摘要缓存
│   ├── git/           # GitService（status/diff/commit/cherry-pick 等）
│   ├── prompts/       # PromptManager（本地模板）+ XuePromptManager（SQLite 中文精选）
│   ├── skills/        # SkillManager
│   ├── extensions/    # ExtensionManager
│   ├── settings/      # SettingsStore + DesktopProxy
│   ├── terminal/      # 终端会话管理
│   ├── pet/           # 桌面宠物
│   ├── feishu/        # 飞书集成
│   └── web/           # Web 服务管理
├── preload/           # preload 脚本，暴露 IPC API
├── renderer/
│   └── src/
│       ├── components/
│       │   ├── ui/        # ★ 共享 UI 组件（Button/IconButton/SelectField/TextField/Modal）
│       │   ├── app/       # 业务组件（AppParts/GitPanel/BrowserPanel/FileDiffViewer 等）
│       │   ├── terminal/  # 终端 Dock
│       │   ├── scratchPad/# 草稿本
│       │   └── feishu/     # 飞书相关
│       ├── config/        # 配置弹窗各 tab（Models/Auth/Settings/Skills/Prompts/Extensions）
│       ├── assets/        # 字体、编辑器图标、git-logo
│       ├── utils/         # monacoSetup、openExternal、notice、agentRuntimeState 等
│       ├── i18n.ts        # 所有可见文案
│       └── styles.css     # 全局样式 + 语义 token
└── shared/            # 主进程与渲染进程共享类型和 IPC 通道定义
```

## 开发要求

- 修改核心逻辑、复杂状态流转、业务规则、数据转换或异常处理时，需要补充有价值的代码注释。
- 注释应说明为什么这样做、对应的业务规则或边界条件，不要逐行解释显而易见的代码。
- UI 调整应尽量保持现有桌面三栏布局和微信式交互风格，避免引入无关重构。
- 修改后应根据影响范围运行必要验证，例如 `npm run typecheck`。

## 共享 UI 组件（必须使用）

> **核心规则：新增 UI 时优先使用 `src/renderer/src/components/ui/` 下的共享组件，不要自己造轮子，也不要用原生 HTML 控件。**

### 已有组件

| 组件 | 路径 | 用途 | 何时用 |
|------|------|------|--------|
| `Button` | `components/ui/Button.tsx` | 主按钮、次按钮、危险按钮、ghost 按钮；支持 `loading` | 任何可点击的操作按钮 |
| `IconButton` | `components/ui/IconButton.tsx` | 纯图标按钮，带 `aria-label` | 工具栏图标按钮、行内操作按钮 |
| `CloseIconButton` | `components/ui/IconButton.tsx` | 统一的关闭按钮（X 图标） | 弹框/抽屉的关闭按钮 |
| `SelectField` | `components/ui/SelectField.tsx` | 自定义下拉选择器（按钮 + 弹出 listbox） | **替代所有原生 `<select>`** |
| `TextField` | `components/ui/TextField.tsx` | 带标签的文本输入 | 表单输入、配置项编辑 |
| `Modal` | `components/ui/Modal.tsx` | 基于 Radix Dialog 的弹框，支持 full/medium/small 三档尺寸 | 全屏弹框、中/小弹框 |
| `LazyMonacoEditor` | `components/ui/LazyMonacoEditor.tsx` | Monaco 编辑器懒加载封装 | 代码编辑、SKILL.md 编辑 |

### 禁止的做法

| ❌ 禁止 | ✅ 正确 |
|---------|---------|
| `<select><option>...</option></select>` | `<SelectField label=... value=... options=... onChange=... />` |
| `<input type="text" />` 裸写 | `<TextField label=... value=... onChange=... />` |
| `<button className="随便写">` | `<Button variant="primary">...</Button>` 或 `<IconButton label="...">{icon}</IconButton>` |
| 手写 `div + onClick` 弹框 | `<Modal open=... onClose=...>...</Modal>` |
| 自己实现 `✕` 关闭按钮 | `<CloseIconButton label={t("common.close")} onClick=... />` |

### 自定义下拉的例外

如果 `SelectField` 无法满足需求（例如选项里需要显示图标、两行文字、分组等），可以参考 `GitPanel.tsx` 的 `GitCompactFilter` 自定义实现，但必须：
- 使用 `button + role="listbox"` + `role="option"` 的 ARIA 结构
- 用 `ChevronDown` 图标（来自 lucide-react）
- 支持 `Escape` 关闭、点击外部关闭、键盘 `ArrowDown/ArrowUp` 打开
- 样式走 `--color-*` 语义 token，不要写死颜色

## 图标系统

> **图标统一使用 `lucide-react`，不要引入其他图标库，不要用 emoji 代替功能图标。**

### 使用规范

- 所有功能图标来自 `lucide-react`（已在 `package.json` 中，`^1.17.0`）。
- 图标尺寸：按钮内 `14~18`，行内 `12~15`，标题旁 `18~20`。
- `strokeWidth` 统一 `1.8`（默认）或 `2.0~2.4`（强调状态）。
- 交互图标必须带 `aria-hidden="true"`（纯装饰），可点击的图标按钮用 `IconButton` + `aria-label`。
- 不要用 emoji（🚀🔥✅ 等）作为 UI 控件图标，只能用于文案/通知。

### Logo

项目 Logo 是一个**特定的 SVG 路径**，不是通用图标，不要用 lucide 的图标替代。

- **品牌 Logo（应用图标/启动画面/Agent 头像）**：使用 `LogoMark` 组件（`AppParts.tsx`），它内嵌 PiDeck 标志的 SVG path。
  ```tsx
  <LogoMark />  // 22x22 品牌标志
  ```
- **Agent 头像**：使用 `AgentAvatar` 组件（`AppParts.tsx`），内嵌相同的 SVG path + 状态 class。
- **启动画面 Logo**：见 `index.html` 中的 `#boot-logo`，SVG path 与 `LogoMark` 保持一致。
- **项目头像**：使用 `ProjectAvatar` 组件（`AppParts.tsx`），区分 chat / project 两种 kind。
- **编辑器 Logo**：使用 `src/renderer/src/assets/editors/` 下的对应图片，通过 `new URL("./assets/editors/vscode.png", import.meta.url).href` 引用，配合 `editor-logo` class。
- **Git Logo**：`src/renderer/src/assets/git-logo.svg`。

> 修改 Logo 时，`LogoMark`、`AgentAvatar`、`EmptyState`、`index.html` 中的 SVG path 必须保持一致。

## UI 设计规范

- 主界面保持桌面工作台结构：左侧项目/Agent 列表、中间会话、右侧上下文抽屉和底部终端。不要把核心体验改成营销页、卡片堆叠页或强装饰布局。
- 视觉风格以安静、克制、开发工具感为主。颜色优先使用 `styles.css` 顶部的语义 token；新增颜色前应先判断能否复用 `--color-*`、`--shadow-*`、`--focus-ring`。
- 圆角统一使用小圆角 token，常规控件优先 `--radius-sm` / `--radius-md`，大型页面式弹层不使用夸张圆角；避免在组件中直接写新的固定圆角值。
- 字号优先使用 `--font-size-*` 和 `--line-height-*` token。普通正文、按钮、表单、列表 meta 不再直接写散落的 `px` 字号；图形 logo 等视觉标识可保留独立尺寸。
- 间距尽量遵守 4px 栅格，优先使用 `--space-*` 或与相邻布局一致的响应式 padding。列表 hover、按钮显隐不能造成文本跳动。
- 交互态必须覆盖 hover、active、disabled 和 `focus-visible`。输入、下拉、按钮和可点击列表项应使用统一焦点环，不要只依赖颜色变化表达状态。
- 暗色模式必须通过语义 token 自然适配。新增面板、弹层、菜单、日志、代码块时，不要写死浅色背景或固定深色块，除非是明确的终端主题或图片预览遮罩。

## 多语言文案

> **所有用户可见文本必须走 `i18n.ts`，不要在 JSX 中硬编码中英文。**

- 新增文案时在 `i18n.ts` 中添加 key，同时提供中文（`zh`）和英文（`en`）。
- 按钮、tab、label、placeholder、toast、空状态文案都属于"可见文本"。
- 按钮和 tab 需要为英文、中文和伪翻译预留伸缩空间（不要用固定宽度）。
- 日志、调试输出、内部标识符不算"可见文本"，可以硬编码。

## 样式与布局

- 全局样式在 `src/renderer/src/styles.css`，所有语义 token 定义在文件顶部 `:root`。
- 新增样式优先复用已有 class（如 `config-btn`、`config-icon-btn`、`config-toolbar`、`config-empty`、`config-loading`、`config-error`、`modal-backdrop` 等），避免散落的内联 style。
- 设置、配置管理、反馈等全屏页面式弹层需要适配自定义标题栏，内容不能被顶部窗口控制栏遮挡。

### 弹框尺寸规范

所有全屏式弹框（设置、配置、导入、会话管理、项目资源等）使用统一的尺寸，以确保视觉一致性：

```css
width: min(1300px, calc(100vw - 48px));
height: min(850px, calc(100vh - 48px));
```

如果弹框内容无需那么高，可以缩小高度但不要改变宽度。小号选择器弹框（如模型选择器、思考级别选择器）不受此限。

弹框使用以下样式基底：
- `border-radius: var(--radius-lg)`
- `box-shadow: var(--shadow-xl)`
- 点击 backdrop（`<div className="modal-backdrop">`）关闭弹框，弹框本身通过 `stopPropagation()` 阻止冒泡

> **推荐使用 `components/ui/Modal.tsx`**，它基于 Radix Dialog 已内置以上规范。

## 字体使用标准

- `--font-family-base` 用于全局 UI 正文、按钮、表单、列表和长说明文本，保持系统 UI 字体优先，以保证中英文和 Windows 渲染清晰。
- `PiDeckPlantin` 用于品牌字标、站点展示标题或少量品牌化标题，不用于长正文、密集列表和表单标签。
- `PiDeckCommitMono` 是默认等宽字体，用于代码块、终端、RPC 日志、路径、模型 ID、端口和需要对齐的技术文本。
- `PiDeckDepartureMono` 仅用于文档站或品牌展示页的少量展示型技术标识；Desktop 主应用不要使用，避免密集工具界面显得粗糙。
- `--font-family-business` 用于业务展示型短文本，例如状态徽标、计数、耗时、模型 chip、端口和运行状态；Desktop 中该 token 应指向 `PiDeckCommitMono`，正文、按钮和长说明仍使用 `--font-family-base`。
- 新增字体文件应放在 renderer 或 docs-site 对应资产目录，并配套 `font-display: swap`。不要从远程 CDN 加载运行时字体。

## Issue 修复流程

处理 GitHub Issue 或外部反馈缺陷时，应按以下分支流程进行，避免直接在 `main` 上修复：

1. 从最新 `main` 创建短修复分支，命名建议为 `fix/issue-<number>-<short-description>`，例如 `fix/issue-1-windows-pi-path-spaces`。
2. 修复前先定位根因，记录影响范围；如果问题涉及启动、环境检测、会话恢复等核心流程，应同步检查相邻路径是否存在同类问题。
3. 修复提交应聚焦单一问题，提交信息建议使用 `fix:` 前缀，并在 PR 或提交说明中关联 issue。
4. 推送修复分支后创建 PR，PR 描述需包含问题原因、修复摘要、验证命令，并使用 `Closes #<number>` 让合并后自动关闭 issue。
5. 合并建议使用 Squash and merge，保持 `main` 历史清晰；合并后视用户影响决定是否发布 patch 版本。
6. 如果修复包含用户可见行为变化或需要发版，应同步遵守下方发版要求。

## 发版要求

发版或准备 release 时，必须核对并更新以下内容：

1. `README.md` / `README.en.md`
   - 核对功能说明、截图说明、安装/使用说明是否仍然准确。
   - 如果本次版本包含用户可见的新功能、行为变化或配置变化，需要同步补充说明。

2. `CHANGELOG.md` / `CHANGELOG.zh-CN.md`
   - 为新版本增加对应版本号和日期。
   - 用简洁条目记录新增、优化、修复等用户可感知变化。
   - 中英文更新日志应保持信息一致。

3. GitHub Release 说明
   - 发布时需要在 release notes 中写明本次版本的主要变化。
   - Release 说明应覆盖 README 和 CHANGELOG 中提到的关键用户可见调整，避免只写版本号或空说明。

4. 版本号
   - 核对 `package.json` 和 `package-lock.json` 中版本号一致。
   - 发版提交应清晰标识版本，例如 `chore: release vX.Y.Z`。

5. docs-site同步修改
   官网pages项目也要记得更新

## 提交commit规则

### 核心原则

> **不要自以为是地提交代码。** 只有用户明确要求时，AI 助手才可以执行 `git add`、`git commit` 或 `git push`。**

### 规则

1. **禁止在工作过程中自动 commit** — 无论是修改文件、修复 bug 还是新增功能，完成一步后都不应自动提交。修改只是过程，不是节点。
2. **等待用户指令** — 只有用户说出「可以 commit 了」「提交吧」「推上去」「push」等明确意图时，才能执行 commit 或 push。用户没说，就不动。
3. **完成后再确认** — 整个功能或修复完成后，应向用户简要总结做了什么，并询问「需要我提交吗？」或类似措辞，等待用户确认。
4. **提交粒度** — 如果用户同意提交，应在一个 commit 中包含该功能/修复的全部文件变更，不要拆成多个小 commit。用户另有要求除外。

### 举例

| ❌ 错误做法                           | ✅ 正确做法                                  |
| ------------------------------------- | -------------------------------------------- |
| 改完一个文件就 `git add + git commit` | 改完整个功能后，问用户「可以提交吗？」       |
| 认为用户默认让自己提交                | 用户明确说了「提交」「commit」「push」才执行 |
| 把一个小修复拆成 3 个 commit          | 整个修复放在 1 个 commit 里                  |

### 提醒

如果用户长时间没有给出提交指令，可以主动询问一次，但不要频繁追问。


### GitHub协作说明

请查看 docs/PiDeck-协作说明.md 文件了解 GitHub 协作流程。