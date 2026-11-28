//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) setWechatEnabled(on bool) {
	h := a.wechat
	if on && (h.connection.Token == "" || h.connection.Session == "") {
		h.status.Set(apptext.T("先登录微信并绑定会话。"))
		return
	}
	a.cfg.WeChatEnabled = on
	a.st.change(func(c *config) { c.WeChatEnabled = on })
	go func() {
		if err := a.st.save(); err != nil {
			a.cx.Post(func() { h.status.Set(err.Error()) })
		}
	}()
	a.bumpSettings()
	if on {
		a.startWechat()
	} else {
		a.stopWechat()
		h.status.Set(apptext.T("微信接收已关闭。"))
	}
}

func (a *app) bindWechatSession(s *session) {
	h := a.wechat
	if h == nil || !h.ready.GetUntracked() || !h.linked.GetUntracked() {
		a.toast(ui.ToastWarning, "微信 iLink", apptext.T("先登录微信并绑定会话。"))
		return
	}
	if s == nil || s.External || s.deleting || a.byID[s.ID] != s {
		a.toast(ui.ToastWarning, "微信 iLink", apptext.T("请先打开一个应用内的会话。"))
		return
	}
	if h.pending != nil {
		a.toast(ui.ToastWarning, "微信 iLink", apptext.T("会话正在运行，微信消息未提交；请稍后重发。"))
		return
	}
	ws := a.workspaceFor(s.Target, s.WS)
	if ws == nil || !a.projectTrusted(ws) {
		a.toast(ui.ToastWarning, "微信 iLink", apptext.T("请先在应用中信任绑定会话的项目。"))
		return
	}
	if h.connection.Session != s.ID {
		h.connection.Session = s.ID
		a.saveWechat()
		if a.cfg.WeChatEnabled {
			a.startWechat()
		}
	}
	h.status.Set(apptext.T("已绑定当前会话。"))
	a.toast(ui.ToastSuccess, "已绑定当前会话。", s.title.GetUntracked())
}

// wechatSessionMenu binds the session whose menu was opened, including background tabs.
func (a *app) wechatSessionMenu(sess func() *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s, h := sess(), a.wechat
		if h == nil || s == nil || s.External || s.deleting {
			return nil
		}
		h.status.Get()
		label := "绑定当前会话"
		if h.connection.Session == s.ID {
			label = "已绑定当前会话。"
		}
		item := a.menuRow(cx, lucide.Link, label, "", false, func() { a.bindWechatSession(sess()) })
		item.TestID = "wechat-bind"
		item.Disabled = func() bool { return !h.ready.Get() || !h.linked.Get() || h.pending != nil }
		return ui.Submenu{Text: apptext.T("微信 iLink"), Icon: lucide.MessageCircle, Back: apptext.T("微信 iLink"),
			TestID: "session-wechat-menu", Children: []core.Node{item}}
	})
}

func (a *app) logoutWechat() {
	h := a.wechat
	if h.loginCancel != nil {
		h.loginCancel()
		h.loginCancel = nil
	}
	h.loginSeq++
	a.setWechatEnabled(false)
	h.connection = wechatConnection{Version: 1}
	a.saveWechat()
	h.linked.Set(false)
	h.qr.Set(nil)
	h.needCode.Set(false)
	h.verify.Set("")
	h.status.Set(apptext.T("微信已退出登录。"))
}

func (a *app) wechatSettings() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		h := a.wechat
		colors := ui.ColorsOf(cx)
		return setGroup("微信 iLink",
			setRow("接收微信消息", "仅接收扫码登录账号的私聊，提交到绑定且已信任的会话；权限确认仍在应用内完成。",
				ui.Switch{Checked: func() bool { return a.cfg.WeChatEnabled }, OnChange: a.setWechatEnabled, Disabled: func() bool { return !h.ready.Get() }, Label: apptext.T("接收微信消息"), TestID: "wechat-enabled"}),
			core.Text{Content: apptext.T("会话") + " → " + apptext.T("微信 iLink") + " → " + apptext.T("绑定当前会话"),
				Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(6, 2)}, StyleFunc: ui.Colored(colors.Muted)},
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
				ui.Button{Text: apptext.T("扫码登录微信"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, Disabled: func() bool { return !h.ready.Get() }, TestID: "wechat-login", OnPress: a.loginWechat},
				ui.Button{Text: apptext.T("退出登录"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "wechat-logout", OnPress: a.logoutWechat},
			}},
			core.Dynamic(func(*core.Scope) core.Node {
				if len(h.qr.Get()) == 0 {
					return nil
				}
				return core.Image{Source: core.ImageSource{Data: h.qr.Get()}, ResizeMode: core.Contain, Label: apptext.T("微信登录二维码"), TestID: "wechat-qr", Style: core.Style{Width: core.Pt(220), Height: core.Pt(220)}}
			}),
			core.Show{When: h.needCode.Get, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					core.Input{Value: h.verify.Get, OnChange: h.verify.Set, Label: apptext.T("微信验证码"), TestID: "wechat-code", Style: panelFieldStyle(colors)},
					ui.Button{Text: apptext.T("提交验证码"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, TestID: "wechat-code-submit", OnPress: func() {
						code := strings.TrimSpace(h.verify.GetUntracked())
						if code != "" && len(code) <= 16 {
							select {
							case h.codes <- code:
								h.verify.Set("")
							default:
							}
						}
					}},
				}}
			}},
			core.Text{ContentFunc: h.status.Get, MaxLines: 4, Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(6, 2)}, StyleFunc: ui.Colored(colors.Muted)},
		)
	})
}
