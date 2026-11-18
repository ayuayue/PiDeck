//go:build !js && !android && !ios

package workbench

// Read commit history and resolve links to hosted commits.

import (
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// readUnpushedCommits lists the commits the upstream branch does not have.
func readUnpushedCommits(t target, dir string) ([]gitCommit, error) {
	out, stderr, code, err := gitRun(t, dir, 30*time.Second, "--no-pager", "log", "-n", "100", "--date=iso-strict",
		"--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1e", "@{u}..HEAD")
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, errors.New(gitMessage(stderr, code))
	}
	return parseGitLog(out), nil
}

// parseGitLog reads the record-separated log.
func parseGitLog(out string) []gitCommit {
	var commits []gitCommit
	for _, rec := range strings.Split(out, "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		parts := strings.SplitN(rec, "\x1f", 7)
		if len(parts) < 6 {
			continue
		}
		c := gitCommit{Hash: parts[0], Short: parts[1], Author: parts[2], Email: parts[3], Subject: parts[5]}
		if len(parts) == 7 && strings.TrimSpace(parts[6]) != "" {
			c.Parents = strings.Fields(parts[6])
		}
		if t, err := time.Parse(time.RFC3339, parts[4]); err == nil {
			c.Date = t
		}
		commits = append(commits, c)
	}
	return commits
}

// listGitStashes reads the stash list.
func listGitStashes(g gitRunner) ([]gitStashEntry, error) {
	out, err := g.exec(30*time.Second, "stash", "list", "--format=%gd%x09%gs")
	if err != nil {
		return nil, err
	}
	var list []gitStashEntry
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		ref, subject, _ := strings.Cut(line, "\t")
		if ref == "" {
			continue
		}
		list = append(list, gitStashEntry{Ref: ref, Subject: subject})
		if len(list) >= 100 {
			break
		}
	}
	return list, nil
}

// commitWebURL is the web page of a commit, from a remote's URL.
func commitWebURL(remote, hash string) (string, error) {
	remote = strings.TrimSpace(remote)
	hash = strings.TrimSpace(hash)
	if remote == "" {
		return "", errors.New("这个仓库没有 origin 远端")
	}
	if hash == "" {
		return "", errors.New("没有提交哈希")
	}
	host, path := "", ""
	switch {
	case strings.HasPrefix(remote, "http://") || strings.HasPrefix(remote, "https://"):
		u, err := url.Parse(remote)
		if err != nil || u.Host == "" {
			return "", errors.New("远端地址看不懂：" + remote)
		}
		host, path = u.Host, u.Path
	case strings.HasPrefix(remote, "ssh://"):
		u, err := url.Parse(remote)
		if err != nil || u.Hostname() == "" {
			return "", errors.New("远端地址看不懂：" + remote)
		}
		host, path = u.Hostname(), u.Path
	case strings.HasPrefix(remote, "git@"):
		rest := strings.TrimPrefix(remote, "git@")
		h, p, ok := strings.Cut(rest, ":")
		if !ok || h == "" || p == "" {
			return "", errors.New("远端地址看不懂：" + remote)
		}
		host, path = h, p
	default:
		return "", errors.New("远端不是常见地址：" + remote)
	}
	path = strings.Trim(strings.TrimSuffix(path, ".git"), "/")
	if host == "" || path == "" {
		return "", errors.New("远端地址缺主机或仓库：" + remote)
	}
	lower := strings.ToLower(host)
	switch {
	case strings.Contains(lower, "gitlab"):
		return "https://" + host + "/" + path + "/-/commit/" + hash, nil
	case strings.Contains(lower, "bitbucket"):
		return "https://" + host + "/" + path + "/commits/" + hash, nil
	}
	return "https://" + host + "/" + path + "/commit/" + hash, nil
}

// openCommitInBrowser opens a commit on its remote's web page.
func (a *app) openCommitInBrowser(c gitCommit) {
	if a.gitPath() == "" {
		return
	}
	runner := a.git.runner()
	go func() {
		out, err := runner.exec(20*time.Second, "remote", "get-url", "origin")
		var link string
		if err == nil {
			link, err = commitWebURL(strings.TrimSpace(out), c.Hash)
		}
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "打不开提交链接", err.Error())
				return
			}
			a.cx.OpenURL(link, nil)
		})
	}()
}
