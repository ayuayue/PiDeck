//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/updater"
)

// settingsAbout is the version and where it comes from.
func (a *app) settingsAbout() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		info := a.env.Get()
		return a.scrollStashFor("settingsAbout:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 8, Bottom: 20, Right: scrollbarGutter}, Gap: 12}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
					a.brandMark(44, "about-logo"),
					core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
						core.Text{ContentFunc: func() string { _ = a.brandNameRev.Get(); return resolveBrandName(a.cfg.AppDisplayName) },
							Style: core.Style{FontSize: 15, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
						ui.Text("PiDeck V2 · v"+brandVersion(), 11, ui.Regular, colors.Muted),
						ui.Text(apptext.T("NSGo 原生窗口 · 只做 pi"), 11, ui.Regular, colors.Muted),
					}},
				}},
				setGroup("运行",
					setRow("操作系统", fmt.Sprintf("%s / %s", runtime.GOOS, runtime.GOARCH), nil),
					setDivider(),
					setRow("pi", piVersionLine(info), nil),
					setDivider(),
					setRow("后端", "pi --mode rpc（会话、工具、模型都由 pi 提供）", nil),
				),
				setGroup("更新",
					setRow("检查更新", "从 GitHub Release 的 appcast 检查；direct 构建会下载、校验并安装。",
						ui.Button{Text: apptext.T("检查"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "check-updates",
							OnPress: func() { updater.Check(a.cx) }}),
				),
				setGroup("链接",
					setRow("项目主页", "github.com/ayuayue/PiDeck-V2", ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { a.cx.OpenURL(appRepoURL, nil) }}),
					setDivider(),
					setRow("pi 项目", "github.com/badlogic/pi-mono", ui.Button{Text: apptext.T("复制"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.copyText("https://github.com/badlogic/pi-mono", "链接")
					}}),
					setDivider(),
					setRow("NSGo 框架", "nsgo.dev", ui.Button{Text: apptext.T("复制"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.copyText("https://nsgo.dev/", "链接")
					}}),
					setDivider(),
					setRow("请作者喝咖啡", "爱猹收打赏：纯打赏，不绑定会话和用量。",
						ui.Button{Text: apptext.T("请作者喝咖啡…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
							TestID: "support-open", OnPress: a.openSupport}),
				),
				core.Text{Content: apptext.T("MIT · 数据都在本机 · 会话由 pi 写入自己的目录"),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			}},
		}})
	})
}

// ensure os is used for the folder pickers the sections offer.
var _ = os.Getenv

var _ = filepath.Join
