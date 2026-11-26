# Electron 会话设计语言对齐

本轮以本地 Electron PiDeck dev v0.13.1 的实现与原生窗口截图为依据，校准 V2 的
会话阅读与输入主路径。它是视觉校准记录，不等同于整款应用逐像素复刻完成。

## 设计依据

直接核对 Electron 仓库中的以下文件，而不是以 V2 的现有数值反推原版：

- `src/renderer/src/styles/foundation.css`：系统字体栈、16 px 正文、1.6 行高、字号档位、
  纸面/白卡、正文与元信息颜色。
- `src/renderer/src/styles/timeline.css`：提问白卡、过程字号下限、代码比例、输入框最小高度。
- `src/renderer/src/styles/streamdownChrome.css`：安静的 Markdown 标题刻度与段落密度。
- `src/renderer/src/components/session/chatContentWidth.ts` 与 `src/shared/types/settings.ts`：
  消息/输入框同列，默认 80%。
- `src/renderer/src/components/session/ComposerArea.tsx`：20 px 输入框圆角。

同时查看了 `%TEMP%/pideck-v2-ui-compare/reference-final/reference-session-complete.png`
与 V2 原生会话截图。旧对照图内容不同，只用于确认视觉语言；本轮用固定数据补充回归。

## 已校准

| 细节 | 原 V2 | 本轮 |
| --- | --- | --- |
| 默认阅读比例 | 正文 15、列宽 60% | 正文 16、列宽 80%，已保存值不变 |
| 字号预设 | 13 / 15 / 17 / 19 | 14 / 16 / 18 / 20，与原版两点步长一致 |
| 系统字体 | 空字体名，依赖宿主回退 | 显式系统 UI / CJK 字体栈；Windows 优先微软雅黑 UI；自定义字体优先 |
| 过程字号 | 行最大 13.5、详情最大 12.5 | `max(13, 正文−2)` / `max(12, 正文−4)`，大字号不再封顶 |
| 思考预览 | 等宽句子 | 界面字体，等宽只保留给代码、标识符和数据 |
| 阅读表面 | 白底配灰气泡 | 从主题表面派生浅灰纸面，白色描边提问卡，时间放在卡片外；暗色保留层次 |
| 正文墨色 | `#18181b` / `#ededed` | `#202124` / `#ecece7`，黑白主按钮独立保留 |
| Markdown 标题 | 通用文档刻度 | h1–h6 为正文 1.3 / 1.15 / 1.06 / 1.03 / 1 / 0.95 倍，行高 1.3 |
| Markdown 细节 | 代码与标题从应用默认字号缩放 | 行内代码 0.875、代码块 0.92、段距 0.7 倍；其他文本从 SDK 实际基线缩放 |
| 代码表面 | 侧栏灰底 | 与提问卡和输入框一致的内容卡表面 |
| 输入框 | 14 圆角、单行高度起步、较重边框 | 20 圆角、112 最小高度、48 文本区、主题原有细边框；占位文字提高对比度 |
| 发送按钮 | 26 高、胶囊、12.5 半粗 | 28 高、8 圆角、13 中等字重 |
| 回复操作 | 九个以上图标同级陈列 | 五个常用动作 + 更多；提问复制/恢复、轨迹、分叉/分支重试进入原生菜单 |

原生截图进一步揭示：当前 NSGo Windows 字体适配器只选择列表中的第一个可用字体。
因此 Windows 的 UI 字体顺序作了适配，不能机械照搬以 Segoe UI 开头的 CSS 栈。
等宽字体中的 CJK 缺字仍由 DirectWrite 回退，不把 CSS 回退声明当成已实现的字形控制。

## 回归与证据

- `internal/workbench/chat_design_test.go`：默认/20 pt 的正文与气泡字号、80% 对齐列、
  气泡外时间、112 最小输入框、自定义字体覆盖、更多菜单恢复草稿、浅深色与窄窗口。
- `internal/viewkit/markdown_test.go`：默认/16/20 三档的标题、正文、行内代码比例及字体继承。
- 原生图片：`internal/workbench/.nsgo/test/screenshots/windows/design-alignment/`
  下的 `reading-default.png`、`reading-large.png`、`light.png`、`dark.png`、`narrow-dark.png`。
  截图为本地验证证据，不提交生成物。
- Impeccable 对改动的 Go UI 文件完成正则扫描；该扫描不支持解析原生元素，不能替代截图检查。

本轮验证结果：

