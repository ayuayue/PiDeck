//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestReviewRefreshKeepsEditorMounted(t *testing.T) {
	var delayed atomic.Bool
	var details atomic.Int32
	release := make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if delayed.Load() {
			<-release
		}
		if len(call.Args) > 1 && call.Args[1] == "view" {
			return reviewCLIResult{Out: fmt.Sprintf(`{"number":1,"title":"alpha item","state":"OPEN","body":"Detail version %d"}`, details.Add(1))}
		}
		return reviewTestResponse(call)
	})
	defer finish()
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, _ := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Type("id:review-comment", "Draft before refresh")
	editor := screen.Find("id:review-comment").ID
	delayed.Store(true)
	screen.Press("id:review-refresh")
	screen.Focus("id:review-comment")
	if got := screen.Find("id:review-comment").ID; got != editor {
		t.Fatalf("refresh replaced the comment editor: %v -> %v", editor, got)
	}
	if screen.Enabled("id:review-refresh") {
		t.Fatal("refresh can be started again while reads are in flight")
	}
	screen.Type("id:review-comment", " while reading")
	finish()
	screen.WaitFor("text:Detail version 2", 10*time.Second)
	if got := screen.Find("id:review-comment"); got.ID != editor || !got.Focused || got.Text != "Draft before refresh while reading" {
		t.Fatalf("refresh completion interrupted the editor: %+v", got)
	}
}

func TestReviewFilterLeavesDetailAndClearsOldRows(t *testing.T) {
	started, release := make(chan struct{}, 1), make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if strings.Contains(strings.Join(call.Args, " "), "--state closed") {
			started <- struct{}{}
			<-release
			return reviewCLIResult{Out: `[{"number":2,"title":"Closed result","state":"CLOSED"}]`}
		}
		return reviewTestResponse(call)
	})
	defer finish()
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, _ := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Press("id:review-filter-closed")
	screen.WaitUntil(10*time.Second, func() bool { return len(started) > 0 })
	if screen.Exists("id:review-comment") || screen.Exists("id:review-row-pr#1") {
		t.Fatal("new filter still shows the old detail or rows")
	}
	screen.WaitFor("id:review-list-loading", time.Second)
	screen.Screenshot("review/loading")
	finish()
	screen.WaitFor("text:Closed result", 10*time.Second)
}

func TestReviewLoadMoreDoesNotQueueExtraPages(t *testing.T) {
	release := make(chan struct{})
	finish := sync.OnceFunc(func() { close(release) })
	var delayed atomic.Bool
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if delayed.Load() {
			<-release
		}
		return reviewTestResponse(call)
	})
	defer finish()
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, built := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	delayed.Store(true)
	screen.Post(func() { built.review.loadMore(); built.review.loadMore() })
	screen.Settle()
	if got := reviewTestRead(screen, func() int { return built.review.limit }); got != 80 {
		t.Fatalf("limit after repeated load more = %d, want 80", got)
	}
	finish()
}

func TestReviewPatchRetryCacheAndReturn(t *testing.T) {
	var reads atomic.Int32
	reviewTestCLI(t, func(call reviewCLICall) reviewCLIResult {
		if len(call.Args) > 1 && call.Args[1] == "view" {
			return reviewCLIResult{Out: `{"number":1,"title":"alpha item","state":"OPEN","body":"Fixture detail","files":[{"path":"main.go","additions":1}]}`}
		}
		if len(call.Args) > 1 && call.Args[1] == "diff" {
			if reads.Add(1) == 1 {
				return reviewCLIResult{Err: "fixture patch unavailable", Code: 1}
			}
			return reviewCLIResult{Out: "diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n@@ -0,0 +1 @@\n+package main\n"}
		}
		return reviewTestResponse(call)
	})
	repo := reviewTestRepo(t, t.TempDir(), "alpha")
	screen, _ := reviewTestScreen(t, []workspaceCfg{{Path: repo, Name: "Project"}})
	screen.WaitFor("id:review-row-pr#1", 10*time.Second)
	screen.Press("id:review-row-pr#1")
	screen.WaitFor("id:review-patch", 10*time.Second)
	screen.Press("id:review-patch")
	screen.WaitFor("text:fixture patch unavailable", 10*time.Second)
	if screen.Enabled("id:review-patch-copy") {
		t.Fatal("failed patch can be copied as if it were a diff")
	}
	screen.Press("id:review-patch-retry")
	screen.WaitFor("id:review-patch-content", 10*time.Second)
	screen.Screenshot("review/patch")
	screen.Press("id:review-patch-back")
	screen.WaitFor("id:review-comment", 10*time.Second)
	screen.Press("id:review-patch")
	screen.WaitFor("id:review-patch-content", time.Second)
	if got := reads.Load(); got != 2 {
		t.Fatalf("opening a cached patch reread it: %d reads", got)
	}
}
