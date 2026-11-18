//go:build !windows && !js && !android && !ios

package workbench

import (
	"os/exec"
)

func hideWindow(cmd *exec.Cmd) {}

// batchCommand runs a batch file; only Windows has them, so elsewhere it
// is the command itself.
func batchCommand(path string, args []string) *exec.Cmd { return exec.Command(path, args...) }
