//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

type navigationTerminalOptions struct {
	dark, appReduced, systemReduced, manualFrames bool
}

func navigationTerminalFixture(t *testing.T, opt navigationTerminalOptions) (*nsgotest.App, *app) {
	t.Helper()
	options := []nsgotest.Option{nsgotest.Size(960, 640),
		nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop, ReduceMotion: opt.systemReduced})}
	if opt.manualFrames {
		options = append(options, nsgotest.ManualFrames())
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(viewkit.Theme())
		if opt.dark {
			cx.SetAppearance(core.AppearanceDark)
		}
		built = &app{cx: cx, reduceEffects: core.NewSignal(cx, opt.appReduced),
			activeID: core.NewSignal(cx, ""), activeWS: core.NewSignal(cx, ""),
			railTab: core.NewSignal(cx, railTabActivity), sidebar: core.NewSignal(cx, true),
			workspaces: core.NewSignalFunc(cx, []*workspace(nil), nil),
			env:        core.NewSignalFunc(cx, envInfo{}, nil), term: newTerminalHost(cx)}
		var tabs []*termTab
		for i, title := range []string{"PowerShell · 当前项目", "cmd · 测试", "日志"} {
			tabs = append(tabs, &termTab{ID: fmt.Sprint(i), Title: core.NewSignal(cx, title),
				state: core.NewSignal(cx, termRunning)})
		}
		built.term.tabs.Set(tabs)
		built.term.active.Set(tabs[0].ID)
		return core.View{Style: ui.FillRest, StyleFunc: func() core.Style {
			return core.Style{Background: ui.ColorsOf(cx).Background(), FontFamily: cx.Theme().Sans}
		}, Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(292), Padding: core.All(8)}, Children: []core.Node{built.railTabBar()}},
			core.View{Style: core.Style{FlexGrow: 1}, Children: []core.Node{
				core.Input{Value: func() string { return "保留正在编辑的内容" }, TestID: "navigation-draft"},
			}},
			built.terminalHeader(cx),
		}}
	}, options...)
	return screen, built
}

func navigationSessionFixture(t *testing.T, project string, dark bool) (*app, *nsgotest.App) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	theme := "light"
	if dark {
		theme = "dark"
	}
	cfg := config{Version: configVersion, Theme: theme, ScanPi: false, AutoModelCatalog: false, SidebarOpen: true,
		Workspaces: []workspaceCfg{{Path: project, Expanded: true}}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(960, 640), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	t.Cleanup(sessionDraftWrites.Wait)
	t.Cleanup(built.closeDiag)
	return built, screen
}

func TestSessionNavigationKeepsSelection(t *testing.T) {
	for _, dark := range []bool{false, true} {
		t.Run(fmt.Sprint(dark), func(t *testing.T) {
			project := t.TempDir()
			built, screen := navigationSessionFixture(t, project, dark)
			screen.WaitFor("id:project-row", 5*time.Second)
			screen.Post(func() {
				ws := built.workspaceOf(project)
				for i, title := range []string{"历史会话", "正在编辑", "核对结果"} {
					id := fmt.Sprint(i)
					s := built.blankSession(id, ws, title)
					s.draft.Set("会话草稿 " + id)
					ws.Sessions.Update(func(list []*session) []*session { return append(list, s) })
					built.addTab(id)
				}
				built.activeID.Set("0")
			})
			screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tab")) == 3 })
			selectionID := screen.Find("id:session-tab-selection").ID
			tabID := screen.Find("id:tab >> nth=0").ID
			screen.Press("id:tab >> nth=1")
			screen.WaitUntil(5*time.Second, func() bool { return built.activeID.GetUntracked() == "1" })
			screen.Focus("id:tab >> nth=0")
			screen.Key("Return")
			screen.WaitUntil(5*time.Second, func() bool { return built.activeID.GetUntracked() == "0" })
			screen.Post(func() {
				built.selectSession(built.byID["2"])
				built.selectSession(built.byID["1"])
			})
			screen.WaitUntil(5*time.Second, func() bool { return built.activeID.GetUntracked() == "1" })
			screen.Advance(220 * time.Millisecond)
			if screen.Find("id:session-tab-selection").ID != selectionID || screen.Find("id:tab >> nth=0").ID != tabID {
				t.Fatal("session selection replaced the tab strip")
			}
			selected := screen.Find("id:tab >> nth=1").Bounds()
			marker := screen.Find("id:session-tab-selection").Bounds()
			if selected != marker {
				t.Fatalf("highlight did not follow the active session: tab=%v marker=%v", selected, marker)
			}
			if got := built.byID["0"].draft.GetUntracked(); got != "会话草稿 0" {
				t.Fatalf("switching sessions changed a draft: %q", got)
			}
			screen.Screenshot(fmt.Sprintf("navigation-session-%t", dark))
		})
	}
}

