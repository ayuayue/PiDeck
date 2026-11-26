//go:build !js && !android && !ios

package workbench

import (
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestReviewDetailRetry(t *testing.T) {
	var reads atomic.Int32
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if len(call.Args) > 1 && call.Args[1] == "view" && reads.Add(1) == 1 {
			return reviewCLIResult{Err: "fixture detail unavailable", Code: 1}
		}
		return reviewTestResponse(call)
	})
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, _ := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("text:fixture detail unavailable", 10*time.Second)
	screen.WaitFor("id:review-back", time.Second)
	screen.Press("role:button 重试")
	screen.WaitFor("text:Fixture detail", 10*time.Second)
	screen.Screenshot("review/detail")
}

func TestReviewWriteCompletesInOriginalProject(t *testing.T) {
	started, release := make(chan struct{}, 1), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if len(call.Args) > 1 && call.Args[1] == "comment" {
			started <- struct{}{}
			<-release
			return reviewCLIResult{Err: "fixture original comment failed", Code: 1}
		}
		return reviewTestResponse(call)
	})
	defer finish()
	alpha := reviewTestRepo(t, t.TempDir(), "alpha")
	beta := reviewTestRepo(t, t.TempDir(), "beta")
	screen, built := reviewTestScreen(t, []workspaceCfg{{Path: alpha, Name: "First project"}, {Path: beta, Name: "Second project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Type("id:review-comment", "First draft")
	screen.Press("id:review-comment-send")
	screen.WaitUntil(10*time.Second, func() bool { return len(started) > 0 })
	// A concurrent list read must not clear the write-in-progress guard.
	screen.Press("id:review-refresh")
	screen.WaitUntil(10*time.Second, func() bool { return !built.review.state.GetUntracked().Loading })
	if screen.Enabled("id:review-comment-send") {
		t.Fatal("a list refresh enabled duplicate comment submission")
	}
	screen.Press("id:review-project")
	screen.Press("text:Second project")
	screen.WaitFor("text:beta item", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Type("id:review-comment", "Second draft")
	finish()
	screen.WaitUntil(10*time.Second, func() bool {
		return reviewTestRead(screen, func() bool {
			return !built.review.views[localTarget.key()+"|"+alpha+"\x00"+alpha].state.Writing
		})
	})
	if screen.Exists("text:fixture original comment failed") || !screen.Enabled("id:review-comment-send") {
		t.Fatal("the first project's write result changed the second project")
	}
	if got := screen.Find("id:review-comment").Text; got != "Second draft" {
		t.Fatalf("second project's draft = %q", got)
	}
	screen.Press("id:review-project")
	screen.Press("text:First project")
	screen.WaitFor("text:fixture original comment failed", 10*time.Second)
	if got := screen.Find("id:review-comment").Text; got != "First draft" {
		t.Fatalf("original failed draft = %q", got)
	}
}

func TestReviewSuccessfulCommentKeepsNewDraft(t *testing.T) {
	started, release := make(chan reviewCLICall, 1), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if len(call.Args) > 1 && call.Args[1] == "comment" {
			started <- call
			<-release
			return reviewCLIResult{}
		}
		return reviewTestResponse(call)
	})
	defer finish()
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, _ := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Type("id:review-comment", "Sent comment")
	screen.Press("id:review-comment-send")
	screen.WaitUntil(10*time.Second, func() bool { return len(started) > 0 })
	screen.Clear("id:review-comment")
	screen.Type("id:review-comment", "Next draft")
	finish()
	screen.WaitFor("text:已提交", 10*time.Second)
	sent := <-started
	if got := screen.Find("id:review-comment").Text; got != "Next draft" {
		t.Fatalf("new draft after successful submission = %q", got)
	}
	if !samePath(sent.Dir, repo) || sent.Stdin != "Sent comment" || strings.Join(sent.Args, " ") != "pr comment 1 --body-file -" {
		t.Fatalf("comment request = %+v", sent)
	}
}

func TestReviewSuccessfulCommentClearsSubmittedDraft(t *testing.T) {
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if len(call.Args) > 1 && call.Args[1] == "comment" {
			return reviewCLIResult{}
		}
		return reviewTestResponse(call)
	})
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, _ := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Type("id:review-comment", "Submitted draft")
	screen.Press("id:review-comment-send")
	screen.WaitFor("text:已提交", 10*time.Second)
	if got := screen.Find("id:review-comment").Text; got != "" {
		t.Fatalf("submitted draft = %q, want cleared", got)
	}
	screen.Press("id:review-back")
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	if got := screen.Find("id:review-comment").Text; got != "" {
		t.Fatalf("submitted draft returned after navigation: %q", got)
	}
}

func TestReviewPatchDoesNotFollowItemSwitch(t *testing.T) {
	started, release, finished := make(chan struct{}, 1), make(chan struct{}), make(chan struct{}, 1)
	finish := sync.OnceFunc(func() { close(release) })
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if len(call.Args) > 1 && call.Args[1] == "diff" {
			started <- struct{}{}
			<-release
			finished <- struct{}{}
			return reviewCLIResult{Out: "old pull request patch"}
		}
		return reviewTestResponse(call)
	})
	defer finish()
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, built := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Post(built.review.loadPatch)
	screen.WaitUntil(10*time.Second, func() bool { return len(started) > 0 })
	screen.Press("id:review-back")
	screen.Press("id:review-kind-issue")
	screen.WaitFor("id:review-row-issue#1", 10*time.Second)
	screen.Press("id:review-row-issue#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	finish()
	screen.WaitUntil(10*time.Second, func() bool { return len(finished) > 0 })
	screen.Settle()
	if st := built.review.state.GetUntracked(); st.Patch != "" || st.PatchBusy || st.Open != "issue#1" {
		t.Fatalf("late patch changed the new item: %+v", st)
	}
}

func TestReviewEvaluationUsesSelectedRepository(t *testing.T) {
	reviewTestCLI(t, reviewTestResponse)
	parent := t.TempDir()
	alpha := reviewTestRepo(t, parent, "alpha")
	screen, built := reviewTestScreen(t, []workspaceCfg{{Path: parent, Name: "Project"}})
	screen.WaitFor("text:alpha item", 10*time.Second)
	var selected *workspace
	screen.Post(func() { selected = built.reviewEvaluationWorkspace() })
	screen.Settle()
	if selected == nil || !samePath(selected.Path, alpha) || selected.Target.remote() {
		t.Fatalf("evaluation workspace = %+v, want selected clone %s", selected, alpha)
	}
	if got := built.workspaceByWireKey(projectWireKey(selected)); got != selected || filepath.Base(got.Path) != "alpha" {
		t.Fatal("selected clone was not registered as the session's project")
	}
}
