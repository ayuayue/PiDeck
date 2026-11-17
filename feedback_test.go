package main

// Checks the issue link the feedback dialog opens: what travels in the
// URL, and what stays on the clipboard because GitHub will not take it.

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestFeedbackSummary keeps the head of the report without the blanks.
func TestFeedbackSummary(t *testing.T) {
	report := "PiDeck Lite 0.2.0\n\nwindows/amd64\n\n数据目录：C:/tmp\npi：C:/bin/pi 1.5.2\n" +
		"goroutine：3\n\n进程：\n  没有\n\n最近日志：\n  10:00:00 [info] 启动\n"
	got := feedbackSummary(report)
	want := "PiDeck Lite 0.2.0\nwindows/amd64\n数据目录：C:/tmp\npi：C:/bin/pi 1.5.2\ngoroutine：3\n进程：\n  没有\n最近日志："
	if got != want {
		t.Fatalf("summary =\n%q\nwant\n%q", got, want)
	}
	if feedbackSummary("  \n \n") != "" {
		t.Fatal("an empty report made a summary")
	}
}

// TestFeedbackIssueURL puts the note in the link and the report beside it.
func TestFeedbackIssueURL(t *testing.T) {
	for _, lang := range []string{langZhCN, langEnUS} {
		defer setUILanguage(langZhCN)
		setUILanguage(lang)
		report := "PiDeck Lite 0.2.0\nwindows/amd64\n"
		link := feedbackIssueURL("导出没反应\n第二次就好了", report, "报告已复制")

		if !strings.HasPrefix(link, feedbackIssueBase+"?") {
			t.Fatalf("link = %q", link)
		}
		u, err := url.Parse(link)
		if err != nil {
			t.Fatal(err)
		}
		title := u.Query().Get("title")
		if !strings.Contains(title, "导出没反应") {
			t.Errorf("title %q has no first line", title)
		}
		if strings.Contains(title, "第二次") {
			t.Errorf("title %q took the second line", title)
		}
		body := u.Query().Get("body")
		if !strings.Contains(body, "第二次就好了") {
			t.Errorf("body %q lost the details", body)
		}
		if !strings.Contains(body, "windows/amd64") {
			t.Errorf("body %q has no environment", body)
		}
		if !strings.Contains(body, "报告已复制") {
			t.Errorf("body %q has no note", body)
		}
		if strings.Contains(link, " ") {
			t.Errorf("link %q has a raw space", link)
		}
	}
	// With nothing written the title still says what it is.
	empty := feedbackIssueURL("  ", "", "note")
	u, err := url.Parse(empty)
	if err != nil {
		t.Fatal(err)
	}
	if u.Query().Get("title") == "" {
		t.Fatal("an empty report has no title")
	}
}

// TestAnnounceExpiryUsesWallClock keeps a feed from outliving its window.
func TestAnnounceExpiryUsesWallClock(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	item := announceItem{ID: "x", Title: "x", Level: announceInfo,
		PublishedAt: now.Add(-time.Hour).Format(time.RFC3339), EffectiveUntil: now.Format(time.RFC3339)}
	if kept := filterAnnouncements([]announceItem{item}, now, "0.2.0"); len(kept) != 0 {
		t.Fatalf("an entry expiring now was kept: %+v", kept)
	}
	item.EffectiveUntil = now.Add(time.Second).Format(time.RFC3339)
	if kept := filterAnnouncements([]announceItem{item}, now, "0.2.0"); len(kept) != 1 {
		t.Fatalf("an entry with a second left was dropped")
	}
}
