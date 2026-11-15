package main

// pi's own settings, as controls in the models section: the few fields
// the app can show without losing what the file holds.

import (
	"strconv"
	"strings"

	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/ui"
)

// piSettingsGroup draws pi's settings rows.
func (a *app) piSettingsGroup() core.Node {
	_ = a.piSetRev.Get()
	colors := ui.ColorsOf(a.cx)
	number := func(value func() string, set func(string), onSubmit func(int), label, testID string) core.Node {
		return core.Input{Value: value, OnChange: set, Label: label, TestID: testID,
			OnSubmit: func(text string) {
				n, _ := strconv.Atoi(strings.TrimSpace(text))
				onSubmit(n)
			},
			Style: core.Style{Width: core.Pt(96), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
				FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
				BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6}}
	}
	var thinking []choice[string]
	thinking = append(thinking, choice[string]{Value: "", Label: T("跟随 pi")})
	for _, lv := range []string{"off", "low", "medium", "high", "max"} {
		thinking = append(thinking, choice[string]{Value: lv, Label: levelLabel(lv)})
	}
	rows := []core.Node{
		setRow("隐藏思考块", "pi 自己的界面里不显示思考块；不影响本应用的时间线。",
			ui.Switch{Checked: func() bool { return a.piSet.HideThinking }, Label: T("隐藏思考块"), TestID: "pi-hide-thinking",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.HideThinking = on }) }}),
		setDivider(),
		setRow("安静启动", "pi 启动时不打印欢迎信息。",
			ui.Switch{Checked: func() bool { return a.piSet.QuietStartup }, Label: T("安静启动"), TestID: "pi-quiet-startup",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.QuietStartup = on }) }}),
		setDivider(),
		setRow("折叠更新日志", "pi 升级后的更新说明默认收起。",
			ui.Switch{Checked: func() bool { return a.piSet.CollapseChangelog }, Label: T("折叠更新日志"), TestID: "pi-collapse-changelog",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.CollapseChangelog = on }) }}),
		setDivider(),
		setRow("默认思考档", "pi 自己的默认思考等级；本应用的会话另有自己的选择。",
			choiceChips(thinking, func() string { return a.piSet.DefaultThinking }, func(v string) {
				a.updatePiSettings(func(s *piSettings) { s.DefaultThinking = v })
			})),
		setDivider(),
		setRow("自动重试", "供应商失败时 pi 自动重试，次数在右侧。",
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Switch{Checked: func() bool { return a.piSet.RetryEnabled }, Label: T("自动重试"), TestID: "pi-retry-enabled",
					OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.RetryEnabled = on }) }},
				number(a.piRetryText.Get, a.piRetryText.Set, func(n int) {
					a.updatePiSettings(func(s *piSettings) { s.RetryMax = n })
				}, "重试次数", "pi-retry-max"),
			}}),
		setDivider(),
		setRow("自动压缩", "上下文快满时 pi 自动压缩历史；两个数字是预留与保留的 token 数。",
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Switch{Checked: func() bool { return a.piSet.CompactionEnabled }, Label: T("自动压缩"), TestID: "pi-compaction-enabled",
					OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.CompactionEnabled = on }) }},
				number(a.piReserveText.Get, a.piReserveText.Set, func(n int) {
					a.updatePiSettings(func(s *piSettings) { s.ReserveTokens = n })
				}, "预留 tokens", "pi-reserve-tokens"),
				number(a.piKeepText.Get, a.piKeepText.Set, func(n int) {
					a.updatePiSettings(func(s *piSettings) { s.KeepRecentTokens = n })
				}, "保留最近 tokens", "pi-keep-tokens"),
			}}),
	}
	if a.piSetErr != "" {
		rows = append(rows, core.Text{Content: a.piSetErr, MaxLines: 2, Style: core.Style{FontSize: 10.5},
			StyleFunc: ui.Colored(colors.Danger)})
	}
	if !a.piSet.Loaded {
		rows = append(rows, core.Text{Content: T("还没有 settings.json；改动会新建一个。"),
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
	}
	return setGroup("pi 设置", rows...)
}
