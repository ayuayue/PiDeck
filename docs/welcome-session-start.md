# 欢迎页与新会话页

桌面端直接使用原生 NSGo 界面，不加载设计目录里的 HTML 原型。页面入口位于 `internal/workbench/ui_chat_empty.go`，共用输入组件位于 `internal/workbench/ui_composer_card.go`。

## 欢迎页

未选择会话时显示品牌、开始提示和主要操作。有项目时展示已添加的真实项目名称和路径；点击项目行直接通过 `newProjectSession` 创建并选中该项目的新会话。顶部“新建会话”优先使用当前项目，其次使用列表中的第一个项目。内置的直接对话目录不计入项目列表；没有项目时，主要操作打开已有的文件夹选择流程。

“直接对话”“导入会话”“添加工作区”继续调用已有应用功能。列表按应用已有的项目顺序显示，不声称是最近使用顺序。内容较多或窗口较小时可以滚动，操作区自动换行。

## 新会话页

项目标题、四个快捷任务和输入框对齐到用户设置的会话列宽。快捷任务只填入草稿并聚焦输入框，不自动发送；输入过程中保留快捷任务区的占位，避免输入框跳动。

首条消息之前提供更高的输入区，并让模型设置独占一行。产生首条消息后恢复原有停靠布局。沿用同一个原生编辑器和 Holder，保留草稿、焦点、输入法、附件、发送及停止逻辑。

颜色和字体继续来自当前主题及用户设置，不修改全局主题、语言配置或会话持久化格式。

## 定向回归

在仓库根目录运行：

```powershell
go test ./internal/workbench -run '^(TestWelcome|TestWorkspacePicker|TestWelcomeProjectStartsRealSession|TestWelcomeDoesNotCountChatAsProject|TestChatStartKeepsComposerAcrossFirstTurn|TestChatColumnFillsTheChatAreaAtFullWidth|TestChatDesignCustomFontWins)$' -count=1
```

测试覆盖实际项目入口、直接对话目录排除、键盘操作、初始输入布局、首条消息后的编辑器与草稿保留、暗色法语窄窗口和用户字体。无需启动真实模型服务。
