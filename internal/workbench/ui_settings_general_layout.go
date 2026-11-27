//go:build !js && !android && !ios

package workbench

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// updateGeneralSettings publishes the value before saving off the UI thread.
func (a *app) updateGeneralSettings(change func(*config)) {
	change(&a.cfg)
	if a.st != nil {
		a.st.change(change)
		a.saveConfigAsync()
	}
	a.bumpSettings()
}

// tabWidthLabel describes the existing fine-grained range without exposing
// the implementation's percentage of the entire window.
func tabWidthLabel(pct int) string {
	switch {
	case pct <= 12:
		return apptext.T("紧凑")
	case pct <= 18:
		return apptext.T("较窄")
	case pct <= 24:
		return apptext.T("标准")
	case pct < tabWidthPctMax:
		return apptext.T("较宽")
	default:
		return apptext.T("宽松")
	}
}

func (a *app) generalLayoutSettings() core.Node {
	return setGroup("语言与布局",
		setRow("语言", "界面文案；切换后立即生效，未翻译的条目保留中文。",
			ui.Select[string]{Options: languageOptions(), Value: func() string { return a.cfg.Language }, OnChange: a.setLanguage,
				Label: apptext.T("语言"), TestID: "language-select", Style: settingsSelectStyle()}),
		setDivider(),
		setRow("内容宽度", "对话正文与输入框共用宽度。50% 最窄，100% 铺满聊天区。",
			settingsSlider(ui.Slider{Min: chatWidthPctMin, Max: chatWidthPctMax, Step: 2,
				Value: func() float64 { return float64(a.chatWidthPct()) }, Label: apptext.T("对话内容宽度"), TestID: "chat-width",
				ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) },
				OnChange:  func(v float64) { a.setChatWidthPct(int(v)) }},
				func() string { return fmt.Sprintf("%d%%", a.chatWidthPct()) }, "50%", "100%")),
		setDivider(),
		setRow("标签页宽度", "调整单个会话标签的最大宽度。紧凑可容纳更多标签，宽松可显示更长标题。",
			settingsSlider(ui.Slider{Min: tabWidthPctMin, Max: tabWidthPctMax, Step: 1,
				Value: func() float64 { return float64(a.tabWidthPct()) }, Label: apptext.T("标签页宽度"), TestID: "tab-width",
				ValueText: func(v float64) string { return tabWidthLabel(int(v)) },
				OnChange:  func(v float64) { a.setTabWidthPct(int(v)) }},
				func() string { return tabWidthLabel(a.tabWidthPct()) }, "紧凑", "宽松")),
		setDivider(),
		setRow("恢复布局默认值", "内容宽度恢复为 80%，标签页宽度恢复为标准。",
			ui.Button{Text: apptext.T("恢复默认"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "general-layout-reset",
				OnPress: func() { a.setChatWidthPct(chatWidthPctDefault); a.setTabWidthPct(tabWidthPctDefault) }}),
	)
}

func (a *app) generalSessionSettings() core.Node {
	options := []ui.Option[string]{{Value: "", Label: apptext.T("使用 pi 默认值")}}
	for _, level := range []string{"off", "low", "medium", "high", "max"} {
		options = append(options, ui.Option[string]{Value: level, Label: levelLabel(level)})
	}
	return setGroup("新会话默认值",
		setRow("新会话默认模型", "仅用于之后创建的本地 pi 会话；现有会话和 ACP Agent 不受影响。", a.defaultModelSettings()),
		setDivider(),
		setRow("新会话默认思考等级", "新建本地 pi 会话的推理投入；可用等级由模型决定。",
			ui.Select[string]{Options: options, Value: func() string { return a.defaultThinking },
				Label: apptext.T("新会话默认思考等级"), TestID: "default-thinking", Style: settingsSelectStyle(),
				OnChange: func(level string) {
					a.defaultThinking = level
					a.updateGeneralSettings(func(c *config) { c.Thinking = level })
				}}),
	)
}

func (a *app) generalSidebarSettings() core.Node {
	return setGroup("侧栏与会话列表",
		setRow("项目排序", "置顶项目始终在最前；手动顺序可在项目菜单中用“上移项目”“下移项目”调整。",
			ui.Select[string]{Options: []ui.Option[string]{
				{Value: "recent", Label: apptext.T("最近活动")}, {Value: "created", Label: apptext.T("创建时间")},
				{Value: "title", Label: apptext.T("名称")}, {Value: "manual", Label: apptext.T("手动")},
			}, Value: a.projectSortMode, OnChange: a.setProjectSort,
				Label: apptext.T("项目排序"), TestID: "general-project-sort", Style: settingsSelectStyle()}),
		setDivider(),
		setRow("会话排序", "项目内的会话按最近活动或名称排列；置顶会话始终在最前。",
			ui.Select[string]{Options: []ui.Option[string]{
				{Value: "updated", Label: apptext.T("最近活动")}, {Value: "name", Label: apptext.T("名称")},
			}, Value: a.sessionSortMode, OnChange: a.setSessionSort,
				Label: apptext.T("会话排序"), TestID: "general-session-sort", Style: settingsSelectStyle()}),
		setDivider(),
		setRow("列出 pi 本地会话", "在侧栏列出终端 pi 的历史会话，可点击继续；不会移动原始文件。",
			ui.Switch{Checked: func() bool { return a.cfg.ScanPi }, Label: apptext.T("列出 pi 本地会话"), TestID: "scan-pi",
				OnChange: func(on bool) {
					a.updateGeneralSettings(func(c *config) { c.ScanPi = on })
					a.reloadFrameworks()
				}}),
		setDivider(),
		setRow("扫描所有项目", "需先开启上项。包含尚未添加的项目文件夹；关闭后只扫描已添加的项目。",
			ui.Switch{Checked: func() bool { return a.cfg.ScanAll }, Label: apptext.T("扫描所有项目"), TestID: "scan-all",
				Disabled: func() bool { return !a.cfg.ScanPi },
				OnChange: func(on bool) {
					a.updateGeneralSettings(func(c *config) { c.ScanAll = on })
					a.reloadFrameworks()
				}}),
	)
}
