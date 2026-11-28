//go:build !js && !android && !ios

package workbench

// pi's own settings, as controls in their own section: the few fields
// the app can show without losing what the file holds.

import (
	"strconv"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) settingsPi() core.Node {
	// Initialize text when the page opens; later redraws retain draft input.
	a.piRetryText.Set(modelNumber(a.piSet.RetryMax))
	a.piReserveText.Set(modelNumber(a.piSet.ReserveTokens))
	a.piKeepText.Set(modelNumber(a.piSet.KeepRecentTokens))
	return a.providerSettingsPage("settings-page", core.Dynamic(func(*core.Scope) core.Node { return a.piSettingsGroup() }),
		core.View{Style: core.Style{Direction: core.Row}, Children: []core.Node{
			ui.Button{Text: apptext.T("编辑 settings.json"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
				OnPress: func() { a.openPiConfigFile("settings.json") }},
		}})
}

// piSettingsGroup draws pi's settings rows.
func (a *app) piSettingsGroup() core.Node {
	_ = a.piSetRev.Get()
	colors := ui.ColorsOf(a.cx)
	number := func(value func() string, set func(string), onSubmit func(int), label, testID string) core.Node {
		return core.Func(func(cx *core.Scope) core.Node {
			invalid := core.NewSignal(cx, false)
			commit := func() {
				text := strings.TrimSpace(value())
				n, err := strconv.Atoi(text)
				if text == "" {
					n, err = 0, nil
				}
				if err != nil || n < 0 {
					invalid.Set(true)
					return
				}
				invalid.Set(false)
				onSubmit(n)
			}
			return core.View{Style: core.Style{Width: core.Pt(144), MaxWidth: core.Pct(100), Gap: 4}, Children: []core.Node{
				core.Input{Value: value, Label: apptext.T(label), TestID: testID, Placeholder: apptext.T("跟随 pi"),
					OnChange: func(text string) { set(text); invalid.Set(false) },
					OnSubmit: func(string) { commit() }, OnBlur: commit,
					Style: core.Style{Width: core.Pct(100), Height: core.Pt(28), Overflow: core.Hidden,
						Padding: core.Symmetric(0, 8), FontSize: 11, FontFamily: viewkit.MonoFont(),
						Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6}},
				core.Show{When: invalid.Get, Then: func(*core.Scope) core.Node {
					return core.Text{Content: apptext.T("请输入非负整数；留空或填 0 使用 pi 默认值。"), TestID: testID + "-error",
						Style: core.Style{FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Danger)}
				}},
			}}
		})
	}
	var thinking []choice[string]
	thinking = append(thinking, choice[string]{Value: "", Label: apptext.T("跟随 pi")})
	for _, lv := range []string{"off", "low", "medium", "high", "max"} {
		thinking = append(thinking, choice[string]{Value: lv, Label: levelLabel(lv)})
	}
	rows := []core.Node{
		setRow("隐藏思考块", "pi 自己的界面里不显示思考块；不影响本应用的时间线。",
			ui.Switch{Checked: func() bool { return a.piSet.HideThinking }, Label: apptext.T("隐藏思考块"), TestID: "pi-hide-thinking",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.HideThinking = on }) }}),
		setDivider(),
		setRow("安静启动", "pi 启动时不打印欢迎信息。",
			ui.Switch{Checked: func() bool { return a.piSet.QuietStartup }, Label: apptext.T("安静启动"), TestID: "pi-quiet-startup",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.QuietStartup = on }) }}),
		setDivider(),
		setRow("折叠更新日志", "pi 升级后的更新说明默认收起。",
			ui.Switch{Checked: func() bool { return a.piSet.CollapseChangelog }, Label: apptext.T("折叠更新日志"), TestID: "pi-collapse-changelog",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.CollapseChangelog = on }) }}),
		setDivider(),
		setRow("默认思考等级", "写入 pi 的全局默认值；新建 pi 会话时，「通用」中的思考等级可覆盖此值。",
			choiceChips(thinking, func() string { return a.piSet.DefaultThinking }, func(v string) {
				a.updatePiSettings(func(s *piSettings) { s.DefaultThinking = v })
			})),
		setDivider(),
		setRow("自动重试", "pi 在可重试的供应商错误发生后自动重试。",
			ui.Switch{Checked: func() bool { return a.piSet.RetryEnabled }, Label: apptext.T("自动重试"), TestID: "pi-retry-enabled",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.RetryEnabled = on }) }}),
		setDivider(),
		setRow("重试次数", "留空或填 0 使用 pi 默认值；正整数设置最大重试次数。",
			number(a.piRetryText.Get, a.piRetryText.Set, func(n int) {
				a.updatePiSettings(func(s *piSettings) { s.RetryMax = n })
			}, "重试次数", "pi-retry-max")),
		setDivider(),
		setRow("自动压缩", "上下文将满时，pi 会总结较早的历史以腾出空间。",
			ui.Switch{Checked: func() bool { return a.piSet.CompactionEnabled }, Label: apptext.T("自动压缩"), TestID: "pi-compaction-enabled",
				OnChange: func(on bool) { a.updatePiSettings(func(s *piSettings) { s.CompactionEnabled = on }) }}),
		setDivider(),
		setRow("预留 Token", "Token 是模型计量文本长度的单位；此值为后续消息预留上下文空间。留空或填 0 使用 pi 默认值。",
			number(a.piReserveText.Get, a.piReserveText.Set, func(n int) {
				a.updatePiSettings(func(s *piSettings) { s.ReserveTokens = n })
			}, "预留 Token", "pi-reserve-tokens")),
		setDivider(),
		setRow("保留最近 Token", "压缩时保留的近期历史长度，以 Token 计；留空或填 0 使用 pi 默认值。",
			number(a.piKeepText.Get, a.piKeepText.Set, func(n int) {
				a.updatePiSettings(func(s *piSettings) { s.KeepRecentTokens = n })
			}, "保留最近 Token", "pi-keep-tokens")),
	}
	if a.piSetErr != "" {
		rows = append(rows, core.Text{Content: a.piSetErr, Style: core.Style{FontSize: 10.5, LineHeight: 16},
			StyleFunc: ui.Colored(colors.Danger)})
	}
	if !a.piSet.Loaded {
		rows = append(rows, core.Text{Content: apptext.T("还没有 settings.json；改动会新建一个。"),
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
	}
	return core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
		core.Text{Content: apptext.T("这些设置写入本机 pi 的 settings.json，供之后启动的 pi 进程使用；不会立即修改当前会话，也不影响 ACP。"), TestID: "pi-settings-scope",
			Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
		setGroup("pi 设置", rows...),
	}}
}
