//go:build !js && !android && !ios

package workbench

import "github.com/nsgo-dev/nsgo/ui"

// revealFileBrowserRoot starts the platform file manager off the UI thread.
func (a *app) revealFileBrowserRoot(root string) {
	if root == "" {
		return
	}
	go func() {
		if err := revealFolder(localTarget, root); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "打不开文件夹", err.Error()) })
		}
	}()
}
