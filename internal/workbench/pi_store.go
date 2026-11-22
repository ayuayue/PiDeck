//go:build !js && !android && !ios

package workbench

// The extension store's actions: read pi's packages, search pi.dev, and run
// pi's install/remove/update commands after an explicit confirmation.

import (
	"context"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// openPiExtensionStore shows the store and starts both reads.
func (a *app) openPiExtensionStore() {
	a.piStoreOpen.Set(true)
	a.piStoreQuery.Set("")
	a.piStoreList.Set(nil)
	a.piStoreErr.Set("")
	a.piStorePage.Set(1)
	a.piStoreLast.Set(1)
	a.piStoreActing.Set("")
	a.loadPiInstalled()
	a.loadPiCatalog(1)
}

func (a *app) closePiExtensionStore() {
	a.cancelPiCatalog()
	a.piStoreOpen.Set(false)
}

// cancelPiCatalog invalidates the current request and clears its busy flag.
func (a *app) cancelPiCatalog() {
	a.piStoreGen++
	if a.piStoreCancel != nil {
		a.piStoreCancel()
		a.piStoreCancel = nil
	}
	a.piStoreBusy.Set(false)
}

// startPiCatalog owns the next catalog request.
func (a *app) startPiCatalog() (context.Context, uint64) {
	a.cancelPiCatalog()
	base := a.lifetime
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 20*time.Second)
	a.piStoreCancel = cancel
	a.piStoreBusy.Set(true)
	a.piStoreErr.Set("")
	return ctx, a.piStoreGen
}

// loadPiInstalled refreshes the installed list through `pi list`.
func (a *app) loadPiInstalled() {
	piPath, dir := a.piPath(), a.dataDir
	go func() {
		list, err := readPiPackages(piPath, dir)
		a.cx.Post(func() {
			if !a.piStoreOpen.GetUntracked() {
				return
			}
			if err != nil {
				a.piStoreInstalledErr.Set(err.Error())
				return
			}
			a.piStoreInstalledErr.Set("")
			a.piStoreInstalled.Set(list)
		})
	}()
}

// loadPiCatalog reads one page of pi.dev's directory.
func (a *app) loadPiCatalog(page int) {
	if page < 1 {
		page = 1
	}
	query := a.piStoreQuery.GetUntracked()
	ctx, gen := a.startPiCatalog()
	go func() {
		result, err := fetchPiCatalog(ctx, query, page)
		a.cx.Post(func() {
			if gen != a.piStoreGen || !a.piStoreOpen.GetUntracked() {
				return
			}
			a.cancelPiCatalog()
			if err != nil {
				a.piStoreErr.Set(err.Error())
				return
			}
			a.piStoreList.Set(result.Items)
			a.piStorePage.Set(result.Page)
			a.piStoreLast.Set(result.Last)
		})
	}()
}

// searchPiCatalog starts a new search from page one.
func (a *app) searchPiCatalog() {
	a.loadPiCatalog(1)
}

func (a *app) confirmInstallPiPackage(item piCatalogItem) {
	source := item.InstallSource
	if !validPiInstallSource(source) {
		a.toast(ui.ToastError, apptext.T("安装扩展失败"), apptext.T("来源包含不支持的字符，已取消。"))
		return
	}
	author := strings.TrimSpace(item.Author)
	if author == "" {
		author = "pi.dev"
	}
	a.askConfirmPrimary(apptext.T("安装扩展"),
		apptext.T("扩展来自 %s，安装后 pi 会加载并运行它的代码。只安装你信任的来源。", author),
		apptext.T("安装"), func() { a.installPiPackage(source, item.Name) })
}

func (a *app) installPiPackage(source, name string) {
	if a.piStoreActing.GetUntracked() != "" {
		return
	}
	a.piStoreActing.Set(source)
	piPath, dir := a.piPath(), a.dataDir
	go func() {
		ctx, cancel := a.piPackageContext()
		defer cancel()
		err := runPiPackageCommand(ctx, piPath, dir, "install", source)
		a.cx.Post(func() {
			a.piStoreActing.Set("")
			if err != nil {
				a.toast(ui.ToastError, apptext.T("安装扩展失败"), err.Error())
				return
			}
			a.afterPiPackagesChanged()
			a.toast(ui.ToastSuccess, apptext.T("已安装扩展"), name)
		})
	}()
}

func (a *app) confirmRemovePiPackage(pkg piPackage) {
	if !validPiPackageSource(pkg.Source) {
		a.toast(ui.ToastError, apptext.T("卸载扩展失败"), apptext.T("来源包含不支持的字符，已取消。"))
		return
	}
	a.askConfirmPrimary(apptext.T("卸载扩展"),
		apptext.T("「%s」会从 pi 配置中移除，扩展文件留在本机。", pkg.Source),
		apptext.T("卸载"), func() { a.removePiPackage(pkg.Source) })
}

func (a *app) removePiPackage(source string) {
	if a.piStoreActing.GetUntracked() != "" {
		return
	}
	a.piStoreActing.Set(source)
	piPath, dir := a.piPath(), a.dataDir
	go func() {
		ctx, cancel := a.piPackageContext()
		defer cancel()
		err := runPiPackageCommand(ctx, piPath, dir, "remove", source)
		a.cx.Post(func() {
			a.piStoreActing.Set("")
			if err != nil {
				a.toast(ui.ToastError, apptext.T("卸载扩展失败"), err.Error())
				return
			}
			a.afterPiPackagesChanged()
			a.toast(ui.ToastSuccess, apptext.T("已卸载扩展"), source)
		})
	}()
}

func (a *app) confirmUpdatePiPackages() {
	a.askConfirmPrimary(apptext.T("更新扩展"),
		apptext.T("会运行 pi update --extensions，更新本机已安装的扩展。"),
		apptext.T("更新全部"), a.updatePiPackages)
}

func (a *app) updatePiPackages() {
	if a.piStoreActing.GetUntracked() != "" {
		return
	}
	a.piStoreActing.Set("update")
	piPath, dir := a.piPath(), a.dataDir
	go func() {
		ctx, cancel := a.piPackageContext()
		defer cancel()
		err := runPiPackageCommand(ctx, piPath, dir, "update", "--extensions")
		a.cx.Post(func() {
			a.piStoreActing.Set("")
			if err != nil {
				a.toast(ui.ToastError, apptext.T("更新扩展失败"), err.Error())
				return
			}
			a.afterPiPackagesChanged()
			a.toast(ui.ToastSuccess, apptext.T("扩展更新完成"), "")
		})
	}()
}

// afterPiPackagesChanged refreshes both views that show extensions.
func (a *app) afterPiPackagesChanged() {
	a.loadPiInstalled()
	a.resourcesLoaded = false
	a.loadResources(true)
}

// piPackageContext gives installs enough time for npm or git.
func (a *app) piPackageContext() (context.Context, context.CancelFunc) {
	base := a.lifetime
	if base == nil {
		base = context.Background()
	}
	return context.WithTimeout(base, 5*time.Minute)
}
