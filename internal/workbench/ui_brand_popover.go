//go:build !js && !android && !ios

package workbench

import (
	"runtime"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/updater"
)

// brandInfo keeps destinations separate from diagnostic details. The disclosure
// belongs to the mounted panel, so an environment refresh does not close it.
func (a *app) brandInfo(cx *core.Scope) core.Node {
	_ = a.langRev.Get()
	colors := ui.ColorsOf(cx)
	detailsOpen := core.NewSignal(cx, false)
	buttonStyle := func() core.Style {
		return core.Style{
			Hover:        &core.Style{Background: colors.Hover()},
			Active:       &core.Style{Background: colors.Pressed()},
			FocusVisible: ui.FocusRing(cx, -2),
		}
	}
	action := func(icon func() *core.SVG, label, id string, onPress func(), external bool) core.Node {
		arrow := lucide.ChevronRight
		if external {
			arrow = lucide.ExternalLink
		}
		return base.Button{Label: apptext.T(label), TestID: id,
			OnPress: func(core.PressEvent) { a.brandOpen.Set(false); onPress() },
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12,
				MinHeight: core.Pt(36), Padding: core.Symmetric(8, 8), CornerRadius: 8, MinWidth: core.Pt(0)},
			StyleFunc: buttonStyle, Children: []core.Node{
				ui.Icon(icon, 16, colors.Muted),
				core.Text{Content: apptext.T(label),
					Style:     core.Style{FontSize: 13, LineHeight: 20, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
					StyleFunc: ui.Colored(colors.Text)},
				ui.Icon(arrow, 14, colors.Muted),
			}}
	}
	group := func(label, id string, rows ...core.Node) core.Node {
		return core.View{TestID: id, Style: core.Style{Gap: 4}, Children: []core.Node{
			core.Text{Content: apptext.T(label),
				Style:     core.Style{FontSize: 12, LineHeight: 16, FontWeight: ui.Medium, Padding: core.Symmetric(0, 8)},
				StyleFunc: ui.Colored(colors.Muted)},
			core.View{Children: rows},
		}}
	}
	return core.View{TestID: "brand-info", Style: core.Style{Padding: core.All(8), Gap: 8, MinWidth: core.Pt(0)}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12,
			Padding: core.All(8), MinWidth: core.Pt(0)}, Children: []core.Node{
			a.brandMark(40, "brand-info-logo"),
			core.View{Style: core.Style{Gap: 8, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				core.Text{ContentFunc: func() string {
					_ = a.brandNameRev.Get()
					return resolveBrandName(a.cfg.AppDisplayName)
				}, TestID: "brand-info-name", MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 18, LineHeight: 24, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
					core.View{Style: core.Style{Padding: core.Symmetric(2, 8), CornerRadius: 6, FlexShrink: 0},
						StyleFunc: func() core.Style { return core.Style{Background: colors.Hover()} }, Children: []core.Node{
							core.Text{Content: "v" + brandVersion(), TestID: "brand-app-version",
								Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Text)},
						}},
					core.Dynamic(func(*core.Scope) core.Node {
						label, tone := a.piStatus(colors)
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4,
							MinWidth: core.Pt(0), FlexShrink: 1}, Children: []core.Node{
							core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, FlexShrink: 0, Background: tone}},
							core.Text{Content: label, TestID: "brand-pi-status", MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: 11.5, LineHeight: 16, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Muted)},
						}}
					}),
				}},
			}},
		}},
		setDivider(),
		group("应用", "brand-app-actions",
			action(lucide.RefreshCw, "检查更新", "brand-check-updates", func() { updater.Check(a.cx) }, false),
			action(lucide.Tag, "发布记录", "brand-releases", func() { a.cx.OpenURL(appRepoURL+"/releases", nil) }, true),
			action(lucide.Palette, "自定义品牌", "brand-customize", a.openBrandSettings, false)),
		group("项目", "brand-project-actions",
			action(lucide.FolderGit2, "项目主页", "brand-project", func() { a.cx.OpenURL(appRepoURL, nil) }, true),
			action(lucide.Globe, "pi 项目", "brand-pi-project", func() { a.cx.OpenURL("https://github.com/badlogic/pi-mono", nil) }, true)),
		setDivider(),
		base.Button{Label: apptext.T("运行环境"), TestID: "brand-runtime-toggle", Expanded: detailsOpen.Get,
			OnPress: func(core.PressEvent) { detailsOpen.Set(!detailsOpen.Get()) },
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12,
				MinHeight: core.Pt(36), Padding: core.All(8), CornerRadius: 8}, StyleFunc: buttonStyle,
			Children: []core.Node{
				ui.Icon(lucide.Terminal, 16, colors.Muted),
				core.Text{Content: apptext.T("运行环境"), Style: core.Style{FontSize: 13, LineHeight: 20, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Text)},
				ui.IconOf(func() *core.SVG {
					if detailsOpen.Get() {
						return lucide.ChevronDown()
					}
					return lucide.ChevronRight()
				}, 14, colors.Muted),
			}},
		core.Show{When: detailsOpen.Get, Then: func(*core.Scope) core.Node {
			return core.Dynamic(func(*core.Scope) core.Node {
				info, build := a.env.Get(), readBrandBuild()
				row := func(label, value, id string) core.Node {
					return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 12,
						MinHeight: core.Pt(24)}, Children: []core.Node{
						core.Text{Content: apptext.T(label), Style: core.Style{FontSize: 12, LineHeight: 20, MinWidth: core.Pt(64)}, StyleFunc: ui.Colored(colors.Muted)},
						core.Text{Content: value, TestID: id,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11.5, LineHeight: 20,
								FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), TextAlign: core.TextAlignRight}, StyleFunc: ui.Colored(colors.Text)},
					}}
				}
				piVersion := info.PiVersion
				if piVersion == "" {
					piVersion = piVersionLine(info)
				}
				rows := []core.Node{
					row("Pi CLI", piVersion, "brand-pi-version"),
					row("Go", runtime.Version(), "brand-go-version"),
					row("操作系统", runtime.GOOS+" / "+runtime.GOARCH, "brand-platform"),
				}
				if build.Revision != "" {
					rows = append(rows, row("构建提交", build.Revision, "brand-revision"))
				}
				if build.Time != "" {
					value := build.Time
					if at, err := time.Parse(time.RFC3339, value); err == nil {
						value = at.Local().Format("2006-01-02 15:04")
					}
					rows = append(rows, row("提交时间", value, "brand-build-time"))
				}
				return core.View{TestID: "brand-runtime-details", Style: core.Style{Gap: 4, Padding: core.Symmetric(4, 8), MinWidth: core.Pt(0)}, Children: rows}
			})
		}},
		action(lucide.Info, "更多应用信息", "brand-about", func() { a.openSettingsSection("about"); a.openSettingsPane() }, false),
	}}
}