| 验证 | 命令 / 范围 | 结果 |
| --- | --- | --- |
| 静态检查 | `go tool nsgo check` | 通过；SDK 部分语言仍有既有回退警告 |
| 工作区短测试 | `go tool nsgo test -- -short -count=1 -timeout=20m` | 656 通过、0 失败、108 跳过 |
| Windows 原生回归 | `go tool nsgo test -target windows -run '^TestChatDesign' -timeout 3m ./internal/workbench` | 4 通过；检查默认/大字号、浅深色、窄窗口截图 |
| Web 与嵌入桌面构建 | `go run ./scripts web` | 通过；Web Brotli 9.2 MB / 12 MB；`windows_x64` 构建通过 |
| 仅本轮增量快照 | 下述四包定向测试与同一 Windows 原生命令 | 34 项定向测试与 4 项原生测试均通过 |

只含本轮提交增量的快照另行运行：

```text
go test ./internal/viewkit ./internal/workbench ./internal/apptext ./internal/architecture -run '^Test(ChatDesign|MarkdownReadingScale|ProcessSizesDerived|TextSizesNormalized|ChatWidthPct|ChatFontSetting|SettingsSchema|TranslationCallsCovered|VisibleStringsTranslated|ToastTitlesTranslated|ToastDetailsTranslated|DesktopBuildConstraints|DependencyLayers|SourceFileSize)' -count=1 -timeout=3m
```

快照与原生图片保留在本机 `%TEMP%/pideck-design-verify-f5yz4e7p/`，用于确认本轮提交
不依赖工作区其他未提交代码。桌面截图代表 Windows 原生窗口，窄窗口不等于真实手机验收。

真实 pi 会话端到端路径未验收：本机 Go 查找到的 pi shim 由不兼容的 Node 20 启动，
在 `enableCompileCache` 导入处失败。短测试重跑时仅对该命令进程过滤失效的 pi 路径，
使既有 `requirePi` 按原规则跳过外部依赖；没有修改系统 PATH、测试断言或跳过规则。

## 保留边界

- 不修改配置文件格式、版本号或用户显式选择的值；输入框 `0 = 跟随聊天` 保持原语义。
- SDK 仍拥有过程折叠、运行态与会话状态；固定 13.5 的摘要条保留，未复制其状态机。
- 侧栏导航结构、设置页布局、文件/Git/终端的完整视觉对齐不是本轮完成项。
- 工作区原有未提交改动独立保留，本轮提交只包含此次视觉校准的增量。

## 2026-11-22：输入框上方的信任提示

将黄底、顶部分隔线与实底按钮组成的横幅，收敛为阅读纸面上的轻提示：只有盾牌保留
警示色，正文为 12 pt / 18 pt 行高，操作使用原生 ghost 按钮，与输入框留出 8 pt 间距。
背景保持不透明，避免滚动内容或壁纸透过文字；长翻译可换行，操作保持可见。
原文、信任范围、持久化格式和发送前的确认门禁均不变。

回归同时复现了旧实现的交互缺陷：点击「信任」已更新配置，提示却没有立即收起。
现在由现有项目修订信号通知信任状态的观察者，不额外维护一份内存信任状态；直接信任
后提示消失，撤销后重新出现，两个操作都保留当前草稿。

`TestTrustNotice` 在同一窗口内验证浅色、深色、760 pt 窄窗口、法语长文案、鼠标、
键盘 Return、信任及撤销。会话截图 fixture 显式声明桌面环境，使无头测试也具备真实的
按钮键盘焦点规则。验证命令：

```text
go test ./internal/workbench -run '^Test(Trust|ChatDesign)' -count=1 -timeout=90s
go tool nsgo check
go tool nsgo test -target windows -run '^TestTrustNotice$' -timeout 2m ./internal/workbench
```

以上均通过；原生截图位于 `internal/workbench/.nsgo/test/screenshots/windows/trust-notice/`
下的 `light.png`、`dark.png`、`narrow.png`、`narrow-french.png`，已检查浅深色及长文案的
排版。仅本轮增量另在 `%TEMP%/pideck-trust-verify-zgbw3gdm/` 验证：信任、会话设计及
架构守护共 19 项定向测试通过；`^Test(TrustNotice|ChatDesign)` 的 5 项 Windows 原生
测试通过，0 失败、0 跳过；`go tool nsgo build -target windows_x64` 构建通过。
这些结果不依赖其余未提交改动。

