//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
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

	frame.Background, frame.CornerRadius = core.RGB(0xffffff), size*228/1024
	frame.BorderWidth, frame.BorderColor = 1, core.RGB(0xe5e5e5)
	frame.AlignItems, frame.JustifyContent = core.AlignCenter, core.JustifyCenter
	glyph := size * 0.65
	mark, label := piTUILogo, apptext.T("pi TUI 彩色 Logo")
	if style == logoStyleClassic {
		mark, label = piClassicLogo, apptext.T("pi 经典 Logo")
	}
	return core.View{TestID: testID, Style: frame, Children: []core.Node{
		core.SVGView{SVG: mark, Label: label,
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
		PopupStyle:     core.Style{Width: core.Pt(320)},
		PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
		Trigger: core.Dynamic(func(cx *core.Scope) core.Node {
			_ = a.brandRev.Get()
			colors := ui.ColorsOf(cx)
			label, tone := a.piStatus(colors)
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9,
				MinWidth: core.Pt(0), MaxWidth: core.Pct(100)}, Children: []core.Node{
				a.brandMark(30, "rail-brand-logo"),
				core.View{Style: core.Style{Gap: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Text{ContentFunc: func() string {
							_ = a.brandNameRev.Get()
							return resolveBrandName(a.cfg.AppDisplayName)
						}, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							TestID: "rail-brand-name", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 15, FontWeight: ui.Bold,
								LetterSpacing: 0.4, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
						core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, FlexShrink: 0,
							BorderWidth: 1, BorderColor: colors.Border()}, Children: []core.Node{
							core.Text{Content: "v" + brandVersion(), TestID: "rail-brand-version",
								Style: core.Style{FontSize: 10, FontWeight: ui.Regular}, StyleFunc: ui.Colored(colors.Faint)},
						}},
					}},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), FlexShrink: 0, CornerRadius: 3, Background: tone}},
						core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
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

	a.forgetScrolls("settings")
}

// brandingGroup keeps name editing and image loading local to this group.
func (a *app) brandingGroup(colors ui.Colors) core.Node {
	nameDirty := false
	saveName := func() {
		if nameDirty {
			nameDirty = false
			a.saveConfigAsync()
		}
	}
	var options []core.Node
	for _, choice := range []struct{ style, label string }{
		{logoStyleTUI, "pi TUI 彩色"}, {logoStyleClassic, "pi 经典"}, {logoStyleCustom, "自定义图片"},
	} {
		style, label := choice.style, choice.label
		options = append(options, ui.Radio{
			Label: apptext.T(label), TestID: "brand-logo-" + style,
			Checked:  func() bool { _ = a.brandRev.Get(); return resolveLogoStyle(a.cfg.LogoStyle) == style },
			OnChange: func(bool) { a.setLogoStyle(style) },
			Style:    core.Style{MinHeight: core.Pt(30), Gap: 8},
			Children: []core.Node{
				core.Dynamic(func(*core.Scope) core.Node {
					_ = a.brandRev.Get()
					if style == logoStyleCustom && a.cfg.LogoCustomImage == "" {
						return ui.Icon(lucide.ImagePlus, 20, colors.Muted)
					}
					return logoMark(style, a.customBrand, 20, "")
				}), ui.Text(apptext.T(label), 11.5, ui.Regular, colors.Text),
			}})
	}
	return setGroup("应用标识",
		setRow("Logo 风格", "用于侧栏左上角；自定义图片可在下方选择。", ui.RadioGroup{
			Label: apptext.T("Logo 风格"), Style: core.Style{Width: core.Pt(230), MaxWidth: core.Pct(100)}, Children: options}),
		setDivider(),
		setRow("应用显示名称", "最多 24 个字符；留空使用 PiDeck，结束编辑后保存。", core.Input{
			Value:    func() string { _ = a.brandInputRev.Get(); return a.cfg.AppDisplayName },
			OnChange: func(value string) { nameDirty = true; a.setBrandName(value) },
			OnSubmit: func(string) { saveName() }, OnBlur: saveName,
			MaxLength: brandNameMax, Label: apptext.T("应用显示名称"), Placeholder: brandNameDefault, TestID: "brand-display-name",
			Style: core.Style{Width: core.Pt(230), MaxWidth: core.Pct(100), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11.5,
				CornerRadius: 6, BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), Background: colors.Field(),
				CaretColor: colors.Text(), SelectionColor: colors.Now().Selection, FocusVisible: ui.FocusRing(a.cx, 2)}}),
		core.Dynamic(func(*core.Scope) core.Node {
			_ = a.brandRev.Get()
			if resolveLogoStyle(a.cfg.LogoStyle) != logoStyleCustom {
				return nil
			}
			return core.View{Children: []core.Node{
				setDivider(),
				setRow("自定义 Logo", "PNG、JPEG、WebP、GIF 或 SVG；图片随设置保存，保留透明背景和比例。",
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8,
						Width: core.Pt(230), MaxWidth: core.Pct(100), JustifyContent: core.JustifyEnd}, Children: []core.Node{
						logoMark(logoStyleCustom, a.customBrand, 32, "brand-custom-preview"),
						ui.Button{Text: apptext.T("选择图片"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "brand-image-choose",
							Disabled: a.brandBusy.Get, OnPress: a.pickBrandImage},
						core.Show{When: func() bool { return a.cfg.LogoCustomImage != "" }, Then: func(*core.Scope) core.Node {
							return ui.Button{Text: apptext.T("清除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "brand-image-clear", OnPress: a.clearBrandImage}
						}},
					}}),
				core.Show{When: func() bool { return a.cfg.LogoCustomImage == "" }, Then: func(*core.Scope) core.Node {
					return ui.Text(apptext.T("未选择图片时使用 TUI 彩色 Logo。"), 11, ui.Regular, colors.Muted)
				}},
			}}
		}),
		core.Show{When: a.brandBusy.Get, Then: func(*core.Scope) core.Node {
			return ui.Text(apptext.T("正在读取 Logo…"), 11, ui.Regular, colors.Muted)
		}},
		core.Show{When: func() bool { return a.brandError.Get() != "" }, Then: func(*core.Scope) core.Node {
			return core.Text{ContentFunc: a.brandError.Get, TestID: "brand-image-error", Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Danger)}
		}},
		setDivider(),
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(6, 2)}, Children: []core.Node{
			a.brandMark(28, "brand-preview"),
			core.Text{ContentFunc: func() string { _ = a.brandNameRev.Get(); return resolveBrandName(a.cfg.AppDisplayName) },
				MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 12, FontFamily: viewkit.MonoFont(), MinWidth: core.Pt(0), FlexShrink: 1, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Text)},
			ui.Button{Text: apptext.T("恢复默认品牌"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "brand-reset", OnPress: a.resetBrand},
		}},
	)
}
