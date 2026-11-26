//go:build !js && !android && !ios

package workbench

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDiagLogBrowserFiltersAndConfirmsCleanup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	path := filepath.Join(home, "logs", "events.jsonl")
	j := newDiagJournal(path)
	for i, category := range []string{"git", "git", "session"} {
		ev := journalEvent(i+1, category, "info")
		if i == 0 {
			ev.Level = "error"
		}
		ev.Text = "history-fixture"
		j.append(ev)
	}
	j.close()

	screen := nsgotest.Start(t, Root, nsgotest.Size(1200, 900))
	screen.Press("label:设置")
	screen.Press("id:settings-tab-diagnostics")
	screen.WaitFor("id:diag-log-browser", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("text:正在读取日志…")) == 0 })
	screen.Type("id:diag-log-query", "history-fixture")
	screen.Press("id:diag-log-search")
	screen.WaitFor("text:共 3 条匹配，已显示 3 条", 5*time.Second)
	screen.Press("id:diag-log-category")
	screen.Press("id:diag-log-category-4") // Select's Git option.
	screen.WaitFor("text:共 2 条匹配，已显示 2 条", 5*time.Second)
	screen.Press("id:diag-log-level")
	screen.Press("id:diag-log-level-3") // Select's error option.
	screen.WaitFor("text:共 1 条匹配，已显示 1 条", 5*time.Second)

	screen.Press("id:diag-log-clear-filtered")
	screen.WaitFor("id:confirm-cancel", 5*time.Second)
	screen.Press("id:confirm-cancel")
	screen.Press("id:diag-log-refresh")
	screen.WaitFor("text:共 1 条匹配，已显示 1 条", 5*time.Second)
	screen.Press("id:diag-log-clear-filtered")
	screen.Press("id:confirm-ok")
	screen.WaitFor("text:已清理 1 条日志。", 5*time.Second)
	screen.WaitFor("text:共 0 条匹配，已显示 0 条", 5*time.Second)

	// Read the persisted history independently: only the confirmed match
	// should be gone; the other category and severity must survive.
	reader := newDiagJournal(path)
	defer reader.close()
	got, err := reader.query(diagFilter{Text: "history-fixture"}, 100)
	if err != nil || got.Total != 2 {
		t.Fatalf("persisted survivors = %+v, %v", got, err)
	}
	for _, ev := range got.Events {
		if ev.ID == "1" {
			t.Fatalf("cleared record survived: %+v", ev)
		}
	}

	screen.Press("id:diag-log-clear-all")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	// A record generated while the confirmation is open must survive even
	// when the user chooses to clear every category.
	writer := newDiagJournal(path)
	writer.append(diagEvent{Version: 1, ID: "after-confirmation", Time: time.Now(), Level: "info", Category: "session", Text: "history-fixture-new"})
	writer.close()
	screen.Press("id:confirm-ok")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("text:正在读取日志…")) == 0 })
	got, err = reader.query(diagFilter{Text: "history-fixture"}, 100)
	if err != nil || got.Total != 1 || got.Events[0].ID != "after-confirmation" {
		t.Fatalf("records generated during confirmation = %+v, %v", got, err)
	}
}
