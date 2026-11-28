//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func startQuitEditor(t *testing.T, dirty bool) (*nsgotest.App, *app, string) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("headless quit request regression")
	}
	previous := exitStore.Swap(nil)
	t.Cleanup(func() { exitStore.Store(previous) })
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("original content"), 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = &app{
			cx: cx, editor: newEditorHost(cx),
			editorFont: core.NewSignal(cx, 13.0),
			editorWrap: core.NewSignal(cx, false),
		}
		built.setupDesktop()
		return built.editorPane()
	}, nsgotest.Size(900, 500), nsgotest.PendingAlerts(),
		nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	screen.Post(func() { built.editor.openFile(dir, path) })
	screen.WaitFor("text:original content", 5*time.Second)
	if dirty {
		screen.Type("id:editor", "changed ")
	}
	return screen, built, path
}

func TestDesktopQuitKeepsUnsavedEditsUntilConfirmed(t *testing.T) {
	for _, restart := range []bool{false, true} {
		name := "quit"
		if restart {
			name = "restart"
		}
		t.Run(name, func(t *testing.T) {
			screen, built, path := startQuitEditor(t, true)
			request := built.quitApp
			if restart {
				request = built.restartApp
			}
			// A clean active tab must not hide unsaved changes in another tab.
			clean := filepath.Join(filepath.Dir(path), "clean.txt")
			if err := os.WriteFile(clean, []byte("clean tab"), 0o644); err != nil {
				t.Fatal(err)
			}
			screen.Post(func() { built.editor.openFile(filepath.Dir(path), clean) })
			screen.WaitFor("text:clean tab", 5*time.Second)
			screen.Post(request)
			screen.Settle()
			if screen.Quits != 0 || screen.Restarts != 0 || built.quitting || len(screen.Alerts()) != 1 {
				t.Fatalf("pending confirmation: quits=%d restarts=%d quitting=%v alerts=%d", screen.Quits, screen.Restarts, built.quitting, len(screen.Alerts()))
			}
			// Repeated requests while the native alert is open share one decision.
			screen.Post(request)
			screen.Settle()
			if len(screen.Alerts()) != 1 {
				t.Fatalf("repeated request showed %d alerts, want 1", len(screen.Alerts()))
			}
			screen.Answer(0)
			if screen.Quits != 0 || screen.Restarts != 0 || built.quitting {
				t.Fatalf("canceled request: quits=%d restarts=%d quitting=%v", screen.Quits, screen.Restarts, built.quitting)
			}
			screen.Post(func() { built.editor.active.Set(path) })
			screen.WaitFor("text:changed original content", 5*time.Second)
			if data, err := os.ReadFile(path); err != nil || string(data) != "original content" {
				t.Fatalf("cancel changed saved file: %q, %v", data, err)
			}
			screen.Post(request)
			screen.Settle()
			screen.Answer(1)
			if !built.quitting {
				t.Fatal("confirmed request did not mark the app as quitting")
			}
			if restart && screen.Restarts != 1 || !restart && screen.Quits != 1 {
				t.Fatalf("confirmed %s: quits=%d restarts=%d", name, screen.Quits, screen.Restarts)
			}
		})
	}
}

func TestDesktopQuitCleanEditorNeedsNoConfirmation(t *testing.T) {
	for _, restart := range []bool{false, true} {
		name := "quit"
		if restart {
			name = "restart"
		}
		t.Run(name, func(t *testing.T) {
			screen, built, _ := startQuitEditor(t, false)
			request := built.quitApp
			if restart {
				request = built.restartApp
			}
			screen.Post(request)
			screen.Settle()
			if len(screen.Alerts()) != 0 || !built.quitting {
				t.Fatalf("clean editor: alerts=%d quitting=%v", len(screen.Alerts()), built.quitting)
			}
			if restart && screen.Restarts != 1 || !restart && screen.Quits != 1 {
				t.Fatalf("clean %s: quits=%d restarts=%d", name, screen.Quits, screen.Restarts)
			}
		})
	}
}

func TestDesktopSystemQuitProtectsEditsAndAllowsShutdown(t *testing.T) {
	screen, built, _ := startQuitEditor(t, true)
	screen.RequestQuit(false)
	if screen.Quits != 0 || len(screen.Alerts()) != 1 {
		t.Fatalf("system quit: quits=%d alerts=%d", screen.Quits, len(screen.Alerts()))
	}
	// Dismissing the native alert is cancellation too, and frees the next request.
	screen.Answer(-1)
	if screen.Quits != 0 || built.quitting {
		t.Fatalf("dismissed request: quits=%d quitting=%v", screen.Quits, built.quitting)
	}
	screen.RequestQuit(true)
	if screen.Quits != 1 || len(screen.Alerts()) != 0 || !built.quitting {
		t.Fatalf("forced shutdown: quits=%d alerts=%d quitting=%v", screen.Quits, len(screen.Alerts()), built.quitting)
	}
}
