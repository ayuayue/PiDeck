package main

// Checks the local HTML export.

import (
	"strings"
	"testing"
	"time"
)

// TestRenderSessionHTML checks content is escaped and the turn is drawn.
func TestRenderSessionHTML(t *testing.T) {
	page := renderSessionHTML(exportData{
		Title:   "测试会话",
		Project: "C:/work/shop",
		Model:   "acme/one",
		When:    time.Date(2026, 6, 1, 10, 0, 0, 0, time.Local),
		Turns: []turn{{
			Prompt: `<script>alert("x")</script>`,
			Steps: []turnStep{{
				Thinking: "想一想",
				Text:     "第一段",
				Tools:    []toolRun{{Action: "运行", Detail: "go test", Output: "ok", Status: 2}},
			}},
			Final: "最后回答",
		}},
	})
	for _, want := range []string{"测试会话", "C:/work/shop", "第一段", "最后回答", "go test", "想一想"} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if strings.Contains(page, `<script>alert`) {
		t.Fatal("the prompt was not escaped")
	}
	if !strings.Contains(page, "&lt;script&gt;") {
		t.Fatal("the escaped prompt is missing")
	}
}

// TestSanitizeFileName checks path characters are replaced.
func TestSanitizeFileName(t *testing.T) {
	if got := sanitizeFileName(`a/b\c:d*e?f"g<h>i|j`); strings.ContainsAny(got, `/\:*?"<>|`) {
		t.Fatalf("name = %q", got)
	}
	if got := sanitizeFileName("   "); got != "session" {
		t.Fatalf("blank = %q", got)
	}
}
