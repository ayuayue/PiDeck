//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsEnv shows what the probe found on every machine.
//
// The probe result arrives and changes on its own, so only the rows that show
// it subscribe to it: a probe finishing while the user types would otherwise
// rebuild the page and drop the keystrokes in its fields.
func (a *app) settingsEnv() core.Node {
	probeRows := core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		info := a.env.Get()
		piOK := info.PiPath != "" && info.PiError == ""
		piPath := info.PiPath
		if !piOK {
			piPath = apptext.T("没找到：") + viewkit.FirstLine(info.PiError, 80)
		}
		return core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
			setRow("pi 可执行文件", piPath, ui.Text(piVersionLine(info), 10.5, ui.Regular, colors.Faint)),
			a.piUpdateSetting(piOK),
			a.sessionLinkSetting(),
			setDivider(),
			setRow("pi 会话目录", info.SessionsDir, ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
				if info.SessionsDir != "" {
					a.cx.OpenURL(fileURL(info.SessionsDir), nil)
				}
			}}),
			setDivider(),
			setRow("pi 配置目录", piConfigDir(), ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
				if dir := piConfigDir(); dir != "" {
					a.cx.OpenURL(fileURL(dir), nil)
				}
			}}),
			setDivider(),
		}}
	})
	targetRows := core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		info := a.env.Get()
		var rows []core.Node
		if info.TargetsProbing {
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(2, 0)}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在检测 WSL 与 SSH…"), 11.5, ui.Regular, colors.Muted)}})
		}
		for _, d := range info.WSL {
			ok := d.PiPath != ""
			status := d.PiPath
			if !ok {
				status = "未找到 pi：" + viewkit.FirstLine(d.Error, 60)
			}
			rows = append(rows, targetStatusRow("WSL", d.Name, status, ok))
		}
		for _, h := range info.SSH {
			ok := h.PiPath != ""
			status := h.PiPath
			if !ok {
				status = "连不上或没有 pi：" + viewkit.FirstLine(h.Error, 60)
			}
			rows = append(rows, targetStatusRow("SSH", h.Name, status, ok))
		}
		if len(info.WSL) == 0 && len(info.SSH) == 0 && !info.TargetsProbing {
			rows = append(rows, core.Text{Content: apptext.T("没有读到 WSL 发行版或 SSH Host。"),
				Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return core.View{Style: core.Style{Gap: 2}, Children: rows}
	})
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		editorRow := setRow("外部编辑器", detectedEditorsText(), core.Input{
			Value: func() string { return a.cfg.EditorCommand }, Placeholder: apptext.T("code / cursor / 自定义命令"),
			Label: apptext.T("外部编辑器命令"), TestID: "editor-command",
			// Leaving the field saves it: writing on every keystroke would put
			// disk IO in the typing path.
			OnSubmit: func(string) { a.saveConfigAsync() }, OnBlur: func() { a.saveConfigAsync() },
			OnChange: func(v string) {
				a.cfg.EditorCommand = v
				a.st.change(func(c *config) { c.EditorCommand = v })
			},
			Style: core.Style{Width: core.Pt(170), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
				FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
				BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6},
		})
		proxyField := func(value func() string, set func(string), placeholder, label, testID string) core.Node {
			return core.Input{Value: value, Placeholder: placeholder, Label: label, TestID: testID,
				OnChange: set,
				OnSubmit: func(string) { a.applyProxy(); a.saveConfigAsync() },
				OnBlur:   func() { a.applyProxy(); a.saveConfigAsync() },
				Style: core.Style{Width: core.Pt(190), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
					FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6}}
		}
		proxyRows := []core.Node{
			setRow("应用请求代理", "供应商测试/余额、飞书与 Git 的网络请求；留空直连。", proxyField(
				func() string { return a.cfg.ProxyApp },
				func(v string) {
					a.cfg.ProxyApp = v
					a.st.change(func(c *config) { c.ProxyApp = v })
				}, "http://127.0.0.1:7890", "应用请求代理", "proxy-app")),
			setDivider(),
			setRow("Agent 代理", "启动 pi 与 ACP 时写入 HTTP(S)_PROXY；重启 Agent 后生效。", proxyField(
				func() string { return a.cfg.ProxyAgent },
				func(v string) {
					a.cfg.ProxyAgent = v
					a.st.change(func(c *config) { c.ProxyAgent = v })
				}, "http://127.0.0.1:7890", "Agent 代理", "proxy-agent")),
			setDivider(),
			setRow("直连名单", "NO_PROXY，逗号分隔域名或网段；两侧共用。", proxyField(
				func() string { return a.cfg.ProxyBypass },
				func(v string) {
					a.cfg.ProxyBypass = v
					a.st.change(func(c *config) { c.ProxyBypass = v })
				}, "localhost,127.0.0.1,.local", "直连名单", "proxy-bypass")),
		}
		return core.Scroll{TestID: "settings-page", Ref: a.settingsScroll, OnScroll: a.settingsScrolled, Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 2}, Children: []core.Node{
				setGroup("本机", probeRows, editorRow),
				setGroup("网络代理", proxyRows...),
				core.Text{Content: apptext.T("应用代理只影响应用自己发出的请求；Agent 代理在启动进程时注入环境变量。"),
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				setGroup("其它机器", targetRows),
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 4}}, Children: []core.Node{
					ui.Button{Text: apptext.T("添加 WSL 工作区"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.closePane(paneSettings)
						a.openTargetDialog(targetWSL)
					}},
					ui.Button{Text: apptext.T("添加 SSH 工作区"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.closePane(paneSettings)
						a.openTargetDialog(targetSSH)
					}},
				}},
			}},
		}}
	})
}

// targetStatusRow is one WSL distribution or SSH host and whether pi
// answers there.
func targetStatusRow(kind, name, status string, ok bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		icon := lucide.Globe
		if kind == "WSL" {
			icon = lucide.Monitor
		}
		ink := colors.Faint()
		if !ok {
			ink = colors.Danger()
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
			Padding: core.Symmetric(2, 2)}, Children: []core.Node{
			ui.IconOf(icon, 13, colors.Muted),
			ui.Text(kind, 9.5, ui.Medium, colors.Faint),
			core.Text{Content: name, Style: core.Style{FlexGrow: 0, FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Text{Content: shorten(status, 52), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5},
				StyleFunc: ui.Colored(func() core.Color { return ink })},
		}}
	})
}

// arrowButton is a small up/down control for ordering a list.
func arrowButton(icon func() *core.SVG, label string, fn func()) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{OnPress: func(core.PressEvent) { fn() }, Role: core.RoleButton, Label: label,
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
					JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: []core.Node{ui.Icon(icon, 12, colors.Muted)}}
	})
}

// piVersionLine is the pi version, or that there is none.
func piVersionLine(info envInfo) string {
	if info.PiVersion != "" {
		return "pi " + info.PiVersion
	}
	if info.PiError != "" {
		return apptext.T("找不到 pi")
	}
	return apptext.T("检测中…")
}
