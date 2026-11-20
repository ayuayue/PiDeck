package client

// The phone's read-only file browser: a project's files, and one file's
// text, all through the desktop's API.

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// mobileFilesMax bounds the rows the phone draws for one list.
const mobileFilesMax = 300

// openSessionFiles browses the open session's project.
func (a *mobileApp) openSessionFiles() {
	path, name := a.projectOf(a.active.GetUntracked())
	if path == "" {
		a.notice.Set(apptext.T("这个会话不在项目里"))
		return
	}
	a.openFiles(path, name)
}

// projectOf finds the project a session belongs to.
func (a *mobileApp) projectOf(id string) (path, name string) {
	if id == "" {
		return "", ""
	}
	for _, p := range a.state.GetUntracked().Projects {
		for _, s := range p.Sessions {
			if s.ID == id {
				return p.Path, p.Name
			}
		}
	}
	return "", ""
}

// openFiles shows a project's file list.
func (a *mobileApp) openFiles(project, name string) {
	a.filesProject.Set(project)
	a.filesName.Set(name)
	a.filesQuery.Set("")
	a.filesList.Set(nil)
	a.filesErr.Set("")
	a.filesOpen.Set(true)
	a.loadFiles()
}

// loadFiles reads the project's file list from the desktop.
func (a *mobileApp) loadFiles() {
	client := a.client
	project := a.filesProject.GetUntracked()
	if client == nil || project == "" || a.filesBusy.GetUntracked() {
		return
	}
	a.filesBusy.Set(true)
	a.filesErr.Set("")
	go func() {
		files, err := client.files(project)
		a.cx.Post(func() {
			a.filesBusy.Set(false)
			if err != nil {
				a.filesErr.Set(remoteErrorText(err))
				return
			}
			a.filesList.Set(files)
		})
	}()
}

// openFile reads one file's text.
func (a *mobileApp) openFile(path string) {
	client := a.client
	project := a.filesProject.GetUntracked()
	if client == nil || project == "" {
		return
	}
	a.fileTitle.Set(path)
	a.fileEdit.reset(project, path)
	request := a.fileEdit.request
	a.fileText.Set("")
	a.fileErr.Set("")
	a.fileFind.Set("")
	a.fileBusy.Set(true)
	a.fileOpen.Set(true)
	go func() {
		file, err := client.file(project, path)
		a.cx.Post(func() {
			if a.client != client || a.fileEdit.request != request {
				return
			}
			a.fileBusy.Set(false)
			if err != nil {
				a.fileErr.Set(remoteErrorText(err))
				return
			}
			a.fileText.Set(file.Text)
			a.fileEdit.revision.Set(file.Revision)
			a.fileEdit.writable.Set(file.Writable)
		})
	}()
}

// fileSizeText is a file's size as a row shows it.
func fileSizeText(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// filesTitle names the file list: mention mode says what a tap does.
func (a *mobileApp) filesTitle() string {
	if a.filesMention.Get() {
		return apptext.T("插入文件") + " · " + a.filesName.Get()
	}
	return apptext.T("文件") + " · " + a.filesName.Get()
}

// filesSheet lists a project's files, filtered by the field above.
func (a *mobileApp) filesSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.filesList.Get()
		busy := a.filesBusy.Get()
		errText := a.filesErr.Get()
		query := strings.ToLower(strings.TrimSpace(a.filesQuery.Get()))
		var rows []core.Node
		for _, f := range list {
			f := f
			if query != "" && !strings.Contains(strings.ToLower(f.Path), query) {
				continue
			}
			if len(rows) >= mobileFilesMax {
				break
			}
			name, dir := viewkit.SplitGitPath(f.Path)
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					if a.filesMention.GetUntracked() {
						a.insertMention(f.Path)
						return
					}
					a.openFile(f.Path)
				},
				Role: core.RoleButton, Label: f.Path, TestID: "mobile-file",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(38),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.FileText, 13, colors.Faint),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
						core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return dir != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: dir, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
					ui.Text(fileSizeText(f.Size), 9.5, ui.Regular, colors.Faint),
				}})
		}
		var body []core.Node
		switch {
		case busy:
			body = append(body, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(12)},
				Children: []core.Node{ui.Spinner{Size: 14, Label: apptext.T("读取文件")}, ui.Text(apptext.T("正在读取文件…"), 12, ui.Regular, colors.Muted)}})
		case errText != "":
			body = append(body, ui.Text(errText, 12, ui.Regular, colors.Danger))
		case len(rows) == 0:
			body = append(body, ui.Text(apptext.T("没有匹配的文件"), 12, ui.Regular, colors.Faint))
		default:
			body = append(body, core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}})
		}
		return ui.Dialog{
			Open:         a.filesOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.filesOpen.Set(open) },
			Title:        a.filesTitle(),
			TestID:       "mobile-files",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Input{Value: a.filesQuery.Get, OnChange: a.filesQuery.Set, Placeholder: apptext.T("筛选文件…"), Label: apptext.T("筛选文件"),
					TestID: "mobile-files-filter",
					Style: core.Style{Height: core.Pt(38), Padding: core.Symmetric(0, 10), CornerRadius: 8, FontSize: 13,
						Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}},
				core.View{Style: core.Style{Gap: 4}, Children: body},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("刷新"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.loadFiles},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.filesOpen.Set(false) }},
			},
		}
	})
}

