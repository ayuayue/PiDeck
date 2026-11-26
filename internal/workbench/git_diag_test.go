//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDiagGitRecordsOutcomeAfterRepositoryChanges(t *testing.T) {
	for _, tc := range []struct {
		name, level string
		err         error
	}{
		{name: "success", level: "info"},
		{name: "failure", level: "error", err: errors.New("private-command-error")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &app{}
			dir := t.TempDir()
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				r := newGitRepo(cx)
				r.path, r.target = dir, localTarget
				r.onLog = func(level, text string) { a.logEvent(level, "git", "", "%s", text) }
				return core.View{TestID: "run-git", Role: core.RoleButton, Style: core.Style{Width: core.Pt(100), Height: core.Pt(40)},
					OnPress: func(core.PressEvent) {
						r.runDetail("Git 操作", func(g gitRunner) (string, error) {
							return "private-command-output", tc.err
						}, nil)
						// Moving to another repository discards the old UI result,
						// but must not discard the operation's log record.
						r.seq++
					}}
			}, nsgotest.Size(300, 100))
			screen.Press("id:run-git")
			screen.WaitUntil(5*time.Second, func() bool { return len(a.diagSnapshot()) == 2 })
			events := a.diagSnapshot()
			if len(events) != 2 || events[0].Level != "info" || events[1].Level != tc.level {
				t.Fatalf("Git operation records = %+v", events)
			}
			for _, ev := range events {
				if ev.Category != "git" || strings.Contains(ev.Text, "private-command-") {
					t.Fatalf("Git record contains command output or wrong category: %+v", ev)
				}
			}
		})
	}
}
