package main

// Checks for reading usage out of session files and rolling it up.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// usageSession is a small session file with two billed answers.
const usageSession = `{"type":"session","version":3,"id":"s-1","timestamp":"2026-06-01T10:00:00.000Z","cwd":"C:/work/shop"}
{"type":"model_change","id":"a","parentId":null,"timestamp":"2026-06-01T10:00:01.000Z","provider":"acme","modelId":"acme-1"}
{"type":"message","id":"m1","parentId":"a","timestamp":"2026-06-01T10:00:02.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-06-01T10:00:03.000Z","message":{"role":"assistant","provider":"acme","model":"acme-1","content":[{"type":"text","text":"one"}],"usage":{"input":100,"output":20,"cacheRead":10,"cacheWrite":5,"totalTokens":135,"cost":{"total":0.05}}}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-06-01T10:01:00.000Z","message":{"role":"assistant","provider":"acme","model":"acme-2","content":[{"type":"text","text":"two"}],"usage":{"input":200,"output":40,"cacheRead":0,"cacheWrite":0,"totalTokens":240,"cost":{"total":0.10}}}}
`

// TestReadUsageFile checks the samples and the session id.
func TestReadUsageFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(usageSession), 0o644); err != nil {
		t.Fatal(err)
	}
	samples, id := readUsageFile(path)
	if id != "s-1" {
		t.Fatalf("id = %q", id)
	}
	if len(samples) != 2 {
		t.Fatalf("samples = %+v", samples)
	}
	first := samples[0]
	if first.Provider != "acme" || first.Model != "acme-1" || first.Total != 135 ||
		first.Input != 100 || first.Output != 20 || first.CacheRead != 10 || first.CacheWrite != 5 ||
		first.Cost != 0.05 || first.Cwd != "C:/work/shop" {
		t.Fatalf("first = %+v", first)
	}
	if samples[1].Model != "acme-2" || samples[1].Total != 240 {
		t.Fatalf("second = %+v", samples[1])
	}
}

// TestCollectUsage checks deduplication, buckets and the heatmap window.
func TestCollectUsage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(usageSession), 0o644); err != nil {
		t.Fatal(err)
	}
	// A copy of the same session must not double the totals.
	copyPath := filepath.Join(dir, "copy.jsonl")
	if err := os.WriteFile(copyPath, []byte(usageSession), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 6, 2, 12, 0, 0, 0, time.Local)
	report := collectUsage([]string{dir}, "", now)
	if report.Sessions != 1 {
		t.Fatalf("sessions = %d", report.Sessions)
	}
	if report.Replies != 2 || report.Total.Total != 375 {
		t.Fatalf("report = %+v", report)
	}
	if report.Total.Cost < 0.149 || report.Total.Cost > 0.151 {
		t.Fatalf("cost = %v", report.Total.Cost)
	}
	if len(report.Models) != 2 || report.Models[0].Name != "acme / acme-2" {
		t.Fatalf("models = %+v", report.Models)
	}
	if len(report.Projects) != 1 || report.Projects[0].Name != "shop" {
		t.Fatalf("projects = %+v", report.Projects)
	}
	if len(report.Days) < usageWindowDays {
		t.Fatalf("days = %d", len(report.Days))
	}
	if got := report.Days[0].Weekday; got != int(time.Monday) {
		t.Fatalf("first weekday = %d, want Monday", got)
	}
}

// TestHeatLevel checks the four steps and the empty day.
func TestHeatLevel(t *testing.T) {
	cases := []struct{ total, max, want int }{
		{0, 100, 0}, {1, 100, 1}, {20, 100, 2}, {50, 100, 3}, {90, 100, 4},
	}
	for _, c := range cases {
		if got := heatLevel(c.total, c.max); got != c.want {
			t.Errorf("heatLevel(%d, %d) = %d, want %d", c.total, c.max, got, c.want)
		}
	}
}

// TestUsageWeekRows checks 84 days become 12 rows of 7.
func TestUsageWeekRows(t *testing.T) {
	start := time.Date(2026, 1, 5, 0, 0, 0, 0, time.Local) // a Monday
	var days []usageDay
	for i := 0; i < usageWindowDays; i++ {
		d := start.AddDate(0, 0, i)
		days = append(days, usageDay{Date: d.Format("2006-01-02"), Weekday: int(d.Weekday())})
	}
	weeks := usageWeekRows(days)
	if len(weeks) != 12 {
		t.Fatalf("weeks = %d", len(weeks))
	}
	for i, w := range weeks {
		if len(w) != 7 {
			t.Fatalf("week %d has %d days", i, len(w))
		}
	}
}

// TestUsagePage checks the settings page shows a report read from the
// app's own session files.
func TestUsagePage(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", t.TempDir())
	dir := filepath.Join(home, "sessions", "--x--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(usageSession), 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-usage")
	app.WaitFor("text:最近 12 周", 10*time.Second)
	app.WaitFor(`text:"375"`, 5*time.Second)
}

// TestEstimateTokens checks the CJK and ASCII split.
func TestEstimateTokens(t *testing.T) {
	if got := estimateTokens("hello world"); got != 3 {
		t.Errorf("ascii = %d", got)
	}
	if got := estimateTokens("你好"); got != 2 {
		t.Errorf("cjk = %d", got)
	}
	if got := estimateTokens(""); got != 0 {
		t.Errorf("empty = %d", got)
	}
}

// TestReadACPUsage checks archived ACP turns become estimated samples.
func TestReadACPUsage(t *testing.T) {
	dir := t.TempDir()
	arch := acpArchive{ID: "acp-1", Preset: "claude", Cwd: "C:/w", Updated: time.Now(),
		Turns: []turn{{Prompt: "你好", Final: "你好，我在"}}}
	raw, err := json.Marshal(arch)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "acp-1.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	samples := readACPUsage(dir)
	if len(samples) != 1 {
		t.Fatalf("samples = %+v", samples)
	}
	s := samples[0]
	if !s.Estimated || s.Provider != "acp" || s.Model != "claude" || s.Input == 0 || s.Output == 0 {
		t.Fatalf("sample = %+v", s)
	}
}
