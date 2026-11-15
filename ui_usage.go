package main

// The usage page: totals, a 12-week heatmap, and the models and projects
// that used the most tokens.

import (
	"fmt"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsUsage shows the local statistics.
func (a *app) settingsUsage() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		if a.usageLoading.Get() && !a.usageLoaded {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
				Children: []core.Node{ui.Spinner{Size: 16}, ui.Text("正在统计本地会话…", 11.5, ui.Regular, colors.Muted)}}
		}
		r := a.usage.Get()
		if r.Replies == 0 {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 10},
				Children: []core.Node{
					ui.Icon(lucide.ChartColumn, 22, colors.Faint),
					ui.Text("还没有可统计的用量", 12.5, ui.Regular, colors.Muted),
					core.Text{Content: "发几轮消息后再来看；统计只读本地会话文件。",
						Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
					ui.Button{Text: T("重新统计"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.loadUsage(true) }},
				}}
		}
		max := usageMaxDay(r.Days)
		var columns []core.Node
		for _, week := range usageWeekRows(r.Days) {
			var cells []core.Node
			for _, d := range week {
				day := d
				cells = append(cells, core.View{
					Tooltip: core.Text{Content: dayTooltip(day), Style: core.Style{FontSize: 10}},
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(11), Height: core.Pt(11), CornerRadius: 2.5,
							Background: heatColor(colors, heatLevel(day.Total, max))}
					},
				})
			}
			columns = append(columns, core.View{Style: core.Style{Direction: core.Column, Gap: 3}, Children: cells})
		}
		heat := core.View{Style: core.Style{Direction: core.Row, Gap: 3, AlignItems: core.AlignStart}, Children: columns}
		modelMax, projectMax := 0, 0
		for _, b := range r.Models {
			if b.Total > modelMax {
				modelMax = b.Total
			}
		}
		for _, b := range r.Projects {
			if b.Total > projectMax {
				projectMax = b.Total
			}
		}
		var modelRows []core.Node
		for _, b := range r.Models {
			bucket := b
			modelRows = append(modelRows, usageBarRow(colors, bucket.Name, bucket.Sub, bucket.Total, modelMax,
				tokens(bucket.Total)+" tokens", credits(bucket.Cost)))
		}
		var projectRows []core.Node
		for _, b := range r.Projects {
			bucket := b
			projectRows = append(projectRows, usageBarRow(colors, bucket.Name, bucket.Sub, bucket.Total, projectMax,
				tokens(bucket.Total)+" tokens", credits(bucket.Cost)))
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("累计",
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8, Padding: core.Symmetric(4, 2)}, Children: []core.Node{
						statCard(colors, "会话", fmt.Sprint(r.Sessions), ""),
						statCard(colors, "回复", fmt.Sprint(r.Replies), ""),
						statCard(colors, "tokens", tokens(r.Total.Total),
							fmt.Sprintf("输入 %s · 输出 %s", tokens(r.Total.Input), tokens(r.Total.Output))),
						statCard(colors, "费用", credits(r.Total.Cost), ""),
					}}),
				core.Show{When: func() bool { return r.Estimated > 0 }, Then: func(*core.Scope) core.Node {
					return core.Text{Content: T("其中 %d 条为 ACP 估算（按文本长度）", r.Estimated),
						Style: core.Style{FontSize: 10.5, Padding: core.Edges{Left: 4}}, StyleFunc: ui.Colored(colors.Faint)}
				}},
				setGroup("最近 12 周",
					core.View{Style: core.Style{Padding: core.Symmetric(6, 2), Gap: 6}, Children: []core.Node{
						heat,
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
							ui.Text("少", 9.5, ui.Regular, colors.Faint),
							heatKey(colors, 1), heatKey(colors, 2), heatKey(colors, 3), heatKey(colors, 4),
							ui.Text("多", 9.5, ui.Regular, colors.Faint),
						}},
					}}),
				setGroup("模型", append(modelRows, usageNote(colors,
					fmt.Sprintf("按 token 排序，前 %d 个。", len(r.Models))))...),
				setGroup("项目", append(projectRows, usageNote(colors, "按会话工作目录归并。"))...),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Button{Text: T("重新统计"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.loadUsage(true) }},
					ui.Button{Text: T("导出 CSV"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "usage-export",
						OnPress: a.exportUsageCSV},
					core.Text{Content: fmt.Sprintf("读了 %d 个会话文件 · 只在本机计算", r.Files), Style: core.Style{FontSize: 10.5},
						StyleFunc: ui.Colored(colors.Faint)},
				}},
			}},
		}}
	})
}

