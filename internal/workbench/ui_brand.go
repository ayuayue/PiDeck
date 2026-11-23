//go:build !js && !android && !ios

package workbench

import (
	"runtime"
	"time"

	"example.com/pideck-v2/assets"
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/updater"
)

func logoMark(style string, custom brandImage, size core.Points, testID string) core.Node {
	frame := core.Style{Width: core.Pt(size), Height: core.Pt(size), FlexShrink: 0}
	if style == logoStyleCustom {
		if custom.svg != nil {
			return core.SVGView{SVG: custom.svg, Label: apptext.T("自定义 Logo"), TestID: testID, Style: frame}
		}
		if len(custom.data) > 0 {
			return core.Image{Source: core.ImageSource{Data: custom.data}, ResizeMode: core.Contain,
				Label: apptext.T("自定义 Logo"), TestID: testID, Style: frame}
		}
	}
	if style == logoStyleClassic {
		frame.CornerRadius = size * 0.24
		return core.Image{Source: core.ImageSource{Data: assets.LogoPNG}, ResizeMode: core.Contain,
			Label: apptext.T("pi 经典 Logo"), TestID: testID, Style: frame}
	}
	frame.Background, frame.CornerRadius = core.RGB(0x09090b), size*0.24
	frame.AlignItems, frame.JustifyContent = core.AlignCenter, core.JustifyCenter
	glyph := size * 0.5625
	return core.View{TestID: testID, Style: frame, Children: []core.Node{
		core.SVGView{SVG: piTUILogo, Label: apptext.T("pi TUI 彩色 Logo"),
			Style: core.Style{Width: core.Pt(glyph), Height: core.Pt(glyph)}},
	}}
}

func (a *app) brandMark(size core.Points, testID string) core.Node {
	return core.Dynamic(func(*core.Scope) core.Node {
		_ = a.brandRev.Get()
		return logoMark(resolveLogoStyle(a.cfg.LogoStyle), a.customBrand, size, testID)
	})
}

// brand keeps the click target around the actual lockup. The name can
// shrink and ellipsize at the rail's minimum width without moving the logo.
func (a *app) brand() core.Node {
	return base.Popover{
		Open: a.brandOpen.Get, OnOpenChange: func(open bool, _ base.Reason) {
			if open {
				a.cx.DismissKeyboard()
			}
			a.brandOpen.Set(open)
		},
		Placement: core.PlaceBottom, Align: core.AlignStart, Offset: 8, Margin: 12,
		TestID: "rail-brand", Label: apptext.T("关于与版本信息"),
		Style: core.Style{AlignSelf: core.AlignStart, MaxWidth: core.Pct(100), MinWidth: core.Pt(0),
			Padding: core.Symmetric(4, 4), CornerRadius: 7},
		StyleFunc: func() core.Style {
			colors := ui.ColorsOf(a.cx)
			return core.Style{Hover: &core.Style{Background: colors.Hover()},
				Focus: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		PopupStyle:     core.Style{Width: core.Pt(300)},
		PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
		Trigger: core.Dynamic(func(cx *core.Scope) core.Node {
			_ = a.brandRev.Get()
			colors := ui.ColorsOf(cx)
			label, tone := a.piStatus(colors)
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9,
				MinWidth: core.Pt(0), MaxWidth: core.Pct(100)}, Children: []core.Node{
				a.brandMark(28, "rail-brand-logo"),
				core.View{Style: core.Style{Gap: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Text{ContentFunc: func() string {
							_ = a.brandNameRev.Get()
							return resolveBrandName(a.cfg.AppDisplayName)
						}, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							TestID: "rail-brand-name", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 14, FontWeight: ui.Bold,
								LetterSpacing: 0.4, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
						core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, FlexShrink: 0,
							BorderWidth: 1, BorderColor: colors.Border()}, Children: []core.Node{
							ui.Text("v2", 9, ui.Regular, colors.Faint),
						}},
					}},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.View{Style: core.Style{Width: core.Pt(5), Height: core.Pt(5), FlexShrink: 0, CornerRadius: 3, Background: tone}},
						core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
					}},
				}},
			}}
		}),
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node { return a.brandInfo(cx) })},
	}
}

func (a *app) openBrandSettings() {
	a.brandOpen.Set(false)
	a.openSettingsSection("look")
	a.openSettingsPane()
	a.settingsOffset = core.Point{}
	a.settingsScroll.ScrollTo(core.Point{}, false)
}

