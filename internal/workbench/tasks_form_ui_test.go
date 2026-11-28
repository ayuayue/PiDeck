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
	"github.com/nsgo-dev/nsgo/ui"
)

// taskFormFixture mounts only the editor: no agent, scheduler or log writer.
func taskFormFixture(t *testing.T, width, height core.Points, projects int, dark bool) (*nsgotest.App, *app) {
	t.Helper()
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(viewkit.Theme())
		if dark {
			cx.SetAppearance(core.AppearanceDark)
		} else {
			cx.SetAppearance(core.AppearanceLight)
		}
		var workspaces []*workspace
		for i := range projects {
			workspaces = append(workspaces, &workspace{Path: fmt.Sprintf("/projects/project-%d", i),
				Name: fmt.Sprintf("产品工作台与移动端优化 %02d", i+1)})
		}
		workspaces[len(workspaces)-1].Name = strings.Repeat("跨平台产品界面与可访问性优化", 4)
		built = &app{
			cx: cx, langRev: core.NewSignal(cx, 0), chatWidthPctSig: core.NewSignal(cx, chatWidthPctDefault),
			workspaces:   core.NewSignalFunc(cx, workspaces, nil),
			taskRev:      core.NewSignal(cx, 0),
			taskFormOpen: core.NewSignal(cx, true),
			taskEditID:   core.NewSignal(cx, ""),
			taskName:     core.NewSignal(cx, ""),
			taskCron:     core.NewSignal(cx, "0 9 * * *"),
			taskTimeout:  core.NewSignal(cx, "30"),
			taskPrompt:   core.NewSignal(cx, ""),
			taskProject:  core.NewSignal(cx, workspaces[0].Path),
			taskBackend:  core.NewSignal(cx, "acp"),
			taskPreset:   core.NewSignal(cx, "claude"),
			taskPersona:  core.NewSignal(cx, ""),
			taskEnabled:  core.NewSignal(cx, true),
			taskErr:      core.NewSignal(cx, ""),
		}
		return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans}), Children: []core.Node{built.taskFormDialog()}}
	}, nsgotest.Size(width, height), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	screen.WaitFor("id:task-form", 5*time.Second)
	return screen, built
}

func TestTaskFormFitsCompactWindow(t *testing.T) {
	for _, tt := range []struct {
		name          string
		width, height core.Points
		projects      int
		dark          bool
	}{
		{name: "regular", width: 1320, height: 860, projects: 3},
		{name: "compact", width: 960, height: 600, projects: 14},
		{name: "narrow-dark", width: 720, height: 520, projects: 14, dark: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			screen, built := taskFormFixture(t, tt.width, tt.height, tt.projects, tt.dark)
			if nsgotest.Target() != "" {
				screen.Screenshot("task-form-" + tt.name)
			}
			assertInside := func(selector string) {
				t.Helper()
				b := screen.Find(selector).Bounds()
				if b.Size.Width <= 0 || b.Size.Height <= 0 || b.Origin.X < 0 || b.Origin.Y < 0 ||
					b.Origin.X+b.Size.Width > tt.width || b.Origin.Y+b.Size.Height > tt.height {
					t.Fatalf("%s bounds = %+v, outside %vx%v window", selector, b, tt.width, tt.height)
				}
			}
			assertInside("id:task-save")
			for _, selector := range []string{"id:task-field-name", "id:task-field-cron", "id:task-field-timeout"} {
				assertInside(selector)
				if got := screen.Find(selector).Bounds().Size.Width; got < 64 {
					t.Fatalf("%s width = %v, too narrow to edit", selector, got)
				}
			}
			footerY := screen.Find("id:task-save").Bounds().Origin.Y
			body := screen.Find("id:task-form-scroll")
			if body.Content.Width > body.Bounds().Size.Width+1 {
				t.Fatalf("form content width = %v, exceeds scroll viewport %v\n%s", body.Content.Width, body.Bounds().Size.Width, screen.Dump())
			}
			if body.Content.Height > body.Bounds().Size.Height+1 {
				screen.Scroll("id:task-form-scroll", body.Content.Height)
			}
			if got := screen.Find("id:task-save").Bounds().Origin.Y; got != footerY {
				t.Fatalf("scrolling moved the save button from %v to %v", footerY, got)
			}
			screen.Focus("id:task-field-prompt")
			const prompt = "整理今天的变更，并列出需要跟进的问题。"
			screen.Type("id:task-field-prompt", prompt)
			assertInside("id:task-field-prompt")
			assertInside("id:task-save")
			if got := built.taskPrompt.GetUntracked(); got != prompt {
				t.Fatalf("prompt = %q, want %q", got, prompt)
			}
			if nsgotest.Target() != "" {
				screen.Screenshot("task-form-" + tt.name + "-scrolled")
			}
			// The action must remain reachable by keyboard while the body is scrolled.
			screen.Focus("id:task-save")
			screen.Key("Return")
			screen.WaitFor("text:名称和提示词都要填。", 5*time.Second)
			assertInside("text:名称和提示词都要填。")
			assertInside("id:task-save")
			if !built.taskFormOpen.GetUntracked() {
				t.Fatal("validation unexpectedly closed the editor")
			}
			if nsgotest.Target() != "" {
				screen.Screenshot("task-form-" + tt.name + "-validation")
			}
			screen.Key("Escape")
			screen.WaitUntil(5*time.Second, func() bool { return !built.taskFormOpen.GetUntracked() })
		})
	}
}
