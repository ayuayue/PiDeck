//go:build !js && !android && !ios

package workbench

// The TokenDance account as the settings page drives it: the key, the
// balance, the catalog pull, and a recharge that waits for the payment to
// land. Every network call runs off the UI thread and answers through a
// signal.

import (
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// tdRefresh reads the account's balance, when a key is configured. The
// key is read off the UI thread, as pi's files are not the graph's.
func (a *app) tdRefresh() {
	a.tdBusy.Set(true)
	go func() {
		key := tokenDanceKey()
		if key == "" {
			a.cx.Post(func() {
				a.tdBusy.Set(false)
				a.tdBalance.Set("")
				a.tdBalanceErr.Set("")
			})
			return
		}
		balance, err := fetchTokenDanceBalance(key)
		a.cx.Post(func() {
			a.tdBusy.Set(false)
			if err != nil {
				a.tdBalance.Set("")
				a.tdBalanceErr.Set(err.Error())
				return
			}
			a.tdBalanceErr.Set("")
			a.tdBalance.Set(apptext.T("剩余 %s · 已用 %s / 共 %s", yuan(balance.Left), yuan(balance.Used), yuan(balance.Credits)))
		})
	}()
}

// tdOpenKey asks for the account's API key.
func (a *app) tdOpenKey() {
	a.tdKeyText.Set("")
	a.tdKeyErr.Set("")
	a.tdKeyOpen.Set(true)
}

// tdSaveKey checks the key against the account, then stores it beside the
// provider in models.json, which is where pi's own editor puts it.
func (a *app) tdSaveKey() {
	key := strings.TrimSpace(a.tdKeyText.GetUntracked())
	if key == "" {
		a.tdKeyErr.Set(apptext.T("先填 API Key。"))
		return
	}
	a.tdKeyBusy.Set(true)
	go func() {
		balance, err := fetchTokenDanceBalance(key)
		a.cx.Post(func() {
			if err != nil {
				a.tdKeyBusy.Set(false)
				a.tdKeyErr.Set(apptext.T("校验没通过：%s", err.Error()))
				return
			}
			if err := ensureTokenDanceProvider(key); err != nil {
				a.tdKeyBusy.Set(false)
				a.tdKeyErr.Set(err.Error())
				return
			}
			a.tdKeyBusy.Set(false)
			a.tdKeyText.Set("")
			a.tdBalanceErr.Set("")
			a.tdBalance.Set(apptext.T("剩余 %s · 已用 %s / 共 %s", yuan(balance.Left), yuan(balance.Used), yuan(balance.Credits)))
			a.toast(ui.ToastSuccess, "TokenDance 已就绪", apptext.T("余额 %s", yuan(balance.Left)))
			a.loadAuth()
			a.refreshProviders()
		})
	}()
}

// tdPullModels writes the platform's catalog into models.json.
func (a *app) tdPullModels() {
	a.tdModelBusy.Set(true)
	a.tdModelMsg.Set(apptext.T("正在读取模型目录…"))
	go func() {
		catalog, err := fetchTokenDanceCatalog()
		a.cx.Post(func() {
			if err != nil {
				a.tdModelBusy.Set(false)
				a.tdModelMsg.Set(apptext.T("读取失败：%s", err.Error()))
				return
			}
			chat := chatModels(catalog)
			if err := ensureTokenDanceProvider(""); err != nil {
				a.tdModelBusy.Set(false)
				a.tdModelMsg.Set(err.Error())
				return
			}
			var existing []modelConfig
			for _, cfg := range readProviderConfigs() {
				if cfg.ID == tokenDanceProvider {
					existing = cfg.Models
					break
				}
			}
			merged, added, updated, kept := tokenDanceMerge(existing, catalog)
			if err := saveProviderModels(tokenDanceProvider, merged); err != nil {
				a.tdModelBusy.Set(false)
				a.tdModelMsg.Set(apptext.T("写入失败：%s", err.Error()))
				return
			}
			a.tdModelBusy.Set(false)
			a.tdModelMsg.Set(apptext.T("目录 %d 个模型，其中 %d 个能由这个供应商调用；新增 %d，更新 %d，保留 %d。",
				len(catalog), len(chat), added, updated, kept))
			a.toast(ui.ToastSuccess, apptext.T("已拉取 %d 个模型", added), apptext.T("重启 Agent 后生效。"))
			a.refreshProviders()
		})
	}()
}

// tdOpenRecharge asks how much to add to the account.
func (a *app) tdOpenRecharge() {
	a.tdPayAmount.Set("")
	a.tdPayErr.Set("")
	a.tdPayStatus.Set("")
	a.tdPaySession = tokenDanceSession{}
	a.tdPayKeyHint = ""
	a.tdPayQR = nil
	a.tdPayOpen.Set(true)
}

// tdStartPayment opens a payment session for the amount that was typed.
func (a *app) tdStartPayment() {
	amount := modelCount(a.tdPayAmount.GetUntracked())
	if amount < 1 || amount > 100000 {
		a.tdPayErr.Set(apptext.T("金额是 1 到 100000 之间的整数元。"))
		return
	}
	a.tdPayBusy.Set(true)
	a.tdPayErr.Set("")
	go func() {
		key := tokenDanceKey()
		if key == "" {
			a.cx.Post(func() {
				a.tdPayBusy.Set(false)
				a.tdPayErr.Set(apptext.T("先配置 TokenDance 的 API Key。"))
			})
			return
		}
		session, err := createTokenDanceSession(key, amount)
		hint := maskKey(key)
		a.cx.Post(func() {
			a.tdPayBusy.Set(false)
			a.tdPayKeyHint = hint
			if err != nil {
				a.tdPayErr.Set(apptext.T("创建支付会话失败：%s", err.Error()))
				return
			}
			a.tdPaySession = session
			a.tdPayQR = qrPNGFor(session.PaymentURL)
			a.tdPayStatus.Set(tokenDanceStatusLabel(session))
			a.tdWatchPayment()
		})
	}()
}

// tdWatchPayment asks the platform about the session every three seconds
// until it settles, the dialog closes, or the session expires.
func (a *app) tdWatchPayment() {
	a.tdStopWatch()
	stop := make(chan struct{})
	a.tdPayStop = stop
	statusURL := a.tdPaySession.StatusURL
	if statusURL == "" {
		return
	}
	go func() {
		key := tokenDanceKey()
		if key == "" {
			return
		}
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
			session, err := fetchTokenDanceSession(key, statusURL)
			settled := err == nil && session.settled()
			a.cx.Post(func() {
				select {
				case <-stop:
					return
				default:
				}
				if err != nil {
					a.tdPayStatus.Set(apptext.T("查询失败：%s", err.Error()))
				} else {
					a.tdPaySession = session
					a.tdPayStatus.Set(tokenDanceStatusLabel(session))
					if session.Status == "paid" {
						a.toast(ui.ToastSuccess, "充值到账", apptext.T("%d 元已到账。", session.Amount))
						a.tdRefresh()
					}
				}
				if settled {
					a.tdStopWatch()
				}
			})
			if settled {
				return
			}
			if a.tdPaySession.ExpiredAt > 0 && time.Now().Unix() > a.tdPaySession.ExpiredAt {
				return
			}
		}
	}()
}

