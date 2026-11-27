package client

import (
	"net/http"
	"testing"

	"example.com/pideck-v2/internal/remotewire"
)

func TestMobileProjectPanelsClearOnDisconnect(t *testing.T) {
	a, _ := newConnectionTestApp(t)
	a.gitOpen.Set(true)
	a.gitProject.Set("/old")
	a.gitState.Set(remotewire.Git{IsRepo: true, Branch: "private"})
	a.gitMsg.Set("private message")
	a.gitBusy.Set(true)
	a.gitSending.Set(true)
	a.gitDiffOpen.Set(true)
	a.gitDiffText.Set("private diff")
	a.gitBranchesOpen.Set(true)
	a.reviewOpen.Set(true)
	a.reviewProject.Set("/old")
	a.reviewItems.Set([]remotewire.ReviewItem{{Number: 1}})
	a.reviewBusy.Set(true)
	a.reviewDetailOpen.Set(true)
	a.reviewDetail.Set(remotewire.ReviewDetail{Body: "private discussion"})
	a.reviewSending.Set(true)
	a.reviewComment.Set("private comment")
	a.reviewPending.Set("merge:squash")
	a.reviewPatchOpen.Set(true)
	a.reviewPatch.Set("private patch")
	a.disconnect()
	if a.gitOpen.GetUntracked() || a.gitProject.GetUntracked() != "" || a.gitState.GetUntracked().IsRepo || a.gitMsg.GetUntracked() != "" || a.gitBusy.GetUntracked() || a.gitSending.GetUntracked() || a.gitDiffOpen.GetUntracked() || a.gitDiffText.GetUntracked() != "" || a.gitBranchesOpen.GetUntracked() {
		t.Fatal("disconnect kept previous desktop's Git state")
	}
	if a.reviewOpen.GetUntracked() || a.reviewProject.GetUntracked() != "" || len(a.reviewItems.GetUntracked()) != 0 || a.reviewBusy.GetUntracked() || a.reviewDetailOpen.GetUntracked() || a.reviewDetail.GetUntracked().Body != "" || a.reviewSending.GetUntracked() || a.reviewComment.GetUntracked() != "" || a.reviewPending.GetUntracked() != "" || a.reviewPatchOpen.GetUntracked() || a.reviewPatch.GetUntracked() != "" {
		t.Fatal("disconnect kept previous desktop's review or pending action")
	}
}

func TestMobileReviewListKeepsProjectVisit(t *testing.T) {
	for _, navigation := range []string{"project", "reopen", "connection"} {
		for _, status := range []int{http.StatusOK, http.StatusForbidden} {
			t.Run(navigation+"/"+http.StatusText(status), func(t *testing.T) {
				a, posts := newConnectionTestApp(t)
				client, reads := newSessionReadServer(t)
				a.client = client
				a.state.Set(remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/a"}}})
				a.openReview()
				old := nextSessionRead(t, reads)
				if navigation == "project" {
					a.state.Set(remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/b"}}})
				}
				if navigation == "connection" {
					a.disconnect()
					a.client = newSessionReadClient(client)
					a.state.Set(remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/a"}}})
				}
				a.openReview()
				a.reviewErr.Set("current notice")
				replySessionRead(t, posts, old, status, remotewire.ReviewList{Items: []remotewire.ReviewItem{{Number: 1}}})
				if len(a.reviewItems.GetUntracked()) != 0 || !a.reviewBusy.GetUntracked() || a.reviewErr.GetUntracked() != "current notice" {
					t.Fatal("old review list changed the current project visit")
				}
				replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.ReviewList{Items: []remotewire.ReviewItem{{Number: 2}}})
				if a.reviewBusy.GetUntracked() || a.reviewItems.GetUntracked()[0].Number != 2 {
					t.Fatal("current review list did not load")
				}
			})
		}
	}
}

func TestMobileReviewCurrentActionsComplete(t *testing.T) {
	for _, action := range []string{"comment", "close", "evaluate"} {
		t.Run(action, func(t *testing.T) {
			a, posts := newSessionReadTestApp(t)
			client, reads := newSessionReadServer(t)
			a.client = client
			openReviewForLifecycleTest(t, a, posts, reads, "/a")
			a.openReviewDetail(remotewire.ReviewItem{Kind: "pr", Number: 2})
			replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.ReviewDetail{Item: remotewire.ReviewItem{Kind: "pr", Number: 2}})
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
			replySessionRead(t, posts, nextSessionRead(t, reads), http.StatusOK, remotewire.ReviewEvaluation{Session: "evaluated"})
			if a.reviewSending.GetUntracked() {
				t.Fatal("current action did not finish")
			}
			if action == "evaluate" {
				if a.reviewOpen.GetUntracked() || a.reviewDetailOpen.GetUntracked() || a.active.GetUntracked() != "evaluated" {
					t.Fatal("evaluation did not open its session")
				}
				finishAgentCreationReads(t, posts, reads, "evaluated")
				return
			}
			for range 2 {
				read := nextSessionRead(t, reads)
				switch read.path {
				case "/api/review":
					replySessionRead(t, posts, read, http.StatusOK, remotewire.ReviewList{})
				case "/api/review/detail":
					replySessionRead(t, posts, read, http.StatusOK, remotewire.ReviewDetail{Item: remotewire.ReviewItem{Kind: "pr", Number: 2}})
				default:
					t.Fatalf("unexpected follow-up: %s", read.path)
				}
			}
			if a.reviewBusy.GetUntracked() || a.reviewDetailBusy.GetUntracked() || a.reviewDetail.GetUntracked().Item.Number != 2 {
				t.Fatal("current action did not refresh the same item")
			}
		})
	}
}
