//go:build !js && !android && !ios

package workbench

// 请作者喝咖啡（爱猹收打赏）的界面与动作：打开时查一次，支付码就地画出来，
// 用户付款后每 5 秒重查一次，次数变多就算到账。

import (
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// watchaUser is this installation's id, created the first time it is
// needed and kept in the config.
func (a *app) watchaUser() string {
	if id := strings.TrimSpace(a.cfg.WatchaUserID); watchaUserRE.MatchString(id) {
		return id
	}
	id, err := newInstallID()
	if err != nil {
		return ""
	}
	a.cfg.WatchaUserID = id
	if a.st != nil {
		a.st.edit(func(c *config) { c.WatchaUserID = id })
	}
	return id
}

// openSupport shows the dialog and asks the proxy straight away. Closing
// throws the ticket away: it is short-lived and never worth persisting.
func (a *app) openSupport() {
	a.supportSnapshot = watchaSnapshot{}
	a.supportBase = 0
	a.supportQR = nil
	a.supportPaid.Set(false)
	a.supportErr.Set("")
	a.supportPolling.Set(false)
	a.supportState.Set("")
	a.supportOpen.Set(true)
	a.supportLoad(false)
}

// supportLoad asks for the tip state; force skips nothing here because the
// answer is only kept for the dialog's lifetime.
func (a *app) supportLoad(force bool) {
	if !force && a.supportSnapshot.Access != "" {
		return
	}
	a.supportBusy.Set(true)
	a.supportErr.Set("")
	go func() {
		user := a.watchaUser()
		snapshot, err := fetchWatchaAccess(user)
		a.cx.Post(func() {
			a.supportBusy.Set(false)
			if err != nil {
				a.supportErr.Set(watchaErrorText(err))
				return
			}
			a.applySupport(snapshot, false)
		})
	}()
}

// applySupport stores a snapshot, redraws its code, and starts watching
// for the payment when it is asked to.
func (a *app) applySupport(snapshot watchaSnapshot, polling bool) {
	a.supportSnapshot = snapshot
	a.supportQR = qrPNGFor(snapshot.PurchaseURL)
	a.supportState.Set(watchaAccessLabel(snapshot))
	if snapshot.Access == watchaGranted {
		a.supportBase = snapshot.Remaining
	}
	if polling {
		a.supportWatch()
	}
}

// supportPay opens the ticket the proxy handed out. Alipay links go to the
// app; a page goes to the browser. Either way the dialog starts watching,
// because opening the link is not proof of payment.
func (a *app) supportPay() {
	url := a.supportSnapshot.PurchaseURL
	if url == "" {
		return
	}
	a.cx.OpenURL(url, nil)
	a.supportWatch()
}

// supportWatch re-reads the tip state every five seconds until the count
// grows, the dialog closes, or two minutes pass.
func (a *app) supportWatch() {
	a.supportStop()
	stop := make(chan struct{})
	a.supportPayStop = stop
	a.supportPolling.Set(true)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		deadline := time.NewTimer(2 * time.Minute)
		defer deadline.Stop()
		for {
			select {
			case <-stop:
				return
			case <-deadline.C:
				a.cx.Post(func() {
					if a.supportPayStop == stop {
						a.supportPolling.Set(false)
					}
				})
				return
			case <-ticker.C:
			}
			user := a.watchaUser()
			snapshot, err := fetchWatchaAccess(user)
			reached := err == nil && snapshot.Remaining > a.supportBase
			a.cx.Post(func() {
				select {
				case <-stop:
					return
				default:
				}
				if err != nil || snapshot.Access == "" {
					return
				}
				if reached {
					a.supportPaid.Set(true)
					a.supportPolling.Set(false)
					a.supportSnapshot = snapshot
					a.supportQR = nil
					a.supportState.Set(watchaAccessLabel(snapshot))
					a.supportStop()
					return
				}
				a.applySupport(snapshot, false)
			})
			if reached {
				return
			}
		}
	}()
}

// supportStop ends the watching goroutine.
func (a *app) supportStop() {
	a.supportStopMu.Lock()
	stop := a.supportPayStop
	a.supportPayStop = nil
	a.supportStopMu.Unlock()
	if stop != nil {
		close(stop)
	}
	a.supportPolling.Set(false)
}

