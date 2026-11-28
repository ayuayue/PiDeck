//go:build !js && !android && !ios

package workbench

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
)

func acpProcessCommand(ctx context.Context, command string, args []string) (*exec.Cmd, error) {
	path, err := exec.LookPath(command)
	if err != nil {
		return nil, err
	}
	var cmd *exec.Cmd
	if isBatch(path) {
		shim := batchCommand(path, args)
		cmd = exec.CommandContext(ctx, shim.Path, shim.Args[1:]...)
		cmd.SysProcAttr = shim.SysProcAttr
	} else {
		cmd = exec.CommandContext(ctx, path, args...)
	}
	hideWindow(cmd)
	return cmd, nil
}

// Only immutable built-ins can install software. Custom JSON can describe
// a launch command, but cannot provide arguments to the npm installer.
func acpPresetInstallArgs(id string) ([]string, bool) {
	for _, p := range acpPresets() {
		if p.ID == id && p.Install != "" && !p.Npx {
			return []string{"install", "--global", "--no-audit", "--no-fund", p.Install}, true
		}
	}
	return nil, false
}

func installACPPackage(ctx context.Context, args []string) error {
	cmd, err := acpProcessCommand(ctx, "npm", args)
	if err != nil {
		return fmt.Errorf("%s: %w", apptext.T("找不到 npm，请先安装 Node.js"), err)
	}
	cmd.Dir = loginDir()
	cmd.Env = append(os.Environ(), agentProxy.env()...)
	log := &ringBuffer{limit: 8 << 10}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if detail := viewkit.FirstLine(strings.TrimSpace(log.String()), 200); detail != "" {
			return fmt.Errorf("%s: %w", detail, err)
		}
		return err
	}
	return nil
}

func (a *app) installACPPreset(id, name string) {
	args, ok := acpPresetInstallArgs(id)
	if !ok || a.acpInstalling.GetUntracked() != "" {
		return
	}
	a.acpInstalling.Set(id)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		err := installACPPackage(ctx, args)
		a.cx.Post(func() {
			a.acpInstalling.Set("")
			a.refreshACPManager()
			if err != nil {
				a.toast(ui.ToastError, "安装失败", err.Error())
				return
			}
			a.toast(ui.ToastSuccess, "已安装", name)
		})
	}()
}
