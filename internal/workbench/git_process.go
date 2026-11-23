//go:build !js && !android && !ios

package workbench

// Run Git commands on local, WSL and SSH targets.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"example.com/pideck-v2/internal/viewkit"
)

// gitRunner is an action's repository: commands stay on the project that
// asked for them even if the drawer moves to another while they run.
type gitRunner struct {
	t    target
	path string
}

// exec runs one git command in the runner's repository.
func (g gitRunner) exec(timeout time.Duration, args ...string) (string, error) {
	out, stderr, code, err := gitRun(g.t, g.path, timeout, args...)
	if err != nil {
		return out, err
	}
	if code != 0 {
		return out, errors.New(gitMessage(stderr, code))
	}
	return out, nil
}

// execDiff reads a diff, where exit code 1 means the texts differ.
func (g gitRunner) execDiff(timeout time.Duration, args ...string) (string, error) {
	out, stderr, code, err := gitRun(g.t, g.path, timeout, args...)
	if err != nil {
		return "", err
	}
	if code > 1 {
		return "", errors.New(gitMessage(stderr, code))
	}
	return out, nil
}

// runner binds a command to the repository attached now.
func (r *gitRepo) runner() gitRunner {
	t, path := r.repo()
	return gitRunner{t: t, path: path}
}

// run performs an action off the UI thread, then rereads the repository.
func (r *gitRepo) run(label string, fn func(g gitRunner) error, done func(error)) {
	t, path := r.repo()
	if path == "" || r.running {
		return
	}
	r.running = true
	r.err.Set("")
	r.busy.Set(label)
	seq := r.seq
	go func() {
		err := fn(gitRunner{t: t, path: path})
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.running = false
			r.busy.Set("")
			if err != nil {
				r.err.Set(label + "失败：" + err.Error())
			}
			if done != nil {
				done(err)
			}
			if r.onResult != nil {
				r.onResult(label, err)
			}
			r.refreshAll()
		})
	}()
}

// gitCommand builds the command that runs git on a target.
func gitCommand(ctx context.Context, t target, dir string, args ...string) *exec.Cmd {
	// Callers select concrete files from status, never patterns. Even after
	// "--", Git would otherwise expand names such as [id] into other paths.
	args = append([]string{"--literal-pathspecs"}, args...)
	var cmd *exec.Cmd
	switch t.Kind {
	case targetWSL:
		all := append([]string{"-d", t.Distro, "--cd", dir, "--", "env",
			"LC_ALL=C", "GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "GIT_EDITOR=true", "git"}, args...)
		cmd = exec.CommandContext(ctx, "wsl.exe", all...)
	case targetSSH:
		script := "cd " + shellQuote(dir) + " && LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat GIT_EDITOR=true git " + shellJoin(args)
		cmd = exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", t.Host, script)
	default:
		cmd = exec.CommandContext(ctx, "git", args...)
		cmd.Dir = dir
	}
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_PAGER=cat", "GIT_EDITOR=true", "LC_ALL=C")
	cmd.Env = append(cmd.Env, appProxy.env()...)
	hideWindow(cmd)
	return cmd
}

// gitRun runs one git command and reports its output and exit code.
func gitRun(t target, dir string, timeout time.Duration, args ...string) (stdout, stderr string, code int, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := gitCommand(ctx, t, dir, args...)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err = cmd.Run()
	switch {
	case err == nil:
		return out.String(), errOut.String(), 0, nil
	case ctx.Err() == context.DeadlineExceeded:
		return out.String(), errOut.String(), -1, fmt.Errorf("git 超过 %s 没有结束", timeout)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return out.String(), errOut.String(), exit.ExitCode(), nil
	}
	if errors.Is(err, exec.ErrNotFound) {
		return out.String(), errOut.String(), -1, errors.New("找不到 git 命令，请先安装 Git")
	}
	return out.String(), errOut.String(), -1, err
}

// gitMessage is a git command's failure as one line.
func gitMessage(stderr string, code int) string {
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = fmt.Sprintf("git 退出码 %d", code)
	}
	return viewkit.FirstLine(msg, 400)
}

// isNotGitRepo reports whether git said the folder is no repository.
func isNotGitRepo(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, "not a git repository") || strings.Contains(lower, "not a git repo")
}
