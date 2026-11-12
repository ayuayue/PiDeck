package main

// Opening things the app does not draw: a folder in the system's file
// manager, a file's location. Remote targets go through their own shell,
// so a WSL folder opens in Windows' Explorer at the right place.

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// revealFolder opens a folder in the file manager of the machine it is
// on. It does not wait for the manager to close.
func revealFolder(t target, path string) error {
	if path == "" {
		return fmt.Errorf("没有路径")
	}
	switch t.Kind {
	case targetWSL:
		if runtime.GOOS != "windows" {
			return fmt.Errorf("WSL 只能在 Windows 上打开")
		}
		cmd := exec.Command("wsl.exe", "-d", t.Distro, "--", "explorer.exe", windowsPath(path, t.Distro))
		hideWindow(cmd)
		return cmd.Start()
	case targetSSH:
		return fmt.Errorf("SSH 主机上的目录不能在这里打开")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// explorer.exe exits with 1 even when it opened the folder, so it
		// is only started, never waited on.
		cmd = exec.Command("explorer.exe", filepath.Clean(path))
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	hideWindow(cmd)
	return cmd.Start()
}

// revealFile shows a file's folder with the file selected, where the
// platform can: Explorer takes /select, and macOS `open -R`.
func revealFile(t target, path string) error {
	if path == "" {
		return fmt.Errorf("没有路径")
	}
	if t.Kind != targetLocal {
		return revealFolder(t, filepath.Dir(path))
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", "/select,", filepath.Clean(path))
	case "darwin":
		cmd = exec.Command("open", "-R", path)
	default:
		return revealFolder(t, filepath.Dir(path))
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
