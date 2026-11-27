//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

func newGitBlameTestApp(t *testing.T, dir string) (*app, <-chan func()) {
	t.Helper()
	posts := make(chan func(), 16)
	cx := core.NewRoot(core.RootOptions{CheckCommits: true, Post: func(fn func()) { posts <- fn }})
	t.Cleanup(cx.Dispose)
	a := &app{
		cx: cx, git: newGitRepo(cx),
		activeID: core.NewSignal(cx, ""), activePane: core.NewSignal(cx, ""),
		gitBlameOpen: core.NewSignal(cx, false), gitBlamePath: core.NewSignal(cx, ""),
		gitBlameRev: core.NewSignal(cx, 0), gitBlameErr: core.NewSignal(cx, ""),
		review: &review{}, notifications: &notificationHistory{}, video: &videoHost{},
	}
	a.git.path, a.git.target = dir, localTarget
	return a, posts
}

func nextGitBlamePost(t *testing.T, posts <-chan func()) func() {
	t.Helper()
	select {
	case fn := <-posts:
		return fn
	case <-time.After(5 * time.Second):
		t.Fatal("Git result was not posted")
		return nil
	}
}

func TestGitBlameIgnoresPreviousContext(t *testing.T) {
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("another file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", "other.txt")
	run("commit", "-m", "another file")
	for _, missing := range []bool{false, true} {
		for _, mode := range []string{"project", "file", "reopen", "close"} {
			name := mode + "/success"
			if missing {
				name = mode + "/error"
			}
			t.Run(name, func(t *testing.T) {
				a, posts := newGitBlameTestApp(t, dir)
				path := "note.txt"
				if missing {
					path = "missing.txt"
				}
				a.openBlame(path)
				nextGitBlamePost(t, posts)() // tab reveal, queued before the worker
				old := nextGitBlamePost(t, posts)
				switch mode {
				case "project":
					a.git.attach(&workspace{Path: t.TempDir(), Target: localTarget})
					nextGitBlamePost(t, posts)() // new project's status
				case "file":
					a.openBlame("other.txt")
					nextGitBlamePost(t, posts)()
				case "reopen":
					a.closePane(paneBlame)
					a.openBlame(path)
					nextGitBlamePost(t, posts)()
				case "close":
					a.closePane(paneBlame)
				}
				current := []blameRange{{Hash: "current", Start: 1, End: 1}}
				a.gitBlame = current
				a.gitBlameErr.Set("current notice")
				revision := a.gitBlameRev.GetUntracked()
				old()
				if !reflect.DeepEqual(a.gitBlame, current) || a.gitBlameErr.GetUntracked() != "current notice" || a.gitBlameRev.GetUntracked() != revision {
					t.Errorf("old blame changed current context: ranges=%+v error=%q revision=%d", a.gitBlame, a.gitBlameErr.GetUntracked(), a.gitBlameRev.GetUntracked())
				}
				if mode == "file" || mode == "reopen" {
					nextGitBlamePost(t, posts)()
					if a.gitBlameRev.GetUntracked() != revision+1 {
						t.Fatal("current blame request did not publish")
					}
					if mode == "reopen" && missing {
						if a.gitBlameErr.GetUntracked() == "current notice" || len(a.gitBlame) != 0 {
							t.Fatal("current error did not publish")
						}
					} else if len(a.gitBlame) == 0 {
						t.Fatal("current blame did not load its lines")
					}
				}
			})
		}
	}
}
