//go:build !js && !android && !ios

package workbench

// Opening things the app does not draw, and where they live on a target
// that is not this machine. The file manager itself is the host's job, in
// app_reveal.go: it knows which process shows a window.

import (
	"os/exec"
	"runtime"
	"strings"
)

// openExternally opens a URL or a file with the system's handler.
func openExternally(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("cmd.exe", "/d", "/s", "/c", `start "" "`+strings.ReplaceAll(path, `"`, `""`)+`"`)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	hideWindow(cmd)
	return cmd.Start()
}

// windowsPath turns a WSL path into the Windows path Explorer takes:
// /mnt/c/x is C:\x, and anything else is reached through the distro's
// network share.
func windowsPath(path, distro string) string {
	if len(path) > 6 && strings.HasPrefix(path, "/mnt/") && path[6] == '/' && len(path) > 7 {
		drive := strings.ToUpper(string(path[5]))
		rest := strings.ReplaceAll(path[7:], "/", `\`)
		return drive + ":" + `\` + rest
	}
	if strings.HasPrefix(path, "/") {
		return `\\wsl$\` + distro + strings.ReplaceAll(path, "/", `\`)
	}
	return path
}
