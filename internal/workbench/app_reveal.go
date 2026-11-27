//go:build !js && !android && !ios

package workbench

// Showing a path in the file manager of the machine it is on. The host's
// shell does it, not a command the app builds: explorer.exe started as a
// hidden child opens no window, which is what "the button does nothing"
// looked like. A WSL path becomes the Windows one the host can reach.

import (
	"fmt"
	"runtime"

	"github.com/nsgo-dev/nsgo/ui"
)

// openFolder opens a folder in the file manager of its machine.
func (a *app) openFolder(t target, path string) {
	if path == "" {
		return
	}
	shown, err := fileManagerPath(t, path)
	if err != nil {
		a.toast(ui.ToastError, "打不开文件夹", err.Error())
		return
	}
	a.cx.OpenURL(fileURL(shown), func(opened bool) {
		if !opened {
			a.cx.Post(func() { a.toast(ui.ToastError, "打不开文件夹", path) })
		}
	})
}

// revealFilePath shows a file's folder with the file selected.
func (a *app) revealFilePath(t target, path string) {
	if path == "" {
		return
	}
	shown, err := fileManagerPath(t, path)
	if err != nil {
		a.toast(ui.ToastError, "打不开位置", err.Error())
		return
	}
	a.cx.RevealFile(shown, func(err error) {
		if err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "打不开位置", err.Error()) })
		}
	})
}

// fileManagerPath is path as this host's file manager reaches it: a WSL
// path is the Windows one for its distribution, and an SSH host has no file
// manager here.
func fileManagerPath(t target, path string) (string, error) {
	switch t.Kind {
	case targetLocal:
		return path, nil
	case targetWSL:
		if runtime.GOOS != "windows" {
			return "", fmt.Errorf("WSL 只能在 Windows 上打开")
		}
		return windowsPath(path, t.Distro), nil
	}
	return "", fmt.Errorf("SSH 主机上的目录不能在这里打开")
}
