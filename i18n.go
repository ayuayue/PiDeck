package main

// The interface's language. Messages are written in Chinese and looked up
// by that text, so a missing translation falls back to the source rather
// than to a key name; new screens can be added first and translated
// later. Plugins bring their own words and stay as they are.

import (
	"fmt"
	"strings"
	"sync"
)

// Languages the app ships with.
const (
	langSystem = ""
	langZhCN   = "zh-CN"
	langZhTW   = "zh-TW"
	langEnUS   = "en-US"
)

var (
	uiLangMu sync.RWMutex
	uiLang   = langZhCN
)

// setUILanguage makes code the language T reads.
func setUILanguage(code string) {
	uiLangMu.Lock()
	uiLang = code
	uiLangMu.Unlock()
}

// currentUILanguage is the language T reads now.
func currentUILanguage() string {
	uiLangMu.RLock()
	defer uiLangMu.RUnlock()
	return uiLang
}

// T says a message in the interface's language. The message is the
// source text; a translation replaces it, then args are formatted.
func T(message string, args ...any) string {
	uiLangMu.RLock()
	lang := uiLang
	uiLangMu.RUnlock()
	if table, ok := messages[lang]; ok {
		if s, ok := table[message]; ok {
			message = s
		}
	}
	if len(args) == 0 {
		return message
	}
	return fmt.Sprintf(message, args...)
}

// resolveLanguage picks the language to show: the user's choice, else the
// system's, else Chinese.
func resolveLanguage(setting, system string) string {
	switch setting {
	case langZhCN, langZhTW, langEnUS:
		return setting
	}
	s := strings.ToLower(system)
	switch {
	case strings.HasPrefix(s, "zh"):
		if strings.Contains(s, "tw") || strings.Contains(s, "hk") || strings.Contains(s, "mo") ||
			strings.Contains(s, "hant") || strings.Contains(s, "traditional") {
			return langZhTW
		}
		return langZhCN
	case strings.HasPrefix(s, "en"):
		return langEnUS
	}
	return langZhCN
}

// applyLanguage sets the interface language from the config and the
// system, and asks the pages that hold static text to rebuild.
func (a *app) applyLanguage() {
	setUILanguage(resolveLanguage(a.cfg.Language, a.cx.Env().Language()))
	if a.langRev != nil {
		a.langRev.Update(func(n int) int { return n + 1 })
	}
}

// setLanguage remembers the user's choice and applies it.
func (a *app) setLanguage(code string) {
	a.cfg.Language = code
	if a.st != nil {
		a.st.edit(func(c *config) { c.Language = code })
	}
	a.applyLanguage()
}

// languageName is a language's name in itself.
func languageName(code string) string {
	switch code {
	case langZhTW:
		return "繁體中文"
	case langEnUS:
		return "English"
	}
	return "简体中文"
}

