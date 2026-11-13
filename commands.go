package main

// One place for every command. The palette, the menus and the keyboard
// read the same list, so a plugin adds a command without the UI knowing
// where it came from.

import (
	"fmt"
	"strings"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
	"github.com/oneo-me/nsgo/updater"
)

// appCommand is one thing the app can do, as the palette lists it.
type appCommand struct {
	ID          string
	Label       string
	Description string
	Group       string
	Shortcut    string
	Icon        func() *core.SVG
	// When hides the command when it does not apply; nil always shows.
	When func(*app) bool
	// Hidden keeps a command out of the palette while a key still runs
	// it: closing a tab, cycling tabs, opening the palette itself.
	Hidden bool
	Run    func(*app)
}

// builtinCommands is the app's own list. Groups read as the palette's
// sections.
func builtinCommands() []appCommand {
	return []appCommand{
		{ID: "palette", Label: "打开命令面板", Group: "应用", Shortcut: "mod+k", Icon: lucide.Command, Hidden: true,
			Run: func(a *app) { a.palette.Set(true) }},
		{ID: "new-session", Label: "新建会话", Group: "会话", Shortcut: "mod+n", Icon: lucide.SquarePen,
			Run: func(a *app) { a.newSession(a.activeWS.Get()) }},
		{ID: "close-tab", Label: "关闭当前标签", Group: "会话", Shortcut: "mod+w", Icon: lucide.X, Hidden: true,
			When: func(a *app) bool { return a.editorOpen() || a.activeID.GetUntracked() != "" },
			Run: func(a *app) {
				if a.editorOpen() {
					a.closeEditorPane()
					return
				}
				a.closeTab(a.activeID.GetUntracked())
			}},
		{ID: "save-file", Label: "保存文件", Group: "文件", Shortcut: "mod+s", Icon: lucide.Save,
			When: func(a *app) bool {
				return a.editorOpen() && a.editor.activeFile() != nil && a.editor.activeFile().Dirty.GetUntracked()
			},
			Run: func(a *app) { a.saveActiveFile() }},
		{ID: "reload-file", Label: "重新读取文件", Group: "文件", Icon: lucide.RotateCcw, Hidden: true,
			When: func(a *app) bool { return a.editorOpen() && a.editor.activeFile() != nil },
			Run:  func(a *app) { a.reloadActiveFile() }},
		{ID: "close-file", Label: "关闭文件", Group: "文件", Icon: lucide.X, Hidden: true,
			When: func(a *app) bool { return a.editorOpen() && a.editor.activeFile() != nil },
			Run:  func(a *app) { a.closeEditorFile(a.editor.activeFile()) }},
		{ID: "next-tab", Label: "下一个标签", Group: "会话", Shortcut: "ctrl+tab", Icon: lucide.ChevronRight, Hidden: true,
			Run: func(a *app) { a.cycleTab(1) }},
		{ID: "prev-tab", Label: "上一个标签", Group: "会话", Shortcut: "ctrl+shift+tab", Icon: lucide.ChevronLeft, Hidden: true,
			Run: func(a *app) { a.cycleTab(-1) }},
		{ID: "rename", Label: "重命名会话", Group: "会话", Icon: lucide.Pencil,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.askRename(a.active()) }},
		{ID: "export", Label: "导出会话为 HTML", Group: "会话", Icon: lucide.FileDown,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.exportHTML(a.active()) }},
		{ID: "compact", Label: "压缩上下文", Group: "会话", Icon: lucide.Minimize2,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.compact(a.active()) }},
		{ID: "stop", Label: "停止当前运行", Group: "会话", Icon: lucide.Square,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.stop(a.active()) }},
		{ID: "restart-agent", Label: "重启 Agent", Group: "会话", Icon: lucide.RefreshCw,
			When: func(a *app) bool { return a.active() != nil },
			Run: func(a *app) {
				s := a.active()
				if s.busyNow() {
					a.askConfirm("重启 Agent", "这一轮还在运行，重启会中断它。", "重启", func() { a.restartAgent(s) })
					return
				}
				a.restartAgent(s)
			}},
		{ID: "close-agent", Label: "关闭 Agent", Group: "会话", Icon: lucide.Power,
			When: func(a *app) bool { return a.active() != nil },
			Run: func(a *app) {
				s := a.active()
				if s.busyNow() {
					a.askConfirm("关闭 Agent", "这一轮还在运行，关闭会中断它；记录和标签会保留。", "关闭", func() { a.closeAgent(s) })
					return
				}
				a.closeAgent(s)
			}},
		{ID: "copy-last", Label: "复制最后回复", Group: "会话", Icon: lucide.Copy,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.copyLastReply() }},
		{ID: "copy-prompt", Label: "复制上一条提问", Group: "会话", Icon: lucide.Quote,
			When: func(a *app) bool { return a.active() != nil },
			Run: func(a *app) {
				if text, ok := a.lastPrompt(); ok {
					a.copyText(text, "提问")
				}
			}},
		{ID: "edit-prompt", Label: "把上一条提问放回输入框", Group: "会话", Icon: lucide.PencilLine,
			When: func(a *app) bool { return a.active() != nil },
			Run: func(a *app) {
				if text, ok := a.lastPrompt(); ok {
					a.active().draft.Set(text)
					a.toast(ui.ToastInfo, "提问已放回输入框", "可以改完再发。")
				}
			}},
		{ID: "copy-id", Label: "复制会话 ID", Group: "会话", Icon: lucide.IdCard,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.copySessionID() }},
		{ID: "reveal-session", Label: "在文件管理器中显示会话", Group: "会话", Icon: lucide.FolderOpen,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.revealSession(a.active()) }},
		{ID: "plan-mode", Label: "计划模式", Group: "会话", Icon: lucide.ClipboardList,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.togglePlanMode(a.active()) }},
		{ID: "search-sessions", Label: "搜索会话内容…", Group: "会话", Shortcut: "mod+shift+f", Icon: lucide.Search,
			Run: func(a *app) { a.openSearch() }},
		{ID: "ask", Label: "并行问询…", Group: "会话", Shortcut: "mod+shift+a", Icon: lucide.MessagesSquare,
			Run: func(a *app) { a.openAsk() }},
		{ID: "fork-last", Label: "分叉上一条提问", Group: "会话", Icon: lucide.GitBranch,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.forkLastTurn() }},
		{ID: "duplicate-session", Label: "复制会话", Group: "会话", Icon: lucide.CopyPlus,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.duplicateSession(a.active()) }},
		{ID: "delete", Label: "删除会话", Group: "会话", Icon: lucide.Trash,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.deleteSession(a.active()) }},

		{ID: "add-workspace", Label: "添加工作区（系统选择器）", Group: "工作区", Icon: lucide.FolderPlus,
			Run: func(a *app) { a.pickNative("workspace") }},
		{ID: "browse-workspace", Label: "浏览文件夹添加工作区…", Group: "工作区", Icon: lucide.FolderOpen,
			Run: func(a *app) { a.openPicker("workspace") }},
		{ID: "add-wsl", Label: "在 WSL 里添加工作区…", Group: "工作区", Icon: lucide.Monitor,
			Run: func(a *app) { a.openTargetDialog(targetWSL) }},
		{ID: "add-ssh", Label: "在 SSH 主机上添加工作区…", Group: "工作区", Icon: lucide.Globe,
			Run: func(a *app) { a.openTargetDialog(targetSSH) }},
		{ID: "import", Label: "导入会话（pi / Codex / Claude）…", Group: "工作区", Icon: lucide.FileInput,
			Run: func(a *app) { a.pickNative("import") }},
		{ID: "browse-import", Label: "浏览文件导入会话…", Group: "工作区", Icon: lucide.FolderOpen,
			Run: func(a *app) { a.openPicker("import") }},
		{ID: "open-editor", Label: "在编辑器中打开工作区", Group: "工作区", Icon: lucide.Code,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.openPathInEditor(a.active().WS) }},
		{ID: "open-folder", Label: "在文件管理器中打开工作区", Group: "工作区", Icon: lucide.FolderOpen,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.openWorkspaceFolder(a.active().WS) }},

		{ID: "terminal", Label: "显示 / 隐藏终端", Group: "工具", Shortcut: "ctrl+shift+t", Icon: lucide.SquareTerminal,
			Run: func(a *app) { a.toggleTerminal() }},
		{ID: "terminal-new", Label: "新建终端", Group: "工具", Icon: lucide.Plus,
			Run: func(a *app) { a.newTerminalTab() }},
		{ID: "git", Label: "显示 Git 面板", Group: "工具", Shortcut: "mod+shift+g", Icon: lucide.GitBranch,
			Run: func(a *app) { a.openGit() }},
		{ID: "git-refresh", Label: "刷新 Git 状态", Group: "工具", Icon: lucide.RefreshCw,
			Run: func(a *app) { a.git.refreshAll() }},
		{ID: "git-branch", Label: "新建 Git 分支…", Group: "工具", Icon: lucide.GitBranchPlus,
			When: func(a *app) bool { return a.git.state.GetUntracked().IsRepo },
			Run: func(a *app) {
				a.gitNewBranchName.Set("")
				a.gitNewBranchOpen.Set(true)
			}},

		{ID: "prompts", Label: "提示词库", Group: "应用", Shortcut: "mod+shift+p", Icon: lucide.Library,
			Run: func(a *app) { a.openPromptLibrary() }},
		{ID: "save-prompt", Label: "保存当前草稿为提示词", Group: "会话", Icon: lucide.BookmarkPlus,
			When: func(a *app) bool { return a.active() != nil },
			Run:  func(a *app) { a.saveDraftPrompt() }},
		{ID: "appearance", Label: "切换外观（浅色 / 深色 / 跟随系统）", Group: "应用", Icon: lucide.Sun,
			Run: func(a *app) { a.cycleTheme() }},
		{ID: "sidebar", Label: "显示 / 隐藏侧栏", Group: "应用", Shortcut: "mod+b", Icon: lucide.PanelLeft,
			Run: func(a *app) {
				a.sidebar.Update(func(v bool) bool { return !v })
				a.remember()
			}},
		{ID: "drawer", Label: "显示 / 隐藏会话面板", Group: "应用", Shortcut: "mod+j", Icon: lucide.PanelRight,
			Run: func(a *app) {
				a.drawer.Update(func(v bool) bool { return !v })
				a.remember()
			}},
		{ID: "data-dir", Label: "打开数据目录", Group: "应用", Icon: lucide.HardDrive,
			Run: func(a *app) {
				if a.st != nil {
					a.cx.OpenURL(fileURL(a.st.dir), nil)
				}
			}},
		{ID: "themes-dir", Label: "打开主题目录", Group: "应用", Icon: lucide.Palette,
			Run: func(a *app) { a.openThemesDir() }},
		{ID: "plugins-dir", Label: "打开插件目录", Group: "应用", Icon: lucide.Puzzle,
			Run: func(a *app) { a.openPluginsDir() }},
		{ID: "reload-addons", Label: "重新加载插件与主题", Group: "应用", Icon: lucide.RefreshCw,
			Run: func(a *app) { a.reloadAddons() }},
		{ID: "shortcuts", Label: "键盘快捷键", Group: "应用", Shortcut: "mod+/", Icon: lucide.Keyboard,
			Run: func(a *app) { a.shortcutsQuery.Set(""); a.shortcutsOpen.Set(true) }},
		{ID: "check-updates", Label: "检查更新", Group: "应用", Icon: lucide.CloudDownload,
			Run: func(a *app) { updater.Check(a.cx) }},
		{ID: "settings", Label: "设置", Group: "应用", Shortcut: "mod+,", Icon: lucide.Settings,
			Run: func(a *app) { a.settings.Set(true) }},
	}
}

