//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsData shows the folders the app writes.
func (a *app) settingsData() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		dir, sessions := "", ""
		if a.st != nil {
			dir, sessions = a.st.dir, a.st.sessions
		}
		count := 0
		if a.st != nil {
			count = a.st.countSessions()
		}
		piCount := 0
		for _, ws := range a.workspaces.Get() {
			piCount += len(ws.Pi.Get())
		}
		return core.Scroll{TestID: "settings-page", Ref: a.settingsScroll, OnScroll: a.settingsScrolled, Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 2}, Children: []core.Node{
				setGroup("位置",
					setRow("数据目录", dir, ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if dir != "" {
							a.cx.OpenURL(fileURL(dir), nil)
						}
					}}),
					setDivider(),
					setRow("会话目录", sessions, ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if sessions != "" {
							a.cx.OpenURL(fileURL(sessions), nil)
						}
					}}),
					setDivider(),
					setRow("pi 的会话目录", a.env.GetUntracked().SessionsDir, ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if sd := a.env.GetUntracked().SessionsDir; sd != "" {
							a.cx.OpenURL(fileURL(sd), nil)
						}
					}}),
				),
				setGroup("数量",
					setRow("本应用的会话", fmt.Sprintf("%d 个", count), ui.Text(apptext.T("已打开 %d", len(a.tabs.Get())), 10.5, ui.Regular, colors.Faint)),
					setDivider(),
					setRow("项目下的 pi 本地会话", fmt.Sprintf("%d 个", piCount), nil),
					setDivider(),
					setRow("配置版本", fmt.Sprintf("%d", a.cfg.Version),
						ui.Text(apptext.T("旧文件读取时自动迁移"), 10.5, ui.Regular, colors.Faint)),
				),
				setGroup("备份",
					setRow("导出设置包", "配置、插件、主题、提示词、智能体与 ACP 预设打成一个 zip；不含会话与日志。",
						ui.Button{Text: apptext.T("导出"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "settings-export",
							OnPress: a.exportSettings}),
					setDivider(),
					setRow("导入设置包", "从 zip 恢复；同名文件会被覆盖，部分设置重启后生效。",
						ui.Button{Text: apptext.T("选择…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "settings-import",
							OnPress: a.pickSettingsZip}),
				),
				setRow("加密同步", "通过目录、GitHub Gist 或 Google Drive 传输设置。", ui.Button{
					Text: apptext.T("加密同步"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "settings-sync", OnPress: a.openSettingsSync,
				}),
				a.cacheCleanupSettings(),
			}},
		}}
	})
}
