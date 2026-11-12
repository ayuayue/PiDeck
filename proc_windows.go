//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the child's console window from flashing.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