// commandList is the app's commands followed by the enabled plugins'.
func (a *app) commandList() []appCommand {
	out := builtinCommands()
	if a.plugins == nil {
		return out
	}
	for _, p := range a.plugins.GetUntracked() {
		if p.Disabled || p.Error != "" {
			continue
		}
		for _, c := range p.Commands {
			cmd := c
			out = append(out, appCommand{
				ID:          pluginCommandID(p.ID, cmd.ID),
				Label:       cmd.Title,
				Description: cmd.Description,
				Group:       firstNonEmpty(cmd.Group, p.Name, "插件"),
				Icon:        pluginIcon(cmd.Icon),
				Run:         func(a *app) { a.runPluginCommand(p.ID, cmd.ID) },
			})
		}
	}
	return out
}

// commandItems turns the commands into the palette's rows.
func (a *app) commandItems() []base.CommandItem {
	var out []base.CommandItem
	for _, c := range a.commandList() {
		if c.Hidden {
			continue
		}
		if c.When != nil && !c.When(a) {
			continue
		}
		icon := c.Icon
		if icon == nil {
			icon = lucide.Command
		}
		out = append(out, base.CommandItem{ID: c.ID, Label: T(c.Label), Description: T(c.Description),
			Group: T(c.Group), Shortcut: c.Shortcut, Icon: icon()})
	}
	if a.themes != nil {
		for _, th := range a.themes.GetUntracked() {
			out = append(out, base.CommandItem{ID: "theme:" + th.ID, Label: T("配色") + " · " + th.Name, Group: T("外观"),
				Icon: lucide.Palette()})
		}
	}
	return out
}

