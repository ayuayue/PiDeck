//go:build !js && !android && !ios

package workbench

import (
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestAskNotificationReachesDesktopAndApp(t *testing.T) {
	for _, kind := range []string{"pi-batch", "permission-select"} {
		t.Run(kind, func(t *testing.T) {
			a, screen, s := newAskApp(t)
			t.Cleanup(notificationHistoryWrites.Wait)
			screen.NotificationPermission = core.NotificationsGranted
			onNativeUI(t, screen, a, func() {
				a.cfg.NotifyOnDone = false
				a.cfg.NotifyOnWaiting = true
				a.cfg.NotifyOnlyHidden = false
				a.setupNotifications()
				ask := &extensionAsk{ID: "notify-ask", Method: remotewire.AskMethodBatch,
					Questions: []askQuestion{{ID: "q1", Type: askConfirm, Question: "请确认执行"}}}
				if kind == "permission-select" {
					ask = &extensionAsk{ID: "permission-notify", Method: "select", Title: "确认运行测试", Options: []string{"Allow once"}}
				}
				a.enqueueAsk(s, ask)
			})
			screen.Advance(100 * time.Millisecond)

			if len(screen.Notifications) != 1 {
				t.Fatalf("question desktop notifications = %v, want one", screen.Notifications)
			}
			if got := screen.Notifications[0]; got.ID != sessionNotificationPrefix+s.ID || got.Title != "问一句话" || got.Body != apptext.T("Agent 正在等待你的回答或确认。") {
				t.Errorf("question notification = %+v, want the session title and waiting message", got)
			}
			if entries := a.notifications.entries.GetUntracked(); len(entries) != 1 || entries[0].Session != s.ID {
				t.Errorf("question notification history = %+v, want the waiting session", entries)
			}
			screen.WaitFor("role:button 打开会话", 5*time.Second)
			onNativeUI(t, screen, a, func() { a.activeID.Set("") })
			screen.Press("role:button 打开会话")
			if got := a.activeID.GetUntracked(); got != s.ID {
				t.Errorf("in-app notification opened %q, want %q", got, s.ID)
			}
			onNativeUI(t, screen, a, func() { a.activeID.Set("") })
			screen.PressNotification(sessionNotificationPrefix + s.ID)
			screen.Settle()
			if got := a.activeID.GetUntracked(); got != s.ID {
				t.Errorf("desktop notification opened %q, want %q", got, s.ID)
			}
		})
	}
}

func TestAskNotificationControls(t *testing.T) {
	for _, tc := range []struct {
		name       string
		enabled    bool
		onlyHidden bool
		hidden     bool
		denied     bool
		wantSystem int
		wantApp    int
	}{
		{name: "disabled"},
		{name: "foreground-hidden-only", enabled: true, onlyHidden: true, wantApp: 1},
		{name: "hidden", enabled: true, onlyHidden: true, hidden: true, wantSystem: 1, wantApp: 1},
		{name: "foreground-allowed", enabled: true, wantSystem: 1, wantApp: 1},
		{name: "system-denied", enabled: true, denied: true, wantApp: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PIDECK_V2_HOME", t.TempDir())
			dir := t.TempDir()
			var a *app
			var s *session
			screen := nsgotest.StartApp(t, func(cx *core.Scope) {
				nsgo.SetMainView(cx, func(cx *core.Scope) core.Node {
					a = newApp(cx)
					s = a.blankSession("waiting", &workspace{Path: dir}, "待确认会话")
					a.byID[s.ID] = s
					a.all = append(a.all, s)
					return a.view()
				})
			}, nsgotest.Size(1200, 800), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
			t.Cleanup(a.closeDiag)
			t.Cleanup(notificationHistoryWrites.Wait)
			w := a.window()
			if w == nil {
				t.Fatal("fixture has no desktop window")
			}
			screen.NotificationPermission = core.NotificationsGranted
			if tc.denied {
				screen.NotificationPermission = core.NotificationsDenied
			}
			onNativeUI(t, screen, a, func() {
				a.cfg.NotifyOnDone = true
				a.cfg.NotifyOnWaiting = tc.enabled
				a.cfg.NotifyOnlyHidden = tc.onlyHidden
				if tc.hidden {
					w.Hide()
				}
				a.enqueueAsk(s, &extensionAsk{ID: "waiting", Method: "confirm", Title: "请确认"})
			})
			screen.Settle()
			if got := len(screen.Notifications); got != tc.wantSystem {
				t.Errorf("system notifications = %d, want %d", got, tc.wantSystem)
			}
			if got := len(a.notifications.entries.GetUntracked()); got != tc.wantApp {
				t.Errorf("notification history = %d, want %d", got, tc.wantApp)
			}
			if got := len(screen.QueryMounted("role:button 打开会话")); got != tc.wantApp {
				t.Errorf("in-app actions = %d, want %d", got, tc.wantApp)
			}
		})
	}
}

func TestAskNotificationWaitsForQueuedCard(t *testing.T) {
	a, screen, s := newAskApp(t)
	t.Cleanup(notificationHistoryWrites.Wait)
	screen.NotificationPermission = core.NotificationsGranted
	first := &extensionAsk{ID: "first", Method: "confirm", Title: "先确认"}
	second := &extensionAsk{ID: "second", Method: "confirm", Title: "再确认"}
	onNativeUI(t, screen, a, func() {
		a.cfg.NotifyOnWaiting = true
		a.cfg.NotifyOnlyHidden = false
		a.enqueueAsk(s, first)
		a.enqueueAsk(s, second)
	})
	screen.Settle()
	if got := len(a.notifications.entries.GetUntracked()); got != 1 {
		t.Fatalf("queued question posted early: history = %d, want 1", got)
	}
	onNativeUI(t, screen, a, func() { a.popAsk(s, first) })
	screen.Settle()
	if got := len(a.notifications.entries.GetUntracked()); got != 2 {
		t.Fatalf("next question did not notify when shown: history = %d, want 2", got)
	}
}
