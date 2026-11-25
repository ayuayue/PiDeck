//go:build windows

package workbench

import (
	"context"
	"os/exec"
	"strconv"
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
	return batchCommandContext(context.Background(), path, args)
}

// batchCommandContext is batchCommand with a deadline.
func batchCommandContext(ctx context.Context, path string, args []string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `/d /s /c "` + batchLine(path, args) + `"`}
	return cmd
}

// killTree ends a child and everything it started. An npx shim runs cmd.exe
// which runs node: killing the wrapper alone leaves the agent holding the
// pipes, so a stuck start would leak a process per attempt.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	kill := exec.Command("taskkill.exe", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	hideWindow(kill)
	if err := kill.Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}
