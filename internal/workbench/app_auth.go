//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// loadAuth reads pi's credentials file into the settings page.
func (a *app) loadAuth() {
	go func() {
		entries, err := readAuthEntries()
		a.cx.Post(func() {
			if err != nil {
				a.authErr.Set(err.Error())
				return
			}
			a.authErr.Set("")
			a.authEntries.Set(entries)
		})
	}()
}

// openAuthKey asks for one provider's api key.
func (a *app) openAuthKey(provider string) {
	a.authKeyProvider.Set(provider)
	a.authKeyText.Set("")
	a.authKeyOpen.Set(true)
}

// saveAuthKey writes the key that was typed and reloads the list.
func (a *app) saveAuthKey() {
	provider := a.authKeyProvider.GetUntracked()
	key := strings.TrimSpace(a.authKeyText.GetUntracked())
	if key == "" {
		a.toast(ui.ToastWarning, "还没有填密钥", "粘贴 API key 再保存。")
		return
	}
	if err := replaceAuthKey(provider, key); err != nil {
		a.toast(ui.ToastError, "写不了 auth.json", err.Error())
		return
	}
	a.authKeyOpen.Set(false)
	a.authKeyText.Set("")
	a.toast(ui.ToastSuccess, "密钥已更新", provider)
	a.loadAuth()
	a.refreshProviders()
}

// authLogin signs in to a provider in a terminal of its own: pi's login
// waits for a browser or a typed key, so it cannot run behind the app.
func (a *app) authLogin(provider string) {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return
	}
	a.animateNextLayout()
	a.term.open.Set(true)
	a.remember()
	a.term.newCommandTab(loginDir(), localTarget, apptext.T("登录 %s", provider),
		piTerminalCommand(a.piPath(), "auth", "login", provider), func() {
			// The credential is written when the login ends, so the list
			// and every provider's state are read again here.
			a.loadAuth()
			a.refreshProviders()
		})
}

// authCheck asks pi about one provider again, refreshing an expired token.
func (a *app) authCheck(provider string) {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return
	}
	go func() {
		status, kind, reason := probeOneProvider(a.piPath(), provider)
		a.cx.Post(func() {
			a.setProviderAuth(provider, status, kind, reason)
			a.loadAuth()
			switch status {
			case "ready":
				a.toast(ui.ToastSuccess, apptext.T("%s 可以使用", provider), apptext.T("凭据已就绪。"))
			case "":
				a.toast(ui.ToastError, apptext.T("检测 %s 失败", provider), reason)
			default:
				a.toast(ui.ToastWarning, apptext.T("%s 还不可用", provider), authReason(reason))
			}
		})
	}()
}

// setProviderAuth updates one row's auth state without waiting for a full
// reload.
func (a *app) setProviderAuth(provider, status, authType, reason string) {
	match := func(p providerInfo) bool { return p.ID == provider }
	found := false
	a.providers.Update(func(list []providerInfo) []providerInfo {
		for i := range list {
			if !match(list[i]) {
				continue
			}
			list[i].Auth, list[i].AuthType, list[i].Reason = status, authType, reason
			found = true
		}
		return list
	})
	if !found {
		a.refreshProviders()
	}
}

// dropAuthEntry removes a provider's stored credential after asking. pi
// does it when it is installed, so a token refresh running in pi cannot
// write the credential back; otherwise the file is edited directly.
func (a *app) dropAuthEntry(provider string) {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return
	}
	a.askConfirm("删除凭据", "从 auth.json 里删掉「"+provider+"」的凭据？", "删除", func() {
		err := error(nil)
		if a.piReady() {
			err = logoutAuth(a.piPath(), provider)
		} else {
			err = removeAuthEntry(provider)
		}
		if err != nil {
			a.toast(ui.ToastError, "写不了 auth.json", err.Error())
			return
		}
		a.toast(ui.ToastSuccess, "已删除凭据", provider)
		a.loadAuth()
		a.refreshProviders()
	})
}
