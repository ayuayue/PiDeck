package client

import (
	"encoding/hex"
	"hash/fnv"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// The notification ID is tied to the connected desktop so a notification
// from an earlier connection cannot open a different desktop's session.
func (a *mobileApp) notificationPrefix() string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(a.server.GetUntracked()))
	return "pideck-session:" + hex.EncodeToString(h.Sum(nil)) + ":"
}

func (a *mobileApp) installNotificationHandler() {
	a.cx.OnNotificationPress(func(id string) {
		session, found := strings.CutPrefix(id, a.notificationPrefix())
		if !found || !a.connected.GetUntracked() {
			return
		}
		for _, project := range a.state.GetUntracked().Projects {
			for _, s := range project.Sessions {
				if s.ID == session {
					a.openSession(s.ID, s.Title)
					return
				}
			}
		}
	})
}

func (a *mobileApp) notifySession(id string, waiting bool) {
	if !a.notifyOn.GetUntracked() || id == "" {
		return
	}
	body := apptext.T("会话已结束一轮。")
	if waiting {
		body = apptext.T("会话正在等待你的确认。")
	}
	_ = a.cx.ShowNotification(core.Notification{ID: a.notificationPrefix() + id, Title: "PiDeck V2", Body: body, Silent: a.soundOn.GetUntracked()}, nil)
}

func (a *mobileApp) notificationSettings(colors ui.Colors) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10}, Children: []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 3}, Children: []core.Node{
			ui.Text(apptext.T("系统通知"), 12, ui.Medium, colors.Text),
			ui.Text(apptext.T("连接期间提醒回合结束和等待确认。"), 11, ui.Regular, colors.Muted),
		}},
		ui.Switch{Checked: a.notifyOn.Get, Label: apptext.T("系统通知"), TestID: "mobile-notifications", OnChange: func(on bool) {
			if !on {
				a.notifyOn.Set(false)
				a.saveLook()
				return
			}
			a.cx.RequestNotificationPermission(func(p core.NotificationPermission) {
				a.notifyOn.Set(p == core.NotificationsGranted)
				a.saveLook()
				if p != core.NotificationsGranted {
					a.notice.Set(apptext.T("系统通知尚未获得授权。"))
				}
			})
		}},
	}}
}
