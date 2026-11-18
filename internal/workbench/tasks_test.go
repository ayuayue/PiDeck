//go:build !js && !android && !ios

package workbench

// Checks the scheduled-task file and the small rules around it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestLoadTasksInterruptsRunning checks a restart never leaves a run
// looking alive, and that defaults are filled in.
func TestLoadTasksInterruptsRunning(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	state := tasksFile{Version: 1,
		Tasks: []*scheduledTask{{ID: "t1", Name: "每日整理", Prompt: "整理", Project: "/tmp", Cron: "0 9 * * *", Enabled: true}},
		Runs:  []taskRun{{ID: "r1", TaskID: "t1", TaskName: "每日整理", Status: taskRunning, StartedAt: time.Now()}},
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tasks.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	a.loadTasks()
	if got := a.taskList(); len(got) != 1 || got[0].Backend != "pi" || got[0].CreatedAt.IsZero() {
		t.Fatalf("tasks = %+v", got)
	}
	runs := a.taskRunList()
	if len(runs) != 1 || runs[0].Status != taskInterrupted || runs[0].Error == "" {
		t.Fatalf("runs = %+v", runs)
	}
}

// TestTrimTaskRuns keeps the newest runs, newest first.
func TestTrimTaskRuns(t *testing.T) {
	base := time.Now()
	var runs []taskRun
	for i := 0; i < taskHistoryLimit+5; i++ {
		runs = append(runs, taskRun{ID: string(rune('a' + i%26)), StartedAt: base.Add(time.Duration(i) * time.Second)})
	}
	out := trimTaskRuns(runs)
	if len(out) != taskHistoryLimit {
		t.Fatalf("trimmed to %d", len(out))
	}
	if !out[0].StartedAt.After(out[len(out)-1].StartedAt) {
		t.Error("runs are not newest first")
	}
}

// TestTaskTimeoutText checks the two shapes the message uses.
func TestTaskTimeoutText(t *testing.T) {
	if got := taskTimeoutText(30 * time.Minute); got != "30 分钟" {
		t.Errorf("minutes = %q", got)
	}
	if got := taskTimeoutText(90 * time.Second); got != "1m30s" {
		t.Errorf("seconds = %q", got)
	}
}

// TestSaveTaskFormState checks task normalization keeps a usable shape.
func TestSaveTaskFormState(t *testing.T) {
	now := time.Now()
	task := &scheduledTask{ID: "  t1 ", Name: " 每日 ", Prompt: " 整理 ", Project: " /tmp ", Cron: " ", Backend: "other"}
	normalizeTask(task, now)
	if task.ID != "t1" || task.Name != "每日" || task.Project != "/tmp" || task.Cron != "0 9 * * *" || task.Backend != "pi" {
		t.Fatalf("normalized = %+v", task)
	}
	if task.CreatedAt.IsZero() || task.LastScheduledAt.IsZero() {
		t.Error("timestamps were not filled")
	}
}