func TestNavigationRailSelectionRetainsTabs(t *testing.T) {
	screen, built := navigationTerminalFixture(t, navigationTerminalOptions{manualFrames: true})
	before := screen.Find("id:rail-tab-activity").ID
	start := screen.Find("id:rail-tab-selection").ShownFrame
	screen.Press("id:rail-tab-projects")
	screen.Advance(50 * time.Millisecond)
	indicator := screen.Find("id:rail-tab-selection")
	if !(indicator.ShownFrame.Origin.X > start.Origin.X && indicator.ShownFrame.Origin.X < indicator.Frame.Origin.X) {
		t.Fatalf("sidebar selection jumped: shown=%v target=%v", indicator.ShownFrame, indicator.Frame)
	}
	screen.Press("id:rail-tab-activity")
	screen.Advance(220 * time.Millisecond)
	if built.railTab.GetUntracked() != railTabActivity || screen.Find("id:rail-tab-activity").ID != before {
		t.Fatal("sidebar selection rebuilt its tabs or lost the latest selection")
	}
}

func TestNavigationRailKeyboardSelection(t *testing.T) {
	screen, built := navigationTerminalFixture(t, navigationTerminalOptions{dark: true})
	tabID := screen.Find("id:rail-tab-chat").ID
	draftID := screen.Find("id:navigation-draft").ID
	screen.Press("id:rail-tab-projects")
	screen.Focus("id:rail-tab-chat")
	screen.Key("Return")
	if built.railTab.GetUntracked() != railTabChat {
		t.Fatal("keyboard did not select the sidebar's chat tab")
	}
	if screen.Find("id:rail-tab-chat").ID != tabID || screen.Find("id:navigation-draft").ID != draftID {
		t.Fatal("sidebar selection rebuilt its tabs or input")
	}
	if marker, tab := screen.Find("id:rail-tab-selection").Bounds(), screen.Find("id:rail-tab-chat").Bounds(); marker != tab {
		t.Fatalf("sidebar highlight missed its selected tab: marker=%v tab=%v", marker, tab)
	}
	screen.Screenshot("navigation-rail-dark")
}

func TestTabRevealIgnoresSupersededSelection(t *testing.T) {
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = &app{cx: cx, activeID: core.NewSignal(cx, "0"), activePane: core.NewSignal(cx, ""), reduceEffects: core.NewSignal(cx, false)}
		var tabs []core.Node
		for i := 0; i < 12; i++ {
			tabs = append(tabs, core.View{Ref: built.tabRef(fmt.Sprint(i)), Style: core.Style{Width: core.Pt(120), Height: core.Pt(30), FlexShrink: 0}})
		}
		return core.Scroll{Horizontal: true, TestID: "motion-strip", Style: core.Style{Width: core.Pt(240), Height: core.Pt(40)},
			Children: []core.Node{core.View{Style: core.Style{Direction: core.Row}, Children: tabs}}}
	}, nsgotest.Size(960, 640), nsgotest.ManualFrames())
	before := screen.Find("id:motion-strip").Applied
	screen.Post(func() {
		built.activeID.Set("11")
		built.revealTab("11")
		built.activeID.Set("0")
		built.revealTab("0")
	})
	screen.WaitUntil(time.Second, func() bool { return built.activeID.GetUntracked() == "0" })
	screen.Advance(250 * time.Millisecond)
	if v := screen.Find("id:motion-strip"); v.Applied != before || v.Offset.X != 0 {
		t.Fatalf("superseded reveal scrolled the strip: commands=%d offset=%v", v.Applied-before, v.Offset)
	}
}

