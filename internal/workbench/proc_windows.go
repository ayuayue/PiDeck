//go:build windows

package workbench

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the child's console window from flashing.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}

// batchCommand runs a .bat or .cmd through cmd.exe. The line is set as
// cmd.exe takes it, because Go escapes the quotes of a /c argument.
func batchCommand(path string, args []string) *exec.Cmd {
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `/d /s /c "` + batchLine(path, args) + `"`}
	return cmd
}
