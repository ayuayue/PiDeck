//go:build !js && !android && !ios

package workbench

// Desktop integration: the tray icon, closing to it, and the system
// notification a finished turn posts. The tray's menu is built when it
// opens, so it shows the sessions running at that moment.

import (
	"runtime"
	"strings"
	"time"

	"example.com/pideck-lite/assets"
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
	"github.com/nsgo-dev/nsgo/ui"
)

// sessionNotificationPrefix names the session a notification opens.
const sessionNotificationPrefix = "session:"

// setupDesktop gives the app its tray and its close-to-tray behaviour,
// where the platform has a desktop. The phone build has neither.
func (a *app) setupDesktop() {
	if !desktop.IsAvailable(a.cx) {
		return
	}
	a.attachMainWindow()
	// A menu bar draws its icons as shapes in its own colors, so it takes
	// the glyph alone; Windows and Linux show the app's mark in color.
	icon, template := assets.LogoPNG, false
	if runtime.GOOS == "darwin" {
		icon, template = assets.TrayGlyphPNG, true
	}
	a.tray = desktop.NewTray(a.cx, desktop.TrayOptions{
		Icon:     icon,
		Template: template,
		Tooltip:  "PiDeck Lite",
		Menu:     a.trayMenu,
	})
	a.setupNotifications()
	a.setupSessionLinks()
	a.updateTray()
	a.watchWindow()
	// A second launch hands over to this instance instead of opening
	// another window and another phone server.
	desktop.OnReopen(a.cx, a.showMainWindow)
}

// setupNotifications opens the session a pressed notification names.
func (a *app) setupNotifications() {
	a.cx.OnNotificationPress(func(id string) {
		if strings.HasPrefix(id, sessionNotificationPrefix) {
			a.openSessionByID(strings.TrimPrefix(id, sessionNotificationPrefix))
			return
		}
		a.showMainWindow()
	})
}

// openSessionByID brings the window back and selects a session a
// notification named, when it is still loaded.
func (a *app) openSessionByID(id string) {
	for _, s := range a.all {
		if s != nil && s.ID == id {
			a.showMainWindow()
			a.selectSession(s)
			return
		}
	}
}

// attachMainWindow hooks the window's close once the platform has made
// it: Root runs before the window exists.
func (a *app) attachMainWindow() {
	if a.mainHooked {
		return
	}
	w := a.window()
	if w == nil {
		a.mainTries++
		if a.mainTries <= 25 {
			a.cx.AfterFunc(200*time.Millisecond, a.attachMainWindow)
		}
		return
	}
	a.mainHooked = true
	w.OnClosing(a.cx, func(c *core.WindowClosing) {
		if a.quitting || !a.cfg.CloseToTray {
			return
		}
		c.Cancel()
		w.Hide()
		if !a.trayHinted {
			a.trayHinted = true
			a.notifyDesktop("pideck:tray-hint", "PiDeck Lite 仍在运行", "点托盘图标可以重新打开窗口。", nil)
		}
	})
}

// window is the main window, looked up again if the platform replaced it.
func (a *app) window() *core.Window {
	if a.mainWin != nil && !a.mainWin.Closed() {
		return a.mainWin
	}
	if w := desktop.MainWindow(a.cx); w != nil {
		a.mainWin = w
		return w
	}
	if w := desktop.CurrentWindow(a.cx); w != nil {
		a.mainWin = w
		return w
	}
	return nil
}

// runningSessions are the sessions with a turn in flight, newest first.
func (a *app) runningSessions() []*session {
	var out []*session
	for _, s := range a.all {
		if s.busyNow() {
			out = append(out, s)
		}
	}
	return out
}

// showMainWindow brings the window back from the tray.
func (a *app) showMainWindow() {
	if w := a.window(); w != nil {
		w.Show()
		w.Focus()
	}
}

// quitApp ends the app even when close-to-tray would keep it.
func (a *app) quitApp() {
	a.quitting = true
	a.cx.Quit()
}