验证边界：最初按每个状态新建窗口的原生组合测试，在 NSGo Windows 的 Direct2D
`EndDraw` / `backdrop` 路径发生访问异常，独立增量快照也能复现；鼠标和键盘分别运行
均通过。最终回归在同一窗口保留完整草稿与状态转换流程，未跳过用例、放宽断言或添加
重试。多窗口生命周期问题仍待单独定位，本轮没有修改 SDK 或升级依赖。

## 2026-11-22 新会话起始页

参考 PiDeck Electron 的起始页，将字号 22 pt 的项目标题、四个建议按钮和会话输入框集中到
同一视线范围。建议按钮位于标题与输入框之间：输入框底部已经承载目录、pi 与用量信息，
按钮再放在下面会挤在页脚之下。窄窗口里建议按钮自然换行，高度不足时可滚动。删除了重复的
模型说明和写死的 Mac 快捷键。法语、日语、韩语和俄语按钮采用更短的译文。

项目建议填入当前会话的空草稿并聚焦输入框。开始输入后，建议隐藏并保留占位，避免
输入框跳动。首条消息出现后，已挂载的输入框移到会话底部，两种布局共用阅读列的宽度
设置。读取历史时仍显示加载占位。

`TestChatStartKeepsComposerAcrossFirstTurn` 校验建议行整体位于输入框卡片之上，再在
同一窗口验证键盘和鼠标选择、填入后不发送、首条消息出现后保留草稿和焦点，以及
760 pt 法语窄窗的布局。Windows 浅色、深色和法语窄窗截图保存在
`internal/workbench/.nsgo/test/screenshots/windows/chat-start/`。会话切换用测试数据驱动，
本机 Pi CLI 因 Node 版本不匹配无法启动。

`go tool nsgo check` 和 `go tool nsgo build -target windows_x64` 均通过。独立工作树
上的 Windows 原生回归通过两项，覆盖新会话和信任提示。完整短测 657 项通过、108 项
跳过，`TestGitAbortMerge` 一次超时，定向复测通过。短测仅在测试进程的 PATH 中排除
了无法启动的 Pi 安装。日志位于 `%TEMP%/pideck-chat-start-short-isolated.log`。

## 2026-11-26 会话刻度的尺寸与点击区域

右缘刻度从默认 6 × 2.5 pt、悬停 18 × 2.5 pt，调整为默认 12 × 4 pt、
悬停 28 × 4 pt。整块 32 pt 宽的悬停槽位接收点击，线条只负责显示；
140 ms 的伸缩动画不再改变可点击范围。长会话按至少 8 pt 的槽位高度取样，
保留首尾轮次，并使各槽位连续、不重叠。

`TestAxisTickHitArea` 直接挂载实际定位轴，覆盖普通与密集会话、无悬停与动画初始帧、
槽位两角和中心的单击跳转，以及原有刻度选择器。`TestAxisTicksGrowOnHover` 验证
默认尺寸、悬停伸长及离开后回缩；`TestPlanAxisTicks` 验证取样、最小间距及首尾保留。
整页会话加载的集成测试与这些组件回归分开验证。

本轮组件回归与 Windows 原生尺寸、悬停和槽位单击回归通过：

```text
go test ./internal/workbench -run '^(TestPlanAxisTicks|TestAxisTickHitArea|TestAxisTicksGrowOnHover)$' -count=1 -timeout=30s
go tool nsgo test -target windows -run '^TestAxisTicksGrowOnHover$' -timeout 45s ./internal/workbench
go tool nsgo test -target windows -run '^TestAxisTickHitArea$' -timeout 45s ./internal/workbench
```

原生截图位于 `internal/workbench/.nsgo/test/screenshots/windows/57-axis-ticks-rest.png` 和
`58-axis-ticks-hover.png`，已检查默认刻度、悬停伸长和提示框的位置。
整页 `TestTurnAxis` 在等待会话输入框加载时超时（20 s），不计入通过项。

## 会话列表的日期分组

同一项目按最近活动排序时，会话时间先统一到界面当前时间的时区，再判断“今天”“昨天”。
历史文件的 UTC 时间与本地活动时间混排时，同一天的会话不会再因时区不同反复切换日期标题；
原有的会话顺序和父子嵌套规则保留。“昨天”按日历前一天判断，兼容夏令时的 23／25 小时日。

`TestSessionBucketsUseDisplayTimezone` 覆盖 UTC、UTC+8、UTC−8 下的混合时间戳、唯一日期标题和
组内顺序；`TestSessionBucketsUseCalendarYesterday` 覆盖夏令时开始与结束的日期边界。