// messages are the translations, by source text. zh-CN is the source and
// needs no table.
var messages = map[string]map[string]string{
	langEnUS: {
		// Settings sections.
		"通用":    "General",
		"模型与认证": "Models & auth",
		"用量":    "Usage",
		"键位":    "Keybindings",
		"外观":    "Appearance",
		"远程":    "Remote",
		"远程访问":  "Remote access",
		"环境":    "Environment",
		"扩展":    "Extensions",
		"数据":    "Data",
		"关于":    "About",
		"新会话的默认值，以及侧栏读什么。":            "What a new session starts with, and what the rail reads.",
		"pi 认识哪些供应商、各自有多少模型、凭据是否可用。":  "Which providers pi knows, their models, and whether credentials resolve.",
		"从本地会话文件统计 token、费用、模型与项目分布。": "Tokens, cost, models and projects, counted from local session files.",
		"每个命令的快捷键；留空则不绑定，改坏了可以恢复默认。":  "Each command's shortcut; leave it empty to unbind, or restore the defaults.",
		"配色与主题文件。":                  "Palettes and theme files.",
		"让手机连接这台电脑上的项目和会话。":         "Let a phone reach this computer's projects and sessions.",
		"pi 在哪里、能不能用；WSL 与 SSH 目标。": "Where pi is and whether it runs; WSL and SSH targets.",
		"插件给命令面板加提示词，给外观加主题。":       "Plugins add commands to the palette and themes to the look.",
		"会话与配置在磁盘上的位置。":             "Where sessions and config live on disk.",
		"版本、许可与来源。":                 "Version, licence and source.",

		"插件": "Plugins",
		"插件给命令面板加命令，给外观加主题。": "Plugins add commands to the palette and themes to the look.",
		"资源": "Resources",
		"pi 的技能与扩展：看它们做什么，打开或停用。": "pi's skills and extensions: what they do, and how to open or turn one off.",
		"技能":     "Skills",
		"打开技能目录": "Open skills folder",
		"打开扩展目录": "Open extensions folder",
		"重新读取":   "Reload",
		"自动加载":   "Loaded automatically",
		"内置":     "Built-in",
		"本地文件":   "Local file",
		"没有读到技能；技能放在 pi 配置目录的 skills 下。": "No skills found; they live under skills in pi's config folder.",
		"没有读到扩展。":    "No extensions found.",
		"正在读取技能与扩展…": "Reading skills and extensions…",

		// General settings.
		"界面": "Interface",
		"语言": "Language",
		"界面文案；切换后立即生效，未翻译的条目保留中文。": "Interface text; it changes at once, and untranslated items stay in Chinese.",
		"跟随系统":      "System",
		"简体中文":      "简体中文",
		"繁體中文":      "繁體中文",
		"新会话默认模型":   "Default model for new sessions",
		"新会话默认思考等级": "Default thinking level for new sessions",
		"会话列表":      "Session list",
		"排序":        "Sort",
		"最近活动":      "Recent activity",
		"名称":        "Name",
		"项目里的会话按最近活动或名称排列；置顶的总在最前。": "Sessions sort by recent activity or name; pinned ones stay first.",
		"扫描所有项目": "Scan every project",
		"默认只读打开过的项目；打开后每个项目都会读一遍 pi 的会话，会话多时更慢。": "Only opened projects are read by default; turning this on reads pi's sessions for every project, which is slower with many sessions.",
		"侧栏":         "Rail",
		"列出 pi 本地会话": "List pi's local sessions",
		"在项目下显示终端里 pi 用过的会话，点开即继续。": "Show the sessions pi used in a terminal under their project; open one to continue it.",
		"连没有添加为项目的文件夹也读，会话多时会更慢。":   "Also read folders that are not projects; slower with many sessions.",
		"桌面":        "Desktop",
		"关闭窗口时留在托盘": "Keep running in the tray when the window closes",
		"关掉窗口不退出应用，Agent 继续跑；从托盘图标恢复窗口。": "Closing the window does not quit; agents keep running, and the tray icon brings the window back.",
		"一轮完成时通知": "Notify when a turn finishes",
		"用系统通知告诉你回答好了；运行中的会话也会显示在托盘菜单里。": "A system notification says the answer is ready; running sessions also show in the tray menu.",
		"只在窗口隐藏时通知":      "Only notify while the window is hidden",
		"窗口在前台时不再弹系统通知。": "No system notification while the window is in front.",
		"测试通知": "Test notification",
		"发一条系统通知，确认这台机器收得到。": "Post one system notification to check this machine shows it.",
		"发一条":        "Send one",
		"跟随 pi 当前模型": "Follow pi's current model",
		"跟随会话":       "Follow the session",
		"重新检测":       "Check again",
		"重新统计":       "Count again",

		// Common controls.
		"取消":  "Cancel",
		"保存":  "Save",
		"删除":  "Delete",
		"关闭":  "Close",
		"打开":  "Open",
		"复制":  "Copy",
		"重试":  "Retry",
		"停止":  "Stop",
		"发送":  "Send",
		"重命名": "Rename",
		"导入":  "Import",
		"导出":  "Export",
		"添加":  "Add",

		"配色": "Theme",

		// Command groups.
		"会话":  "Session",
		"工作区": "Workspace",
		"工具":  "Tools",
		"应用":  "App",
		"文件":  "File",

		// Commands.
		"打开命令面板":               "Open command palette",
		"提示词库":                 "Prompt library",
		"保存当前草稿为提示词":           "Save the draft as a prompt",
		"新建会话":                 "New session",
		"关闭当前标签":               "Close current tab",
		"下一个标签":                "Next tab",
		"上一个标签":                "Previous tab",
		"保存文件":                 "Save file",
		"重新读取文件":               "Reload file",
		"关闭文件":                 "Close file",
		"重命名会话":                "Rename session",
		"导出会话为 HTML":           "Export session as HTML",
		"压缩上下文":                "Compact context",
		"停止当前运行":               "Stop the running turn",
		"重启 Agent":             "Restart agent",
		"关闭 Agent":             "Close agent",
		"复制最后回复":               "Copy last reply",
		"复制上一条提问":              "Copy previous prompt",
		"把上一条提问放回输入框":          "Put previous prompt back in the composer",
		"复制会话 ID":              "Copy session ID",
		"在文件管理器中显示会话":          "Reveal session in file manager",
		"复制会话":                 "Duplicate session",
		"删除会话":                 "Delete session",
		"添加工作区（系统选择器）":         "Add workspace (system picker)",
		"浏览文件夹添加工作区…":          "Browse for a folder to add…",
		"在 WSL 里添加工作区…":        "Add a workspace in WSL…",
		"在 SSH 主机上添加工作区…":      "Add a workspace over SSH…",
		"导入 pi 会话（系统选择器）…":     "Import pi sessions (system picker)…",
		"浏览文件导入会话…":            "Browse for a session file to import…",
		"在文件管理器中打开工作区":         "Open workspace in file manager",
		"显示 / 隐藏终端":            "Show / hide terminal",
		"新建终端":                 "New terminal",
		"显示 Git 面板":            "Show Git panel",
		"刷新 Git 状态":            "Refresh Git status",
		"新建 Git 分支…":           "New Git branch…",
		"切换外观（浅色 / 深色 / 跟随系统）": "Cycle appearance (light / dark / system)",
		"显示 / 隐藏侧栏":            "Show / hide sidebar",
		"显示 / 隐藏会话面板":          "Show / hide session panel",
		"打开数据目录":               "Open data folder",
		"打开主题目录":               "Open themes folder",
		"打开插件目录":               "Open plugins folder",
		"重新加载插件与主题":            "Reload plugins and themes",
		"设置":                   "Settings",

		// Tray.
		"显示 PiDeck Lite": "Show PiDeck Lite",
		"运行中 · %s":       "Running · %s",
		"设置…":            "Settings…",
		"退出":             "Quit",
	},
	langZhTW: {
		// Settings sections.
		"通用":    "一般",
		"模型与认证": "模型與認證",
		"用量":    "用量",
		"键位":    "快速鍵",
		"外观":    "外觀",
		"远程":    "遠端",
		"远程访问":  "遠端存取",
		"环境":    "環境",
		"扩展":    "擴充",
		"数据":    "資料",
		"关于":    "關於",
		"新会话的默认值，以及侧栏读什么。":            "新工作階段的預設值，以及側欄讀什麼。",
		"pi 认识哪些供应商、各自有多少模型、凭据是否可用。":  "pi 認識哪些供應商、各自有多少模型、憑證是否可用。",
		"从本地会话文件统计 token、费用、模型与项目分布。": "從本機工作階段檔案統計 token、費用、模型與專案分布。",
		"每个命令的快捷键；留空则不绑定，改坏了可以恢复默认。":  "每個指令的快速鍵；留空則不綁定，改壞了可以恢復預設。",
		"配色与主题文件。":                  "配色與主題檔案。",
		"让手机连接这台电脑上的项目和会话。":         "讓手機連線這台電腦上的專案與工作階段。",
		"pi 在哪里、能不能用；WSL 与 SSH 目标。": "pi 在哪裡、能不能用；WSL 與 SSH 目標。",
		"插件给命令面板加提示词，给外观加主题。":       "外掛為指令面板加入指令，為外觀加入主題。",
		"会话与配置在磁盘上的位置。":             "工作階段與設定在磁碟上的位置。",
		"版本、许可与来源。":                 "版本、授權與來源。",

		"插件": "外掛",
		"插件给命令面板加命令，给外观加主题。": "外掛為指令面板加入指令，為外觀加入主題。",
		"资源": "資源",
		"pi 的技能与扩展：看它们做什么，打开或停用。": "pi 的技能與擴充：看它們做什麼，開啟或停用。",
		"技能":     "技能",
		"打开技能目录": "開啟技能目錄",
		"打开扩展目录": "開啟擴充目錄",
		"重新读取":   "重新讀取",
		"自动加载":   "自動載入",
		"内置":     "內建",
		"本地文件":   "本機檔案",
		"没有读到技能；技能放在 pi 配置目录的 skills 下。": "沒有讀到技能；技能放在 pi 設定目錄的 skills 下。",
		"没有读到扩展。":    "沒有讀到擴充。",
		"正在读取技能与扩展…": "正在讀取技能與擴充…",

		// General settings.
		"界面": "介面",
		"语言": "語言",
		"界面文案；切换后立即生效，未翻译的条目保留中文。": "介面文字；切換後立即生效，未翻譯的項目保留中文。",
		"跟随系统":      "跟隨系統",
		"简体中文":      "简体中文",
		"繁體中文":      "繁體中文",
		"新会话默认模型":   "新工作階段預設模型",
		"新会话默认思考等级": "新工作階段預設思考等級",
		"会话列表":      "工作階段清單",
		"排序":        "排序",
		"最近活动":      "最近活動",
		"名称":        "名稱",
		"项目里的会话按最近活动或名称排列；置顶的总在最前。": "專案裡的工作階段依最近活動或名稱排列；置頂的總是最前。",
		"扫描所有项目": "掃描所有專案",
		"默认只读打开过的项目；打开后每个项目都会读一遍 pi 的会话，会话多时更慢。": "預設只讀開啟過的專案；開啟後每個專案都會讀一遍 pi 的工作階段，工作階段多時更慢。",
		"侧栏":         "側欄",
		"列出 pi 本地会话": "列出 pi 本機工作階段",
		"在项目下显示终端里 pi 用过的会话，点开即继续。": "在專案下顯示終端機裡 pi 用過的工作階段，點開即繼續。",
		"连没有添加为项目的文件夹也读，会话多时会更慢。":   "連沒有新增為專案的資料夾也讀，工作階段多時會更慢。",
		"桌面":        "桌面",
		"关闭窗口时留在托盘": "關閉視窗時留在系統匣",
		"关掉窗口不退出应用，Agent 继续跑；从托盘图标恢复窗口。": "關掉視窗不退出應用程式，Agent 繼續跑；從系統匣圖示恢復視窗。",
		"一轮完成时通知": "一輪完成時通知",
		"用系统通知告诉你回答好了；运行中的会话也会显示在托盘菜单里。": "用系統通知告訴你回答好了；執行中的工作階段也會顯示在系統匣選單裡。",
		"只在窗口隐藏时通知":      "只在視窗隱藏時通知",
		"窗口在前台时不再弹系统通知。": "視窗在前景時不再彈系統通知。",
		"测试通知": "測試通知",
		"发一条系统通知，确认这台机器收得到。": "發一條系統通知，確認這台機器收得到。",
		"发一条":        "發一條",
		"跟随 pi 当前模型": "跟隨 pi 目前模型",
		"跟随会话":       "跟隨工作階段",
		"重新检测":       "重新偵測",
		"重新统计":       "重新統計",

		// Common controls.
		"取消":  "取消",
		"保存":  "儲存",
		"删除":  "刪除",
		"关闭":  "關閉",
		"打开":  "開啟",
		"复制":  "複製",
		"重试":  "重試",
		"停止":  "停止",
		"发送":  "傳送",
		"重命名": "重新命名",
		"导入":  "匯入",
		"导出":  "匯出",
		"添加":  "新增",

		"配色": "主題",

		// Command groups.
		"会话":  "工作階段",
		"工作区": "工作區",
		"工具":  "工具",
		"应用":  "應用程式",
		"文件":  "檔案",

		// Commands.
		"打开命令面板":               "開啟指令面板",
		"提示词库":                 "提示詞庫",
		"保存当前草稿为提示词":           "將目前草稿存為提示詞",
		"新建会话":                 "新增工作階段",
		"关闭当前标签":               "關閉目前分頁",
		"下一个标签":                "下一個分頁",
		"上一个标签":                "上一個分頁",
		"保存文件":                 "儲存檔案",
		"重新读取文件":               "重新讀取檔案",
		"关闭文件":                 "關閉檔案",
		"重命名会话":                "重新命名工作階段",
		"导出会话为 HTML":           "匯出工作階段為 HTML",
		"压缩上下文":                "壓縮上下文",
		"停止当前运行":               "停止目前執行",
		"重启 Agent":             "重新啟動 Agent",
		"关闭 Agent":             "關閉 Agent",
		"复制最后回复":               "複製最後回覆",
		"复制上一条提问":              "複製上一則提問",
		"把上一条提问放回输入框":          "把上一則提問放回輸入框",
		"复制会话 ID":              "複製工作階段 ID",
		"在文件管理器中显示会话":          "在檔案管理員中顯示工作階段",
		"复制会话":                 "複製工作階段",
		"删除会话":                 "刪除工作階段",
		"添加工作区（系统选择器）":         "新增工作區（系統選擇器）",
		"浏览文件夹添加工作区…":          "瀏覽資料夾新增工作區…",
		"在 WSL 里添加工作区…":        "在 WSL 裡新增工作區…",
		"在 SSH 主机上添加工作区…":      "在 SSH 主機上新增工作區…",
		"导入 pi 会话（系统选择器）…":     "匯入 pi 工作階段（系統選擇器）…",
		"浏览文件导入会话…":            "瀏覽檔案匯入工作階段…",
		"在文件管理器中打开工作区":         "在檔案管理員中開啟工作區",
		"显示 / 隐藏终端":            "顯示 / 隱藏終端機",
		"新建终端":                 "新增終端機",
		"显示 Git 面板":            "顯示 Git 面板",
		"刷新 Git 状态":            "重新整理 Git 狀態",
		"新建 Git 分支…":           "新增 Git 分支…",
		"切换外观（浅色 / 深色 / 跟随系统）": "切換外觀（淺色 / 深色 / 跟隨系統）",
		"显示 / 隐藏侧栏":            "顯示 / 隱藏側欄",
		"显示 / 隐藏会话面板":          "顯示 / 隱藏工作階段面板",
		"打开数据目录":               "開啟資料目錄",
		"打开主题目录":               "開啟主題目錄",
		"打开插件目录":               "開啟外掛目錄",
		"重新加载插件与主题":            "重新載入外掛與主題",
		"设置":                   "設定",

		// Tray.
		"显示 PiDeck Lite": "顯示 PiDeck Lite",
		"运行中 · %s":       "執行中 · %s",
		"设置…":            "設定…",
		"退出":             "結束",
	},
}