// updateTray puts the running count in the tooltip, keeps the computer
// awake and shows the task's progress while an agent runs.
func (a *app) updateTray() {
	a.syncRunState()
	if a.tray == nil {
		return
	}
	n := len(a.runningSessions())
	tip := "PiDeck Lite"
	if n > 0 {
		tip = apptext.T("PiDeck Lite · %d 个会话运行中", n)
	}
	a.tray.SetTooltip(tip)
}

// syncRunState holds the computer awake and shows the icon's progress
// while an agent runs, and releases both when none does.
func (a *app) syncRunState() {
	if !a.cx.Env().Desktop() {
		return
	}
	if len(a.runningSessions()) > 0 {
		if a.keepAwake == nil {
			a.keepAwake = a.cx.KeepAwake("PiDeck Lite: an agent is running", core.KeepAwakeOptions{})
		}
		a.cx.SetTaskProgress(core.TaskProgress{State: core.TaskProgressIndeterminate})
		return
	}
	if a.keepAwake != nil {
		a.keepAwake()
		a.keepAwake = nil
	}
	a.cx.SetTaskProgress(core.TaskProgress{State: core.TaskProgressNone})
}

// shouldNotify says whether a finished turn posts a notification.
func shouldNotify(cfg config, windowVisible bool) bool {
	if !cfg.NotifyOnDone {
		return false
	}
	if cfg.NotifyOnlyHidden && windowVisible {
		return false
	}
	return true
}

// notifyTurnDone posts a desktop notification for a finished turn, as
// the settings allow.
func (a *app) notifyTurnDone(s *session) {
	if s == nil {
		return
	}
	visible := false
	if w := a.window(); w != nil {
		visible = w.Visible()
	}
	if !shouldNotify(a.cfg, visible) {
		return
	}
	a.notifications.add(s, a.cx.Now())
	body := viewkit.FirstLine(lastAnswer(s), 90)
	if body == "" {
		body = "这一轮已完成。"
	}
	a.notifyDesktop(sessionNotificationPrefix+s.ID, "PiDeck Lite · "+s.title.GetUntracked(), body, nil)
}

// notifyDesktop posts a system notification. The ID is what a press reports
// to setupNotifications' handler. Desktops post straight away: Windows
// answers a permission query with "unavailable" until a toast has gone
// through, so asking first would refuse notifications that work. Phones and
// the web are asked first, as their systems gate them. It is best effort: a
// refused notification falls back to an in-app toast with the same text.
func (a *app) notifyDesktop(id, title, body string, done func(shown bool)) {
	if id == "" {
		return
	}
	notify := core.Notification{ID: id, Title: viewkit.FirstLine(title, 120), Body: viewkit.FirstLine(body, 200)}
	post := func() {
		err := a.cx.ShowNotification(notify, func(shown bool) {
			if !shown {
				// The platform took the notification and dropped it, or
				// refused it: say so where the app can be seen.
				a.toast(ui.ToastInfo, title, "系统没有显示这条通知："+body)
			}
			if done != nil {
				done(shown)
			}
		})
		if err != nil {
			a.toast(ui.ToastInfo, title, body)
			if done != nil {
				done(false)
			}
		}
	}
	// Desktops report a permission the app cannot trust — Windows answers
	// "unavailable" until a toast has gone through — while posting works
	// regardless. Post there, and ask only where the system really gates it
	// (phones and the web).
	if a.cx.Env().Desktop() {
		post()
		return
	}
	a.cx.NotificationPermission(func(p core.NotificationPermission) {
		switch p {
		case core.NotificationsGranted:
			post()
		case core.NotificationsNotAsked:
			a.cx.RequestNotificationPermission(func(p core.NotificationPermission) {
				if p == core.NotificationsGranted {
					post()
					return
				}
				if done != nil {
					done(false)
				}
			})
		default:
			if done != nil {
				done(false)
			}
		}
	})
}

// trayIdle is how often the tray's tooltip follows the running count.
const trayIdle = 2 * time.Second