// runCommand runs a palette item by id.
func (a *app) runCommand(id string) {
	a.palette.Set(false)
	if rest, ok := strings.CutPrefix(id, "theme:"); ok {
		a.setTheme(rest)
		return
	}
	if rest, ok := strings.CutPrefix(id, "plugin:"); ok {
		name, cmdID, _ := strings.Cut(rest, ":")
		a.runPluginCommand(name, cmdID)
		return
	}
	for _, c := range builtinCommands() {
		if c.ID == id {
			c.Run(a)
			return
		}
	}
}

// runPluginCommand runs one command a plugin contributes.
func (a *app) runPluginCommand(pluginID, commandID string) {
	for _, p := range a.plugins.GetUntracked() {
		if p.ID != pluginID {
			continue
		}
		for _, c := range p.Commands {
			if c.ID != commandID {
				continue
			}
			a.runPluginAction(p, c)
			return
		}
	}
}

// runPluginAction carries out a plugin command's action.
func (a *app) runPluginAction(p plugin, c pluginCommand) {
	act := c.Action
	switch act.Type {
	case "prompt", "insert", "":
		if strings.TrimSpace(act.Prompt) == "" {
			a.toast(ui.ToastError, "插件命令没有内容", c.Title)
			return
		}
		s := a.active()
		if s == nil {
			a.toast(ui.ToastInfo, "先开一个会话", "插件命令会把内容放进输入框。")
			return
		}
		s.draft.Set(act.Prompt)
	case "send":
		s := a.active()
		if s == nil {
			a.toast(ui.ToastInfo, "先开一个会话", "插件命令要发送到会话。")
			return
		}
		s.draft.Set(act.Prompt)
		a.send()
	case "command":
		if act.Command == "" {
			a.toast(ui.ToastError, "插件命令没有目标", c.Title)
			return
		}
		a.runCommand(act.Command)
	case "url":
		if !strings.HasPrefix(act.URL, "https://") && !strings.HasPrefix(act.URL, "http://") {
			a.toast(ui.ToastError, "插件链接不安全", act.URL)
			return
		}
		a.cx.OpenURL(act.URL, nil)
	case "theme":
		spec := a.themeSpecByName(act.Theme)
		if spec == nil {
			a.toast(ui.ToastError, "找不到主题", act.Theme)
			return
		}
		a.setTheme(spec.ID)
	default:
		a.toast(ui.ToastError, "未知的插件命令", act.Type)
	}
}

