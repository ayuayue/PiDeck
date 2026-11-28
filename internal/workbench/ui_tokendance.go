//go:build !js && !android && !ios

package workbench

// The TokenDance block of the settings page and its three dialogs: the
// key, a recharge that waits for the payment, and the tip page.

import (
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// tokenDanceGroup is the built-in provider's account: its state, the
// catalog pull, and the recharge.
func (a *app) tokenDanceGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		keyState, tone := apptext.T("未配置"), colors.Warn
		info, _ := a.providerInfoOf(tokenDanceProvider)
		if info.Credential.Kind != "" && info.Credential.Ready {
			keyState, tone = apptext.T("已配置"), colors.Up
		}
		balance := a.tdBalance.Get()
		if err := a.tdBalanceErr.Get(); err != "" {
			balance = apptext.T("读取失败：%s", err)
		}
		if balance == "" {
			balance = apptext.T("填入 API Key 后显示余额。")
		}
		busy := a.tdBusy.Get() || a.tdModelBusy.Get()
		control := func(label, testID string, on func()) core.Node {
			return ui.Button{Text: label, Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: testID,
				Disabled: func() bool { return busy }, OnPress: on}
		}
		return setGroup(apptext.T("TokenDance 账户"),
			setRow("余额", apptext.T("平台按元计费；充值进入这个 API Key 所属的账户。"),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.Text{Content: balance, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style:     core.Style{MaxWidth: core.Pt(240), FontFamily: viewkit.MonoFont(), FontSize: 10.5},
						StyleFunc: ui.Colored(colors.Muted)},
					control(apptext.T("刷新"), "td-balance-refresh", a.tdRefresh),
				}}),
			setDivider(),
			setRow("API Key", apptext.T("在 tokendance.space 的「API 密钥」页创建；只写进 pi 的 auth.json。"),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Text(keyState, 10.5, ui.Medium, tone),
					ui.Button{Text: apptext.T("登录…"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "td-login",
						OnPress: a.tdLogin},
					ui.Button{Text: apptext.T("填入密钥…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "td-key-open",
						OnPress: a.tdOpenKey},
				}}),
			setDivider(),
			setRow("模型目录", a.tdModelHint(),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					control(apptext.T("拉取模型"), "td-models-pull", a.tdPullModels),
				}}),
			setDivider(),
			setRow("充值", apptext.T("生成支付宝聚合码，扫码支付后自动到账。"),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					control(apptext.T("充值…"), "td-recharge-open", a.tdOpenRecharge),
				}}),
		)
	})
}

// tdModelHint is the line under the catalog row: the last pull's result,
// or what pulling does.
func (a *app) tdModelHint() string {
	if msg := a.tdModelMsg.Get(); msg != "" {
		return msg
	}
	return apptext.T("拉取平台目录，把 OpenAI 兼容的模型写进 models.json；目录里没有的条目保留。")
}

// tdKeyDialog asks for the account's API key and checks it before saving.
func (a *app) tdKeyDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		errText := a.tdKeyErr.Get()
		busy := a.tdKeyBusy.Get()
		var notes []core.Node
		if errText != "" {
			notes = append(notes, core.Text{Content: errText, MaxLines: 3, Style: core.Style{FontSize: 10.5, LineHeight: 15},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		notes = append(notes, core.Text{Content: apptext.T("保存前会先查一次余额，密钥无效就不写入。"),
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
		return ui.Dialog{
			Open:         a.tdKeyOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.tdKeyOpen.Set(open) },
			Title:        apptext.T("TokenDance API Key"),
			Description:  apptext.T("密钥存在 pi 的 auth.json 里，重启 Agent 后 pi 就能用它。"),
			TestID:       "td-key",
			Style:        core.Style{Width: core.Pt(460)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Input{Value: a.tdKeyText.Get, OnChange: a.tdKeyText.Set, Masked: true,
					Placeholder: "sk-…", Label: apptext.T("TokenDance API Key"), TestID: "td-key-input",
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7, FontSize: 12,
						Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}},
				core.View{Style: core.Style{Gap: 4}, Children: notes},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.tdKeyOpen.Set(false) }},
				ui.Button{Text: busyButton(apptext.T("保存"), busy), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
					TestID: "td-key-save", Disabled: func() bool { return busy }, OnPress: a.tdSaveKey},
			},
		}
	})
}

// busyButton marks a button whose work is running.
func busyButton(label string, busy bool) string {
	if busy {
		return label + "…"
	}
	return label
}

