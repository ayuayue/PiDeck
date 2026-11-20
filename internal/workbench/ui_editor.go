//go:build !js && !android && !ios

package workbench

// The editor's face: a strip of open files over the text, the file's
// path and language under it, and the editor itself in between.

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base/editor"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// editorPane is the editor in the middle of the window.
func (a *app) editorPane() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
		Background: colors.Background()}, Children: []core.Node{
		a.editorTabBar(),
		a.editorBody(),
		a.editorStatus(),
	}}
}

// editorTabBar is the open files and the actions on them.
func (a *app) editorTabBar() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(38),
			Padding: core.Symmetric(0, 8), FlexShrink: 0, Background: colors.Inset(),
			Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: []core.Node{
		core.Scroll{Horizontal: true, HideIndicator: true,
			Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 3}, Children: []core.Node{
					core.Each(a.editor.files.Get, func(f *editorFile) string { return f.Key },
						func(cx *core.Scope, f func() *editorFile, _ func() int) core.Node {
							return a.editorTab(f)
						}),
				}},
			}},
		a.editorActions(),
	}}
}

// editorTab is one open file.
func (a *app) editorTab(f func() *editorFile) core.Node {
	colors := ui.ColorsOf(a.cx)
	file := func() *editorFile { return f() }
	active := func() bool { return a.editor.active.Get() == file().Key }
	return core.View{
		OnPress: func(core.PressEvent) {
			if file() != nil {
				a.editor.active.Set(file().Key)
			}
		},
		Role: core.RoleTab, LabelFunc: func() string { return file().Name }, TestID: "editor-tab",
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(28),
				MaxWidth: core.Pt(220), Padding: core.Edges{Left: 9, Right: 5}, CornerRadius: 7,
				Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}}
			if active() {
				st.Background = colors.Surface()
				st.BorderWidth = 1
				st.BorderColor = colors.Border()
			}
			return st
		},
		Children: []core.Node{
			ui.Icon(lucide.FileCode, 12, colors.Faint),
			core.Text{ContentFunc: func() string { return file().Name }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
			core.Show{When: func() bool { return file().Dirty.Get() }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3,
					Background: colors.Accent(), FlexShrink: 0}}
			}},
			core.View{OnPress: func(core.PressEvent) { a.closeEditorFile(file()) }, Role: core.RoleButton, Label: apptext.T("关闭文件"),
				StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(18), Height: core.Pt(18), CornerRadius: 5, AlignItems: core.AlignCenter,
						JustifyContent: core.JustifyCenter, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Pressed()}, Active: &core.Style{Background: colors.Pressed()}}
				}, Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
		},
	}
}

// editorActions are save, reload, reveal and close.
func (a *app) editorActions() core.Node {
	colors := ui.ColorsOf(a.cx)
	enabled := func() bool {
		f := a.editor.activeFile()
		return f != nil && !f.Loading.Get() && !f.busy.Get() && f.Err.Get() == ""
	}
	dirty := func() bool {
		f := a.editor.activeFile()
		return enabled() && f.Dirty.Get()
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
		hintOf(func() string { return apptext.T("保存") }, ui.IconButton{Icon: lucide.Save, Label: apptext.T("保存"), Size: 28, IconSize: 14, TestID: "editor-save",
			Disabled: func() bool { return !dirty() }, OnPress: func() { a.saveActiveFile() }}),
		hintOf(func() string { return apptext.T("自动换行") }, ui.IconButton{Icon: lucide.TextWrap, Label: apptext.T("自动换行"), Size: 28, IconSize: 14, TestID: "editor-wrap",
			Selected: a.editorWrap.Get, OnPress: a.toggleEditorWrap}),
		hintOf(func() string { return apptext.T("保存所有文件") }, ui.IconButton{Icon: lucide.SaveAll, Label: apptext.T("保存所有文件"), Size: 28, IconSize: 14, TestID: "editor-save-all",
			Disabled: func() bool {
				for _, f := range a.editor.files.GetUntracked() {
					if f != nil && f.Dirty.GetUntracked() {
						return false
					}
				}
				return true
			}, OnPress: func() { a.saveAllFiles() }}),
		hintOf(func() string { return apptext.T("重新读取") }, ui.IconButton{Icon: lucide.RotateCcw, Label: apptext.T("重新读取"), Size: 28, IconSize: 14, TestID: "editor-reload",
			Disabled: func() bool { return !enabled() }, OnPress: func() { a.reloadActiveFile() }}),
		hintOf(func() string { return apptext.T("在文件管理器中显示") }, ui.IconButton{Icon: lucide.ExternalLink, Label: apptext.T("在文件管理器中显示"), Size: 28, IconSize: 14,
			Disabled: func() bool { return !enabled() || a.editor.activeFile().file.target.remote() }, OnPress: func() {
				if f := a.editor.activeFile(); f != nil {
					if err := revealFile(localTarget, f.Path); err != nil {
						a.toast(ui.ToastError, "打不开位置", err.Error())
					}
				}
			}}),
		core.View{Style: core.Style{Width: core.Pt(1), Height: core.Pt(18), Background: colors.Line(), Margin: core.Symmetric(0, 4)}},
		hintOf(func() string { return apptext.T("回到对话") }, ui.IconButton{Icon: lucide.X, Label: apptext.T("回到对话"), Size: 28, IconSize: 14, TestID: "editor-close",
			OnPress: a.closeEditorPane}),
	}}
}

