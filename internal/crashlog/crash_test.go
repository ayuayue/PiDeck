package crashlog

// Checks crash logs: what a report holds, how the newest is found, and
// the screen the error boundary shows.

import (
	"os"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/appinfo"
)

func TestCrashReport(t *testing.T) {
	dir := t.TempDir()
	path, err := WriteReport(dir, "boom", []byte("goroutine 1 [running]:\nmain.main()"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{"PiDeck Lite " + appinfo.Version, "boom", "goroutine 1 [running]"} {
		if !strings.Contains(text, want) {
			t.Fatalf("report is missing %q:\n%s", want, text)
		}
	}
	if got, _, ok := Latest(dir); !ok || got != path {
		t.Fatalf("latestCrash = %q, %v", got, ok)
	}
	if got := Count(dir); got != 1 {
		t.Fatalf("crashCount = %d", got)
	}
	time.Sleep(10 * time.Millisecond)
	second, err := WriteReport(dir, "again", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, _, ok := Latest(dir); !ok || got != second {
		t.Fatalf("latestCrash after a second report = %q, %v", got, ok)
	}
	if got := Count(dir); got != 2 {
		t.Fatalf("crashCount after a second report = %d", got)
	}
}

func TestCrashDataDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", dir)
	SetDataDir("")
	if got := DataDir(); got != dir {
		t.Fatalf("fallback dir = %q, want %q", got, dir)
	}
	other := t.TempDir()
	SetDataDir(other)
	if got := DataDir(); got != other {
		t.Fatalf("recorded dir = %q, want %q", got, other)
	}
	SetDataDir("")
}