// pluginCommandID is a plugin command's palette id.
func pluginCommandID(pluginID, commandID string) string {
	return "plugin:" + pluginID + ":" + commandID
}

// pluginIcon maps a plugin's icon name to one of the app's icons.
func pluginIcon(name string) func() *core.SVG {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "terminal", "shell":
		return lucide.SquareTerminal
	case "git", "branch":
		return lucide.GitBranch
	case "file", "folder":
		return lucide.FolderOpen
	case "search":
		return lucide.Search
	case "play", "run":
		return lucide.Play
	case "check", "done":
		return lucide.Check
	case "list", "todo":
		return lucide.ListTodo
	case "message", "chat":
		return lucide.MessageSquare
	case "bug":
		return lucide.Bug
	case "code":
		return lucide.Code
	case "sparkles", "ai":
		return lucide.Sparkles
	case "palette", "theme":
		return lucide.Palette
	case "globe", "web":
		return lucide.Globe
	case "settings":
		return lucide.Settings
	case "zap":
		return lucide.Zap
	case "star":
		return lucide.Star
	}
	return lucide.Puzzle
}

// copyLastReply copies the newest final answer to the clipboard.
func (a *app) copyLastReply() {
	s := a.active()
	if s == nil {
		return
	}
	ts := s.turns.Get()
	for i := len(ts) - 1; i >= 0; i-- {
		if ts[i].Final != "" {
			a.copyText(ts[i].Final, "回复")
			return
		}
	}
	a.toast(ui.ToastInfo, "没有可复制的回复", "")
}

// lastPrompt is the newest user prompt in the active session.
func (a *app) lastPrompt() (string, bool) {
	s := a.active()
	if s == nil {
		return "", false
	}
	ts := s.turns.Get()
	for i := len(ts) - 1; i >= 0; i-- {
		if ts[i].Prompt != "" {
			return ts[i].Prompt, true
		}
	}
	return "", false
}

// copySessionID copies the active session's id.
func (a *app) copySessionID() {
	s := a.active()
	if s == nil {
		return
	}
	a.copyText(s.ID, "会话 ID")
}

// openThemesDir opens the folder themes are read from.
func (a *app) openThemesDir() {
	a.ensureAddonDirs()
	if dir := a.themesDir(); dir != "" {
		a.cx.OpenURL(fileURL(dir), nil)
	}
}

// openPluginsDir opens the folder plugins are read from.
func (a *app) openPluginsDir() {
	a.ensureAddonDirs()
	if dir := a.pluginsDir(); dir != "" {
		a.cx.OpenURL(fileURL(dir), nil)
	}
}

// firstNonEmpty returns the first value that is not blank.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// commandShortcut is the key a command shows, for menus.
func (a *app) commandShortcut(id string) string {
	for _, c := range a.commandList() {
		if c.ID == id {
			return c.Shortcut
		}
	}
	return ""
}

// describeCommand is a command's label and group, for error messages.
func describeCommand(id string) string {
	for _, c := range builtinCommands() {
		if c.ID == id {
			return fmt.Sprintf("%s（%s）", c.Label, c.Group)
		}
	}
	return id
}
