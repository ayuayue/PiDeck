//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
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

func (a *app) bindWechatSession() {
	h := a.wechat
	s := a.active()
	if s == nil || s.External || s.deleting {
		h.status.Set(apptext.T("请先打开一个应用内的会话。"))
		return
	}
	ws := a.workspaceFor(s.Target, s.WS)
	if ws == nil || !a.projectTrusted(ws) {
		h.status.Set(apptext.T("请先在应用中信任绑定会话的项目。"))
		return
	}
	h.connection.Session = s.ID
	a.saveWechat()
	h.status.Set(apptext.T("已绑定当前会话。"))
	if a.cfg.WeChatEnabled {
		a.startWechat()
	}
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
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
				ui.Button{Text: apptext.T("扫码登录微信"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, Disabled: func() bool { return !h.ready.Get() }, TestID: "wechat-login", OnPress: a.loginWechat},
				ui.Button{Text: apptext.T("绑定当前会话"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "wechat-bind", Disabled: func() bool { return !h.linked.Get() }, OnPress: a.bindWechatSession},
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
					core.Input{Value: h.verify.Get, OnChange: h.verify.Set, Label: apptext.T("微信验证码"), TestID: "wechat-code", Style: draftFieldStyle(colors)},
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
