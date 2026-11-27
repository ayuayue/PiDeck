//go:build !js && !android && !ios

package workbench

import (
	"fmt"

	"example.com/pideck-v2/internal/alerts"
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) generalNotificationSettings() core.Node {
	return setGroup("桌面与通知",
		setRow("关闭窗口时留在托盘", "关闭窗口后继续运行；从系统托盘恢复窗口，退出应用请使用托盘菜单。",
			ui.Switch{Checked: func() bool { return a.cfg.CloseToTray }, Label: apptext.T("关闭窗口时留在托盘"), TestID: "close-to-tray",
				OnChange: func(on bool) { a.updateGeneralSettings(func(c *config) { c.CloseToTray = on }) }}),
		setDivider(),
		setRow("一轮完成时通知", "Agent 正常完成一轮回答时发送系统通知；取消或失败时不发送。",
			ui.Switch{Checked: func() bool { return a.cfg.NotifyOnDone }, Label: apptext.T("一轮完成时通知"), TestID: "notify-done",
				OnChange: func(on bool) { a.updateGeneralSettings(func(c *config) { c.NotifyOnDone = on }) }}),
		setDivider(),
		setRow("提问或等待确认时通知", "Agent 等待回答或权限确认时，显示应用内提醒和系统通知。",
			ui.Switch{Checked: func() bool { return a.cfg.NotifyOnWaiting }, Label: apptext.T("提问或等待确认时通知"), TestID: "notify-waiting",
				OnChange: func(on bool) { a.updateGeneralSettings(func(c *config) { c.NotifyOnWaiting = on }) }}),
		setDivider(),
		setRow("只在窗口隐藏时通知", "仅窗口最小化或隐藏到托盘时发送系统通知；被其他窗口遮挡仍视为可见。",
			ui.Switch{Checked: func() bool { return a.cfg.NotifyOnlyHidden }, Label: apptext.T("只在窗口隐藏时通知"), TestID: "notify-hidden",
				Disabled: func() bool { return !a.cfg.NotifyOnDone && !a.cfg.NotifyOnWaiting },
				OnChange: func(on bool) { a.updateGeneralSettings(func(c *config) { c.NotifyOnlyHidden = on }) }}),
		setDivider(),
		setRow("通知工具", "测试不受上方开关限制；通知能否显示还取决于系统权限和勿扰模式。",
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Button{Text: apptext.T("测试通知"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "notification-test", OnPress: func() {
					a.notifyDesktop("pideck:test", apptext.T("测试通知"), apptext.T("这是一条测试通知。"), func(shown bool) {
						if !shown {
							a.toast(ui.ToastInfo, "系统没有接收通知", "请检查系统的通知权限，或安装后再试。")
						}
					})
				}},
				ui.Button{Text: apptext.T("通知历史"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "show-notification-history",
					OnPress: func() { a.openPane(paneNotifications) }},
			}}),
	)
}

func (a *app) generalSoundChoice(kind, id string) core.Node {
	options := make([]ui.Option[string], 0)
	for _, choice := range a.alertSoundChoices() {
		label := apptext.T(choice.Label)
		if choice.Value == "" {
			label = fmt.Sprintf("%s · %s", label, apptext.T(alertSoundLabel(alerts.Default(kind))))
		}
		options = append(options, ui.Option[string]{Value: choice.Value, Label: label})
	}
	previewID := "sound-preview-" + kind
	if kind == alerts.KindDone {
		previewID = "sound-preview"
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(230), MaxWidth: core.Pct(100)}, Children: []core.Node{
		ui.Select[string]{Options: options, Value: func() string { return a.alertChoice(kind) },
			OnChange: func(v string) { a.setAlertKind(kind, v) }, Label: apptext.T("提示音"), TestID: id,
			Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Width: core.Pt(160), Height: core.Pt(28), FontSize: 11.5}},
		ui.Button{Text: apptext.T("试听"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: previewID,
			Disabled: func() bool { return a.alertVolumePct() == 0 }, OnPress: func() { a.soundAlert(kind) }},
	}}
}

func (a *app) generalSoundSettings() core.Node {
	return setGroup("提示音",
		setRow("提示音", "完成、出错或等待确认时播放；音效与系统通知独立，可分别设置。",
			ui.Switch{Checked: func() bool { return a.cfg.SoundEnabled }, Label: apptext.T("提示音"), TestID: "sound-enabled",
				OnChange: func(on bool) { a.updateGeneralSettings(func(c *config) { c.SoundEnabled = on }) }}),
		setDivider(),
		setRow("只在窗口隐藏时出声", "仅窗口最小化或隐藏到托盘时播放；被其他窗口遮挡仍视为可见。",
			ui.Switch{Checked: func() bool { return a.cfg.SoundOnlyHidden }, Label: apptext.T("只在窗口隐藏时出声"), TestID: "sound-hidden",
				Disabled: func() bool { return !a.cfg.SoundEnabled },
				OnChange: func(on bool) { a.updateGeneralSettings(func(c *config) { c.SoundOnlyHidden = on }) }}),
		setDivider(),
		setRow("音量", "0% 为静音。试听使用当前音量，不受提示音开关和窗口状态限制。",
			settingsSlider(ui.Slider{Min: 0, Max: 100, Step: 1,
				Value: func() float64 { return float64(a.alertVolumePct()) }, Label: apptext.T("提示音音量"), TestID: "sound-volume",
				ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) },
				OnChange:  func(v float64) { a.setAlertVolume(int(v)) }},
				func() string { return fmt.Sprintf("%d%%", a.alertVolumePct()) }, "静音", "100%")),
		setDivider(),
		setRow("完成时", "一轮回答正常完成时播放。", a.generalSoundChoice(alerts.KindDone, "sound-done")),
		setDivider(),
		setRow("出错时", "一轮以失败结束时播放；主动取消不播放。", a.generalSoundChoice(alerts.KindError, "sound-error")),
		setDivider(),
		setRow("等待确认时", "Agent 等待你的回答或权限确认时播放。", a.generalSoundChoice(alerts.KindWaiting, "sound-waiting")),
		setDivider(),
		setRow("自定义提示音", "支持 WAV、MP3、M4A、AAC，最大 2 MB。导入后在上方音效中选择“自定义”。",
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 8, MaxWidth: core.Pt(230)}, Children: []core.Node{
				core.Show{When: func() bool { return a.cfg.SoundCustom != "" }, Then: func(cx *core.Scope) core.Node {
					return core.Text{ContentFunc: func() string { return a.cfg.SoundCustom }, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontSize: 11, MaxWidth: core.Pt(135)}, StyleFunc: ui.Colored(ui.ColorsOf(cx).Muted)}
				}},
				ui.Button{Text: apptext.T("导入…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "sound-import", OnPress: a.pickAlertSound},
				core.Show{When: func() bool { return a.cfg.SoundCustom != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("移除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "sound-clear", OnPress: a.clearAlertSound}
				}},
			}}),
	)
}
