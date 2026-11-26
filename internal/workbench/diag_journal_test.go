//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func journalEvent(n int, category, level string) diagEvent {
	return diagEvent{Version: 1, ID: fmt.Sprint(n), Time: time.Date(2026, 11, 1, 12, n, 0, 0, time.UTC),
		Category: category, Level: level, Text: fmt.Sprintf("operation %d", n)}
}

func TestDiagJournalHistoryAndFilters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	j := newDiagJournal(path)
	j.append(journalEvent(1, "git", "info"))
	j.append(journalEvent(2, "acp", "error"))
	j.append(journalEvent(3, "git", "warn"))
	j.close()
	j = newDiagJournal(path)
	t.Cleanup(j.close)
	for _, tc := range []struct {
		name   string
		filter diagFilter
		want   int
	}{
		{"history", diagFilter{}, 3},
		{"category", diagFilter{Category: "git"}, 2},
		{"level", diagFilter{Level: "error"}, 1},
		{"combined", diagFilter{Category: "git", Level: "warn", Text: "OPERATION 3"}, 1},
		{"time", diagFilter{Since: journalEvent(2, "", "").Time, Until: journalEvent(2, "", "").Time}, 1},
		{"empty", diagFilter{Category: "session", Text: "operation"}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := j.query(tc.filter, 100)
			if err != nil || got.Total != tc.want || len(got.Events) != tc.want {
				t.Fatalf("query = %+v, err=%v; want %d", got, err, tc.want)
			}
		})
	}
	got, err := j.query(diagFilter{}, 2)
	if err != nil || got.Total != 3 || len(got.Events) != 2 || got.Events[0].ID != "3" {
		t.Fatalf("limited newest first = %+v, err=%v", got, err)
	}
}

func TestDiagJournalClearPreservesOtherRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	j := newDiagJournal(path)
	t.Cleanup(j.close)
	for i := 1; i <= 3; i++ {
		j.append(journalEvent(i, "git", "info"))
	}
	j.append(journalEvent(4, "acp", "error"))
	removed, err := j.clear(diagFilter{Category: "git", Until: journalEvent(2, "", "").Time})
	if err != nil || removed != 2 {
		t.Fatalf("clear = %d, %v", removed, err)
	}
	j.append(journalEvent(5, "session", "info"))
	got, err := j.query(diagFilter{}, 100)
	if err != nil || got.Total != 3 || got.Events[2].ID != "3" {
		t.Fatalf("remaining = %+v, err=%v", got, err)
	}
	if _, err := j.clear(diagFilter{}); err != nil {
		t.Fatal(err)
	}
	got, err = j.query(diagFilter{}, 100)
	if err != nil || got.Total != 0 {
		t.Fatalf("after clear all = %+v, %v", got, err)
	}
}

func TestDiagJournalLegacyAndCorruptRecords(t *testing.T) {
	dir := t.TempDir()
	legacy := "2026-11-01T11:00:00Z [warn] ACP disconnected\nmalformed\n"
	if err := os.WriteFile(filepath.Join(dir, "pideck.log.1"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "events.jsonl"), []byte("{broken}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	j := newDiagJournal(filepath.Join(dir, "events.jsonl"))
	t.Cleanup(j.close)
	j.append(journalEvent(1, "git", "info"))
	got, err := j.query(diagFilter{}, 100)
	if err != nil || got.Total != 2 || got.Ignored != 2 {
		t.Fatalf("query = %+v, %v", got, err)
	}
	if got.Events[1].Category != "acp" {
		t.Fatalf("legacy category = %q", got.Events[1].Category)
	}
	if _, err := j.clear(diagFilter{Category: "acp"}); err != nil {
		t.Fatal(err)
	}
	got, err = j.query(diagFilter{}, 100)
	if err != nil || got.Total != 1 || got.Ignored != 2 {
		t.Fatalf("remaining = %+v, %v", got, err)
	}
}

func TestDiagJournalRotationAndConcurrentWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	j := newDiagJournal(path)
	t.Cleanup(j.close)
	var wg sync.WaitGroup
	for k := 0; k < 4; k++ {
		wg.Go(func() {
			for i := 0; i < 100; i++ {
				j.append(journalEvent(i, "session", "info"))
			}
		})
	}
	wg.Wait()
	got, err := j.query(diagFilter{}, 500)
	if err != nil || got.Total != 400 {
		t.Fatalf("concurrent = %d, %v", got.Total, err)
	}
	for i := 0; i < 400; i++ {
		ev := journalEvent(i, "app", "info")
		ev.Text = strings.Repeat("x", 4096)
		j.append(ev)
	}
	if err := j.flush(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("rotation: %v", err)
	}
	got, err = j.query(diagFilter{}, 1000)
	if err != nil || got.Total != 800 {
		t.Fatalf("rotated query = %d, %v", got.Total, err)
	}
	for i := 0; i <= diagFileBackups; i++ {
		name := path
		if i > 0 {
			name += fmt.Sprintf(".%d", i)
		}
		if info, err := os.Stat(name); err == nil && info.Size() > diagFileLimit {
			t.Fatalf("%s is %d bytes, limit %d", name, info.Size(), diagFileLimit)
		}
	}
}

func TestDiagJournalPartialTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.WriteFile(path, []byte(`{"version":1,"text":"interrupted`), 0o600); err != nil {
		t.Fatal(err)
	}
	j := newDiagJournal(path)
	t.Cleanup(j.close)
	j.append(journalEvent(1, "startup", "info"))
	got, err := j.query(diagFilter{}, 100)
	if err != nil || got.Total != 1 || got.Ignored != 1 || got.Events[0].ID != "1" {
		t.Fatalf("records following a partial write = %+v, %v", got, err)
	}
}

func TestDiagJournalReadFailureKeepsBoundedResults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.Mkdir(path+".1", 0o700); err != nil {
		t.Fatal(err)
	}
	j := newDiagJournal(path)
	t.Cleanup(j.close)
	for i := 1; i <= 3; i++ {
		j.append(journalEvent(i, "app", "info"))
	}
	got, err := j.query(diagFilter{}, 1)
	if err == nil || got.Total != 3 || len(got.Events) != 1 || got.Events[0].ID != "3" {
		t.Fatalf("bounded results with an unreadable backup = %+v, %v", got, err)
	}
}

func TestDiagJournalWriteFailureIsVisible(t *testing.T) {
	dir := t.TempDir()
	blocked := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	j := newDiagJournal(filepath.Join(blocked, "events.jsonl"))
	t.Cleanup(j.close)
	j.append(journalEvent(1, "app", "error"))
	if err := j.flush(); err == nil {
		t.Fatal("disk failure was silently ignored")
	}
}

func TestDiagRedaction(t *testing.T) {
	text := `Authorization: Bearer private-bearer api_key="private-key" token=private-token password: private-pass https://user:private-password@example.test/v1?key=private-query C:\Users\private-user\project\file.go /home/private-user/project/file.go`
	got := redactDiagText(text)
	for _, secret := range []string{"private-bearer", "private-key", "private-token", "private-pass", "private-password", "private-query", "private-user"} {
		if strings.Contains(got, secret) {
			t.Errorf("log leaked %q: %s", secret, got)
		}
	}
	command := diagCommand("C:\\private-user\\agent.exe", []string{"--acp", "--token", "private-token", "--api-key=private-key", "--prompt", "private-prompt", "--model", "test-model"})
	if strings.Contains(command, "private-") || !strings.Contains(command, "--acp") || !strings.Contains(command, "test-model") {
		t.Fatalf("command = %s", command)
	}
}
