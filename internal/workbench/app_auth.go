//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// Credential snapshots are derived only from auth.json, never from a successful
// button click. A late reload must not overwrite a newer save/delete result.
func (a *app) loadAuth() {
	a.authUI.LoadSeq++
	seq := a.authUI.LoadSeq
	go func() {
		entries, err := readAuthEntries()
		a.cx.Post(func() {
			if seq != a.authUI.LoadSeq {
				return
			}
			if err != nil {
				a.authEntries.Set(nil)
				a.authErr.Set(err.Error())
				return
			}
			a.authErr.Set("")
			a.authEntries.Set(entries)
		})
	}()
}

func (a *app) openAuthMethods() { a.openAuthMethod("api_key") }

func (a *app) openProviderAuth(id string) {
	if a.authUI.Busy.GetUntracked() {
		return
	}
	methods := a.authMethods.GetUntracked()
	if provider, ok := matchingAuthProvider(methods, id); ok && provider.OAuth != nil {
		a.authLogin(id)
		return
	}
	if _, known := matchingAuthProvider(methods, id); !known && len(methods) > 0 {
		a.openAuthKey(id)
		return
	}
	a.openAuthMethods()
	a.authMethodsProvider.Set(id)
	a.authKeyProvider.Set(id)
}

func (a *app) openAuthMethod(mode string) {
	if a.authUI.Busy.GetUntracked() {
		return
	}
	a.authUI.Mode.Set(mode)
	a.authUI.Error.Set("")
	a.authUI.ShowKey.Set(false)
	a.authKeyText.Set("")
	a.authMethodsProvider.Set("")
	a.authMethodsQuery.Set("")
	a.authMethodsOpen.Set(true)
	a.loadAuthMethods()
}

func (a *app) loadAuthMethods() {
	piPath := a.piPath()
	if a.authMethodsBusy.GetUntracked() {
		return
	}
	if len(a.authMethods.GetUntracked()) > 0 && (a.authUI.MethodsPath == "" || a.authUI.MethodsPath == piPath) {
		a.authUI.MethodsPath = piPath
		return
	}
	a.authMethods.Set(nil)
	a.authMethodsBusy.Set(true)
	a.authMethodsError.Set("")
	go func() {
		providers, err := loadPiAuthProviders(piPath)
		a.cx.Post(func() {
			a.authMethodsBusy.Set(false)
			if piPath != a.piPath() {
				a.loadAuthMethods()
				return
			}
			if err != nil {
				a.authMethodsError.Set(err.Error())
				return
			}
			if selected, ok := matchingAuthProvider(providers, a.authMethodsProvider.GetUntracked()); ok && selected.APIKey == nil && selected.OAuth != nil {
				a.authUI.Mode.Set("oauth")
			}
			a.authUI.MethodsPath = piPath
			a.authMethods.Set(providers)
		})
	}()
}

func (a *app) openAuthKey(provider string) {
	if a.authUI.Busy.GetUntracked() {
		return
	}
	a.authKeyProvider.Set(provider)
	a.authUI.KeyEditing = provider
	a.authKeyText.Set("")
	a.authUI.Error.Set("")
	a.authUI.ShowKey.Set(false)
	a.authKeyOpen.Set(true)
}

func (a *app) closeAuthKey() {
	if a.authUI.Busy.GetUntracked() {
		return
	}
	a.authKeyOpen.Set(false)
	a.authKeyText.Set("")
	a.authUI.Error.Set("")
}

func (a *app) saveAuthKey() {
	if a.authUI.Busy.GetUntracked() {
		return
	}
	provider := strings.TrimSpace(a.authKeyProvider.GetUntracked())
	key := strings.TrimSpace(a.authKeyText.GetUntracked())
	if provider == "" {
		a.authUI.Error.Set(apptext.T("请选择供应商，或填写自定义供应商 ID。"))
		return
	}
	if strings.ContainsAny(provider, "\r\n\t") {
		a.authUI.Error.Set(apptext.T("供应商 ID 不能包含换行或制表符。"))
		return
	}
	if key == "" {
		a.authUI.Error.Set(apptext.T("请粘贴 API Key 后保存。"))
		return
	}
	a.authUI.Error.Set("")
	a.authUI.Busy.Set(true)
	go func() {
		err := replaceAuthKey(provider, key)
		a.cx.Post(func() {
			a.authUI.Busy.Set(false)
			if err != nil {
				a.authUI.Error.Set(err.Error())
				return
			}
			a.authKeyText.Set("")
			a.authKeyOpen.Set(false)
			a.authMethodsOpen.Set(false)
			a.toast(ui.ToastSuccess, "密钥已更新", provider)
			a.loadAuth()
			a.refreshProviders()
		})
	}()
}

func (a *app) authLogin(provider string)          { a.authLoginMode(provider, false, false) }
func (a *app) authLoginAPIKey(provider string)    { a.authLoginMode(provider, true, false) }
func (a *app) authLoginNoBrowser(provider string) { a.authLoginMode(provider, false, true) }

func (a *app) authCheck(provider string) {
	provider = strings.TrimSpace(provider)
	if provider == "" || a.authUI.Busy.GetUntracked() {
		return
	}
	a.authUI.Busy.Set(true)
	piPath := a.piPath()
	go func() {
		status, kind, reason := probeOneProvider(piPath, provider)
		a.cx.Post(func() {
			a.authUI.Busy.Set(false)
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

func (a *app) setProviderAuth(provider, status, authType, reason string) {
	found := false
	a.providers.Update(func(list []providerInfo) []providerInfo {
		list = append([]providerInfo(nil), list...)
		for i := range list {
			if list[i].ID != provider {
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

func (a *app) dropAuthEntry(provider string) {
	provider = strings.TrimSpace(provider)
	if provider == "" || a.authUI.Busy.GetUntracked() {
		return
	}
	a.askConfirm("删除凭据", apptext.T("从 auth.json 删除「%s」的凭据？环境变量和 models.json 不受影响。", provider), "删除", func() {
		if a.authUI.Busy.GetUntracked() {
			return
		}
		a.authUI.Busy.Set(true)
		go func() {
			err := removeAuthEntry(provider)
			a.cx.Post(func() {
				a.authUI.Busy.Set(false)
				if err != nil {
					a.toast(ui.ToastError, "写不了 auth.json", err.Error())
					return
				}
				a.toast(ui.ToastSuccess, "已删除凭据", provider)
				a.loadAuth()
				a.refreshProviders()
			})
		}()
	})
}
