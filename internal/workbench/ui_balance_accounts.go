//go:build !js && !android && !ios

package workbench

import (
	"slices"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type balanceAccountsState struct {
	list                                                           *core.Signal[[]balanceAccount]
	open, busy, ready                                              *core.Signal[bool]
	selected, status, deleting, name, address, key, path, currency *core.Signal[string]
}

func (a *app) balanceAccountsSettings() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		h := a.balanceAccounts
		if h == nil {
			h = &balanceAccountsState{
				list: core.NewSignalFunc(a.cx, []balanceAccount(nil), nil),
				open: core.NewSignal(a.cx, false), busy: core.NewSignal(a.cx, false), ready: core.NewSignal(a.cx, false),
				selected: core.NewSignal(a.cx, ""), status: core.NewSignal(a.cx, ""), deleting: core.NewSignal(a.cx, ""),
				name: core.NewSignal(a.cx, ""), address: core.NewSignal(a.cx, ""), key: core.NewSignal(a.cx, ""),
				path: core.NewSignal(a.cx, "balance"), currency: core.NewSignal(a.cx, "USD"),
			}
			a.balanceAccounts = h
			go func() {
				accounts := readBalanceAccounts(a.st.dir)
				a.cx.Post(func() { h.list.Set(accounts); h.ready.Set(true) })
			}()
		}
		list, open, busy, ready := h.list, h.open, h.busy, h.ready
		selected, status, deleting := h.selected, h.status, h.deleting
		name, address, key, path, currency := h.name, h.address, h.key, h.path, h.currency
		ctx := a.lifetime
		persist := func(accounts []balanceAccount) {
			if busy.GetUntracked() {
				return
			}
			busy.Set(true)
			previous := slices.Clone(list.GetUntracked())
			go func() {
				err := saveBalanceAccountsIfCurrent(a.st.dir, previous, accounts)
				a.cx.Post(func() {
					busy.Set(false)
					if err != nil {
						status.Set(err.Error())
						return
					}
					list.Set(accounts)
					selected.Set("")
					key.Set("")
					name.Set("")
					address.Set("")
					path.Set("balance")
					currency.Set("USD")
					status.Set(apptext.T("已保存余额账户。"))
				})
			}()
		}
		field := func(label, id string, s *core.Signal[string], masked bool) core.Node {
			return setRow(label, "", core.Input{Value: s.Get, OnChange: s.Set, Disabled: busy.Get, Label: apptext.T(label), TestID: id, Masked: masked, Style: panelFieldStyle(colors).Merge(core.Style{Width: core.Pt(210)})})
		}
		return core.View{Children: []core.Node{
			setGroup("独立余额账户", setRow("余额多账号", "每个账户使用自己的接口和凭据，不改动 pi 的登录信息。",
				ui.Button{Text: apptext.T("管理账户…"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, TestID: "balance-accounts-open", Disabled: func() bool { return !ready.Get() }, OnPress: func() { open.Set(!open.GetUntracked()) }})),
			core.Show{When: open.Get, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					field("账户名称", "balance-account-name", name, false), field("余额接口", "balance-account-url", address, false), field("访问密钥", "balance-account-key", key, true), field("JSON 路径", "balance-account-path", path, false), field("货币", "balance-account-currency", currency, false),
					ui.Button{Text: apptext.T("保存账户"), TestID: "balance-account-save", Size: ui.SizeSmall, Variant: ui.ButtonSecondary, Disabled: busy.Get, OnPress: func() {
						id := selected.GetUntracked()
						if id == "" {
							id = newSessionID()
						}
						account := balanceAccount{ID: id, Name: strings.TrimSpace(name.GetUntracked()), URL: strings.TrimSpace(address.GetUntracked()), Key: strings.TrimSpace(key.GetUntracked()), Path: strings.TrimSpace(path.GetUntracked()), Currency: strings.TrimSpace(currency.GetUntracked())}
						if !account.valid() {
							status.Set(apptext.T("请输入账户名称和 HTTPS 余额接口。"))
							return
						}
						accounts := slices.Clone(list.GetUntracked())
						found := false
						for i := range accounts {
							if accounts[i].ID == id {
								accounts[i] = account
								found = true
								break
							}
						}
						if !found {
							accounts = append(accounts, account)
						}
						persist(accounts)
					}},
					core.Text{ContentFunc: status.Get, MaxLines: 3, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
					core.Dynamic(func(cx *core.Scope) core.Node {
						var rows []core.Node
						for _, account := range list.Get() {
							entry := account
							rows = append(rows, setRow(entry.Name, entry.URL, core.View{Style: core.Style{Direction: core.Row, Gap: 4}, Children: []core.Node{
								ui.Button{Text: apptext.T("查询"), TestID: "balance-account-query-" + entry.ID, Size: ui.SizeSmall, Variant: ui.ButtonGhost, Disabled: busy.Get, OnPress: func() {
									busy.Set(true)
									go func() {
										value, err := queryBalanceAccount(ctx, entry)
										a.cx.Post(func() {
											busy.Set(false)
											if err != nil {
												status.Set(err.Error())
											} else {
												status.Set(entry.Name + " · " + value)
											}
										})
									}()
								}},
								ui.Button{Text: apptext.T("编辑"), TestID: "balance-account-edit-" + entry.ID, Size: ui.SizeSmall, Variant: ui.ButtonGhost, Disabled: busy.Get, OnPress: func() {
									selected.Set(entry.ID)
									name.Set(entry.Name)
									address.Set(entry.URL)
									key.Set(entry.Key)
									path.Set(entry.Path)
									currency.Set(entry.Currency)
								}},
								ui.Button{Text: apptext.T("删除"), TestID: "balance-account-delete-" + entry.ID, Size: ui.SizeSmall, Variant: ui.ButtonGhost, Disabled: busy.Get, OnPress: func() {
									if deleting.GetUntracked() != entry.ID {
										deleting.Set(entry.ID)
										status.Set(apptext.T("再次点击删除以确认。"))
										return
									}
									accounts := slices.DeleteFunc(slices.Clone(list.GetUntracked()), func(v balanceAccount) bool { return v.ID == entry.ID })
									persist(accounts)
									deleting.Set("")
								}},
							}}))
						}
						return core.View{Style: core.Style{Gap: 4}, Children: rows}
					}),
				}}
			}},
		}}
	})
}