// brandInfo is a compact version panel beside the wordmark. Opening a
// destination dismisses it so the next page or updater has the focus.
func (a *app) brandInfo(cx *core.Scope) core.Node {
	_ = a.brandRev.Get()
	_ = a.langRev.Get()
	colors := ui.ColorsOf(cx)
	info := a.env.Get()
	build := readBrandBuild()
	row := func(label, value, id string) core.Node {
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
			ui.Text(apptext.T(label), 11, ui.Regular, colors.Muted),
			core.Text{Content: value, MaxLines: 1, EllipsizeMode: core.EllipsizeTail, TestID: id,
				Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), TextAlign: core.TextAlignRight},
				StyleFunc: ui.Colored(colors.Text)},
		}}
	}
	piVersion := info.PiVersion
	if piVersion == "" {
		piVersion = piVersionLine(info)
	}
	versions := []core.Node{
		row("Pi CLI", piVersion, "brand-pi-version"),
		row("NSGo", build.NSGo, "brand-nsgo-version"),
		row("Go", runtime.Version(), "brand-go-version"),
		row("操作系统", runtime.GOOS+" / "+runtime.GOARCH, "brand-platform"),
	}
	if build.Revision != "" {
		versions = append(versions, row("构建提交", build.Revision, "brand-revision"))
	}
	if build.Time != "" {
		value := build.Time
		if at, err := time.Parse(time.RFC3339, value); err == nil {
			value = at.Local().Format("2006-01-02 15:04")
		}
		versions = append(versions, row("提交时间", value, "brand-build-time"))
	}
	action := func(icon func() *core.SVG, label, id string, onPress func(), external bool) core.Node {
		arrow := lucide.ChevronRight
		if external {
			arrow = lucide.ExternalLink
		}
		return core.View{Role: core.RoleButton, Label: apptext.T(label), TestID: id,
			OnPress: func(core.PressEvent) { a.brandOpen.Set(false); onPress() },
			Style:   core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(6, 8), CornerRadius: 6},
			StyleFunc: func() core.Style {
				return core.Style{Hover: &core.Style{Background: colors.Hover()}, Focus: &core.Style{Background: colors.Hover()}}
			}, Children: []core.Node{
				ui.Icon(icon, 13, colors.Muted),
				core.Text{Content: apptext.T(label), Style: core.Style{FlexGrow: 1, FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
				ui.Icon(arrow, 12, colors.Faint),
			}}
	}
	return core.View{TestID: "brand-info", Style: core.Style{Padding: core.All(10), Gap: 12, MinWidth: core.Pt(0)}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10}, Children: []core.Node{
			a.brandMark(40, "brand-info-logo"),
			core.View{Style: core.Style{Gap: 3, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				core.Text{ContentFunc: func() string {
					_ = a.brandNameRev.Get()
					return resolveBrandName(a.cfg.AppDisplayName)
				}, MaxLines: 2,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 16, LineHeight: 20, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: "PiDeck V2 · v" + brandVersion(), TestID: "brand-app-version",
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Muted)},
			}},
		}},
		ui.Text(apptext.T("NSGo 原生 pi 工作台"), 11, ui.Regular, colors.Muted),
		core.View{Style: core.Style{Gap: 7}, Children: versions},
		setDivider(),
		core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
			action(lucide.RefreshCw, "检查更新", "brand-check-updates", func() { updater.Check(a.cx) }, false),
			action(lucide.FolderGit2, "项目主页", "brand-project", func() { a.cx.OpenURL(appRepoURL, nil) }, true),
			action(lucide.Tag, "发布记录", "brand-releases", func() { a.cx.OpenURL(appRepoURL+"/releases", nil) }, true),
			action(lucide.Globe, "pi 项目", "brand-pi-project", func() { a.cx.OpenURL("https://github.com/badlogic/pi-mono", nil) }, true),
			action(lucide.Palette, "自定义品牌", "brand-customize", a.openBrandSettings, false),
			action(lucide.Info, "更多应用信息", "brand-about", func() { a.openSettingsSection("about"); a.openSettingsPane() }, false),
		}},
	}}
}