// fileSheet shows one file's text.
func (a *mobileApp) fileSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		busy := a.fileBusy.Get()
		errText := a.fileErr.Get()
		editing := a.fileEdit.open.Get()
		var body core.Node
		switch {
		case busy:
			body = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(12)},
				Children: []core.Node{ui.Spinner{Size: 14, Label: apptext.T("读取文件")}, ui.Text(apptext.T("正在读取文件…"), 12, ui.Regular, colors.Muted)}}
		case errText != "":
			body = core.Text{Content: errText, Style: core.Style{FontSize: 12, Padding: core.All(8)}, StyleFunc: ui.Colored(colors.Danger)}
		case editing:
			body = a.fileEditorBody(colors)
		default:
			body = a.fileBody(colors)
		}
		var finder core.Node
		if !busy && errText == "" && !editing {
			finder = core.Input{Value: a.fileFind.Get, OnChange: a.fileFind.Set, Placeholder: apptext.T("在文件里查找…"),
				Label: apptext.T("在文件里查找"), TestID: "mobile-file-find",
				Style: core.Style{Height: core.Pt(38), Padding: core.Symmetric(0, 10), CornerRadius: 8, FontSize: 13,
					Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}}
		}
		footer := a.fileEditorActions()
		return ui.Dialog{
			Open: a.fileOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					a.closeFileView()
				}
			},
			Title:    a.fileTitle.Get(),
			TestID:   "mobile-file-view",
			Style:    core.Style{Width: core.Pct(100), MaxWidth: core.Pt(640), Height: core.Pct(88)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{finder, body}}},
			Footer:   footer,
		}
	})
}

// fileBody is the file's text, or the lines that match the find field.
func (a *mobileApp) fileBody(colors ui.Colors) core.Node {
	q := strings.ToLower(strings.TrimSpace(a.fileFind.Get()))
	text := a.fileText.Get()
	if q == "" {
		return core.Scroll{Style: core.Style{MaxHeight: core.Pt(520)}, Children: []core.Node{
			core.Text{Content: text, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11.5, LineHeight: 17},
				StyleFunc: ui.Colored(colors.Text)}}}
	}
	var rows []core.Node
	matched := 0
	for i, line := range strings.Split(text, "\n") {
		if !strings.Contains(strings.ToLower(line), q) {
			continue
		}
		matched++
		rows = append(rows, core.Text{Content: fmt.Sprintf("%4d  %s", i+1, line), TestID: "mobile-file-line",
			Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Text)})
		if matched >= 300 {
			break
		}
	}
	if matched == 0 {
		return ui.Text(apptext.T("没有匹配的行"), 12, ui.Regular, colors.Faint)
	}
	head := ui.Text(apptext.T("%d 行匹配", matched), 10.5, ui.Regular, colors.Muted)
	return core.Scroll{Style: core.Style{MaxHeight: core.Pt(500)}, Children: []core.Node{
		core.View{Style: core.Style{Gap: 2}, Children: append([]core.Node{head}, rows...)}}}
}
