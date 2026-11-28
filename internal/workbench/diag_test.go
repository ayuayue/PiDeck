//go:build !js && !android && !ios

package workbench

// Checks for the diagnostics ring and report.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"example.com/pideck/internal/appinfo"
)

// TestDiagRing keeps only the newest events and writes them to disk.
func TestDiagRing(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	a.initDiag()
	t.Cleanup(a.closeDiag)
	for i := 0; i < diagRing+50; i++ {
		a.diagf("info", "event %d", i)
	}
	events := a.diagSnapshot()
	if len(events) != diagRing {
		t.Fatalf("events = %d, want %d", len(events), diagRing)
	}
	if events[len(events)-1].Text != "event 349" {
		t.Fatalf("last = %q", events[len(events)-1].Text)
	}
	if err := a.diagJournal.flush(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "logs", "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "event 349") || !strings.Contains(string(raw), "应用启动") {
		t.Fatalf("log file = %s", raw)
	}
	a.clearDiag()
	if len(a.diagSnapshot()) != 0 {
		t.Fatal("clearDiag left events")
	}
}

// TestDiagnosticText checks the report names the app and the processes.
func TestDiagnosticText(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	a.initDiag()
	t.Cleanup(a.closeDiag)
	a.diagf("error", "something broke")
	text := a.diagnosticText()
	for _, want := range []string{"PiDeck " + appinfo.Version, "进程：", "something broke"} {
		if !strings.Contains(text, want) {
			t.Errorf("report lacks %q:\n%s", want, text)
		}
	}
}
