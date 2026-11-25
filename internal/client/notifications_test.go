package client

import (
	"testing"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
)

func TestNotificationSessionTitleUsesSessionName(t *testing.T) {
	language := apptext.CurrentLanguage()
	apptext.SetLanguage("zh-CN")
	t.Cleanup(func() { apptext.SetLanguage(language) })
	state := remotewire.Snapshot{Projects: []remotewire.Project{{Sessions: []remotewire.Session{
		{ID: "done", Title: "已完成任务"},
		{ID: "untitled"},
	}}}}
	for id, want := range map[string]string{"done": "已完成任务", "untitled": "会话", "missing": "会话"} {
		if got := notificationSessionTitle(state, id); got != want {
			t.Errorf("notificationSessionTitle(%q) = %q, want %q", id, got, want)
		}
	}
}