// tdStopWatch ends the status polling.
func (a *app) tdStopWatch() {
	a.tdWatchMu.Lock()
	stop := a.tdPayStop
	a.tdPayStop = nil
	a.tdWatchMu.Unlock()
	if stop != nil {
		close(stop)
	}
}

// tdCheckPayment asks once, for the button in the dialog.
func (a *app) tdCheckPayment() {
	session := a.tdPaySession
	if session.StatusURL == "" {
		return
	}
	a.tdPayBusy.Set(true)
	go func() {
		key := tokenDanceKey()
		if key == "" {
			a.cx.Post(func() { a.tdPayBusy.Set(false) })
			return
		}
		fresh, err := fetchTokenDanceSession(key, session.StatusURL)
		a.cx.Post(func() {
			a.tdPayBusy.Set(false)
			if err != nil {
				a.tdPayStatus.Set(apptext.T("查询失败：%s", err.Error()))
				return
			}
			a.tdPaySession = fresh
			a.tdPayStatus.Set(tokenDanceStatusLabel(fresh))
			if fresh.Status == "paid" {
				a.toast(ui.ToastSuccess, "充值到账", apptext.T("%d 元已到账。", fresh.Amount))
				a.tdRefresh()
			}
		})
	}()
}

// tdCloseRecharge stops watching and closes the dialog.
func (a *app) tdCloseRecharge() {
	a.tdStopWatch()
	a.tdPayOpen.Set(false)
}

// tdLogin runs TokenDance's authorization: the browser confirms, the code
// comes back on a loopback port, and the key it buys is written beside the
// provider. No long-lived key is typed by hand.
func (a *app) tdLogin() {
	a.tdLoginState.Set(apptext.T("正在打开浏览器…"))
	a.tdLoginOpen.Set(true)
	go func() {
		verifier, challenge, err := pkcePair()
		if err != nil {
			a.cx.Post(func() { a.tdLoginState.Set(err.Error()) })
			return
		}
		callback, err := listenTokenDanceCode()
		if err != nil {
			a.cx.Post(func() {
				a.tdLoginState.Set(apptext.T("开不了本地回调端口；改用「填入密钥…」。"))
			})
			return
		}
		defer callback.close()
		a.cx.Post(func() {
			a.tdLoginCancel = callback.close
			a.tdLoginState.Set(apptext.T("在浏览器里确认授权，回来就会自动填好。"))
			a.cx.OpenURL(tokenDanceAuthURL(challenge, callback.URL), nil)
		})
		code, err := callback.wait(tokenDanceAuthWait)
		if err != nil {
			a.cx.Post(func() { a.tdLoginState.Set(err.Error()) })
			return
		}
		key, err := exchangeAuthCode(code, verifier)
		if err != nil {
			a.cx.Post(func() { a.tdLoginState.Set(err.Error()) })
			return
		}
		if _, err := fetchTokenDanceBalance(key); err != nil {
			a.cx.Post(func() { a.tdLoginState.Set(apptext.T("授权拿到的 Key 用不了：%s", err.Error())) })
			return
		}
		if err := ensureTokenDanceProvider(key); err != nil {
			a.cx.Post(func() { a.tdLoginState.Set(err.Error()) })
			return
		}
		a.cx.Post(func() {
			a.tdLoginCancel = nil
			a.tdLoginOpen.Set(false)
			a.toast(ui.ToastSuccess, "TokenDance 已就绪", apptext.T("授权完成，Key 已写入 models.json。"))
			a.tdRefresh()
			a.refreshProviders()
		})
	}()
}

// tdLoginStop cancels a login that is waiting on the browser.
func (a *app) tdLoginStop() {
	if a.tdLoginCancel != nil {
		cancel := a.tdLoginCancel
		a.tdLoginCancel = nil
		cancel()
	}
	a.tdLoginOpen.Set(false)
}
