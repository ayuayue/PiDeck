//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsLook picks the palette.
//
// The palette list has its own subscription: themes load a moment after the
// window opens, and rebuilding the whole page then would take the focus out
// of a field the user has begun typing in.
func (a *app) settingsLook() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		fontControl := func(value func() string, set func(string), label, testID, placeholder string) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.Input{Value: value, OnChange: set, OnSubmit: func(string) { a.applyFonts() }, OnBlur: func() { a.applyFonts() },
					Placeholder: placeholder, Label: label, TestID: testID,
					Style: core.Style{Width: core.Pt(160), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
						Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6}},
				ui.Button{Text: apptext.T("应用"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.applyFonts},
			}}
		}
		palette := core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			var rows []core.Node
			visible := make([]themeSpec, 0, len(a.themes.Get()))
			for _, spec := range a.themes.Get() {
				// 纸白/炭黑 只是默认配色的明暗两半；不选它们时收起来，避免和跟随系统重复。
				if (spec.ID == "light" || spec.ID == "dark") && a.theme.Get() != spec.ID {
					continue
				}
				visible = append(visible, spec)
			}
			for i, spec := range visible {
				s := spec
				on := func() bool { return a.theme.Get() == s.ID }
				var note string
				switch {
				case s.Error != "":
					note = "读取失败"
				case s.Author != "":
					note = s.Author
				}
				rows = append(rows, core.View{
					OnPress: func(core.PressEvent) { a.setTheme(s.ID) },
					Role:    core.RoleRadio, Label: s.Name, TestID: "theme-" + s.ID,
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, Height: core.Pt(34),
							Padding: core.Symmetric(2, 2), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{
						themePreview(s),
						core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
							ui.Text(s.Name, 12.5, ui.Regular, colors.Text),
							core.Show{When: func() bool { return note != "" }, Then: func(*core.Scope) core.Node {
								return core.Text{Content: note, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
									Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
							}},
						}},
						core.Show{When: func() bool { return s.Appearance == "light" || s.Appearance == "dark" },
							Then: func(*core.Scope) core.Node {
								label := "仅浅色"
								if s.Appearance == "dark" {
									label = "仅深色"
								}
								return ui.Text(label, 9.5, ui.Regular, colors.Faint)
							}},
						core.Show{When: func() bool { return !s.Builtin && s.Source != "" }, Then: func(*core.Scope) core.Node {
							return core.View{OnPress: func(core.PressEvent) { a.deleteTheme(s) }, Role: core.RoleButton,
								Label: apptext.T("删除主题") + " " + s.Name, TestID: "theme-delete-" + strings.ReplaceAll(s.ID, ":", "-"),
								StyleFunc: func() core.Style {
									return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
										JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
								}, Children: []core.Node{ui.Icon(lucide.Trash, 11, colors.Faint)}}
						}},
						core.Show{When: on, Then: func(*core.Scope) core.Node { return ui.Icon(lucide.Check, 13, colors.Text) }},
						core.Show{When: func() bool { return !s.Builtin }, Then: func(*core.Scope) core.Node {
							return ui.Text(apptext.T("用户主题"), 9.5, ui.Regular, colors.Faint)
						}},
					},
				})
				if i < len(visible)-1 {
					rows = append(rows, setDivider())
				}
			}
			return setGroup("配色", rows...)
		})
		return a.scrollStashFor("settingsLook:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setRow("减弱动效", "关闭工作台布局和对话定位的动画。", ui.Switch{
					Checked: a.reduceEffects.Get, Label: apptext.T("减弱动效"), TestID: "reduce-effects",
					OnChange: func(on bool) {
						a.reduceEffects.Set(on)
						a.cfg.ReduceEffects = on
						a.st.edit(func(c *config) { c.ReduceEffects = on })
					},
				}),
				setRow("代码块自动换行", "长代码行按聊天栏宽度折行。", ui.Switch{
					Checked: a.codeWrap.Get, Label: apptext.T("代码块自动换行"), TestID: "chat-code-wrap",
					OnChange: func(on bool) {
						a.codeWrap.Set(on)
						a.cfg.CodeWrap = on
						a.st.edit(func(c *config) { c.CodeWrap = on })
					},
				}),
				setRow("终端字号", "底部终端面板的文字大小，8–20 pt；改完立即重绘。",
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(200)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
							ui.Slider{Min: 8, Max: 20, Step: 1, Value: func() float64 { return a.termFont.Get() },
								Label: apptext.T("终端字号"), ValueText: func(v float64) string { return fmt.Sprintf("%.0f pt", v) },
								TestID: "term-font", OnChange: a.setTerminalFont},
						}},
						core.Text{ContentFunc: func() string { return fmt.Sprintf("%.0f pt", a.termFont.Get()) },
							Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, MinWidth: core.Pt(38), TextAlign: core.TextAlignRight},
							StyleFunc: ui.Colored(colors.Muted)},
					}}),
				setRow("编辑器字号", "中间编辑器的文字大小，11–20 pt；改完立即重绘。",
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(200)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
							ui.Slider{Min: 11, Max: 20, Step: 1, Value: func() float64 { return a.editorFont.Get() },
								Label: apptext.T("编辑器字号"), ValueText: func(v float64) string { return fmt.Sprintf("%.0f pt", v) },
								TestID: "editor-font", OnChange: a.setEditorFont},
						}},
						core.Text{ContentFunc: func() string { return fmt.Sprintf("%.0f pt", a.editorFont.Get()) },
							Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, MinWidth: core.Pt(38), TextAlign: core.TextAlignRight},
							StyleFunc: ui.Colored(colors.Muted)},
					}}),
				setDivider(),
				setRow("聊天字号", "会话正文与提问的字号；标题、代码和列表按同一比例放大。",
					choiceChips([]choice[float64]{
						{14, apptext.T("紧凑")}, {viewkit.ChatFontDefault, apptext.T("标准")}, {18, apptext.T("大")}, {20, apptext.T("特大")},
					}, func() float64 { return a.chatFont.Get() }, a.setChatFont)),
				setDivider(),
				setRow("聊天行高", "正文的行距；宽松一些更好读。",
					choiceChips([]choice[float64]{
						{1.45, apptext.T("紧凑")}, {viewkit.ChatLineDefault, apptext.T("标准")}, {1.8, apptext.T("宽松")}, {2.0, apptext.T("舒展")},
					}, func() float64 { return a.chatLine.Get() }, a.setChatLine)),
				setDivider(),
				setRow("输入框字号", "输入框里的文字大小；「跟随聊天」与聊天字号一致。",
					choiceChips([]choice[float64]{
						{0, apptext.T("跟随聊天")}, {14, apptext.T("紧凑")}, {viewkit.ChatFontDefault, apptext.T("标准")}, {18, apptext.T("大")},
					}, func() float64 { return a.inputFont.Get() }, a.setInputFont)),
				setDivider(),
				setRow("输入框底部指标", "输入框下方那一行显示哪些数字；关掉也不会影响统计，只是不显示。",
					a.composerMetricChips()),
				setDivider(),
				setRow("界面字体", "整个界面的字体（代码与等宽处除外）；系统已安装的字体名，如 Georgia。留空跟随主题，回车、失焦或点「应用」生效。",
					fontControl(func() string { return a.cfg.UIFont }, func(v string) {
						a.cfg.UIFont = strings.TrimSpace(v)
						if a.st != nil {
							a.st.edit(func(c *config) { c.UIFont = a.cfg.UIFont })
						}
					}, apptext.T("界面字体"), "ui-font", apptext.T("留空跟随主题"))),
				setDivider(),
				setRow("等宽字体", "代码、工具输出、编辑器与终端的字体；如 JetBrains Mono。留空用系统等宽字体。",
					fontControl(func() string { return a.cfg.MonoFont }, func(v string) {
						a.cfg.MonoFont = strings.TrimSpace(v)
						if a.st != nil {
							a.st.edit(func(c *config) { c.MonoFont = a.cfg.MonoFont })
						}
					}, apptext.T("等宽字体"), "mono-font", apptext.T("留空用系统等宽字体"))),
				setDivider(),
				setRow("导出当前主题", "把当前配色、tokens、字体与圆角写成一个主题文件，可分享或继续改。",
					ui.Button{Text: apptext.T("导出"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "theme-export",
						OnPress: a.exportTheme}),
				setRow("主题文件", "放在数据目录的 themes 里：JSON 或 YAML，写角色色、tokens、字体与圆角；也读 shadcn/ui 主题文件。",
					ui.Button{Text: apptext.T("打开目录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.openThemesDir}),
				a.brandingGroup(colors),
				palette,
				a.backgroundGroup(colors),
			}},
		}})
	})
}

