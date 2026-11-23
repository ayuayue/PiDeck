//go:build !js && !android && !ios

package workbench

// What the settings page asks pi itself: whether a provider resolves, a
// sign-out, and the login that needs a terminal of its own because it
// waits for a browser or for a key to be typed.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"example.com/pideck-v2/internal/viewkit"
)

// authCheckResult is pi's answer for one provider.
type authCheckResult struct {
	Status   string `json:"status"`
	Provider string `json:"provider"`
	Reason   string `json:"reason"`
	AuthType string `json:"authType"`
}

// piArgs runs pi with args through cmd.exe when it is a batch shim.
func piCommand(ctx context.Context, piPath string, args ...string) *exec.Cmd {
	var cmd *exec.Cmd
	if ctx == nil {
		ctx = context.Background()
	}
	if isBatch(piPath) {
		cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", batchLine(piPath, args))
	} else {
		cmd = exec.CommandContext(ctx, piPath, args...)
	}
	hideWindow(cmd)
	return cmd
}

// piTerminalCommand is pi and its arguments as a terminal should start
// them: a batch shim needs cmd.exe to run at all.
func piTerminalCommand(piPath string, args ...string) []string {
	if piPath == "" {
		piPath = "pi"
	}
	if isBatch(piPath) {
		return []string{"cmd.exe", "/d", "/s", "/c", batchLine(piPath, args)}
	}
	return append([]string{piPath}, args...)
}

// checkAuth asks pi to resolve a provider's credentials. With refresh
// set, an expired OAuth token is renewed and written back to auth.json.
func checkAuth(piPath, provider string, refresh bool) (authCheckResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	args := []string{"auth", "check", "--provider", provider, "--json"}
	if !refresh {
		args = append(args, "--no-refresh")
	}
	out, _ := piCommand(ctx, piPath, args...).Output()
	var res authCheckResult
	if json.Unmarshal(out, &res) == nil && res.Status != "" {
		return res, nil
	}
	line := viewkit.FirstLine(strings.TrimSpace(string(out)), 160)
	if line == "" {
		line = "pi 没有回答"
	}
	return authCheckResult{}, fmt.Errorf("%s", line)
}

// logoutAuth removes a provider's stored credential through pi, which
// leaves environment variables and models.json alone.
func logoutAuth(piPath, provider string) error {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return fmt.Errorf("供应商不能为空")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := piCommand(ctx, piPath, "auth", "logout", provider).CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		if text == "" {
			text = err.Error()
		}
		return fmt.Errorf("%s", viewkit.FirstLine(text, 200))
	}
	return nil
}

// loginDir is where a login terminal starts: the home folder, so pi reads
// the same configuration it does everywhere else.
func loginDir() string {
	if dir, err := os.UserHomeDir(); err == nil {
		return dir
	}
	return ""
}