// editorBody is the text, its loading state or why it did not open.
func (a *app) editorBody() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		f := a.editor.activeFile()
		if f == nil {
			return core.View{Style: ui.FillRest, Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1}}}}
		}
		if f.Loading.Get() {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
				Children: []core.Node{ui.Spinner{Size: 16}, ui.Text(apptext.T("正在读取 %s…", f.Name), 11.5, ui.Regular, colors.Muted)}}
		}
		if msg := f.Err.Get(); msg != "" {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 10},
				Children: []core.Node{
					ui.Icon(lucide.FileX, 22, colors.Faint),
					core.Text{Content: msg, MaxLines: 3, Style: core.Style{FontSize: 12, MaxWidth: core.Pt(420)},
						StyleFunc: ui.Colored(colors.Muted)},
					ui.Button{Text: apptext.T("重新读取"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() { a.editor.load(f) }},
				}}
		}
		return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Background: colors.Background()},
			Children: []core.Node{editor.Editor{
				Ref:      f.ref,
				Value:    f.Text.Get,
				OnChange: func(text string) { f.Text.Set(text); f.Dirty.Set(text != f.saved) },
				OnSelectionChange: func(sels []editor.Selection) {
					if len(sels) == 0 {
						return
					}
					head := sels[0].Head
					f.caret.Set(fmt.Sprintf("%d:%d", head.Line+1, head.Column+1))
				},
				Language:   f.Lang,
				AutoFocus:  true,
				FontFamily: viewkit.MonoFont(),
				FontSize:   core.Points(a.editorFont.Get()),
				LineHeight: core.Points(a.editorFont.Get() * 1.62),
				SoftWrap:   a.editorWrap.Get(),
				StylesFunc: editorStyles(cx),
				TestID:     "editor",
				Style:      core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)},
			}}}
	})
}

// editorStatus is the line under the text: path, language, whether it is
// saved.
func (a *app) editorStatus() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(24),
			Padding: core.Symmetric(0, 10), FlexShrink: 0, Background: colors.Inset(),
			Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}
	}, Children: []core.Node{
		core.Dynamic(func(*core.Scope) core.Node {
			f := a.editor.activeFile()
			if f == nil {
				return core.Text{Content: "", Style: core.Style{FlexGrow: 1}}
			}
			return core.Text{Content: shortPath(f.Path, 70), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Faint)}
		}),
		core.Dynamic(func(*core.Scope) core.Node {
			f := a.editor.activeFile()
			if f == nil {
				return core.View{}
			}
			state := "已保存"
			color := colors.Faint()
			if f.Dirty.Get() {
				state, color = "未保存", colors.Accent()
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Text(f.Lang, 9.5, ui.Regular, colors.Faint),
				core.View{Style: core.Style{Width: core.Pt(4), Height: core.Pt(4), CornerRadius: 2, Background: color}},
				core.Text{Content: state, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				core.Text{Content: apptext.T("%d 行", strings.Count(f.Text.Get(), "\n")+1), Style: core.Style{FontSize: 9.5},
					StyleFunc: ui.Colored(colors.Faint), TestID: "editor-lines"},
				core.View{Style: core.Style{FlexGrow: 1}},
				core.Text{ContentFunc: func() string { return f.caret.Get() }, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5},
					StyleFunc: ui.Colored(colors.Faint)},
			}}
		}),
	}}
}

