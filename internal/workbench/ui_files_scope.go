//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"path/filepath"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) fileScopeTabs() core.Node {
	return ui.Tabs[string]{Variant: ui.TabsSegmented, Equal: true, Size: ui.SizeSmall,
		Label: apptext.T("文件范围"), TestID: "files-scope", Value: a.files.scope.Get, OnChange: a.files.scope.Set,
		Options: []ui.Option[string]{
			{Value: "all", Label: apptext.T("全部文件"), TestID: "files-scope-all"},
			{Value: "session", Label: apptext.T("本次改动"), TestID: "files-scope-session"},
		}}
}

type sessionFileEntry struct {
	Change fileChange
	Rel    string
}

// sessionFileEntries does not turn historical tool activity into Git status.
// Paths outside this project stay in the overview, not in its file browser.
func sessionFileEntries(root string, changes []fileChange) []sessionFileEntry {
	var out []sessionFileEntry
	for _, change := range changes {
		path := filepath.FromSlash(change.Path)
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		out = append(out, sessionFileEntry{Change: change, Rel: filepath.ToSlash(rel)})
	}
	return out
}

func (a *app) sessionFiles(cx *core.Scope, s *session, root string) core.Node {
	colors := ui.ColorsOf(cx)
	return a.scrollStashFor("drawerFiles:session").Bind(cx, core.Scroll{TestID: "files-session-scroll", Style: ui.FillRest,
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			var changes []fileChange
			if s != nil {
				changes = sessionChanges(s.turns.Get())
			}
			filter := strings.ToLower(strings.TrimSpace(a.filesQuery.Get()))
			var rows []core.Node
			entries := sessionFileEntries(root, changes)
			rows = append(rows, core.Text{Content: fmt.Sprintf(apptext.T("修改 %d 个文件"), len(entries)),
				Style: core.Style{FontSize: 12, Padding: core.Edges{Bottom: 8}}, StyleFunc: ui.Colored(colors.Muted)})
			for _, entry := range entries {
				if !containsQuery(entry.Rel, filter) {
					continue
				}
				entry := entry
				rows = append(rows, hintOf(func() string { return entry.Change.Path }, core.View{
					TestID: "file-session-row", Role: core.RoleButton, Label: entry.Rel,
					OnPress: func(core.PressEvent) { a.openChangedFile(s, entry.Change.Path) },
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(8), CornerRadius: 8,
							Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
					}, Children: []core.Node{
						ui.Icon(lucide.FileText, 16, colors.Muted),
						core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 4}, Children: []core.Node{
							core.Text{Content: filepath.Base(entry.Rel), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
							core.Text{Content: filepath.ToSlash(filepath.Dir(entry.Rel)), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontSize: 11, FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Muted)},
						}},
						ui.Text(fmt.Sprintf("+%d", entry.Change.Added), 11, ui.Medium, colors.Up),
						ui.Text(fmt.Sprintf("−%d", entry.Change.Removed), 11, ui.Medium, colors.Danger),
					},
				}))
			}
			if len(rows) == 1 {
				label := apptext.T("当前会话暂无文件改动")
				if filter != "" {
					label = apptext.T("没有匹配的文件")
				}
				rows = append(rows, ui.Text(label, 12, ui.Regular, colors.Muted))
			}
			return core.View{Style: core.Style{Gap: 4, Padding: core.Edges{Bottom: 20}}, Children: rows}
		})}})
}
