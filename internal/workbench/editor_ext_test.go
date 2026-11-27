//go:build !js && !android && !ios

package workbench

// Checks for opening files in an external editor.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// TestEditorCandidates checks the list is filled in.
func TestEditorCandidates(t *testing.T) {
	list := editorCandidates()
	if len(list) < 5 {
		t.Fatalf("candidates = %+v", list)
	}
	for _, e := range list {
		if e.Name == "" || e.Command == "" {
			t.Errorf("candidate = %+v", e)
		}
	}
}

// TestEditorChoices checks the configured editor stays first and every
// detected one is kept, so the menu can offer all of them.
func TestEditorChoices(t *testing.T) {
	detected := []extEditor{{"VS Code", "code"}, {"Zed", "zed"}}
	cases := []struct {
		name       string
		configured string
		want       []extEditor
	}{
		{"none", "", detected},
		{"detected", "zed", []extEditor{{"Zed", "zed"}, {"VS Code", "code"}}},
		{"unknown", "C:/bin/my-ide", []extEditor{{"C:/bin/my-ide", "C:/bin/my-ide"}, {"VS Code", "code"}, {"Zed", "zed"}}},
	}
	for _, c := range cases {
		got := editorChoices(detected, c.configured)
		if len(got) != len(c.want) {
			t.Errorf("%s: choices = %+v, want %+v", c.name, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: choice %d = %+v, want %+v", c.name, i, got[i], c.want[i])
			}
		}
	}
}

// TestEditorBrandName checks the mark a command resolves to: the folder and
// the extension are not part of an editor's name.
func TestEditorBrandName(t *testing.T) {
	cases := map[string]string{
		"code":             "code",
		"Zed.exe":          "zed",
		"  cursor  ":       "cursor",
		"idea64.exe":       "idea",
		"sublime_text.exe": "subl",
	}
	cases[filepath.Join("usr", "local", "bin", "zed")] = "zed"
	if runtime.GOOS == "windows" {
		cases[`C:\Tools\code.cmd`] = "code"
	}
	for command, want := range cases {
		if got := editorBrandName(command); got != want {
			t.Errorf("editorBrandName(%q) = %q, want %q", command, got, want)
		}
	}
}

// TestEditorMenusDoNotScanUI keeps PATH discovery out of menu construction.
func TestEditorMenusDoNotScanUI(t *testing.T) {
	var calls atomic.Int32
	original := editorScan
	editorScan = func() []extEditor {
		calls.Add(1)
		return []extEditor{{"VS Code", "code"}, {"Zed", "zed"}}
	}
	t.Cleanup(func() { editorScan = original })
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := &app{cx: cx, overviewMore: core.NewSignal(cx, "file"),
			externalEditors: core.NewSignalFunc(cx, []extEditor(nil), nil)}
		a.editorCommand()
		return a.pathMenu(ui.ColorsOf(cx), "file", func() string { return "fixture.txt" }, func() {}, "overview-file-menu")
	}, nsgotest.Size(400, 300))
	screen.WaitFor("id:overview-file-menu-edit", time.Second)
	if got := calls.Load(); got != 0 {
		t.Fatalf("menu construction called the PATH scanner %d times", got)
	}
}

// TestEditorDiscoveryPublishesMenu covers a pending probe and its empty,
// single-editor and submenu results without looking up installed programs.
func TestEditorDiscoveryPublishesMenu(t *testing.T) {
	for _, tc := range []struct {
		name       string
		detected   []extEditor
		configured string
		want       string
	}{
		{"none", nil, "", "editors:0:"},
		{"one", []extEditor{{"Zed", "zed"}}, "", "editors:1:zed"},
		{"multiple", []extEditor{{"VS Code", "code"}, {"Zed", "zed"}}, "", "editors:2:code"},
		{"configured", []extEditor{{"VS Code", "code"}, {"Zed", "zed"}}, "my-editor", "editors:3:my-editor"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			release := make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			t.Cleanup(unblock)
			original := editorScan
			editorScan = func() []extEditor {
				calls.Add(1)
				<-release
				return tc.detected
			}
			t.Cleanup(func() { editorScan = original })
			var a *app
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a = &app{cx: cx, cfg: config{EditorCommand: tc.configured},
					overviewMore:    core.NewSignal(cx, "file"),
					externalEditors: core.NewSignalFunc(cx, []extEditor(nil), nil)}
				return core.View{Children: []core.Node{
					a.pathMenu(ui.ColorsOf(cx), "file", func() string { return "fixture.txt" }, func() {}, "overview-file-menu"),
					core.Text{ContentFunc: func() string { return fmt.Sprintf("editors:%d:%s", len(a.editors()), a.editorCommand()) }},
				}}
			}, nsgotest.Size(600, 400))
			screen.WaitFor("id:overview-file-menu-edit", time.Second)
			if got := calls.Load(); got != 0 {
				t.Fatalf("menu built before startup discovery called the PATH scanner %d times", got)
			}
			screen.Post(a.discoverEditors)
			screen.WaitUntil(time.Second, func() bool { return calls.Load() == 1 })
			// The UI queue must still run while the worker probe is blocked.
			var responsive atomic.Bool
			screen.Post(func() { responsive.Store(true) })
			screen.WaitUntil(time.Second, responsive.Load)
			screen.WaitFor("id:overview-file-menu-edit", time.Second)
			if tc.configured != "" {
				screen.WaitFor("text:editors:1:"+tc.configured, time.Second)
			}
			unblock()
			screen.WaitFor("text:"+tc.want, 5*time.Second)
			screen.WaitFor("id:overview-file-menu-edit", time.Second)
			if len(editorChoices(tc.detected, tc.configured)) > 1 {
				screen.Press("id:overview-file-menu-edit")
				for _, e := range tc.detected {
					screen.WaitFor("text:"+e.Name, time.Second)
				}
			}
			if got := calls.Load(); got != 1 {
				t.Fatalf("menu rebuild repeated PATH discovery: %d calls", got)
			}
		})
	}
}

// TestOpenInEditorMissing checks a command that does not exist fails.
func TestOpenInEditorMissing(t *testing.T) {
	a := &app{cfg: config{EditorCommand: "pideck-no-such-editor-xyz"}}
	if err := a.openInEditor("some-file.txt"); err == nil {
		t.Fatal("a missing editor was accepted")
	}
}

// TestOpenInEditorRuns checks the editor command actually starts, through
// a batch file on Windows and a shell script elsewhere.
func TestOpenInEditorRuns(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker.txt")
	var script string
	if runtime.GOOS == "windows" {
		script = filepath.Join(dir, "open.bat")
		body := "@echo off\r\n> \"%~dp0marker.txt\" echo opened\r\n"
		if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	} else {
		script = filepath.Join(dir, "open.sh")
		body := "#!/bin/sh\ntouch \"$(dirname \"$0\")/marker.txt\"\n"
		if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	a := &app{cfg: config{EditorCommand: script}}
	if err := a.openInEditor(filepath.Join(dir, "target.txt")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the editor command did not run")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
