package main

// Desktop integration: the tray icon, closing to it, and the system
// notification a finished turn posts. The tray's menu is built when it
// opens, so it shows the sessions running at that moment.

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
)

// setupDesktop gives the app its tray and its close-to-tray behaviour,
// where the platform has a desktop. The phone build has neither.
func (a *app) setupDesktop() {
	if mobileMode() || !desktop.IsAvailable(a.cx) {
		return
	}
	a.attachMainWindow()
	a.tray = desktop.NewTray(a.cx, desktop.TrayOptions{
		Icon:    logoPNG,
		Tooltip: "PiDeck Lite",
		Menu:    a.trayMenu,
	})
	a.updateTray()
	a.setupPet()
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
			notifyDesktop("PiDeck Lite 仍在运行", "点托盘图标可以重新打开窗口。")
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

// trayMenu is what the tray icon's menu shows.
func (a *app) trayMenu() []desktop.MenuItem {
	items := []desktop.MenuItem{
		{Label: T("显示 PiDeck Lite"), OnSelect: a.showMainWindow},
		{Label: T("新建会话"), OnSelect: func() {
			a.showMainWindow()
			a.newSession(a.activeWS.GetUntracked())
		}},
	}
	running := a.runningSessions()
	if len(running) > 0 {
		items = append(items, desktop.MenuItem{Separator: true})
		for _, s := range running {
			s := s
			items = append(items, desktop.MenuItem{
				Label:    T("运行中 · %s", s.title.GetUntracked()),
				OnSelect: func() { a.showMainWindow(); a.selectSession(s) },
			})
		}
	}
	items = append(items,
		desktop.MenuItem{Separator: true},
		desktop.MenuItem{Label: T("设置…"), OnSelect: func() { a.showMainWindow(); a.settings.Set(true) }},
		desktop.MenuItem{Label: T("退出"), OnSelect: a.quitApp},
	)
	return items
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

// updateTray puts the running count in the tooltip.
func (a *app) updateTray() {
	if a.tray == nil {
		return
	}
	n := len(a.runningSessions())
	tip := "PiDeck Lite"
	if n > 0 {
		tip = fmt.Sprintf("PiDeck Lite · %d 个会话运行中", n)
	}
	a.tray.SetTooltip(tip)
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
	body := firstLine(lastAnswer(s), 90)
	if body == "" {
		body = "这一轮已完成。"
	}
	notifyDesktop("PiDeck Lite · "+s.title.GetUntracked(), body)
}

// notifyDesktop posts a system notification with the platform's own
// tool. It is best effort: a platform without one, or a refused toast,
// leaves the in-app toast as the only notice.
func notifyDesktop(title, body string) {
	title = firstLine(title, 120)
	body = firstLine(body, 200)
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf("display notification %s with title %s", appleScriptString(body), appleScriptString(title))
		cmd := exec.Command("osascript", "-e", script)
		hideWindow(cmd)
		_ = cmd.Start()
	case "linux":
		cmd := exec.Command("notify-send", "-a", "PiDeck Lite", title, body)
		hideWindow(cmd)
		_ = cmd.Start()
	case "windows":
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", toastScript(title, body))
		hideWindow(cmd)
		_ = cmd.Start()
	}
}

// toastScript is the PowerShell that posts a Windows toast without any
// module: the WinRT notifier is part of Windows 10 and later.
func toastScript(title, body string) string {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	return "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null; " +
		"$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); " +
		"$n=$t.GetElementsByTagName('text'); " +
		"$n.Item(0).AppendChild($t.CreateTextNode(" + q(title) + ")) > $null; " +
		"$n.Item(1).AppendChild($t.CreateTextNode(" + q(body) + ")) > $null; " +
		"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PiDeck Lite').Show([Windows.UI.Notifications.ToastNotification]::new($t))"
}

// appleScriptString quotes a string for AppleScript.
func appleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// trayIdle is how often the tray's tooltip follows the running count.
const trayIdle = 2 * time.Second
