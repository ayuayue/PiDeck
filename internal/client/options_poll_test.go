package client

// What the browser page did while a desktop was polled: a sheet rebuilt
// under the reader's finger twice a second, and a model list long enough
// that it could not be found by eye. Each test names the behaviour it
// protects.

import (
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// openModelSheet connects to a desk, opens the first session and shows the
// sheet the model list lives in.
func openModelSheet(t *testing.T) (*fakeComposerDesktop, *nsgotest.App) {
	t.Helper()
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话", Updated: time.Now().UnixMilli()})
	var app *nsgotest.App
	desk.open(t, &app)
	waitApp(app, "id:mobile-session", 10*time.Second)
	app.Press("id:mobile-session")
	waitApp(app, "id:mobile-model", 15*time.Second)
	app.Press("id:mobile-model")
	waitApp(app, "id:mobile-options-sheet", 10*time.Second)
	return desk, app
}

// TestMobileVersionNoticeLeavesAfterMatch checks the reload banner stays
// away when the page and the desktop agree. The desktop once reported
// "0.2.0" while the page said "2.0.0", because the server kept its own copy
// of the number beside appinfo.Version.
func TestMobileVersionNoticeLeavesAfterMatch(t *testing.T) {
	_, app := openModelSheet(t)
	for _, text := range app.Texts() {
		if strings.Contains(text, "刷新后一起用新版本") {
			t.Fatalf("the page matched the desktop's version but offered a reload: %q", text)
		}
	}
}

// TestMobileModelListSearches checks the model list can be narrowed: a
// desktop offers well over a hundred models, and a flat list of that length
// cannot be found by eye.
func TestMobileModelListSearches(t *testing.T) {
	_, app := openModelSheet(t)
	waitApp(app, "id:mobile-model-search", 10*time.Second)

	// Both models are listed before a query.
	if !app.Exists("id:mobile-options-sheet >> text:模型一") || !app.Exists("id:mobile-options-sheet >> text:GPT 模型") {
		t.Fatal("the sheet did not list both models")
	}
	app.Type("id:mobile-model-search", "GPT")
	app.Settle()
	if app.Exists("id:mobile-options-sheet >> text:模型一") {
		t.Fatal("the search did not hide the model it did not match")
	}
	if !app.Exists("id:mobile-options-sheet >> text:GPT 模型") {
		t.Fatal("the search hid the model it matched")
	}

	// A query that matches nothing says so instead of showing an empty box.
	app.Type("id:mobile-model-search", "没有这个模型")
	waitApp(app, "text:没有匹配的模型", 10*time.Second)
}

// TestMobilePollDoesNotRereadOptions pins the two halves of the fix. The
// headless clock does not advance the poll's timer, so what is asserted is
// the mechanism the poll relies on: an equal read leaves the signal alone,
// and a real change still reaches the sheet.
func TestMobilePollDoesNotRereadOptions(t *testing.T) {
	app := newMobileSheetApp(t)
	reads := 0
	// A computation over the signal runs once per notification, which is
	// once per rebuild of the sheet.
	app.cx.Effect(func() {
		_ = app.options.Get()
		reads++
	})

	first := remotewire.Options{
		Model: "a", Provider: "p", Thinking: "high", Ready: true,
		Models: []remotewire.Model{{ID: "a", Name: "Alpha", Provider: "p"}},
		Levels: []string{"off", "high"},
	}
	app.options.Set(first)
	if reads != 2 {
		t.Fatalf("one change ran the reader %d times, want 2 (first run and the change)", reads)
	}

	// The same choices, decoded into fresh slices, as a poll delivers them.
	app.options.Set(remotewire.Options{
		Model: "a", Provider: "p", Thinking: "high", Ready: true,
		Models: []remotewire.Model{{ID: "a", Name: "Alpha", Provider: "p"}},
		Levels: []string{"off", "high"},
	})
	if reads != 2 {
		t.Fatalf("an equal read ran the reader %d times; every run rebuilds every model row", reads)
	}

	// A real change does reach it.
	app.options.Set(remotewire.Options{
		Model: "b", Provider: "p", Thinking: "high", Ready: true,
		Models: []remotewire.Model{{ID: "b", Name: "Beta", Provider: "p"}},
		Levels: []string{"off", "high"},
	})
	if reads != 3 {
		t.Fatalf("a changed read ran the reader %d times, want 3", reads)
	}
}

// newMobileSheetApp is the real phone state on a graph of its own: the
// signals are the ones the page uses, so a test sees the wiring and not a
// copy of it.
func newMobileSheetApp(t *testing.T) *mobileApp {
	t.Helper()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	cx := core.NewRoot(core.RootOptions{CheckCommits: true})
	t.Cleanup(cx.Dispose)
	return newMobileApp(cx)
}