// backgroundGroup edits the picture behind the app and how much of it
// shows.
func (a *app) backgroundGroup(colors ui.Colors) core.Node {
	path := a.cfg.wallpaper()
	var preview core.Node
	if wallpaperVideo(path) {
		preview = ui.Icon(lucide.Film, 20, colors.Muted)
	} else if path != "" {
		preview = core.Image{Source: core.ImageSource{URI: path}, ResizeMode: core.Cover,
			Style: core.Style{Width: core.Pt(80), Height: core.Pt(46), CornerRadius: 6, BorderWidth: 1, BorderColor: colors.Border()}}
	} else {
		preview = core.View{Style: core.Style{Width: core.Pt(80), Height: core.Pt(46), CornerRadius: 6,
			BorderWidth: 1, BorderColor: colors.Border(), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
			Children: []core.Node{ui.Text("—", 12, ui.Regular, colors.Faint)}}
	}
	choose := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
		preview,
		ui.Button{Text: apptext.T("选择图片"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "bg-image-choose",
			OnPress: func() {
				a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp", ".gif"}, Limit: 1},
					func(files []core.File, err error) {
						if err != nil {
							a.toast(ui.ToastError, apptext.T("选择图片失败"), err.Error())
							return
						}
						if len(files) > 0 {
							a.setBackgroundImage(files[0].Path)
						}
					})
			}},
		core.Show{When: func() bool { return a.bgImage.Get() != "" }, Then: func(*core.Scope) core.Node {
			return ui.Button{Text: apptext.T("清除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "bg-image-clear",
				OnPress: func() { a.setBackgroundImage("") }}
		}},
	}}
	opacity := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(200)}, Children: []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			ui.Slider{Min: 0, Max: 100, Step: 1, Value: func() float64 { return a.backgroundOpacity() * 100 },
				Label: apptext.T("背景透明度"), ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) },
				TestID: "bg-opacity", OnChange: func(v float64) {
					// The row redraws itself from the opacity signal; the page is
					// bumped once the drag ends, or it would not drag at all.
					a.setBackgroundOpacity(v / 100)
				}},
		}},
		core.Dynamic(func(*core.Scope) core.Node {
			return core.Text{Content: fmt.Sprintf("%.0f%%", a.bgOpacity.Get()*100),
				Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, MinWidth: core.Pt(38), TextAlign: core.TextAlignRight},
				StyleFunc: ui.Colored(colors.Muted)}
		}),
	}}
	return setGroup("背景",
		setRow("背景图片", "从本机选一张图片铺满窗口，只保存路径。", choose),
		setRow("视频壁纸", "选择本机视频或 Wallpaper Engine 视频项目的 project.json。", ui.Button{
			Text: apptext.T("选择视频壁纸"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "video-wallpaper-choose", OnPress: a.pickVideoWallpaper,
		}),
		setDivider(),
		setRow("背景透明度", "0% 完全遮住图片，100% 完全显示；面板会一起变透明。", opacity),
	)
}