// tdRechargeDialog shows the amount first, then the code to scan and the
// payment's state.
func (a *app) tdRechargeDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		session := a.tdPaySession
		var body []core.Node
		if session.ID == "" {
			chips := []core.Node{}
			for _, amount := range []string{"10", "30", "50", "100"} {
				amount := amount
				chips = append(chips, ui.Button{Text: "¥" + amount, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "td-pay-amount-" + amount, OnPress: func() { a.tdPayAmount.Set(amount) }})
			}
			body = append(body, core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Input{Value: a.tdPayAmount.Get, OnChange: a.tdPayAmount.Set, Placeholder: "10",
					Label: apptext.T("充值金额（元）"), TestID: "td-pay-amount",
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7, FontSize: 12,
						FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
						BorderWidth: 1, BorderColor: colors.FieldBorder()}},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: chips},
				core.Text{Content: apptext.T("1 到 100000 之间的整数元；钱进入这个 API Key 所属的 TokenDance 账户。"),
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
			}})
			if err := a.tdPayErr.Get(); err != "" {
				body = append(body, core.Text{Content: err, MaxLines: 3, Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Danger)})
			}
		} else {
			png := a.tdPayQR
			var code core.Node
			if len(png) == 0 {
				code = core.Text{Content: apptext.T("这个支付码装不下二维码，用下面的「打开链接」。"),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)}
			} else {
				code = core.View{Style: core.Style{Padding: core.All(10), CornerRadius: 10, Background: core.RGBA(0xFFFFFF, 1)},
					Children: []core.Node{core.Image{Source: core.ImageSource{Data: png}, ResizeMode: core.Contain,
						Label: apptext.T("支付二维码"), Style: core.Style{Width: core.Pt(220), Height: core.Pt(220)}}}}
			}
			expiry := ""
			if session.ExpiredAt > 0 {
				left := time.Until(time.Unix(session.ExpiredAt, 0))
				if left > 0 {
					expiry = apptext.T("有效期还剩 %s。", compactAge(left))
				} else {
					expiry = apptext.T("这个会话已经过期，重新创建一次。")
				}
			}
			notes := []core.Node{code,
				ui.Text(apptext.T("%d 元 · %s", session.Amount, a.tdPayStatus.Get()), 11.5, ui.Medium, colors.Text),
				core.Text{Content: expiry, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
				core.Text{Content: session.PaymentURL, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
					Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, TextAlign: core.TextAlignCenter},
					StyleFunc: ui.Colored(colors.Faint)},
			}
			if a.tdPayKeyHint != "" {
				notes = append(notes, core.Text{Content: apptext.T("充值记到这个 Key：%s", a.tdPayKeyHint),
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			body = append(body, core.View{Style: core.Style{Gap: 8, AlignItems: core.AlignCenter}, Children: notes})
		}
		title := apptext.T("充值 TokenDance")
		description := apptext.T("钱进入这个 API Key 所属的账户；选一个金额后生成支付码。")
		if session.ID != "" {
			description = apptext.T("手机用支付宝扫这个码；支付完成后这里会自己变成已到账。")
		}
		footer := []core.Node{
			ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "td-pay-close",
				OnPress: a.tdCloseRecharge},
		}
		if session.ID == "" {
			footer = append(footer, ui.Button{Text: busyButton(apptext.T("创建支付"), a.tdPayBusy.Get()), Variant: ui.ButtonPrimary,
				Size: ui.SizeSmall, TestID: "td-pay-create", Disabled: func() bool { return a.tdPayBusy.Get() },
				OnPress: a.tdStartPayment})
		} else {
			if session.AlipayURL != "" {
				footer = append(footer, ui.Button{Text: apptext.T("打开支付宝"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "td-pay-alipay", OnPress: func() { a.cx.OpenURL(session.AlipayURL, nil) }})
			}
			footer = append(footer, ui.Button{Text: apptext.T("检查状态"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
				TestID: "td-pay-check", OnPress: a.tdCheckPayment})
		}
		return ui.Dialog{
			Open:         a.tdPayOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.tdCloseRecharge() },
			Title:        title,
			Description:  description,
			TestID:       "td-recharge",
			Style:        core.Style{Width: core.Pt(420)},
			Children:     []core.Node{core.View{Style: core.Style{Gap: 10}, Children: body}},
			Footer:       footer,
		}
	})
}

// tdLoginDialog shows what the authorization is waiting for.
func (a *app) tdLoginDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.tdLoginOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.tdLoginStop() },
			Title:        apptext.T("登录 TokenDance"),
			Description:  apptext.T("浏览器里确认一次，应用会自动拿到 Key 并写进 models.json。"),
			TestID:       "td-login-dialog",
			Style:        core.Style{Width: core.Pt(420)},
			Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Spinner{Size: 14},
				core.Text{ContentFunc: func() string { return a.tdLoginState.Get() }, MaxLines: 3,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11, LineHeight: 16},
					StyleFunc: ui.Colored(colors.Muted)},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "td-login-cancel",
					OnPress: a.tdLoginStop},
			},
		}
	})
}
