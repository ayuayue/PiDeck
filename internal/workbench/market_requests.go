//go:build !js && !android && !ios

package workbench

import (
	"context"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// Opening a market starts a new browsing generation. An install belongs to
// the app lifetime and keeps its exclusion guard across close/reopen.
func (a *app) openPluginMarket() {
	a.marketURL.Set(a.cfg.PluginIndexURL)
	a.showBuiltinPluginExamples()
	a.marketOpen.Set(true)
}

func (a *app) closePluginMarket() {
	a.cancelPluginMarketRequest()
	a.marketOpen.Set(false)
}

func (a *app) showBuiltinPluginExamples() {
	a.cancelPluginMarketRequest()
	a.marketErr.Set("")
	a.marketList.Set(builtinPluginExamples())
}

func (a *app) cancelPluginMarketRequest() {
	a.marketRequestGen++
	if a.marketRequestCancel != nil {
		a.marketRequestCancel()
		a.marketRequestCancel = nil
	}
	a.marketBusy.Set(false)
}

// startPluginMarketRequest is shared by custom, official and community
// sources. A previous request may already have posted; its generation still
// prevents it from changing the new request's list, error or busy state.
func (a *app) startPluginMarketRequest() (context.Context, uint64) {
	a.cancelPluginMarketRequest()
	ctx, cancel := context.WithTimeout(a.lifetime, 30*time.Second)
	a.marketRequestCancel = cancel
	a.marketBusy.Set(true)
	a.marketErr.Set("")
	return ctx, a.marketRequestGen
}

func (a *app) finishPluginMarketRequest(gen uint64, list []marketEntry, err error) bool {
	if gen != a.marketRequestGen || !a.marketOpen.GetUntracked() {
		return false
	}
	a.cancelPluginMarketRequest()
	if err != nil {
		a.marketErr.Set(err.Error())
		return false
	}
	a.marketList.Set(list)
	return true
}

func (a *app) loadPluginIndex() {
	if !a.marketOpen.GetUntracked() {
		return
	}
	address := strings.TrimSpace(a.marketURL.GetUntracked())
	if address == "" {
		a.cancelPluginMarketRequest()
		a.marketErr.Set(apptext.T("先填一个索引链接"))
		return
	}
	ctx, gen := a.startPluginMarketRequest()
	go func() {
		list, err := fetchPluginIndex(ctx, address)
		a.cx.Post(func() {
			if !a.finishPluginMarketRequest(gen, list, err) {
				return
			}
			a.cfg.PluginIndexURL = address
			if a.st != nil {
				a.st.change(func(c *config) { c.PluginIndexURL = address })
				a.savePluginConfig()
			}
		})
	}()
}

func (a *app) installFromMarket(entry marketEntry) {
	var installed plugin
	a.changePluginFiles(func() (err error) {
		installed, err = a.installMarketPlugin(entry)
		return err
	}, func(err error) {
		if err != nil {
			a.toast(ui.ToastError, "安装失败", err.Error())
			return
		}
		a.toast(ui.ToastSuccess, "已安装 "+installed.Name, "在 设置 → 扩展 里查看。")
	})
}
