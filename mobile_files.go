package main

// The phone's read-only file browser: a project's files, and one file's
// text, all through the desktop's API.

import (
	"fmt"
	"strings"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
)

// mobileFilesMax bounds the rows the phone draws for one list.
const mobileFilesMax = 300

// openSessionFiles browses the open session's project.
func (a *mobileApp) openSessionFiles() {
	path, name := a.projectOf(a.active.GetUntracked())
	if path == "" {
		a.notice.Set(T("这个会话不在项目里"))
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
	a.fileText.Set("")
	a.fileErr.Set("")
	a.fileBusy.Set(true)
	a.fileOpen.Set(true)
	go func() {
		text, err := client.file(project, path)
		a.cx.Post(func() {
			a.fileBusy.Set(false)
			if err != nil {
				a.fileErr.Set(remoteErrorText(err))
				return
			}
			a.fileText.Set(text)
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
			name, dir := splitGitPath(f.Path)
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.openFile(f.Path) },
				Role:    core.RoleButton, Label: f.Path, TestID: "mobile-file",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(38),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: pressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.FileText, 13, colors.Faint),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
						core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return dir != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: dir, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
					ui.Text(fileSizeText(f.Size), 9.5, ui.Regular, colors.Faint),
				}})
		}
		var body []core.Node
		switch {
		case busy:
			body = append(body, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(12)},
				Children: []core.Node{ui.Spinner{Size: 14, Label: T("读取文件")}, ui.Text(T("正在读取文件…"), 12, ui.Regular, colors.Muted)}})
		case errText != "":
			body = append(body, ui.Text(errText, 12, ui.Regular, colors.Danger))
		case len(rows) == 0:
			body = append(body, ui.Text(T("没有匹配的文件"), 12, ui.Regular, colors.Faint))
		default:
			body = append(body, core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}})
		}
		return ui.Dialog{
			Open:         a.filesOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.filesOpen.Set(open) },
			Title:        T("文件") + " · " + a.filesName.Get(),
			TestID:       "mobile-files",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Input{Value: a.filesQuery.Get, OnChange: a.filesQuery.Set, Placeholder: T("筛选文件…"), Label: T("筛选文件"),
					TestID: "mobile-files-filter",
					Style: core.Style{Height: core.Pt(38), Padding: core.Symmetric(0, 10), CornerRadius: 8, FontSize: 13,
						Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}},
				core.View{Style: core.Style{Gap: 4}, Children: body},
			}}},
			Footer: []core.Node{
				ui.Button{Text: T("刷新"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.loadFiles},
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.filesOpen.Set(false) }},
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
		var body core.Node
		switch {
		case busy:
			body = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(12)},
				Children: []core.Node{ui.Spinner{Size: 14, Label: T("读取文件")}, ui.Text(T("正在读取文件…"), 12, ui.Regular, colors.Muted)}}
		case errText != "":
			body = core.Text{Content: errText, Style: core.Style{FontSize: 12, Padding: core.All(8)}, StyleFunc: ui.Colored(colors.Danger)}
		default:
			body = core.Scroll{Style: core.Style{MaxHeight: core.Pt(520)}, Children: []core.Node{
				core.Text{Content: a.fileText.Get(), Style: core.Style{FontFamily: ui.Mono, FontSize: 11.5, LineHeight: 17},
					StyleFunc: ui.Colored(colors.Text)}}}
		}
		return ui.Dialog{
			Open:         a.fileOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.fileOpen.Set(open) },
			Title:        a.fileTitle.Get(),
			TestID:       "mobile-file-view",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(640), Height: core.Pct(88)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.fileOpen.Set(false) }},
			},
		}
	})
}
