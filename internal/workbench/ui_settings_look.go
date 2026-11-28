//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) settingsLook() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		return a.scrollStashFor("settingsLook:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: scrollbarGutter}, Gap: 4}, Children: []core.Node{
				a.lookThemeSettings(),
				a.lookTypographySettings(),
				a.lookFontSettings(cx, colors),
				setGroup("输入框指标",
					setRow("显示哪些指标", "选择输入框下方显示的信息；取消勾选只隐藏显示，不影响统计。", nil),
					a.composerMetricChips()),
				a.backgroundGroup(colors),
				a.brandingGroup(colors),
				a.lookThemeFiles(),
			}},
		}})
	})
}

// lookSizeOptions retains a valid custom value that does not match a preset.
func lookSizeOptions(current float64, options []ui.Option[float64], unit string) []ui.Option[float64] {
	for _, option := range options {
		if option.Value == current {
			return options
		}
	}
	return append(options, ui.Option[float64]{Value: current, Label: fmt.Sprintf("%g %s", current, unit)})
}

func (a *app) lookTypographySettings() core.Node {
	fontOptions := func(current float64, input bool) []ui.Option[float64] {
		options := []ui.Option[float64]{}
		if input {
			options = append(options, ui.Option[float64]{Value: 0, Label: fmt.Sprintf("%s · %g pt", apptext.T("跟随聊天"), float64(a.readingFont()))})
		}
		for _, v := range []struct {
			size float64
			name string
		}{{14, "紧凑"}, {viewkit.ChatFontDefault, "标准"}, {18, "大"}, {20, "特大"}} {
			options = append(options, ui.Option[float64]{Value: v.size, Label: fmt.Sprintf("%g pt · %s", v.size, apptext.T(v.name))})
		}
		return lookSizeOptions(current, options, "pt")
	}
	return setGroup("字号与排版",
		setRow("聊天字号", "对话正文和提问的文字大小；标题与代码按比例调整。", ui.Select[float64]{
			OptionsFunc: func() []ui.Option[float64] { return fontOptions(float64(a.readingFont()), false) },
			Value:       func() float64 { return float64(a.readingFont()) }, OnChange: a.setChatFont,
			Label: apptext.T("聊天字号"), TestID: "chat-font-select", Style: settingsSelectStyle()}),
		setDivider(),
		setRow("聊天行高", "以字号为基准的行距倍数，数值越大，行间越宽松。", ui.Select[float64]{
			OptionsFunc: func() []ui.Option[float64] {
				var options []ui.Option[float64]
				for _, v := range []struct {
					value float64
					name  string
				}{{1.45, "紧凑"}, {viewkit.ChatLineDefault, "标准"}, {1.8, "宽松"}, {2, "舒展"}} {
					options = append(options, ui.Option[float64]{Value: v.value, Label: fmt.Sprintf("%g × · %s", v.value, apptext.T(v.name))})
				}
				return lookSizeOptions(a.readingRatio(), options, "×")
			}, Value: func() float64 { return a.readingRatio() }, OnChange: a.setChatLine,
			Label: apptext.T("聊天行高"), TestID: "chat-line-select", Style: settingsSelectStyle()}),
		setDivider(),
		setRow("输入框字号", "可单独设置，也可随聊天字号一起调整。", ui.Select[float64]{
			OptionsFunc: func() []ui.Option[float64] { return fontOptions(a.inputFont.Get(), true) },
			Value:       a.inputFont.Get, OnChange: a.setInputFont,
			Label: apptext.T("输入框字号"), TestID: "input-font-select", Style: settingsSelectStyle()}),
		setDivider(),
		setRow("编辑器字号", "文件编辑区的文字大小。", settingsSlider(ui.Slider{
			Min: 11, Max: 20, Step: 1, Value: a.editorFont.Get, OnChange: a.setEditorFont,
			Label: apptext.T("编辑器字号"), TestID: "editor-font", ValueText: func(v float64) string { return fmt.Sprintf("%g pt", v) }},
			func() string { return fmt.Sprintf("%g pt", a.editorFont.Get()) }, "11 pt", "20 pt")),
		setDivider(),
		setRow("终端字号", "终端面板的文字大小；支持半点微调。", settingsSlider(ui.Slider{
			Min: 8, Max: 20, Step: 0.5, Value: a.termFont.Get, OnChange: a.setTerminalFont,
			Label: apptext.T("终端字号"), TestID: "term-font", ValueText: func(v float64) string { return fmt.Sprintf("%g pt", v) }},
			func() string { return fmt.Sprintf("%g pt", a.termFont.Get()) }, "8 pt", "20 pt")),
		setDivider(),
		setRow("代码块自动换行", "长代码行按对话内容宽度折行；关闭后可横向滚动。", ui.Switch{
			Checked: a.codeWrap.Get, Label: apptext.T("代码块自动换行"), TestID: "chat-code-wrap",
			OnChange: func(on bool) {
				a.codeWrap.Set(on)
				a.cfg.CodeWrap = on
				if a.st != nil {
					a.st.change(func(c *config) { c.CodeWrap = on })
					a.saveConfigAsync()
				}
			}}),
		setDivider(),
		core.Dynamic(func(cx *core.Scope) core.Node {
			font := core.Points(float64(a.readingFont()))
			return core.Text{Content: apptext.T("这是一段对话正文示例。\n调整字号与行距，预览会同步更新。"), TestID: "look-reading-preview",
				Style:     core.Style{FontSize: font, LineHeight: font * core.Points(a.readingRatio()), Padding: core.Symmetric(10, 2)},
				StyleFunc: ui.Colored(ui.ColorsOf(cx).Text)}
		}),
		setDivider(),
		setRow("恢复字号与行距", "恢复聊天、输入框、编辑器和终端的默认字号，以及默认行距。", ui.Button{
			Text: apptext.T("恢复默认"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "look-typography-reset", OnPress: a.resetLookTypography}),
	)
}

func (a *app) lookFontSettings(cx *core.Scope, colors ui.Colors) core.Node {
	uiDraft, monoDraft := core.NewSignal(cx, a.cfg.UIFont), core.NewSignal(cx, a.cfg.MonoFont)
	commit := func() {
		uiDraft.Set(strings.TrimSpace(uiDraft.GetUntracked()))
		monoDraft.Set(strings.TrimSpace(monoDraft.GetUntracked()))
		a.setCustomFonts(uiDraft.GetUntracked(), monoDraft.GetUntracked())
	}
	field := func(draft *core.Signal[string], label, id string) core.Node {
		return core.Input{Value: draft.Get, OnChange: draft.Set, OnSubmit: func(string) { commit() }, OnBlur: commit,
			Placeholder: apptext.T("留空跟随主题"), Label: apptext.T(label), TestID: id,
			Style: settingsSelectStyle().Merge(core.Style{Padding: core.Symmetric(0, 8),
				Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6,
				CaretColor: colors.Text(), SelectionColor: colors.Now().Selection, FocusVisible: ui.FocusRing(cx, 2)})}
	}
	return setGroup("字体",
		setRow("界面字体", "填写已安装的字体名称；留空跟随主题。回车或移开焦点后应用并保存。", field(uiDraft, "界面字体", "ui-font")),
		setDivider(),
		setRow("等宽字体", "用于代码、工具输出、编辑器和终端；留空跟随主题。", field(monoDraft, "等宽字体", "mono-font")),
	)
}

func (a *app) setCustomFonts(uiName, monoName string) {
	uiName, monoName = strings.TrimSpace(uiName), strings.TrimSpace(monoName)
	if a.cfg.UIFont == uiName && a.cfg.MonoFont == monoName {
		return
	}
	a.cfg.UIFont, a.cfg.MonoFont = uiName, monoName
	if a.st != nil {
		a.st.change(func(c *config) { c.UIFont, c.MonoFont = uiName, monoName })
		a.saveConfigAsync()
	}
	a.applyFonts()
}

func (a *app) resetLookTypography() {
	a.cfg.ChatFont, a.cfg.ChatLine, a.cfg.InputFont, a.cfg.TerminalFont, a.cfg.EditorFont = 0, 0, 0, 0, 0
	a.chatFont.Set(viewkit.ChatFontDefault)
	a.chatLine.Set(viewkit.ChatLineDefault)
	a.inputFont.Set(0)
	a.termFont.Set(12.5)
	a.editorFont.Set(13)
	if a.st != nil {
		a.st.change(func(c *config) { c.ChatFont, c.ChatLine, c.InputFont, c.TerminalFont, c.EditorFont = 0, 0, 0, 0, 0 })
		a.saveConfigAsync()
	}
}

func (a *app) lookThemeFiles() core.Node {
	return setGroup("主题文件",
		setRow("导入主题", "选择 JSON 或 YAML 主题文件；导入后在配色列表中选择。", ui.Button{
			Text: apptext.T("导入"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "theme-import", OnPress: a.importTheme}),
		setDivider(),
		setRow("导出当前主题", "导出主题的配色、字体与圆角，保存为主题目录中的 JSON 文件。", ui.Button{
			Text: apptext.T("导出"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "theme-export", OnPress: a.exportTheme}),
		setDivider(),
		setRow("主题文件", "在数据目录的 themes 文件夹管理主题文件。", ui.Button{
			Text: apptext.T("打开目录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "theme-open-dir", OnPress: a.openThemesDir}),
	)
}