// supportClose ends the watch and forgets the ticket.
func (a *app) supportClose() {
	a.supportStop()
	a.supportSnapshot = watchaSnapshot{}
	a.supportQR = nil
	a.supportOpen.Set(false)
}

// watchaErrorText names a failure in the user's language.
func watchaErrorText(err error) string {
	code := err.Error()
	if e, ok := err.(watchaError); ok {
		code = e.Code
	}
	switch code {
	case watchaNotConfigured:
		return apptext.T("当前版本没有接入支付代理。")
	case watchaTimeoutCode:
		return apptext.T("查询超时，请稍后重试。")
	case watchaNetworkCode:
		return apptext.T("网络不可用，请检查代理或稍后重试。")
	}
	return apptext.T("支付服务返回了无法识别的结果。")
}

// supportDialog is 「请作者喝咖啡」: a code to scan, the state of the tip
// page, and a refresh.
func (a *app) supportDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		busy := a.supportBusy.Get()
		png := a.supportQR
		snapshot := a.supportSnapshot
		var code core.Node
		if len(png) > 0 {
			code = core.View{Style: core.Style{Padding: core.All(10), CornerRadius: 10, Background: core.RGBA(0xFFFFFF, 1)},
				Children: []core.Node{core.Image{Source: core.ImageSource{Data: png}, ResizeMode: core.Contain,
					Label: apptext.T("请作者喝咖啡的购买二维码"), Style: core.Style{Width: core.Pt(208), Height: core.Pt(208)}}}}
		} else {
			code = core.View{StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(208), Height: core.Pt(208), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
					BorderWidth: 1, BorderColor: colors.Border(), CornerRadius: 8, Background: colors.Surface()}
			}, Children: []core.Node{ui.Icon(lucide.Coffee, 26, colors.Faint)}}
		}
		var notes []core.Node
		if err := a.supportErr.Get(); err != "" {
			notes = append(notes, core.Text{Content: err, MaxLines: 3, Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		switch {
		case busy:
			notes = append(notes, core.Text{Content: apptext.T("正在获取支付码…"), Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)})
		case snapshot.PurchaseURL != "":
			notes = append(notes, core.Text{Content: apptext.T("用支付宝扫一扫购买"), Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)})
			notes = append(notes, core.Text{Content: apptext.T("支付码 5 分钟内有效，过期会自动换新"), Style: core.Style{FontSize: 9.5},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		if state := a.supportState.Get(); state != "" {
			notes = append(notes, core.Text{Content: state, MaxLines: 2, Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Muted)})
		}
		if a.supportPaid.Get() {
			notes = append(notes, core.Text{Content: apptext.T("已到账，谢谢！"), Style: core.Style{FontSize: 11},
				StyleFunc: ui.Colored(colors.Up)})
		} else if a.supportPolling.Get() && !busy {
			notes = append(notes, core.Text{Content: apptext.T("等待支付…到账后自动刷新"), Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		footer := []core.Node{
			ui.Button{Text: apptext.T("刷新"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "support-refresh",
				Disabled: func() bool { return busy }, OnPress: func() { a.supportLoad(true) }},
		}
		if snapshot.PurchaseURL != "" {
			label := apptext.T("浏览器打开")
			if strings.HasPrefix(strings.ToLower(snapshot.PurchaseURL), "alipays://") {
				label = apptext.T("用支付宝打开")
			}
			footer = append(footer, ui.Button{Text: label, Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
				TestID: "support-pay", OnPress: a.supportPay})
		}
		footer = append(footer, ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			TestID: "support-close", OnPress: a.supportClose})
		return ui.Dialog{
			Open:         a.supportOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.supportClose() },
			Title:        apptext.T("请作者喝咖啡"),
			Description:  apptext.T("PiDeck 是免费的。如果它帮到了你，可以请作者喝杯咖啡——纯打赏，不绑定会话和用量，点一次就完事。"),
			TestID:       "support",
			Style:        core.Style{Width: core.Pt(400)},
			Children:     []core.Node{core.View{Style: core.Style{Gap: 10, AlignItems: core.AlignCenter}, Children: append([]core.Node{code}, notes...)}},
			Footer:       footer,
		}
	})
}
