//go:build !js && !android && !ios

package workbench

// Run the GitHub CLI on local, WSL and SSH targets. gh owns the credential:
// it reads the token from its own store, so the app never holds one and a
// machine without gh says so instead of failing a request.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
)

// errNoGH tells the pane what to show when the target has no GitHub CLI.
var errNoGH = errors.New("gh-missing")

// ghCommand builds the command that runs gh on a target.
func ghCommand(ctx context.Context, t target, dir string, args ...string) *exec.Cmd {
	var cmd *exec.Cmd
	switch t.Kind {
	case targetWSL:
		all := append([]string{"-d", t.Distro, "--cd", dir, "--", "env",
			"LC_ALL=C", "GH_PAGER=cat", "GH_PROMPT_DISABLED=1", "NO_COLOR=1", "gh"}, args...)
		cmd = exec.CommandContext(ctx, "wsl.exe", all...)
	case targetSSH:
		script := "cd " + shellQuote(dir) + " && LC_ALL=C GH_PAGER=cat GH_PROMPT_DISABLED=1 NO_COLOR=1 gh " + shellJoin(args)
		cmd = exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", t.Host, script)
	default:
		cmd = exec.CommandContext(ctx, "gh", args...)
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "GH_PAGER=cat", "GH_PROMPT_DISABLED=1", "NO_COLOR=1", "GH_NO_UPDATE_NOTIFIER=1", "LC_ALL=C")
	cmd.Env = append(cmd.Env, appProxy.env()...)
	hideWindow(cmd)
	return cmd
}

// ghRun runs one gh command and reports its output and exit code.
func ghRun(t target, dir string, timeout time.Duration, args ...string) (stdout, stderr string, code int, err error) {
	return ghRunIn(t, dir, timeout, "", args...)
}

// ghRunIn runs one gh command with a body on its standard input, which is
// how a comment's text travels without passing through a shell.
func ghRunIn(t target, dir string, timeout time.Duration, stdin string, args ...string) (stdout, stderr string, code int, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := ghCommand(ctx, t, dir, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err = cmd.Run()
	switch {
	case err == nil:
		return out.String(), errOut.String(), 0, nil
	case ctx.Err() == context.DeadlineExceeded:
		return out.String(), errOut.String(), -1, fmt.Errorf("gh 超过 %s 没有结束", timeout)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return out.String(), errOut.String(), exit.ExitCode(), nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return out.String(), errOut.String(), -1, errNoGH
	}
	return out.String(), errOut.String(), -1, err
}

// ghMessage is a gh command's failure as one line the user can act on.
func ghMessage(stderr string, code int) string {
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		return fmt.Sprintf(apptext.T("gh 退出码 %d"), code)
	}
	if strings.Contains(msg, "gh auth login") || strings.Contains(msg, "not logged in") ||
		strings.Contains(msg, "authentication failed") || strings.Contains(msg, "HTTP 401") {
		return apptext.T("GitHub CLI 还没有登录，先在终端里运行 gh auth login")
	}
	return viewkit.FirstLine(msg, 400)
}

// ghJSON runs a gh command that prints one JSON document.
func ghJSON(t target, dir string, timeout time.Duration, args ...string) ([]byte, error) {
	out, stderr, code, err := ghRun(t, dir, timeout, args...)
	if err != nil {
		if errors.Is(err, errNoGH) {
			return nil, errNoGH
		}
		return nil, err
	}
	if code != 0 {
		return nil, errors.New(ghMessage(stderr, code))
	}
	trimmed := strings.TrimSpace(out)
	if trimmed == "" {
		return []byte("null"), nil
	}
	return []byte(trimmed), nil
}
