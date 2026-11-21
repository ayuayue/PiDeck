//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"os"
	"path/filepath"
	"sync"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

var pluginFileWrites sync.WaitGroup

// One file mutation at a time across the market and settings. Its lifetime
// is the workbench's, so closing a dialog never unlocks an ongoing write.
func (a *app) changePluginFiles(work func() error, done func(error)) {
	if a.pluginFileBusy.GetUntracked() {
		return
	}
	a.pluginFileBusy.Set(true)
	pluginFileWrites.Add(1)
	go func() {
		defer pluginFileWrites.Done()
		err := work()
		a.cx.Post(func() {
			finish := func() {
				a.pluginFileBusy.Set(false)
				done(err)
			}
			if err != nil {
				finish()
				return
			}
			// Keep the guard until a current inventory is visible. A newer
			// refresh may supersede this read and owns the completion then.
			a.pluginFilesReloaded = finish
			a.reloadAddons()
		})
	}()
}

func (a *app) createPluginFromDialog() {
	id, name, desc := a.pluginNewID.GetUntracked(), a.pluginNewName.GetUntracked(), a.pluginNewDesc.GetUntracked()
	a.changePluginFiles(func() error {
		_, err := a.createPlugin(id, name, desc)
		return err
	}, func(err error) {
		if err != nil {
			a.toast(ui.ToastWarning, apptext.T("建不了这个插件"), pluginFileError(err))
			return
		}
		a.pluginNewOpen.Set(false)
		a.toast(ui.ToastSuccess, "插件已创建", name)
	})
}

func (a *app) uninstallPlugin(p plugin) {
	entry := pluginInstallPath(a.pluginsDir(), p.Path)
	if entry != "" && a.editor != nil {
		for _, f := range a.editor.files.GetUntracked() {
			if f.file.target.remote() {
				continue
			}
			if rel, err := filepath.Rel(entry, f.Path); err == nil && filepath.IsLocal(rel) {
				a.toast(ui.ToastWarning, "卸载插件失败", "请先关闭编辑器中打开的插件文件。")
				return
			}
		}
	}
	a.changePluginFiles(func() error { return a.archivePlugin(p) }, func(err error) {
		if err != nil {
			a.toast(ui.ToastError, "卸载插件失败", pluginFileError(err))
			return
		}
		a.toast(ui.ToastSuccess, "已卸载插件", p.Name)
	})
}

func (a *app) reinstallArchivedPlugin(item archivedPlugin) {
	a.changePluginFiles(func() error { return a.restoreArchivedPlugin(item) }, func(err error) {
		if err != nil {
			a.toast(ui.ToastError, "恢复插件失败", pluginFileError(err))
			return
		}
		a.toast(ui.ToastSuccess, "已恢复插件", item.label)
	})
}

// Keep full local paths out of the toast and diagnostic ring.
func pluginFileError(err error) string {
	var path *os.PathError
	if errors.As(err, &path) {
		return path.Err.Error()
	}
	var link *os.LinkError
	if errors.As(err, &link) {
		return link.Err.Error()
	}
	return err.Error()
}
