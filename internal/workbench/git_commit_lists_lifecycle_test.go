//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
)

func TestGitCommitListsIgnorePreviousContext(t *testing.T) {
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("another file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", "other.txt")
	run("commit", "-m", "another file")
	for _, kind := range []string{"history", "unpushed"} {
		for _, failed := range []bool{false, true} {
			for _, mode := range []string{"project", "reopen", "close", "file"} {
				if kind == "unpushed" && mode == "file" {
					continue
				}
				name := kind + "/" + mode + "/success"
				if failed {
					name = kind + "/" + mode + "/error"
				}
				t.Run(name, func(t *testing.T) {
					oldDir := dir
					if failed {
						oldDir = t.TempDir() // project is no longer a repository
					}
					a, posts := newGitBlameTestApp(t, oldDir)
					a.gitFileHistoryOpen = core.NewSignal(a.cx, false)
					a.gitFileHistoryPath = core.NewSignal(a.cx, "")
					a.gitFileHistoryRev = core.NewSignal(a.cx, 0)
					a.gitFileHistoryErr = core.NewSignal(a.cx, "")
					a.gitUnpushedOpen = core.NewSignal(a.cx, false)
					a.gitUnpushedRev = core.NewSignal(a.cx, 0)
					a.gitUnpushedErr = core.NewSignal(a.cx, "")
					a.git.state.Set(gitState{Upstream: "origin/main"})
					opened, revision, message := a.gitFileHistoryOpen, a.gitFileHistoryRev, a.gitFileHistoryErr
					commits := &a.gitFileHistory
					if kind == "unpushed" {
						opened, revision, message, commits = a.gitUnpushedOpen, a.gitUnpushedRev, a.gitUnpushedErr, &a.gitUnpushed
					}
					start := func(path string) {
						if kind == "history" {
							a.openFileHistory(path)
							nextGitBlamePost(t, posts)() // tab reveal
						} else {
							a.openUnpushedCommits()
						}
					}
					start("note.txt")
					old := nextGitBlamePost(t, posts)
					switch mode {
					case "project":
						a.git.attach(&workspace{Path: t.TempDir(), Target: localTarget})
						nextGitBlamePost(t, posts)()
					case "reopen":
						opened.Set(false)
						start("note.txt")
					case "file":
						start("other.txt")
					case "close":
						opened.Set(false)
					}
					current := []gitCommit{{Hash: "current", Subject: "current context"}}
					*commits = current
					message.Set("current notice")
					rev := revision.GetUntracked()
					old()
					if !reflect.DeepEqual(*commits, current) || message.GetUntracked() != "current notice" || revision.GetUntracked() != rev {
						t.Errorf("old %s changed the current context: commits=%+v error=%q revision=%d", kind, *commits, message.GetUntracked(), revision.GetUntracked())
					}
					if mode == "reopen" || mode == "file" {
						nextGitBlamePost(t, posts)()
						if revision.GetUntracked() != rev+1 {
							t.Fatal("current list request did not publish")
						}
						if failed {
							if message.GetUntracked() == "current notice" || len(*commits) != 0 {
								t.Fatal("current list error did not publish")
							}
						} else if len(*commits) == 0 || (*commits)[0].Hash == "current" {
							t.Fatal("current list did not load its commits")
						}
					}
				})
			}
		}
	}
}
