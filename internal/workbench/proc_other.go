//go:build !windows && !js && !android && !ios

package workbench

import (
	"context"
	"os/exec"
)

func hideWindow(cmd *exec.Cmd) {}

// batchCommand runs a batch file; only Windows has them, so elsewhere it
// is the command itself.
func batchCommand(path string, args []string) *exec.Cmd { return exec.Command(path, args...) }

// batchCommandContext is batchCommand with a deadline.
func batchCommandContext(ctx context.Context, path string, args []string) *exec.Cmd {
	return exec.CommandContext(ctx, path, args...)
}

// killTree ends a child and everything it started.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}
