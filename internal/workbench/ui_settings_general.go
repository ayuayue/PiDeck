//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/alerts"
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsGeneral says what a new session starts with.
func (a *app) settingsGeneral() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		var modelChips []core.Node
		addChip := func(label string, on func() bool, fn func()) core.Node {
			return core.View{
				OnPress: func(core.PressEvent) { fn() },
				Role:    core.RoleRadio, Label: label,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), Padding: core.Symmetric(0, 9),
						CornerRadius: 13, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(label, 11.5, ui.Regular, colors.Text)},
			}
		}
		modelChips = append(modelChips, addChip(apptext.T("跟随 pi 当前模型"), func() bool { return a.defaultModel.ID == "" }, func() {
			a.defaultModel = modelChoice{}
			a.st.edit(func(c *config) { c.Model = modelChoice{} })
		}))
		for _, key := range a.favModels.Get() {
			provider, id, _ := strings.Cut(key, "/")
			label := id
			key := key
			modelChips = append(modelChips, addChip(label, func() bool { return a.defaultModel.Provider == provider && a.defaultModel.ID == id },
				func() {
					a.defaultModel = modelChoice{Provider: provider, ID: id}
					a.st.edit(func(c *config) { c.Model = a.defaultModel })
					_ = key
				}))
		}
		var levelChips []core.Node
		levelChips = append(levelChips, addChip(apptext.T("跟随会话"), func() bool { return a.defaultThinking == "" }, func() {
			a.defaultThinking = ""
			a.st.edit(func(c *config) { c.Thinking = "" })
		}))
		for _, lv := range []string{"off", "low", "medium", "high", "max"} {
			lv := lv
			levelChips = append(levelChips, addChip(levelLabel(lv), func() bool { return a.defaultThinking == lv }, func() {
				a.defaultThinking = lv
				a.st.edit(func(c *config) { c.Thinking = lv })
			}))
		}
		return a.scrollStashFor("settings:general").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: scrollbarGutter}}, Children: []core.Node{
				setGroup("界面",
					setRow("语言", "界面文案；切换后立即生效，未翻译的条目保留中文。",
						ui.Select[string]{Options: languageOptions(), Value: func() string { return a.cfg.Language }, OnChange: a.setLanguage,
							Label: apptext.T("语言"), TestID: "language-select",
							Style: core.Style{Width: core.Pt(220), Height: core.Pt(28), FontSize: 11}}),
					setDivider(),
					setRow("内容宽度", "对话正文与输入框占聊天区宽度的比例；窄一些更好读，100% 铺满。",
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(230)}, Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								ui.Slider{Min: chatWidthPctMin, Max: chatWidthPctMax, Step: 2,
									Value:     func() float64 { return float64(a.chatWidthPct()) },
									Label:     apptext.T("对话内容宽度"),
									ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) },
									TestID:    "chat-width",
									OnChange: func(v float64) {
										a.setChatWidthPct(int(v))
									}},
							}},
							core.Text{ContentFunc: func() string { return fmt.Sprintf("%.0f%%", float64(a.chatWidthPct())) },
								Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, MinWidth: core.Pt(44), TextAlign: core.TextAlignRight},
								StyleFunc: ui.Colored(colors.Muted)},
						}}),
				),
				setRow("Tab 栏宽度", "单个会话标签页最多能宽到窗口的几分之几；标题长就调宽一些，窄了会截断。",
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(230)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
							ui.Slider{Min: tabWidthPctMin, Max: tabWidthPctMax, Step: 1,
								Value:     func() float64 { return float64(a.tabWidthPct()) },
								Label:     apptext.T("标签页宽度"),
								ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) },
								TestID:    "tab-width",
								OnChange: func(v float64) {
									a.setTabWidthPct(int(v))
								}},
						}},
						core.Text{ContentFunc: func() string { return fmt.Sprintf("%.0f%%", float64(a.tabWidthPct())) },
							Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, MinWidth: core.Pt(44), TextAlign: core.TextAlignRight},
							StyleFunc: ui.Colored(colors.Muted)},
					}}),
				setRow("快捷短语与回复规则", "管理常用短语，以及最新回复结束后按条件显示的发送按钮。",
					ui.Button{Text: apptext.T("编辑"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, TestID: "settings-reply-shortcuts", OnPress: a.openReplyShortcutSettings}),
				setGroup("新会话默认模型", core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Symmetric(4, 2)},
					Children: modelChips}),
				setGroup("新会话默认思考等级", core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Symmetric(4, 2)},
					Children: levelChips}),
				setGroup("项目",
					setRow("项目排序", "侧栏项目按手动顺序、最近活动、创建时间或名称排列；置顶项目总在最前。",
						choiceChips([]choice[string]{
							{"recent", "最近活动"}, {"created", "创建时间"}, {"title", "名称"}, {"manual", "手动"},
						}, a.projectSortMode, a.setProjectSort)),
				),
				setGroup("会话列表",
					setRow("排序", "项目里的会话按最近活动或名称排列；置顶的总在最前。",
						choiceChips([]choice[string]{
							{"updated", "最近活动"}, {"name", "名称"},
						}, a.sessionSortMode, a.setSessionSort)),
				),
				setGroup("侧栏",
					setRow("列出 pi 本地会话", "在项目下显示终端里 pi 用过的会话，点开即继续。",
						ui.Switch{Checked: func() bool { return a.cfg.ScanPi }, Label: apptext.T("列出 pi 本地会话"), OnChange: func(on bool) {
							a.cfg.ScanPi = on
							a.st.edit(func(c *config) { c.ScanPi = on })
							a.reloadFrameworks()

							a.bumpSettings()
						}}),
					setDivider(),
					setRow("扫描所有项目", "连没有添加为项目的文件夹也读，会话多时会更慢。",
						ui.Switch{Checked: func() bool { return a.cfg.ScanAll }, Label: apptext.T("扫描所有项目"), OnChange: func(on bool) {
							a.cfg.ScanAll = on
							a.st.edit(func(c *config) { c.ScanAll = on })
							a.reloadFrameworks()

							a.bumpSettings()
						}}),
				),
				setGroup("桌面",
					setRow("关闭窗口时留在托盘", "关掉窗口不退出应用，Agent 继续跑；从托盘图标恢复窗口。",
						ui.Switch{Checked: func() bool { return a.cfg.CloseToTray }, Label: apptext.T("关闭窗口时留在托盘"), TestID: "close-to-tray",
							OnChange: func(on bool) {
								a.cfg.CloseToTray = on
								a.st.edit(func(c *config) { c.CloseToTray = on })

								a.bumpSettings()
							}}),
					setDivider(),
					setRow("一轮完成时通知", "用系统通知告诉你回答好了；运行中的会话也会显示在托盘菜单里。",
						ui.Switch{Checked: func() bool { return a.cfg.NotifyOnDone }, Label: apptext.T("一轮完成时通知"), TestID: "notify-done",
							OnChange: func(on bool) {
								a.cfg.NotifyOnDone = on
								a.st.edit(func(c *config) { c.NotifyOnDone = on })

								a.bumpSettings()
							}}),
					setDivider(),
					setRow("只在窗口隐藏时通知", "窗口在前台时不再弹系统通知。",
						ui.Switch{Checked: func() bool { return a.cfg.NotifyOnlyHidden }, Label: apptext.T("只在窗口隐藏时通知"), TestID: "notify-hidden",
							OnChange: func(on bool) {
								a.cfg.NotifyOnlyHidden = on
								a.st.edit(func(c *config) { c.NotifyOnlyHidden = on })

								a.bumpSettings()
							}}),
					setDivider(),
					setRow("测试通知", "发一条系统通知，确认这台机器收得到。",
						ui.Button{Text: apptext.T("发一条"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
							a.notifyDesktop("pideck:test", apptext.T("测试通知"), "通知已开启，一轮完成时会这样提醒。", func(shown bool) {
								if !shown {
									a.toast(ui.ToastInfo, "系统没有接收通知", "请检查系统的通知权限，或安装后再试。")
								}
							})
						}}),
					setRow("通知历史", "查看最近提醒过的会话。", ui.Button{Text: apptext.T("查看"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID: "show-notification-history", OnPress: func() { a.openPane(paneNotifications) }}),
				),
				setGroup("提示音",
					setRow("提示音", "一轮结束、出错或等待你确认时，用一段短声音提醒。",
						ui.Switch{Checked: func() bool { return a.cfg.SoundEnabled }, Label: apptext.T("提示音"), TestID: "sound-enabled",
							OnChange: func(on bool) {
								a.cfg.SoundEnabled = on
								a.st.edit(func(c *config) { c.SoundEnabled = on })

								a.bumpSettings()
							}}),
					setDivider(),
					setRow("只在窗口隐藏时出声", "窗口在屏幕上时不响，免得正看着还被提醒。",
						ui.Switch{Checked: func() bool { return a.cfg.SoundOnlyHidden }, Label: apptext.T("只在窗口隐藏时出声"), TestID: "sound-hidden",
							OnChange: func(on bool) {
								a.cfg.SoundOnlyHidden = on
								a.st.edit(func(c *config) { c.SoundOnlyHidden = on })

								a.bumpSettings()
							}}),
					setDivider(),
					setRow("完成时", "一轮回答完成时播放的声音。",
						core.View{Style: core.Style{Width: core.Pt(300), MaxWidth: core.Pct(100)}, Children: []core.Node{
							choiceChips(a.alertSoundChoices(), func() string { return a.alertChoice(alerts.KindDone) },
								func(v string) { a.setAlertKind(alerts.KindDone, v) }),
						}}),
					setDivider(),
					setRow("出错时", "一轮以失败结束时播放的声音。",
						core.View{Style: core.Style{Width: core.Pt(300), MaxWidth: core.Pct(100)}, Children: []core.Node{
							choiceChips(a.alertSoundChoices(), func() string { return a.alertChoice(alerts.KindError) },
								func(v string) { a.setAlertKind(alerts.KindError, v) }),
						}}),
					setDivider(),
					setRow("等待确认时", "Agent 停下来等你允许或回答时播放的声音。",
						core.View{Style: core.Style{Width: core.Pt(300), MaxWidth: core.Pct(100)}, Children: []core.Node{
							choiceChips(a.alertSoundChoices(), func() string { return a.alertChoice(alerts.KindWaiting) },
								func(v string) { a.setAlertKind(alerts.KindWaiting, v) }),
						}}),
					setDivider(),
					setRow("音量", "提示音的音量，0 为静音。",
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(230)}, Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								ui.Slider{Min: 0, Max: 100, Step: 1,
									Value:     func() float64 { return float64(a.alertVolumePct()) },
									Label:     apptext.T("提示音音量"),
									ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) },
									TestID:    "sound-volume",
									// The row's label reads the volume signal, so a drag moves the
									// thumb without the page rebuilding under it.
									OnChange: func(v float64) { a.setAlertVolume(int(v)) }},
							}},
							core.Dynamic(func(*core.Scope) core.Node {
								return core.Text{ContentFunc: func() string { return fmt.Sprintf("%d%%", a.alertVolumePct()) },
									Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, MinWidth: core.Pt(44), TextAlign: core.TextAlignRight},
									StyleFunc: ui.Colored(colors.Muted)}
							}),
						}}),
					setDivider(),
					setRow("自定义提示音", "导入一个 wav、mp3、m4a 或 aac 文件（不超过 2 MB），再在上面三行里选“自定义”。",
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
							core.Show{When: func() bool { return a.cfg.SoundCustom != "" }, Then: func(*core.Scope) core.Node {
								return core.Text{ContentFunc: func() string { return a.cfg.SoundCustom },
									MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
									Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11, MaxWidth: core.Pt(150)},
									StyleFunc: ui.Colored(colors.Faint)}
							}},
							ui.Button{Text: apptext.T("导入…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
								TestID: "sound-import", OnPress: a.pickAlertSound},
							core.Show{When: func() bool { return a.cfg.SoundCustom != "" }, Then: func(*core.Scope) core.Node {
								return ui.Button{Text: apptext.T("移除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
									TestID: "sound-clear", OnPress: a.clearAlertSound}
							}},
						}}),
					setDivider(),
					setRow("试听", "按现在的设置播放一次完成音。",
						ui.Button{Text: apptext.T("试听"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "sound-preview",
							OnPress: func() { a.soundAlert(alerts.KindDone) }}),
				),
				setGroup("隐私",
					setRow("匿名使用统计", "启动时每天最多发一次心跳，带上版本、平台、功能开关与数量统计；不含项目路径、会话内容、文件名或凭据。",
						ui.Switch{Checked: func() bool { return telemetryEnabled(a.cfg) }, Label: apptext.T("匿名使用统计"), TestID: "telemetry-enabled",
							OnChange: func(on bool) {
								value := on
								a.cfg.TelemetryEnabled = &value
								a.st.edit(func(c *config) { c.TelemetryEnabled = &value })

								a.bumpSettings()
							}}),
				),
				setGroup("安全",
					setRow("工具安全门", "标准会先确认危险命令并保护敏感文件；严格再把文件访问限制在工作目录内，写操作也要逐一确认。",
						ui.Select[string]{
							Options: []ui.Option[string]{
								{Value: "off", Label: apptext.T("安全门关闭")},
								{Value: "standard", Label: apptext.T("标准")},
								{Value: "strict", Label: apptext.T("严格")},
							},
							Value:    func() string { return a.securityLevelID() },
							OnChange: a.setSecurityLevel,
							Label:    apptext.T("工具安全门"),
							TestID:   "security-level",
							Style:    core.Style{Width: core.Pt(170), Height: core.Pt(28), FontSize: 11},
						}),
				),
			}},
		}})
	})
}
