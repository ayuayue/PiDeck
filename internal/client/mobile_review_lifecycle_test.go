package client

import (
	"net/http"
	"testing"

	"example.com/pideck-v2/internal/remotewire"
)

func openReviewForLifecycleTest(t *testing.T, a *mobileApp, posts <-chan func(), reads <-chan pendingSessionRead, project string) {
	t.Helper()
	a.state.Set(remotewire.Snapshot{Projects: []remotewire.Project{{Path: project, Name: project}}})
	a.openReview()
	replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.ReviewList{})
}

func TestMobileReviewDetailKeepsProjectAndItem(t *testing.T) {
	for _, navigation := range []string{"project", "reopen", "connection"} {
		for _, status := range []int{http.StatusOK, http.StatusForbidden} {
			t.Run(navigation+"/"+http.StatusText(status), func(t *testing.T) {
				a, posts := newConnectionTestApp(t)
				client, reads := newSessionReadServer(t)
				a.client = client
				openReviewForLifecycleTest(t, a, posts, reads, "/a")
				a.openReviewDetail(remotewire.ReviewItem{Kind: "pr", Number: 1})
				old := nextSessionRead(t, reads)
				project := "/a"
				if navigation == "project" {
					project = "/b"
				}
				if navigation == "connection" {
					a.disconnect()
					a.client = newSessionReadClient(client)
				}
				openReviewForLifecycleTest(t, a, posts, reads, project)
				a.openReviewDetail(remotewire.ReviewItem{Kind: "pr", Number: 2})
				current := nextSessionRead(t, reads)
				replySessionRead(t, posts, old, status, remotewire.ReviewDetail{Item: remotewire.ReviewItem{Kind: "pr", Number: 1}})
				if a.reviewDetail.GetUntracked().Item.Number != 2 || !a.reviewDetailBusy.GetUntracked() || a.reviewDetailErr.GetUntracked() != "" {
					t.Fatal("old detail replaced the current project or pull request")
				}
				replySessionRead(t, posts, current, http.StatusOK, remotewire.ReviewDetail{Item: remotewire.ReviewItem{Kind: "pr", Number: 2}, Body: "current"})
				if a.reviewDetailBusy.GetUntracked() || a.reviewDetail.GetUntracked().Body != "current" {
					t.Fatal("current detail did not load")
				}
			})
		}
	}
}

func TestMobileReviewListKeepsLatestFilter(t *testing.T) {
	a, posts := newConnectionTestApp(t)
	client, reads := newSessionReadServer(t)
	a.client = client
	a.state.Set(remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/a"}}})
	a.openReview()
	old := nextSessionRead(t, reads)
	a.setReviewKind("issue")
	replySessionRead(t, posts, old, http.StatusOK, remotewire.ReviewList{Items: []remotewire.ReviewItem{{Kind: "pr", Number: 1}}})
	if len(a.reviewItems.GetUntracked()) != 0 || !a.reviewBusy.GetUntracked() {
		t.Fatal("old pull requests replaced the pending issue list")
	}
	replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.ReviewList{Items: []remotewire.ReviewItem{{Kind: "issue", Number: 2}}})
	if a.reviewBusy.GetUntracked() || a.reviewItems.GetUntracked()[0].Kind != "issue" {
		t.Fatal("new filter did not load")
	}
}

func TestMobileReviewActionsKeepItemVisit(t *testing.T) {
	for _, action := range []string{"comment", "close", "evaluate"} {
		for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
			t.Run(action+"/"+http.StatusText(status), func(t *testing.T) {
				a, posts := newConnectionTestApp(t)
				client, reads := newSessionReadServer(t)
				a.client = client
				openReviewForLifecycleTest(t, a, posts, reads, "/a")
				open := func(n int) {
					a.openReviewDetail(remotewire.ReviewItem{Kind: "pr", Number: n})
					replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.ReviewDetail{Item: remotewire.ReviewItem{Kind: "pr", Number: n}})
				}
				start := func() {
					switch action {
					case "comment":
						a.reviewComment.Set("comment")
						a.sendReviewComment()
					case "close":
						a.reviewConfirm("close")
						a.runReviewPending()
					case "evaluate":
						a.evaluateReview()
					}
				}
				open(1)
				start()
				old := nextSessionRead(t, reads)
				open(2)
				if a.reviewSending.GetUntracked() {
					t.Fatal("previous item kept the current operation busy")
				}
				start()
				current := nextSessionRead(t, reads)
				a.reviewComment.Set("new draft")
				a.notice.Set("current notice")
				replySessionRead(t, posts, old, status, remotewire.ReviewEvaluation{Session: "old-session"})
				if !a.reviewSending.GetUntracked() || a.reviewComment.GetUntracked() != "new draft" || a.notice.GetUntracked() != "current notice" || !a.reviewDetailOpen.GetUntracked() || a.active.GetUntracked() != "" || a.reviewDetailBusy.GetUntracked() || a.reviewBusy.GetUntracked() {
					t.Fatal("old action changed the current detail, draft or navigation")
				}
				replySessionRead(t, posts, current, http.StatusBadRequest, nil)
				if a.reviewSending.GetUntracked() || a.notice.GetUntracked() == "current notice" {
					t.Fatal("current failure did not finish or report its error")
				}
			})
		}
	}
}

func TestMobileReviewPatchKeepsItemVisit(t *testing.T) {
	a, posts := newConnectionTestApp(t)
	client, reads := newSessionReadServer(t)
	a.client = client
	openReviewForLifecycleTest(t, a, posts, reads, "/a")
	open := func(n int) {
		a.openReviewDetail(remotewire.ReviewItem{Kind: "pr", Number: n})
		replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.ReviewDetail{Item: remotewire.ReviewItem{Kind: "pr", Number: n}})
	}
	open(1)
	a.openReviewPatch()
	old := nextSessionRead(t, reads)
	open(2)
	if a.reviewPatchOpen.GetUntracked() {
		t.Fatal("new detail kept the previous item's patch open")
	}
	a.openReviewPatch()
	current := nextSessionRead(t, reads)
	replySessionRead(t, posts, old, http.StatusOK, map[string]string{"patch": "old"})
	if !a.reviewPatchBusy.GetUntracked() || a.reviewPatch.GetUntracked() != "" {
		t.Fatal("old patch replaced the current item")
	}
	replySessionRead(t, posts, current, http.StatusOK, map[string]string{"patch": "current"})
	if a.reviewPatchBusy.GetUntracked() || a.reviewPatch.GetUntracked() != "current" {
		t.Fatal("current patch did not load")
	}
}