func TestNavigationSelectionRetargets(t *testing.T) {
	screen, built := navigationTerminalFixture(t, navigationTerminalOptions{manualFrames: true})
	selection := "id:terminal-tab-selection"
	first := screen.Find(selection)
	identity, start := first.ID, first.ShownFrame
	draft := screen.Find("id:navigation-draft").ID
	screen.Press("id:terminal-tab >> nth=1")
	screen.Advance(50 * time.Millisecond)
	middle := screen.Find(selection).ShownFrame
	target := screen.Find(selection).Frame
	if !(middle.Origin.X > start.Origin.X && middle.Origin.X < target.Origin.X) {
		t.Fatalf("selection did not travel between tabs: start=%v middle=%v target=%v", start, middle, target)
	}
	screen.Press("id:terminal-tab >> nth=2")
	redirected := screen.Find(selection)
	if redirected.ID != identity || redirected.ShownFrame.Origin.X != middle.Origin.X {
		t.Fatalf("rapid selection restarted the highlight: before=%v after=%v", middle, redirected.ShownFrame)
	}
	screen.Advance(220 * time.Millisecond)
	final := screen.Find(selection)
	if final.ShownFrame != final.Frame || built.term.active.GetUntracked() != "2" {
		t.Fatalf("latest selection did not settle: shown=%v target=%v", final.ShownFrame, final.Frame)
	}
	if screen.Find("id:navigation-draft").ID != draft {
		t.Fatal("tab selection rebuilt the input")
	}
	screen.Post(func() { built.term.tabs.GetUntracked()[0].Title.Set("短标题") })
	screen.WaitUntil(time.Second, func() bool { return built.term.tabs.GetUntracked()[0].Title.GetUntracked() == "短标题" })
	if v := screen.Find(selection); v.ShownFrame != v.Frame {
		t.Fatalf("content reflow animated without a selection change: shown=%v target=%v", v.ShownFrame, v.Frame)
	}
}

func TestNavigationRespectsReducedMotion(t *testing.T) {
	for _, tc := range []struct {
		name        string
		app, system bool
	}{{"application", true, false}, {"system", false, true}, {"both", true, true}} {
		t.Run(tc.name, func(t *testing.T) {
			screen, built := navigationTerminalFixture(t, navigationTerminalOptions{appReduced: tc.app, systemReduced: tc.system, manualFrames: true})
			screen.Press("id:terminal-tab >> nth=2")
			if v := screen.Find("id:terminal-tab-selection"); v.ShownFrame != v.Frame {
				t.Fatalf("reduced motion did not reach the selected tab immediately: shown=%v target=%v", v.ShownFrame, v.Frame)
			}
			if built.term.active.GetUntracked() != "2" {
				t.Fatal("reduced motion delayed selection")
			}
		})
	}
}

func TestNavigationReducedMotionCancelsCurrentMove(t *testing.T) {
	screen, built := navigationTerminalFixture(t, navigationTerminalOptions{manualFrames: true})
	screen.Press("id:terminal-tab >> nth=2")
	screen.Advance(50 * time.Millisecond)
	tabID := screen.Find("id:terminal-tab >> nth=2").ID
	screen.Post(func() { built.reduceEffects.Set(true) })
	screen.WaitUntil(time.Second, func() bool { return built.reduceEffects.GetUntracked() })
	if screen.Find("id:terminal-tab >> nth=2").ID != tabID {
		t.Fatal("changing the motion preference rebuilt the selected tab")
	}
	if v := screen.Find("id:terminal-tab-selection"); v.ShownFrame != v.Frame {
		t.Fatalf("enabling reduced motion left a move running: shown=%v target=%v", v.ShownFrame, v.Frame)
	}
}

func TestTerminalTabSelectionKeepsGeometry(t *testing.T) {
	for _, tc := range []struct {
		name string
		opt  navigationTerminalOptions
	}{{"light", navigationTerminalOptions{}}, {"dark", navigationTerminalOptions{dark: true}},
		{"application-reduced", navigationTerminalOptions{appReduced: true}},
		{"system-reduced", navigationTerminalOptions{systemReduced: true}}} {
		t.Run(tc.name, func(t *testing.T) {
			screen, built := navigationTerminalFixture(t, tc.opt)
			before := make([]core.Bounds, 3)
			for i := range before {
				before[i] = screen.Find(fmt.Sprintf("id:terminal-tab >> nth=%d", i)).Bounds()
			}
			screen.Press("id:terminal-tab >> nth=1")
			screen.Advance(220 * time.Millisecond)
			screen.Screenshot("navigation-terminal-" + tc.name + "-selected")
			for i, want := range before {
				if got := screen.Find(fmt.Sprintf("id:terminal-tab >> nth=%d", i)).Bounds(); got != want {
					t.Errorf("selection moved terminal tab %d: %v -> %v", i, want, got)
				}
			}
			if got := built.term.active.GetUntracked(); got != "1" {
				t.Fatalf("selected terminal = %q, want 1", got)
			}
			screen.Focus("id:terminal-tab >> nth=1")
			screen.Key("right")
			screen.Advance(220 * time.Millisecond)
			if got := built.term.active.GetUntracked(); got != "2" {
				t.Fatalf("keyboard selected terminal = %q, want 2", got)
			}
			screen.Screenshot("navigation-terminal-" + tc.name)
		})
	}
}
