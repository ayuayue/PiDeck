//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestGitFileHistoryKeepsRowsClearOfScrollbar(t *testing.T) {
	for _, width := range []core.Points{260, 420} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			t.Setenv("PIDECK_V2_HOME", t.TempDir())
			t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
			t.Setenv("PIDECK_V2_LANG", "zh-CN")
			var a *app
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a = newApp(cx)
				for i := range 12 {
					a.gitFileHistory = append(a.gitFileHistory, gitCommit{Short: fmt.Sprintf("%07d", i+1),
						Subject: strings.Repeat("检查文件历史的长提交标题", 3), Author: strings.Repeat("Long author ", 5)})
				}
				return a.fileHistoryPane()
			}, nsgotest.Size(width, 300))
			t.Cleanup(a.closeDiag)
			screen.WaitFor("id:git-file-history-scroll", 5*time.Second)
			viewport := screen.Find("id:git-file-history-scroll").Bounds()
			content := screen.FindMounted("id:git-file-history-content").Bounds()
			if content.Size.Height <= viewport.Size.Height {
				t.Fatalf("fixture does not overflow: content=%+v viewport=%+v", content, viewport)
			}
			rows := screen.QueryMounted("id:git-history-row")
			if len(rows) != 12 {
				t.Fatalf("history rows = %d, want 12", len(rows))
			}
			for _, row := range rows {
				bounds := row.Bounds()
				gap := viewport.Origin.X + viewport.Size.Width - bounds.Origin.X - bounds.Size.Width
				if gap < viewkit.PanelInset-0.5 {
					t.Errorf("file history row leaves %.1f points for the scrollbar, want at least %v", gap, viewkit.PanelInset)
				}
			}
		})
	}
}

func TestGitDrawerKeepsRowsClearOfScrollbar(t *testing.T) {
	for _, width := range []core.Points{260, 420} {
		for _, mode := range []string{gitViewFlat, gitViewTree} {
			t.Run(fmt.Sprintf("%v/%s", width, mode), func(t *testing.T) {
				t.Setenv("PIDECK_V2_HOME", t.TempDir())
				t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
				t.Setenv("PIDECK_V2_LANG", "zh-CN")
				state := gitState{Checked: true, IsRepo: true, Branch: "main"}
				for i := range 24 {
					state.Files = append(state.Files, gitFile{Path: fmt.Sprintf("src/workbench/long-path/file-%02d.go", i), X: ' ', Y: 'M'})
					state.Commits = append(state.Commits, gitCommit{Hash: fmt.Sprintf("%040d", i+1), Short: fmt.Sprintf("%07d", i+1),
						Subject: strings.Repeat("检查滚动条与提交标题之间的空间", 3), Author: "PiDeck Test"})
				}
				var a *app
				screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
					a = newApp(cx)
					a.git.state.Set(state)
					a.git.view.Set(mode)
					a.git.historyShown.Set(len(state.Commits))
					return a.drawerGit()
				}, nsgotest.Size(width, 760))
				t.Cleanup(a.closeDiag)
				check := func(scrollID, contentID string, rowIDs ...string) {
					t.Helper()
					screen.WaitFor("id:"+scrollID, 5*time.Second)
					viewport := screen.Find("id:" + scrollID).Bounds()
					content := screen.FindMounted("id:" + contentID).Bounds()
					if content.Size.Height <= viewport.Size.Height {
						t.Fatalf("fixture does not overflow: content=%+v viewport=%+v", content, viewport)
					}
					for _, id := range rowIDs {
						rows := screen.QueryMounted("id:" + id)
						if len(rows) == 0 {
							t.Fatalf("no rows match %s", id)
						}
						for _, row := range rows {
							bounds := row.Bounds()
							gap := viewport.Origin.X + viewport.Size.Width - bounds.Origin.X - bounds.Size.Width
							if gap < viewkit.PanelInset-0.5 {
								t.Errorf("%s leaves %.1f points for the scrollbar, want at least %v", id, gap, viewkit.PanelInset)
							}
						}
					}
				}
				check("git-scroll", "git-changes-content", "git-discard-all", "git-file", "git-discard")
				screen.Post(func() { a.git.panel.Set("history") })
				screen.Settle()
				check("git-history-scroll", "git-history-content", "git-log-search", "git-commit-row", "git-log-refresh")
			})
		}
	}
}
