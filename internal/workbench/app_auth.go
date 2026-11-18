//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"strings"

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
}

// dropAuthEntry removes a provider after asking.
func (a *app) dropAuthEntry(provider string) {
	if strings.TrimSpace(provider) == "" {
		return
	}
	a.askConfirm("删除凭据", "从 auth.json 里删掉「"+provider+"」的凭据？", "删除", func() {
		if err := removeAuthEntry(provider); err != nil {
			a.toast(ui.ToastError, "写不了 auth.json", err.Error())
			return
		}
		a.toast(ui.ToastSuccess, "已删除凭据", provider)
		a.loadAuth()
	})
}
