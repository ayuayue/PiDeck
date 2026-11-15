package main

// Checks crash logs: what a report holds, how the newest is found, and
// the screen the error boundary shows.

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestCrashReport(t *testing.T) {
	dir := t.TempDir()
	path, err := writeCrashReport(dir, "boom", []byte("goroutine 1 [running]:\nmain.main()"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{"PiDeck Lite " + appVersion, "boom", "goroutine 1 [running]"} {
		if !strings.Contains(text, want) {
			t.Fatalf("report is missing %q:\n%s", want, text)
		}
	}
	if got, _, ok := latestCrash(dir); !ok || got != path {
		t.Fatalf("latestCrash = %q, %v", got, ok)
	}
	if got := crashCount(dir); got != 1 {
		t.Fatalf("crashCount = %d", got)
	}
	time.Sleep(10 * time.Millisecond)
	second, err := writeCrashReport(dir, "again", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, _, ok := latestCrash(dir); !ok || got != second {
		t.Fatalf("latestCrash after a second report = %q, %v", got, ok)
	}
	if got := crashCount(dir); got != 2 {
		t.Fatalf("crashCount after a second report = %d", got)
	}
}

func TestCrashDataDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", dir)
	setCrashDataDir("")
	if got := crashDataDirNow(); got != dir {
		t.Fatalf("fallback dir = %q, want %q", got, dir)
	}
	other := t.TempDir()
	setCrashDataDir(other)
	if got := crashDataDirNow(); got != other {
		t.Fatalf("recorded dir = %q, want %q", got, other)
	}
	setCrashDataDir("")
}

func TestCrashScreenFallback(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	panics := 0
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		return core.Catch{
			Try: func(*core.Scope) core.Node {
				panics++
				if panics == 1 {
					panic("boom")
				}
				return core.Text{Content: "ok"}
			},
			Fallback: func(cx *core.Scope, err error, reset func()) core.Node {
				return crashScreenFor(cx, err, reset, "", nil, nil)
			},
		}
	}, nsgotest.Size(900, 700))
	app.WaitFor("id:crash-screen", 5*time.Second)
	app.WaitFor("text:界面出了点问题", 5*time.Second)
	app.Press("id:crash-reset")
	app.WaitFor("text:ok", 5*time.Second)
}
