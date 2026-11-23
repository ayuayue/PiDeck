//go:build !js && !android && !ios

package workbench

// Which repository the review pane reads. gh answers for the directory it
// runs in, so a workspace that holds several clones offers each of them: a
// project's own repository, and the repository of every folder directly
// under it.

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// reviewRepo is one repository the pane can read.
type reviewRepo struct {
	// Path is the directory gh runs in.
	Path string
	// Name is how the pane names it: owner/repository when a remote says so,
	// else the folder.
	Name string
}

// reviewRepos finds the repositories a project can be reviewed in: this
// machine's folders, since a listing of a remote target's children would be
// another command and another failure. A project with no repository at all
// still offers itself, so gh can answer why it cannot work.
func reviewRepos(t target, dir string) []reviewRepo {
	if dir == "" {
		return nil
	}
	var out []reviewRepo
	seen := make(map[string]bool, 4)
	add := func(path string) {
		path = strings.TrimSpace(path)
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		out = append(out, reviewRepo{Path: path, Name: reviewRepoName(t, path)})
	}
	add(reviewGitRoot(t, dir))
	if t.remote() {
		return out
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" {
			continue
		}
		child := filepath.Join(dir, entry.Name())
		if _, err := os.Stat(filepath.Join(child, ".git")); err != nil {
			continue
		}
		add(child)
		if len(out) >= 12 {
			break
		}
	}
	return out
}

// reviewGitRoot is the repository a directory is in: the directory itself
// when git cannot say.
func reviewGitRoot(t target, dir string) string {
	if out, _, code, err := gitRun(t, dir, 15*time.Second, "rev-parse", "--show-toplevel"); err == nil && code == 0 {
		if root := strings.TrimSpace(out); root != "" {
			return root
		}
	}
	return dir
}

// reviewRepoName names one repository: owner/name from its origin, else its
// folder.
func reviewRepoName(t target, dir string) string {
	if out, _, code, err := gitRun(t, dir, 15*time.Second, "config", "--get", "remote.origin.url"); err == nil && code == 0 {
		if name := repoFromRemoteURL(strings.TrimSpace(out)); name != "" {
			return name
		}
	}
	return filepath.Base(dir)
}

// repoFromRemoteURL is the owner and repository a clone URL names, for both
// https and the git@ form.
func repoFromRemoteURL(url string) string {
	if name := repoFromURL(url); name != "" {
		return name
	}
	// git@github.com:owner/repository.git
	rest := url
	if i := strings.Index(rest, "@"); i >= 0 {
		rest = rest[i+1:]
		if j := strings.Index(rest, ":"); j >= 0 {
			rest = rest[j+1:]
		}
	}
	rest = strings.TrimSuffix(strings.TrimSuffix(rest, "/"), ".git")
	parts := strings.Split(rest, "/")
	if len(parts) < 2 {
		return ""
	}
	return parts[len(parts)-2] + "/" + parts[len(parts)-1]
}

// loadReviewRepos reads the candidate repositories and publishes them, then
// loads the list of the one in force.
func (r *review) loadReviewRepos() {
	t, path := r.repo()
	if path == "" {
		r.repos.Set(nil)
		return
	}
	seq := r.seq
	go func() {
		repos := reviewRepos(t, path)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.repos.Set(repos)
		})
	}()
}

// repoName is the name of the repository in force among the candidates.
func (r *review) repoName(repos []reviewRepo) string {
	_, path := r.repo()
	for _, repo := range repos {
		if repo.Path == path {
			return repo.Name
		}
	}
	if len(repos) > 0 {
		return repos[0].Name
	}
	return ""
}

// setRepoPath points the pane at another repository of the same project.
func (r *review) setRepoPath(path string) {
	r.mu.Lock()
	if r.repoPath == path || path == "" {
		r.mu.Unlock()
		return
	}
	r.repoPath = path
	r.mu.Unlock()
	r.seq++
	r.detailSeq++
	r.closeItem()
	r.limit = 40
	r.state.Update(func(s reviewState) reviewState {
		s.Items = nil
		s.Checked = false
		s.Error = ""
		s.Missing = false
		s.NeedsLogin = false
		return s
	})
	r.state.Update(func(s reviewState) reviewState {
		s.Repo = reviewRepoName(r.target, path)
		return s
	})
	r.reload()
}

// reviewRepoMenu offers the project's other repositories, when it has any.
func (a *app) reviewRepoMenu(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Dynamic(func(cx *core.Scope) core.Node {
		repos := a.review.repos.Get()
		_, path := a.review.repo()
		name := a.review.repoName(repos)
		if name == "" {
			name = apptext.T("仓库")
		}
		label := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, FlexShrink: 1, MinWidth: core.Pt(0)},
			Children: []core.Node{
				ui.Icon(lucide.GitBranch, 12, colors.Faint),
				core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style:     core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)},
				core.Show{When: func() bool { return len(repos) > 1 }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.ChevronDown, 11, colors.Faint)
				}},
			}}
		if len(repos) < 2 {
			return label
		}
		items := make([]core.Node, 0, len(repos))
		for _, repo := range repos {
			target := repo.Path
			inForce := repo.Path == path
			item := ui.MenuItem{Text: repo.Name, TestID: "review-repo-" + filepath.Base(repo.Path),
				Checked:  func() bool { return inForce },
				OnSelect: func() { a.review.setRepoPath(target) }}
			items = append(items, item)
		}
		return ui.Menu{Face: label, TestID: "review-repo", Placement: core.PlaceBottom, Align: core.AlignEnd, Children: items}

	})
}
