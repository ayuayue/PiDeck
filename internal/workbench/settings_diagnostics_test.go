//go:build !js && !android && !ios

package workbench

// The diagnostics page keeps its place and its figures honest: these cover
// the formatting of a heap size and the scroll view that used to be rebuilt -
// and thrown back to its top - once a second.

import (
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMemText(t *testing.T) {
	cases := []struct {
		bytes uint64
		want  string
	}{
		{0, "0 MB"},
		{512 << 20, "512 MB"},
		{(1 << 30) - 1, "1024 MB"},
		{1 << 30, "1.00 GB"},
		{3 << 29, "1.50 GB"},
		{8 << 30, "8.00 GB"},
	}
	for _, c := range cases {
		if got := memText(c.bytes); got != c.want {
			t.Errorf("memText(%d) = %q, want %q", c.bytes, got, c.want)
		}
	}
}

// TestDiagnosticsKeepScroll checks that the page stays where the reader left
// it while the tick refreshes its figures. It used to rebuild the whole page
// every second, which made the page jump back to its top.
func TestDiagnosticsKeepScroll(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	// A short window, so the page is taller than the area it scrolls in.
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 420))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-diagnostics", 5*time.Second)
	app.Press("id:settings-tab-diagnostics")
	app.WaitFor("id:settings-page", 5*time.Second)
	app.Settle()
	app.Scroll("id:settings-page", 240)
	app.Advance(200 * time.Millisecond)
	before := app.Find("id:settings-page").Offset.Y
	if before <= 0 {
		t.Skip("the diagnostics page does not scroll in this window")
	}
	// The figures refresh every three seconds; four beats must not move the
	// page.
	app.Advance(4 * time.Second)
	after := app.Find("id:settings-page").Offset.Y
	if after != before {
		t.Fatalf("the page scrolled from %v to %v while its figures refreshed", before, after)
	}
}

// TestDiagLogCopy checks a log row carries its whole record - when it came
// from and what it said - to the clipboard: an error is what a report is
// pasted from.
func TestDiagLogCopy(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1200, 860))
	const detail = "拉取失败：authentication required"
	built.logEvent("error", "git", "", detail)
	events := built.diagSnapshot()
	if len(events) == 0 {
		t.Fatal("the log kept no record of the error")
	}
	ev := events[len(events)-1]

	screen.Press("label:设置")
	screen.WaitFor("id:settings-tab-diagnostics", 5*time.Second)
	screen.Press("id:settings-tab-diagnostics")
	screen.WaitFor("id:diag-log-browser", 5*time.Second)
	screen.WaitFor("id:diag-log-copy-"+ev.ID, 10*time.Second)
	screen.Press("id:diag-log-copy-" + ev.ID)

	want := ev.Time.Local().Format("2006-01-02 15:04:05") + " · " + diagLevelLabel("error") + " · " + diagCategoryLabel("git") + "\n" + detail
	if screen.Clipboard != want {
		t.Fatalf("copied log = %q, want %q", screen.Clipboard, want)
	}
	screen.WaitFor("text:"+apptext.T("已复制"), 5*time.Second)
}
