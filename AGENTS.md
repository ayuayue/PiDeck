# AGENTS.md

## 项目简介

pi-desktop 是一个面向本地开发工作的 Electron 桌面应用，用于在多个项目目录之间管理和运行 pi RPC Agent。应用提供多项目工作区、会话时间线、历史会话恢复、文件抽屉、Git 分支信息、模型选择、工具调用展示以及打包发布能力，目标是让用户可以在桌面端更稳定地管理多个 pi 编码助手会话。

## 开发要求

- 修改核心逻辑、复杂状态流转、业务规则、数据转换或异常处理时，需要补充有价值的代码注释。
- 注释应说明为什么这样做、对应的业务规则或边界条件，不要逐行解释显而易见的代码。
- UI 调整应尽量保持现有桌面三栏布局和微信式交互风格，避免引入无关重构。
- 修改后应根据影响范围运行必要验证，例如 `npm run typecheck`。

## UI 设计规范

- 主界面保持桌面工作台结构：左侧项目/Agent 列表、中间会话、右侧上下文抽屉和底部终端。不要把核心体验改成营销页、卡片堆叠页或强装饰布局。
- 视觉风格以安静、克制、开发工具感为主。颜色优先使用 `styles.css` 顶部的语义 token；新增颜色前应先判断能否复用 `--color-*`、`--shadow-*`、`--focus-ring`。
- 圆角统一使用小圆角 token，常规控件优先 `--radius-sm` / `--radius-md`，大型页面式弹层不使用夸张圆角；避免在组件中直接写新的固定圆角值。
- 字号优先使用 `--font-size-*` 和 `--line-height-*` token。普通正文、按钮、表单、列表 meta 不再直接写散落的 `px` 字号；图形 logo 等视觉标识可保留独立尺寸。
- 间距尽量遵守 4px 栅格，优先使用 `--space-*` 或与相邻布局一致的响应式 padding。列表 hover、按钮显隐不能造成文本跳动。
- 交互态必须覆盖 hover、active、disabled 和 `focus-visible`。输入、下拉、按钮和可点击列表项应使用统一焦点环，不要只依赖颜色变化表达状态。
- 暗色模式必须通过语义 token 自然适配。新增面板、弹层、菜单、日志、代码块时，不要写死浅色背景或固定深色块，除非是明确的终端主题或图片预览遮罩。
- 多语言文案必须走 `i18n.ts`，不要在 JSX 中新增硬编码中英文可见文本。按钮和 tab 需要为英文、中文和伪翻译预留伸缩空间。
- 设置、配置管理、反馈等全屏页面式弹层需要适配自定义标题栏，内容不能被顶部窗口控制栏遮挡。
- 公共控件优先沉淀到 `src/renderer/src/components/ui/`，例如 `Button`、`IconButton`、`TextField`、`SelectField`。当两个以上页面需要相同按钮、输入、下拉、badge、列表行或弹层结构时，应优先抽为共享组件或共享 class。

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

## 提交commit规则

1 不要改完一次就commit一次
2 用户主动要求才commit
3 整个功能完成,并征求用户同意后才能commit