// brandingGroup subscribes only the preview to brandRev. Typing a name
// updates the rail and popover without rebuilding the focused input.
func (a *app) brandingGroup(colors ui.Colors) core.Node {
	nameDirty := false
	saveName := func() {
		if !nameDirty {
			return
		}
		nameDirty = false
		a.saveConfigAsync()
	}
	var options []core.Node
	for _, choice := range []struct{ style, label string }{
		{logoStyleTUI, "pi TUI 彩色"}, {logoStyleClassic, "pi 经典"}, {logoStyleCustom, "自定义图片"},
	} {
		style, label := choice.style, choice.label
		options = append(options, core.View{
			Role: core.RoleRadio, Label: apptext.T(label), TestID: "brand-logo-" + style,
			Checked: func() bool { _ = a.brandRev.Get(); return resolveLogoStyle(a.cfg.LogoStyle) == style },
			OnPress: func(core.PressEvent) { a.setLogoStyle(style) },
			Style:   core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(34), Padding: core.Symmetric(4, 9), CornerRadius: 6, BorderWidth: 1},
			StyleFunc: func() core.Style {
				_ = a.brandRev.Get()
				st := core.Style{BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}, Focus: &core.Style{BorderColor: colors.Text()}}
				if resolveLogoStyle(a.cfg.LogoStyle) == style {
					st.Background, st.BorderColor = colors.Pressed(), colors.Text()
				}
				return st
			}, Children: []core.Node{
				core.Dynamic(func(*core.Scope) core.Node {
					_ = a.brandRev.Get()
					if style == logoStyleCustom && a.cfg.LogoCustomImage == "" {
						return ui.Icon(lucide.ImagePlus, 20, colors.Muted)
					}
					return logoMark(style, a.customBrand, 20, "")
				}),
				ui.Text(apptext.T(label), 11, ui.Regular, colors.Text),
			}})
	}
	return setGroup("品牌",
		core.View{Style: core.Style{Gap: 6, Padding: core.Symmetric(6, 2)}, Children: []core.Node{
			ui.Text(apptext.T("Logo 风格"), 12.5, ui.Regular, colors.Text),
			ui.Text(apptext.T("内置 pi 官方的 TUI 三色与经典银灰标，也可选择自己的图片。"), 11, ui.Regular, colors.Muted),
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 7}, Children: options},
		}},
		setDivider(),
		core.View{Style: core.Style{Gap: 7, Padding: core.Symmetric(6, 2)}, Children: []core.Node{
			ui.Text(apptext.T("应用显示名称"), 12.5, ui.Regular, colors.Text),
			ui.Text(apptext.T("左上角与品牌信息面板共用；最多 24 个字符，留空使用 PiDeck。"), 11, ui.Regular, colors.Muted),
			core.Input{Value: func() string { _ = a.brandInputRev.Get(); return a.cfg.AppDisplayName },
				OnChange: func(value string) { nameDirty = true; a.setBrandName(value) },
				OnSubmit: func(string) { saveName() }, OnBlur: saveName,
				MaxLength: brandNameMax, Label: apptext.T("应用显示名称"), Placeholder: brandNameDefault,
				TestID: "brand-display-name", Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(280), Height: core.Pt(30),
					Padding: core.Symmetric(0, 9), FontSize: 12, CornerRadius: 6, BorderWidth: 1,
					BorderColor: colors.FieldBorder(), Color: colors.Text(), Background: colors.Field(),
					CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
		}},
		core.Dynamic(func(*core.Scope) core.Node {
			_ = a.brandRev.Get()
			if resolveLogoStyle(a.cfg.LogoStyle) != logoStyleCustom {
				return nil
			}
			return core.View{Style: core.Style{Gap: 6, Padding: core.Symmetric(6, 2)}, Children: []core.Node{
				ui.Text(apptext.T("自定义 Logo"), 12.5, ui.Regular, colors.Text),
				ui.Text(apptext.T("PNG、JPEG、WebP、GIF 或 SVG；图片随设置保存，保留透明背景和比例。"), 11, ui.Regular, colors.Muted),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
					logoMark(logoStyleCustom, a.customBrand, 40, "brand-custom-preview"),
					ui.Button{Text: apptext.T("选择图片"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "brand-image-choose",
						Disabled: a.brandBusy.Get, OnPress: a.pickBrandImage},
					core.Show{When: func() bool { return a.cfg.LogoCustomImage != "" }, Then: func(*core.Scope) core.Node {
						return ui.Button{Text: apptext.T("清除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "brand-image-clear", OnPress: a.clearBrandImage}
					}},
				}},
				core.Show{When: func() bool { return a.cfg.LogoCustomImage == "" }, Then: func(*core.Scope) core.Node {
					return ui.Text(apptext.T("未选择图片时使用 TUI 彩色 Logo。"), 11, ui.Regular, colors.Muted)
				}},
			}}
		}),
		core.Show{When: a.brandBusy.Get, Then: func(*core.Scope) core.Node {
			return ui.Text(apptext.T("正在读取 Logo…"), 11, ui.Regular, colors.Muted)
		}},
		core.Show{When: func() bool { return a.brandError.Get() != "" }, Then: func(*core.Scope) core.Node {
			return core.Text{ContentFunc: a.brandError.Get, TestID: "brand-image-error",
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Danger)}
		}},
		setDivider(),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(6, 2)}, Children: []core.Node{
			a.brandMark(28, "brand-preview"),
			core.Text{ContentFunc: func() string { _ = a.brandNameRev.Get(); return resolveBrandName(a.cfg.AppDisplayName) },
				MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 12, FontFamily: viewkit.MonoFont(), MinWidth: core.Pt(0), FlexShrink: 1, FlexGrow: 1},
				StyleFunc: ui.Colored(colors.Text)},
			ui.Button{Text: apptext.T("恢复默认品牌"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "brand-reset", OnPress: a.resetBrand},
		}},
	)
}