// heatColor is a heatmap square's color at a level.
func heatColor(colors ui.Colors, level int) core.Color {
	switch level {
	case 1:
		return ui.Alpha(colors.Accent(), 0.18)
	case 2:
		return ui.Alpha(colors.Accent(), 0.38)
	case 3:
		return ui.Alpha(colors.Accent(), 0.62)
	case 4:
		return ui.Alpha(colors.Accent(), 0.90)
	}
	return ui.Alpha(colors.Text(), 0.05)
}

// statCard is one number with its label.
func statCard(colors ui.Colors, label, value, sub string) core.Node {
	return core.View{StyleFunc: func() core.Style {
		return core.Style{MinWidth: core.Pt(112), Padding: core.Symmetric(8, 10), CornerRadius: 8, Gap: 2,
			BorderWidth: 1, BorderColor: colors.Line(), Background: colors.Background()}
	}, Children: []core.Node{
		ui.Text(label, 9.5, ui.Regular, colors.Faint),
		core.Text{Content: value, Style: core.Style{FontSize: 18, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
		core.Show{When: func() bool { return sub != "" }, Then: func(*core.Scope) core.Node {
			return core.Text{Content: sub, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
		}},
	}}
}

// heatKey is one square of the heatmap's legend.
func heatKey(colors ui.Colors, level int) core.Node {
	return core.View{Style: core.Style{Width: core.Pt(9), Height: core.Pt(9), CornerRadius: 2,
		Background: heatColor(colors, level)}}
}

// usageBarRow is a model or project line with its share.
func usageBarRow(colors ui.Colors, name, sub string, total, max int, right, cost string) core.Node {
	pct := float32(0)
	if max > 0 {
		pct = float32(total) / float32(max) * 100
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(34),
		Padding: core.Symmetric(2, 2)}, Children: []core.Node{
		core.View{Style: core.Style{Width: core.Pt(190), FlexShrink: 0, Gap: 1}, Children: []core.Node{
			core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
			core.Show{When: func() bool { return sub != "" && sub != name }, Then: func(*core.Scope) core.Node {
				return core.Text{Content: shortPath(sub, 46), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontFamily: ui.Mono, FontSize: 9}, StyleFunc: ui.Colored(colors.Faint)}
			}},
		}},
		core.View{Style: core.Style{FlexGrow: 1, Height: core.Pt(5), CornerRadius: 2.5, Background: colors.Track()}, Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Width: core.Pct(pct), Height: core.Pt(5), CornerRadius: 2.5,
					Background: ui.Alpha(colors.Accent(), 0.75)}
			}},
		}},
		core.Text{Content: right, Style: core.Style{Width: core.Pt(74), FontSize: 10, FontFamily: ui.Mono},
			StyleFunc: ui.Colored(colors.Muted)},
		core.Text{Content: cost, Style: core.Style{Width: core.Pt(52), FontSize: 10, FontFamily: ui.Mono},
			StyleFunc: ui.Colored(colors.Faint)},
	}}
}

// usageNote is the quiet line under a list.
func usageNote(colors ui.Colors, text string) core.Node {
	return core.Text{Content: text, Style: core.Style{FontSize: 10, Padding: core.Edges{Left: 2, Top: 4}},
		StyleFunc: ui.Colored(colors.Faint)}
}

// dayTooltip says what a heatmap square holds.
func dayTooltip(d usageDay) string {
	if d.Date == "" {
		return ""
	}
	if d.Replies == 0 {
		return d.Date + " · 没有用量"
	}
	return fmt.Sprintf("%s · %s tokens · %s · %d 条回复", d.Date, tokens(d.Total), credits(d.Cost), d.Replies)
}