// fileMenuItems is a file row's context menu.
func (a *app) fileMenuItems(root string, node fileNode) []core.Node {
	if node.Dir {
		return []core.Node{
			a.menuRow(a.cx, lucide.FilePlus, "新建文件", "", false, func() { a.newFileIn(node.Path) }),
			a.menuRow(a.cx, lucide.FolderPlus, "新建文件夹", "", false, func() { a.newFolderIn(node.Path) }),
			a.menuRow(a.cx, lucide.PencilLine, "重命名", "", false, func() { a.renameFileNode(node.Path) }),
			a.menuSeparator(a.cx),
			a.menuRow(a.cx, lucide.FolderOpen, "在文件管理器中打开", "", false, func() {
				if err := revealFolder(localTarget, node.Path); err != nil {
					a.toast(ui.ToastError, "打不开文件夹", err.Error())
				}
			}),
			a.menuRow(a.cx, lucide.Copy, "复制路径", "", false, func() {
				a.copyText(a.files.relative(node.Path), "路径")
			}),
			a.menuSeparator(a.cx),
			a.menuRow(a.cx, lucide.Trash, "移到回收站", "", false, func() { a.trashFile(node.Path) }),
		}
	}
	return []core.Node{
		a.menuRow(a.cx, lucide.FileCode, "在编辑器中打开", "", false, func() {
			a.openEditorFile(root, node.Path)
		}),
		a.menuRow(a.cx, lucide.PencilLine, "重命名", "", false, func() { a.renameFileNode(node.Path) }),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.AtSign, "插入 @ 路径到输入框", "", false, func() {
			a.mentionFile(node.Path)
		}),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.Code, "在编辑器中打开", "", false, func() { a.openPathInEditor(node.Path) }),
		a.menuRow(a.cx, lucide.FolderOpen, "在文件管理器中显示", "", false, func() {
			if err := revealFile(localTarget, node.Path); err != nil {
				a.toast(ui.ToastError, "打不开位置", err.Error())
			}
		}),
		a.menuRow(a.cx, lucide.Copy, "复制相对路径", "", false, func() {
			a.copyText(a.files.relative(node.Path), "路径")
		}),
		a.menuRow(a.cx, lucide.EyeOff, "加入 .gitignore", "", false, func() { a.ignorePath(node.Path) }),
		a.menuSeparator(a.cx),
		a.menuRow(a.cx, lucide.Trash, "移到回收站", "", false, func() { a.trashFile(node.Path) }),
	}
}

// mentionFile puts an @path in the composer.
func (a *app) mentionFile(path string) {
	s := a.active()
	if s == nil {
		a.toast(ui.ToastInfo, "先开一个会话", "文件路径会放进输入框。")
		return
	}
	mention := "@" + a.files.relative(path) + " "
	draft := s.draft.GetUntracked()
	if draft != "" && !strings.HasSuffix(draft, " ") && !strings.HasSuffix(draft, "\n") {
		draft += " "
	}
	s.draft.Set(draft + mention)
}

// editorStyles is the app's look for the editor's parts.
func editorStyles(cx *core.Scope) func() editor.Styles {
	return ui.Themed(cx, func() editor.Styles {
		colors := ui.ColorsOf(cx).Now()
		wavy := func(c core.Color) core.Style {
			return core.Style{TextDecoration: core.TextDecorationUnderline, TextDecorationStyle: core.DecorationWavy,
				TextDecorationColor: c}
		}
		return editor.Styles{
			Gutter:                 core.Style{Color: colors.Faint, FontSize: 12},
			LineNumber:             core.Style{Color: colors.Faint},
			ActiveLineNumber:       core.Style{Color: colors.Text},
			FoldMarker:             core.Style{Color: colors.Faint},
			Content:                core.Style{Color: colors.Text},
			ActiveLine:             core.Style{Background: ui.Alpha(colors.Text, 0.04)},
			Selection:              core.Style{Background: ui.Alpha(colors.Accent, 0.22)},
			Caret:                  core.Style{Background: colors.Accent, Width: core.Pt(2)},
			SearchMatch:            core.Style{Background: core.RGBA(0xfbbf24, 0.25)},
			CurrentSearchMatch:     core.Style{Background: core.RGBA(0xfbbf24, 0.55)},
			MatchingBracket:        core.Style{BorderWidth: 1, BorderColor: ui.Alpha(colors.Muted, 0.6)},
			FoldPlaceholder:        core.Style{Color: colors.Faint},
			Placeholder:            core.Style{Color: colors.Faint},
			DiagnosticError:        wavy(colors.Danger),
			DiagnosticWarning:      wavy(colors.Warn),
			DiagnosticInfo:         wavy(colors.Info),
			DiagnosticHint:         wavy(colors.Muted),
			UnnecessaryText:        core.Style{Color: colors.Faint},
			DeprecatedText:         core.Style{TextDecoration: core.TextDecorationLineThrough},
			SelectionHandle:        core.Style{CornerRadius: 5, Background: colors.Accent},
			CompletionMenu:         core.Style{Padding: core.All(4), CornerRadius: 8, BorderWidth: 1, BorderColor: colors.Border, Background: colors.Surface},
			CompletionItem:         core.Style{Padding: core.Symmetric(0, 8), Gap: 6, CornerRadius: 5, Color: colors.Text},
			SelectedCompletionItem: core.Style{Background: ui.Alpha(colors.Accent, 0.16)},
			CompletionMatch:        core.Style{FontWeight: ui.Semibold, Color: colors.Accent},
			CompletionDetail:       core.Style{Color: colors.Muted, FontSize: 12},
			CompletionKind:         core.Style{Color: colors.Faint, FontSize: 11, Width: core.Pt(30)},
			CompletionDocumentation: core.Style{Padding: core.Symmetric(6, 8), CornerRadius: 8, BorderWidth: 1,
				BorderColor: colors.Border, Background: colors.Surface, Color: colors.Text, FontSize: 12},
			DefinitionLink:   core.Style{Background: colors.Accent},
			IndentGuide:      core.Style{Background: colors.Border},
			InlineCompletion: core.Style{Color: colors.Faint, Background: colors.Surface},
		}
	})
}
